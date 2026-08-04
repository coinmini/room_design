from __future__ import annotations

import base64
import json
from pathlib import Path

import httpx
import pytest

from app.processors.common import ProcessorError
from app.processors.kuyao_image_edit import (
    KUYAO_IMAGE_DOWNLOAD_REJECTED,
    KUYAO_IMAGE_PROVIDER_REJECTED,
    KUYAO_IMAGE_RESPONSE_INVALID,
    KUYAO_IMAGE_TIMEOUT,
    edit_floorplan_image,
)


API_KEY = "sk-secret-must-not-leak"
PNG_BYTES = b"\x89PNG\r\n\x1a\nmock-png-payload"
JPEG_BYTES = b"\xff\xd8\xffmock-jpeg-payload"


def _public_resolver(_host: str, _port: int) -> list[str]:
    return ["93.184.216.34"]


def _image(path: Path, raw: bytes = PNG_BYTES) -> Path:
    path.write_bytes(raw)
    return path


def test_single_image_uses_image_field_and_writes_b64_artifact(tmp_path: Path) -> None:
    source = _image(tmp_path / "base.png")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(PNG_BYTES).decode("ascii")}]},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        result = edit_floorplan_image(
            source,
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1/",
            model="gpt-image-2",
            size="1536x1024",
            quality="high",
            prompt="保持户型结构，生成写实室内效果图",
            timeout_seconds=30,
            http_client=client,
        )
    finally:
        client.close()

    assert len(requests) == 1
    request = requests[0]
    assert request.method == "POST"
    assert str(request.url) == "https://www.kuyaoapi.com/v1/images/edits"
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert request.headers["Content-Type"].startswith("multipart/form-data; boundary=")
    body = request.content
    assert b'name="image"' in body
    assert b'name="image[]"' not in body
    assert b'name="model"' in body and b"gpt-image-2" in body
    assert b'name="quality"' in body and b"high" in body
    assert b'name="n"' in body
    assert b'name="seed"' not in body

    output = Path(result["path"])
    assert output.read_bytes() == PNG_BYTES
    assert result["url"].startswith("/artifacts/floorplan-kuyao-final-")
    assert result["mimeType"] == "image/png"
    assert result["responseFormat"] == "b64_json"
    assert result["inputImageCount"] == 1
    serialized = json.dumps(result, ensure_ascii=False)
    assert API_KEY not in serialized
    assert "b64_json" not in serialized or result["responseFormat"] == "b64_json"
    assert base64.b64encode(PNG_BYTES).decode("ascii") not in serialized


def test_multiple_images_repeat_image_array_field(tmp_path: Path) -> None:
    source = _image(tmp_path / "base.png")
    reference_one = _image(tmp_path / "style.jpg", JPEG_BYTES)
    reference_two = _image(tmp_path / "layout.png")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(PNG_BYTES).decode("ascii")}]},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        result = edit_floorplan_image(
            source,
            reference_paths=[reference_one, reference_two],
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1",
            prompt="增强",
            http_client=client,
        )
    finally:
        client.close()

    body = requests[0].content
    assert body.count(b'name="image[]"') == 3
    assert b'name="image"' not in body
    assert b'filename="base.png"' in body
    assert b'filename="style.jpg"' in body
    assert b'filename="layout.png"' in body
    assert result["inputImageCount"] == 3


def test_url_result_is_streamed_with_type_and_size_checks(tmp_path: Path) -> None:
    source = _image(tmp_path / "base.png")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={"data": [{"url": "https://cdn.example/final.jpg"}]})
        return httpx.Response(
            200,
            headers={"Content-Type": "image/jpeg", "Content-Length": str(len(JPEG_BYTES))},
            content=JPEG_BYTES,
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        result = edit_floorplan_image(
            source,
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1/images/edits",
            prompt="增强",
            timeout_seconds=12,
            http_client=client,
            host_resolver=_public_resolver,
        )
    finally:
        client.close()

    assert [request.method for request in requests] == ["POST", "GET"]
    assert "Authorization" not in requests[1].headers
    assert Path(result["path"]).read_bytes() == JPEG_BYTES
    assert Path(result["path"]).suffix == ".jpg"
    assert result["responseFormat"] == "url"
    assert "cdn.example" not in json.dumps(result)


@pytest.mark.parametrize(
    ("headers", "body"),
    [
        ({"Content-Type": "text/html"}, PNG_BYTES),
        ({"Content-Type": "image/jpeg"}, PNG_BYTES),
    ],
)
def test_url_download_rejects_wrong_content(
    tmp_path: Path,
    headers: dict[str, str],
    body: bytes,
) -> None:
    source = _image(tmp_path / "base.png")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"data": [{"url": "https://cdn.example/final"}]})
        return httpx.Response(200, headers=headers, content=body)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
                host_resolver=_public_resolver,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_DOWNLOAD_REJECTED


