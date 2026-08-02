from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any


class ComfyUIError(RuntimeError):
    """Raised when ComfyUI is unreachable or returns an invalid response."""


class ComfyUITimeout(ComfyUIError):
    """Raised when a queued generation does not complete in time."""


@dataclass(frozen=True)
class OutputImage:
    filename: str
    subfolder: str = ""
    image_type: str = "output"


class ComfyUIClient:
    def __init__(
        self,
        base_url: str,
        *,
        timeout_seconds: float,
        generation_timeout_seconds: float,
        poll_interval_seconds: float,
    ) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("COMFYUI_URL must use http:// or https://")
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.generation_timeout_seconds = generation_timeout_seconds
        self.poll_interval_seconds = poll_interval_seconds

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _open(self, request: urllib.request.Request) -> bytes:
        try:
            with urllib.request.urlopen(  # noqa: S310 - operator-configured local endpoint
                request,
                timeout=self.timeout_seconds,
            ) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read(4096).decode("utf-8", errors="replace")
            raise ComfyUIError(f"ComfyUI HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ComfyUIError(f"Cannot reach ComfyUI: {exc}") from exc

    def _json(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self._url(path),
            data=body,
            method=method,
            headers={"Content-Type": "application/json"} if body is not None else {},
        )
        raw = self._open(request)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ComfyUIError("ComfyUI returned invalid JSON") from exc
        if not isinstance(parsed, dict):
            raise ComfyUIError("ComfyUI returned a non-object JSON response")
        return parsed

    def system_stats(self) -> dict[str, Any]:
        return self._json("/system_stats")

    def object_info(self) -> dict[str, Any]:
        return self._json("/object_info")

    def upload_image(self, png_bytes: bytes, filename: str) -> dict[str, Any]:
        boundary = f"----room-design-{uuid.uuid4().hex}"
        chunks = [
            f"--{boundary}\r\n".encode(),
            (
                'Content-Disposition: form-data; name="image"; '
                f'filename="{filename}"\r\n'
            ).encode(),
            b"Content-Type: image/png\r\n\r\n",
            png_bytes,
            b"\r\n",
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="type"\r\n\r\ninput\r\n',
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n',
            f"--{boundary}--\r\n".encode(),
        ]
        request = urllib.request.Request(
            self._url("/upload/image"),
            data=b"".join(chunks),
            method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        raw = self._open(request)
        try:
            result = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ComfyUIError("ComfyUI upload returned invalid JSON") from exc
        if not isinstance(result, dict) or not result.get("name"):
            raise ComfyUIError("ComfyUI upload response is missing the image name")
        return result

    def submit_prompt(self, workflow: dict[str, Any]) -> str:
        result = self._json(
            "/prompt",
            method="POST",
            payload={"prompt": workflow, "client_id": f"room-design-{uuid.uuid4().hex}"},
        )
        prompt_id = result.get("prompt_id")
        if not isinstance(prompt_id, str) or not prompt_id:
            error = result.get("error") or result.get("node_errors") or "missing prompt_id"
            raise ComfyUIError(f"ComfyUI rejected the workflow: {error}")
        return prompt_id

    @staticmethod
    def _execution_error(history: dict[str, Any]) -> str | None:
        status = history.get("status")
        if not isinstance(status, dict):
            return None
        for message in status.get("messages", []):
            if (
                isinstance(message, list)
                and len(message) > 1
                and message[0] == "execution_error"
            ):
                detail = message[1]
                if isinstance(detail, dict):
                    return str(detail.get("exception_message") or detail)
                return str(detail)
        return None

    @staticmethod
    def _find_output(history: dict[str, Any], output_node_id: str) -> OutputImage | None:
        outputs = history.get("outputs", {})
        if not isinstance(outputs, dict):
            return None
        ordered = []
        if output_node_id in outputs:
            ordered.append(outputs[output_node_id])
        ordered.extend(value for key, value in outputs.items() if key != output_node_id)
        for node_output in ordered:
            if not isinstance(node_output, dict):
                continue
            images = node_output.get("images", [])
            if not images or not isinstance(images[0], dict):
                continue
            image = images[0]
            filename = image.get("filename")
            if isinstance(filename, str) and filename:
                return OutputImage(
                    filename=filename,
                    subfolder=str(image.get("subfolder", "")),
                    image_type=str(image.get("type", "output")),
                )
        return None

    def wait_for_output(self, prompt_id: str, output_node_id: str) -> OutputImage:
        deadline = time.monotonic() + self.generation_timeout_seconds
        encoded_id = urllib.parse.quote(prompt_id, safe="")
        while time.monotonic() < deadline:
            response = self._json(f"/history/{encoded_id}")
            history = response.get(prompt_id)
            if isinstance(history, dict):
                error = self._execution_error(history)
                if error:
                    raise ComfyUIError(f"ComfyUI generation failed: {error}")
                output = self._find_output(history, output_node_id)
                if output is not None:
                    return output
            time.sleep(self.poll_interval_seconds)
        raise ComfyUITimeout(
            f"ComfyUI generation exceeded {self.generation_timeout_seconds:.1f} seconds"
        )

    def view_image(self, output: OutputImage) -> bytes:
        query = urllib.parse.urlencode(
            {
                "filename": output.filename,
                "subfolder": output.subfolder,
                "type": output.image_type,
            }
        )
        request = urllib.request.Request(self._url(f"/view?{query}"), method="GET")
        raw = self._open(request)
        if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ComfyUIError("ComfyUI /view did not return a PNG image")
        return raw


def uploaded_image_name(upload: dict[str, Any]) -> str:
    name = str(upload["name"])
    subfolder = str(upload.get("subfolder", "")).strip("/")
    return f"{subfolder}/{name}" if subfolder else name
