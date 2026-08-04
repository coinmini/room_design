from __future__ import annotations

import base64
import binascii
import ipaddress
import math
import random
import re
import socket
import threading
import time
from time import perf_counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Callable, TypeAlias
from urllib.parse import urljoin, urlparse

import httpx

from app.processors.common import (
    MAX_PROVIDER_ERROR_BODY_BYTES,
    ProcessorError,
    sanitize_provider_error_detail,
)
from app.storage import artifact_path, artifact_url


ImagePath: TypeAlias = str | Path
HostResolver: TypeAlias = Callable[[str, int], Sequence[str]]

KUYAO_IMAGE_INPUT_REJECTED = "KUYAO_IMAGE_INPUT_REJECTED"
KUYAO_IMAGE_CONFIG_INVALID = "KUYAO_IMAGE_CONFIG_INVALID"
KUYAO_IMAGE_TIMEOUT = "KUYAO_IMAGE_TIMEOUT"
KUYAO_IMAGE_PROVIDER_UNAVAILABLE = "KUYAO_IMAGE_PROVIDER_UNAVAILABLE"
KUYAO_IMAGE_PROVIDER_REJECTED = "KUYAO_IMAGE_PROVIDER_REJECTED"
KUYAO_IMAGE_RESPONSE_INVALID = "KUYAO_IMAGE_RESPONSE_INVALID"
KUYAO_IMAGE_DOWNLOAD_REJECTED = "KUYAO_IMAGE_DOWNLOAD_REJECTED"
KUYAO_IMAGE_WRITE_FAILED = "KUYAO_IMAGE_WRITE_FAILED"

MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
MAX_OUTPUT_IMAGE_BYTES = 50 * 1024 * 1024
MAX_REFERENCE_IMAGES = 8
MAX_BASE64_IMAGE_CHARS = 4 * ((MAX_OUTPUT_IMAGE_BYTES + 2) // 3)
MAX_EDIT_RESPONSE_BYTES = MAX_BASE64_IMAGE_CHARS + 1024 * 1024
MAX_DOWNLOAD_REDIRECTS = 5

_ALLOWED_QUALITIES = {"low", "medium", "high"}
_SIZE_PATTERN = re.compile(r"^[1-9]\d{1,4}x[1-9]\d{1,4}$")
_MIME_SUFFIXES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

# Transient gateway conditions worth one bounded second chance. Read timeouts
# are deliberately excluded: the provider accepted the request and is
# generating, so a retry would double the true worst case and the bill.
_RETRYABLE_STATUS_CODES = frozenset({408, 429, 500, 502, 503, 504})
_RETRY_BACKOFF_SECONDS = (1.0, 4.0)
_MAX_RETRY_AFTER_SECONDS = 30.0

_SHARED_CLIENT: httpx.Client | None = None
_SHARED_CLIENT_LOCK = threading.Lock()


def _shared_client() -> httpx.Client:
    """Process-wide keep-alive client; httpx.Client is thread-safe."""

    global _SHARED_CLIENT
    if _SHARED_CLIENT is None:
        with _SHARED_CLIENT_LOCK:
            if _SHARED_CLIENT is None:
                _SHARED_CLIENT = httpx.Client(
                    limits=httpx.Limits(
                        max_connections=16,
                        max_keepalive_connections=16,
                        keepalive_expiry=300,
                    )
                )
    return _SHARED_CLIENT


def _request_timeout(read_seconds: float) -> httpx.Timeout:
    """Only the read phase owns the long generation budget."""

    return httpx.Timeout(connect=5.0, write=120.0, read=read_seconds, pool=10.0)


def _detect_image_mime(raw: bytes) -> str | None:
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def _read_input_image(path_value: ImagePath) -> tuple[Path, bytes, str]:
    path = Path(path_value)
    try:
        raw = path.read_bytes()
    except (OSError, ValueError) as exc:
        raise ProcessorError(KUYAO_IMAGE_INPUT_REJECTED, "无法读取待增强图片") from exc
    if not raw:
        raise ProcessorError(KUYAO_IMAGE_INPUT_REJECTED, "待增强图片为空")
    if len(raw) > MAX_INPUT_IMAGE_BYTES:
        raise ProcessorError(KUYAO_IMAGE_INPUT_REJECTED, "单张待增强图片不能超过 20 MB")
    mime_type = _detect_image_mime(raw)
    if mime_type is None:
        raise ProcessorError(
            KUYAO_IMAGE_INPUT_REJECTED,
            "图像增强仅支持有效的 JPEG、PNG 或 WebP 图片",
        )
    return path, raw, mime_type


def _validate_config(
    *,
    api_key: str,
    base_url: str,
    model: str,
    size: str,
    quality: str,
    prompt: str,
    timeout_seconds: float,
) -> tuple[str, str, str, str, str, str]:
    clean_key = api_key.strip()
    if not clean_key:
        raise ProcessorError(KUYAO_IMAGE_CONFIG_INVALID, "未配置 Kuyao API Key")
    clean_model = model.strip()
    if not clean_model:
        raise ProcessorError(KUYAO_IMAGE_CONFIG_INVALID, "未配置图像增强模型")
    clean_prompt = prompt.strip()
    if not clean_prompt:
        raise ProcessorError(KUYAO_IMAGE_CONFIG_INVALID, "图像增强提示词不能为空")
    clean_size = size.strip().lower()
    if not _SIZE_PATTERN.fullmatch(clean_size):
        raise ProcessorError(KUYAO_IMAGE_CONFIG_INVALID, "图像增强尺寸必须为宽x高")
    clean_quality = quality.strip().lower()
    if clean_quality not in _ALLOWED_QUALITIES:
        raise ProcessorError(KUYAO_IMAGE_CONFIG_INVALID, "图像增强质量仅支持 low、medium 或 high")
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ProcessorError(KUYAO_IMAGE_CONFIG_INVALID, "图像增强超时时间必须大于 0")

    clean_base_url = base_url.strip().rstrip("/")
    try:
        parsed = urlparse(clean_base_url)
    except ValueError:
        raise ProcessorError(KUYAO_IMAGE_CONFIG_INVALID, "Kuyao API 地址无效") from None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ProcessorError(KUYAO_IMAGE_CONFIG_INVALID, "Kuyao API 地址无效")
    endpoint = (
        clean_base_url
        if parsed.path.rstrip("/").endswith("/images/edits")
        else f"{clean_base_url}/images/edits"
    )
    return clean_key, endpoint, clean_model, clean_size, clean_quality, clean_prompt


def _input_paths(
    source_path: ImagePath,
    reference_paths: Sequence[ImagePath] | ImagePath | None,
) -> list[ImagePath]:
    if reference_paths is None:
        references: list[ImagePath] = []
    elif isinstance(reference_paths, (str, Path)):
        references = [reference_paths]
    else:
        references = list(reference_paths)
    if len(references) > MAX_REFERENCE_IMAGES:
        raise ProcessorError(
            KUYAO_IMAGE_INPUT_REJECTED,
            f"参考图不能超过 {MAX_REFERENCE_IMAGES} 张",
        )
    return [source_path, *references]


def _multipart_files(
    images: list[tuple[Path, bytes, str]],
) -> list[tuple[str, tuple[str, bytes, str]]]:
    field_name = "image" if len(images) == 1 else "image[]"
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for index, (path, raw, mime_type) in enumerate(images):
        suffix = _MIME_SUFFIXES[mime_type]
        filename = path.name.strip() or f"input-{index + 1}{suffix}"
        if Path(filename).suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            filename = f"{Path(filename).stem or f'input-{index + 1}'}{suffix}"
        files.append((field_name, (filename, raw, mime_type)))
    return files


def _read_capped_error_body(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    received = 0
    try:
        for chunk in response.iter_bytes():
            received += len(chunk)
            if received > MAX_PROVIDER_ERROR_BODY_BYTES:
                keep = MAX_PROVIDER_ERROR_BODY_BYTES - (received - len(chunk))
                if keep > 0:
                    chunks.append(chunk[:keep])
                break
            chunks.append(chunk)
    except httpx.HTTPError:
        pass
    return b"".join(chunks)


def _post_edit(
    *,
    client: httpx.Client,
    endpoint: str,
    api_key: str,
    images: list[tuple[Path, bytes, str]],
    model: str,
    size: str,
    quality: str,
    prompt: str,
    timeout_seconds: float,
) -> httpx.Response:
    try:
        with client.stream(
            "POST",
            endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
            data={
                "model": model,
                "prompt": prompt,
                "size": size,
                "quality": quality,
                "n": "1",
            },
            files=_multipart_files(images),
            timeout=_request_timeout(timeout_seconds),
        ) as response:
            if not 200 <= response.status_code < 300:
                # Keep only whitelisted error fields (code/type/message) plus
                # Retry-After so callers can judge retryability; the raw body
                # may echo secrets and is still discarded.
                detail = sanitize_provider_error_detail(
                    _read_capped_error_body(response),
                    secrets=(api_key,),
                )
                headers = {}
                retry_after = response.headers.get("Retry-After")
                if retry_after:
                    headers["Retry-After"] = retry_after
                return httpx.Response(
                    response.status_code,
                    headers=headers,
                    content=detail.encode("utf-8"),
                )
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    declared_size = int(content_length)
                except ValueError:
                    declared_size = 0
                if declared_size > MAX_EDIT_RESPONSE_BYTES:
                    raise ProcessorError(
                        KUYAO_IMAGE_RESPONSE_INVALID,
                        "Kuyao 图像增强响应超过大小限制",
                    )
            chunks: list[bytes] = []
            received = 0
            for chunk in response.iter_bytes():
                received += len(chunk)
                if received > MAX_EDIT_RESPONSE_BYTES:
                    raise ProcessorError(
                        KUYAO_IMAGE_RESPONSE_INVALID,
                        "Kuyao 图像增强响应超过大小限制",
                    )
                chunks.append(chunk)
            # Do not retain Content-Encoding/Length from the upstream response because
            # iter_bytes() has already decoded the transfer representation.
            return httpx.Response(
                response.status_code,
                headers={"Content-Type": response.headers.get("Content-Type", "")},
                content=b"".join(chunks),
            )
    except ProcessorError:
        raise
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        # Connect-phase failures never reached the provider: safe to retry.
        del exc
        raise ProcessorError(
            KUYAO_IMAGE_PROVIDER_UNAVAILABLE,
            "无法连接 Kuyao 图像增强服务",
        ) from None
    except httpx.TimeoutException as exc:
        # The request owns the Authorization header and image bodies; never retain it.
        del exc
        raise ProcessorError(KUYAO_IMAGE_TIMEOUT, "Kuyao 图像增强请求超时") from None
    except httpx.RequestError as exc:
        del exc
        raise ProcessorError(
            KUYAO_IMAGE_PROVIDER_UNAVAILABLE,
            "无法连接 Kuyao 图像增强服务",
        ) from None


def _retry_delay_seconds(response: httpx.Response | None, attempt: int) -> float:
    base = _RETRY_BACKOFF_SECONDS[min(attempt, len(_RETRY_BACKOFF_SECONDS) - 1)]
    if response is not None:
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            try:
                base = max(base, min(float(retry_after), _MAX_RETRY_AFTER_SECONDS))
            except ValueError:
                pass
    return base + random.uniform(0.0, 0.5 * base)


def _post_edit_with_retry(**kwargs: Any) -> httpx.Response:
    """Two bounded extra attempts on connect failures and transient statuses."""

    last_attempt = len(_RETRY_BACKOFF_SECONDS)
    for attempt in range(last_attempt + 1):
        try:
            response = _post_edit(**kwargs)
        except ProcessorError as exc:
            if (
                exc.code == KUYAO_IMAGE_PROVIDER_UNAVAILABLE
                and attempt < last_attempt
            ):
                time.sleep(_retry_delay_seconds(None, attempt))
                continue
            raise
        if (
            response.status_code in _RETRYABLE_STATUS_CODES
            and attempt < last_attempt
        ):
            time.sleep(_retry_delay_seconds(response, attempt))
            continue
        return response
    raise AssertionError("unreachable")


def _response_item(response: httpx.Response) -> dict[str, Any]:
    if not 200 <= response.status_code < 300:
        detail = response.text.strip()[:200]
        suffix = f"：{detail}" if detail else ""
        raise ProcessorError(
            KUYAO_IMAGE_PROVIDER_REJECTED,
            f"Kuyao 图像增强服务拒绝请求（HTTP {response.status_code}）{suffix}",
        )
    try:
        payload = response.json()
        item = payload["data"][0]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        # JSON decoder errors can retain the raw response document (including base64).
        del exc
        raise ProcessorError(
            KUYAO_IMAGE_RESPONSE_INVALID,
            "Kuyao 图像增强返回格式无效",
        ) from None
    if not isinstance(item, dict):
        raise ProcessorError(KUYAO_IMAGE_RESPONSE_INVALID, "Kuyao 图像增强返回格式无效")
    return item


def _decode_base64_image(encoded: Any) -> tuple[bytes, str]:
    if not isinstance(encoded, str) or not encoded.strip():
        raise ProcessorError(KUYAO_IMAGE_RESPONSE_INVALID, "Kuyao 未返回有效的增强图片")
    encoded = encoded.strip()
    if len(encoded) > MAX_BASE64_IMAGE_CHARS:
        raise ProcessorError(KUYAO_IMAGE_RESPONSE_INVALID, "Kuyao 返回的图片编码超过大小限制")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        del exc
        raise ProcessorError(
            KUYAO_IMAGE_RESPONSE_INVALID,
            "Kuyao 返回的图片编码无效",
        ) from None
    if len(raw) > MAX_OUTPUT_IMAGE_BYTES:
        raise ProcessorError(KUYAO_IMAGE_RESPONSE_INVALID, "Kuyao 返回的增强图片超过大小限制")
    mime_type = _detect_image_mime(raw)
    if mime_type is None:
        raise ProcessorError(KUYAO_IMAGE_RESPONSE_INVALID, "Kuyao 返回的内容不是有效图片")
    return raw, mime_type


def _system_host_resolver(host: str, port: int) -> Sequence[str]:
    return tuple(
        {
            address[4][0].split("%", 1)[0]
            for address in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        }
    )


def _reject_non_public_address(address: str) -> None:
    try:
        parsed = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        raise ProcessorError(
            KUYAO_IMAGE_DOWNLOAD_REJECTED,
            "增强图片下载地址解析结果无效",
        ) from None
    if (
        parsed.is_loopback
        or parsed.is_private
        or parsed.is_link_local
        or parsed.is_multicast
        or parsed.is_unspecified
        or parsed.is_reserved
        or not parsed.is_global
    ):
        raise ProcessorError(
            KUYAO_IMAGE_DOWNLOAD_REJECTED,
            "增强图片下载地址不允许访问非公网主机",
        )


def _validate_download_url(url: str, resolver: HostResolver) -> None:
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
    except ValueError:
        raise ProcessorError(KUYAO_IMAGE_RESPONSE_INVALID, "Kuyao 返回的图片地址无效") from None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not hostname:
        raise ProcessorError(KUYAO_IMAGE_RESPONSE_INVALID, "Kuyao 返回的图片地址无效")
    if parsed.username is not None or parsed.password is not None:
        raise ProcessorError(KUYAO_IMAGE_DOWNLOAD_REJECTED, "增强图片下载地址不允许包含用户信息")
    host = hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        raise ProcessorError(
            KUYAO_IMAGE_DOWNLOAD_REJECTED,
            "增强图片下载地址不允许访问本地主机",
        )
    try:
        literal = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        try:
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            addresses = tuple(resolver(host, port))
        except (OSError, ValueError) as exc:
            del exc
            raise ProcessorError(
                KUYAO_IMAGE_PROVIDER_UNAVAILABLE,
                "无法解析 Kuyao 增强图片下载地址",
            ) from None
        if not addresses:
            raise ProcessorError(
                KUYAO_IMAGE_PROVIDER_UNAVAILABLE,
                "无法解析 Kuyao 增强图片下载地址",
            )
        for address in addresses:
            _reject_non_public_address(address)
    else:
        _reject_non_public_address(str(literal))


def _download_image(
    *,
    client: httpx.Client,
    url: Any,
    timeout_seconds: float,
    host_resolver: HostResolver,
) -> tuple[bytes, str]:
    if not isinstance(url, str):
        raise ProcessorError(KUYAO_IMAGE_RESPONSE_INVALID, "Kuyao 未返回有效的增强图片")
    current_url = url.strip()
    for redirect_count in range(MAX_DOWNLOAD_REDIRECTS + 1):
        _validate_download_url(current_url, host_resolver)
        try:
            with client.stream(
                "GET",
                current_url,
                timeout=_request_timeout(timeout_seconds),
                follow_redirects=False,
            ) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    if redirect_count >= MAX_DOWNLOAD_REDIRECTS:
                        raise ProcessorError(
                            KUYAO_IMAGE_DOWNLOAD_REJECTED,
                            "增强图片下载重定向次数过多",
                        )
                    location = response.headers.get("Location")
                    if not location:
                        raise ProcessorError(
                            KUYAO_IMAGE_DOWNLOAD_REJECTED,
                            "增强图片下载重定向缺少目标地址",
                        )
                    current_url = urljoin(current_url, location)
                    continue
                if not 200 <= response.status_code < 300:
                    raise ProcessorError(
                        KUYAO_IMAGE_DOWNLOAD_REJECTED,
                        f"增强图片下载失败（HTTP {response.status_code}）",
                    )
                content_type = (
                    response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                )
                if content_type not in _MIME_SUFFIXES:
                    raise ProcessorError(
                        KUYAO_IMAGE_DOWNLOAD_REJECTED,
                        "增强图片下载响应的 Content-Type 不受支持",
                    )
                content_length = response.headers.get("Content-Length")
                if content_length:
                    try:
                        declared_size = int(content_length)
                    except ValueError:
                        declared_size = 0
                    if declared_size > MAX_OUTPUT_IMAGE_BYTES:
                        raise ProcessorError(
                            KUYAO_IMAGE_DOWNLOAD_REJECTED,
                            "增强图片下载内容超过大小限制",
                        )

                chunks: list[bytes] = []
                received = 0
                for chunk in response.iter_bytes():
                    received += len(chunk)
                    if received > MAX_OUTPUT_IMAGE_BYTES:
                        raise ProcessorError(
                            KUYAO_IMAGE_DOWNLOAD_REJECTED,
                            "增强图片下载内容超过大小限制",
                        )
                    chunks.append(chunk)
        except ProcessorError:
            raise
        except httpx.TimeoutException as exc:
            del exc
            raise ProcessorError(KUYAO_IMAGE_TIMEOUT, "增强图片下载超时") from None
        except httpx.RequestError as exc:
            del exc
            raise ProcessorError(
                KUYAO_IMAGE_PROVIDER_UNAVAILABLE,
                "无法下载 Kuyao 增强图片",
            ) from None

        raw = b"".join(chunks)
        detected_mime = _detect_image_mime(raw)
        if detected_mime is None or detected_mime != content_type:
            raise ProcessorError(KUYAO_IMAGE_DOWNLOAD_REJECTED, "下载内容不是有效的增强图片")
        return raw, detected_mime
    raise ProcessorError(KUYAO_IMAGE_DOWNLOAD_REJECTED, "增强图片下载重定向次数过多")


def _extract_image(
    *,
    item: dict[str, Any],
    client: httpx.Client,
    timeout_seconds: float,
    host_resolver: HostResolver,
) -> tuple[bytes, str, str]:
    if item.get("b64_json"):
        raw, mime_type = _decode_base64_image(item["b64_json"])
        return raw, mime_type, "b64_json"
    if item.get("url"):
        raw, mime_type = _download_image(
            client=client,
            url=item["url"],
            timeout_seconds=timeout_seconds,
            host_resolver=host_resolver,
        )
        return raw, mime_type, "url"
    raise ProcessorError(KUYAO_IMAGE_RESPONSE_INVALID, "Kuyao 未返回有效的增强图片")


def edit_floorplan_image(
    source_path: ImagePath,
    *,
    api_key: str,
    base_url: str,
    prompt: str,
    model: str = "gpt-image-2",
    size: str = "1536x1024",
    quality: str = "high",
    timeout_seconds: float = 900,
    reference_paths: Sequence[ImagePath] | ImagePath | None = None,
    http_client: httpx.Client | None = None,
    host_resolver: HostResolver | None = None,
) -> dict[str, Any]:
    """Enhance a rendered floorplan through Kuyao's OpenAI-compatible image edit API.

    Only safe local artifact metadata is returned. Provider URLs, image base64 and the
    Authorization value never leave this adapter.
    """

    call_started = perf_counter()
    clean_key, endpoint, clean_model, clean_size, clean_quality, clean_prompt = (
        _validate_config(
            api_key=api_key,
            base_url=base_url,
            model=model,
            size=size,
            quality=quality,
            prompt=prompt,
            timeout_seconds=timeout_seconds,
        )
    )
    images = [_read_input_image(path) for path in _input_paths(source_path, reference_paths)]

    client = http_client or _shared_client()
    response = _post_edit_with_retry(
        client=client,
        endpoint=endpoint,
        api_key=clean_key,
        images=images,
        model=clean_model,
        size=clean_size,
        quality=clean_quality,
        prompt=clean_prompt,
        timeout_seconds=timeout_seconds,
    )
    item = _response_item(response)
    raw, mime_type, response_format = _extract_image(
        item=item,
        client=client,
        timeout_seconds=timeout_seconds,
        host_resolver=host_resolver or _system_host_resolver,
    )

    output = artifact_path("floorplan-kuyao-final", _MIME_SUFFIXES[mime_type])
    try:
        output.write_bytes(raw)
    except OSError as exc:
        raise ProcessorError(KUYAO_IMAGE_WRITE_FAILED, "增强图片写入本地失败") from exc

    provider = urlparse(endpoint).netloc
    return {
        "path": str(output),
        "url": artifact_url(output),
        "mimeType": mime_type,
        "bytes": len(raw),
        "provider": provider,
        "model": clean_model,
        "size": clean_size,
        "quality": clean_quality,
        "inputImageCount": len(images),
        "responseFormat": response_format,
        "elapsedSeconds": round(perf_counter() - call_started, 2),
    }