def test_url_download_enforces_streamed_byte_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _image(tmp_path / "base.png")
    monkeypatch.setattr("app.processors.kuyao_image_edit.MAX_OUTPUT_IMAGE_BYTES", 10)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"data": [{"url": "https://cdn.example/final"}]})
        return httpx.Response(200, headers={"Content-Type": "image/png"}, content=PNG_BYTES)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
                host_resolver=_public_resolver,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_DOWNLOAD_REJECTED


def test_post_response_content_length_is_rejected_before_json_decode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _image(tmp_path / "base.png")
    monkeypatch.setattr("app.processors.kuyao_image_edit.MAX_EDIT_RESPONSE_BYTES", 8)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                headers={"Content-Length": "999"},
                content=b"not-json",
            )
        )
    )
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_RESPONSE_INVALID
    assert error.value.__cause__ is None


def test_base64_encoded_length_is_rejected_before_decode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _image(tmp_path / "base.png")
    encoded = base64.b64encode(PNG_BYTES).decode("ascii")
    monkeypatch.setattr("app.processors.kuyao_image_edit.MAX_BASE64_IMAGE_CHARS", 8)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"data": [{"b64_json": encoded}]})
        )
    )
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_RESPONSE_INVALID


@pytest.mark.parametrize(
    "unsafe_url",
    [
        "http://localhost/image.png",
        "http://127.0.0.1/image.png",
        "http://10.0.0.8/image.png",
        "http://169.254.169.254/latest/meta-data",
        "http://224.0.0.1/image.png",
        "http://0.0.0.0/image.png",
        "http://[::1]/image.png",
        "http://[fc00::1]/image.png",
        "http://[fe80::1]/image.png",
    ],
)
def test_url_download_rejects_non_public_literal_before_get(
    tmp_path: Path,
    unsafe_url: str,
) -> None:
    source = _image(tmp_path / "base.png")
    methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        return httpx.Response(200, json={"data": [{"url": unsafe_url}]})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
                host_resolver=_public_resolver,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_DOWNLOAD_REJECTED
    assert methods == ["POST"]


def test_url_download_rejects_hostname_resolving_private(tmp_path: Path) -> None:
    source = _image(tmp_path / "base.png")
    methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        return httpx.Response(200, json={"data": [{"url": "https://cdn.example/final.png"}]})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
                host_resolver=lambda _host, _port: ["192.168.1.20"],
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_DOWNLOAD_REJECTED
    assert methods == ["POST"]


def test_url_download_rejects_malformed_url_without_get(tmp_path: Path) -> None:
    source = _image(tmp_path / "base.png")
    methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        return httpx.Response(200, json={"data": [{"url": "http://[::1"}]})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
                host_resolver=_public_resolver,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_RESPONSE_INVALID
    assert methods == ["POST"]


def test_redirect_target_is_revalidated_before_following(tmp_path: Path) -> None:
    source = _image(tmp_path / "base.png")
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        if request.method == "POST":
            return httpx.Response(200, json={"data": [{"url": "https://cdn.example/start"}]})
        return httpx.Response(302, headers={"Location": "http://127.0.0.1/private.png"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
                host_resolver=_public_resolver,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_DOWNLOAD_REJECTED
    assert urls == [
        "https://www.kuyaoapi.com/v1/images/edits",
        "https://cdn.example/start",
    ]


def test_timeout_and_provider_error_do_not_leak_secret(tmp_path: Path) -> None:
    source = _image(tmp_path / "base.png")

    def timeout_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout(f"transport included {API_KEY}", request=request)

    timeout_client = httpx.Client(transport=httpx.MockTransport(timeout_handler))
    try:
        with pytest.raises(ProcessorError) as timeout_error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                timeout_seconds=0.01,
                http_client=timeout_client,
            )
    finally:
        timeout_client.close()

    assert timeout_error.value.code == KUYAO_IMAGE_TIMEOUT
    assert API_KEY not in timeout_error.value.message
    assert timeout_error.value.__cause__ is None

    rejected_client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(401, json={"error": {"message": API_KEY}})
        )
    )
    try:
        with pytest.raises(ProcessorError) as rejected_error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=rejected_client,
            )
    finally:
        rejected_client.close()

    assert rejected_error.value.code == KUYAO_IMAGE_PROVIDER_REJECTED
    assert API_KEY not in rejected_error.value.message


@pytest.mark.parametrize(
    "response_json",
    [
        {},
        {"data": []},
        {"data": [{}]},
        {"data": [{"b64_json": "not-base64"}]},
    ],
)
def test_invalid_provider_payload_is_rejected(tmp_path: Path, response_json: dict) -> None:
    source = _image(tmp_path / "base.png")
    client = httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=response_json))
    )
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_RESPONSE_INVALID


def test_invalid_json_does_not_survive_in_exception_chain(tmp_path: Path) -> None:
    source = _image(tmp_path / "base.png")
    sensitive_body = f'{API_KEY}:' + base64.b64encode(PNG_BYTES).decode("ascii")
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                headers={"Content-Type": "application/json"},
                content=sensitive_body,
            )
        )
    )
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_RESPONSE_INVALID
    assert API_KEY not in str(error.value)
    assert error.value.__cause__ is None


def test_provider_error_keeps_whitelisted_detail_without_leaking_secret(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.processors.kuyao_image_edit._retry_delay_seconds",
        lambda *_args, **_kwargs: 0,
    )
    source = _image(tmp_path / "base.png")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            400,
            json={
                "error": {
                    "code": "content_policy_violation",
                    "type": "invalid_request_error",
                    "message": "prompt blocked by policy",
                    "echoed_secret": API_KEY,
                }
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
            )
    finally:
        client.close()

    assert error.value.code == KUYAO_IMAGE_PROVIDER_REJECTED
    message = str(error.value)
    assert "HTTP 400" in message
    assert "content_policy_violation" in message
    assert "prompt blocked by policy" in message
    assert API_KEY not in message
    # 400 is permanent: no retry.
    assert len(requests) == 1


def test_transient_502_is_retried_and_eventually_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.processors.kuyao_image_edit._retry_delay_seconds",
        lambda *_args, **_kwargs: 0,
    )
    source = _image(tmp_path / "base.png")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) < 3:
            return httpx.Response(502, json={"error": {"message": "bad gateway"}})
        return httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(PNG_BYTES).decode("ascii")}]},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        result = edit_floorplan_image(
            source,
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1",
            prompt="增强",
            http_client=client,
        )
    finally:
        client.close()

    assert len(requests) == 3
    assert Path(result["path"]).read_bytes() == PNG_BYTES


def test_429_retries_are_bounded_and_honor_retry_after(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delays: list[float] = []

    def fake_delay(response: httpx.Response | None, attempt: int) -> float:
        assert response is not None
        assert response.headers.get("Retry-After") == "7"
        delays.append(attempt)
        return 0

    monkeypatch.setattr(
        "app.processors.kuyao_image_edit._retry_delay_seconds", fake_delay
    )
    source = _image(tmp_path / "base.png")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            429,
            headers={"Retry-After": "7"},
            json={"error": {"code": "rate_limit", "message": "slow down"}},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
            )
    finally:
        client.close()

    # 1 initial attempt + 2 bounded retries, then the detail surfaces.
    assert len(requests) == 3
    assert delays == [0, 1]
    assert error.value.code == KUYAO_IMAGE_PROVIDER_REJECTED
    assert "rate_limit" in str(error.value)


def test_connect_error_is_retried_but_read_timeout_is_not(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.processors.kuyao_image_edit._retry_delay_seconds",
        lambda *_args, **_kwargs: 0,
    )
    source = _image(tmp_path / "base.png")
    requests: list[httpx.Request] = []

    def connect_then_ok(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(PNG_BYTES).decode("ascii")}]},
        )

    client = httpx.Client(transport=httpx.MockTransport(connect_then_ok))
    try:
        result = edit_floorplan_image(
            source,
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1",
            prompt="增强",
            http_client=client,
        )
    finally:
        client.close()
    assert len(requests) == 2
    assert Path(result["path"]).read_bytes() == PNG_BYTES

    def read_timeout(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise httpx.ReadTimeout("still generating", request=request)

    requests.clear()
    client = httpx.Client(transport=httpx.MockTransport(read_timeout))
    try:
        with pytest.raises(ProcessorError) as error:
            edit_floorplan_image(
                source,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                prompt="增强",
                http_client=client,
            )
    finally:
        client.close()
    # Read timeouts mean the provider is already generating: never retried.
    assert len(requests) == 1
    assert error.value.code == KUYAO_IMAGE_TIMEOUT
