from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from app.config import settings
import app.processors.floorplan_vision as floorplan_vision
from app.processors.common import ProcessorError
from app.processors.floorplan_vision import (
    VISION_CONFIG_INVALID,
    VISION_PROVIDER_REJECTED,
    VISION_RESPONSE_INVALID,
    VISION_RESPONSE_SCHEMA,
    VISION_TIMEOUT,
    compile_vision_semantic_layout,
    recognize_floorplan,
)


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"test-floorplan-image"
API_KEY = "test-secret-key"


def _recognition() -> dict[str, Any]:
    return {
        "schemaVersion": "q10000-v1",
        "drawingBounds": {"xQ": 1000, "yQ": 2000, "widthQ": 8000, "depthQ": 6000},
        "physicalPlan": {
            "widthMm": 8000,
            "depthMm": 6000,
            "source": "dimension_labels",
            "confidence": 0.93,
            "evidence": ["outer width 8.0m", "outer depth 6.0m"],
        },
        "rooms": [
            {
                "id": "room_living",
                "type": "living_room",
                "name": "客厅",
                "polygon": [
                    {"xQ": 1000, "yQ": 2000},
                    {"xQ": 9000, "yQ": 2000},
                    {"xQ": 9000, "yQ": 8000},
                    {"xQ": 1000, "yQ": 8000},
                ],
                "confidence": 0.96,
            }
        ],
        "walls": [
            {
                "id": "wall_top",
                "kind": "exterior",
                "axis": "horizontal",
                "segment": {
                    "start": {"xQ": 1000, "yQ": 2000},
                    "end": {"xQ": 9000, "yQ": 2000},
                },
                "thicknessQ": 100,
                "confidence": 0.97,
            },
            {
                "id": "wall_right",
                "kind": "exterior",
                "axis": "vertical",
                "segment": {
                    "start": {"xQ": 9000, "yQ": 2000},
                    "end": {"xQ": 9000, "yQ": 8000},
                },
                "thicknessQ": 100,
                "confidence": 0.97,
            },
            {
                "id": "wall_bottom",
                "kind": "exterior",
                "axis": "horizontal",
                "segment": {
                    "start": {"xQ": 9000, "yQ": 8000},
                    "end": {"xQ": 1000, "yQ": 8000},
                },
                "thicknessQ": 100,
                "confidence": 0.97,
            },
            {
                "id": "wall_left",
                "kind": "exterior",
                "axis": "vertical",
                "segment": {
                    "start": {"xQ": 1000, "yQ": 8000},
                    "end": {"xQ": 1000, "yQ": 2000},
                },
                "thicknessQ": 100,
                "confidence": 0.97,
            },
        ],
        "openings": [
            {
                "id": "door_entry",
                "type": "door",
                "wallAxis": "horizontal",
                "segment": {
                    "start": {"xQ": 4500, "yQ": 8000},
                    "end": {"xQ": 5500, "yQ": 8000},
                },
                "roomIds": ["room_living"],
                "confidence": 0.9,
            }
        ],
        "furniture": [
            {
                "id": "sofa_main",
                "type": "sofa",
                "center": {"xQ": 3000, "yQ": 4500},
                "size": {"widthQ": 2000, "depthQ": 1000},
                "rotationDeg": 90,
                "roomId": "room_living",
                "confidence": 0.92,
            }
        ],
        "confidence": 0.94,
        "warnings": ["尺寸文字较小"],
    }


def _client_returning(recognition: dict[str, Any]) -> tuple[httpx.Client, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(recognition)}}]},
        )

    return httpx.Client(transport=httpx.MockTransport(handler)), requests


def test_posts_multimodal_data_url_with_strict_json_schema() -> None:
    client, requests = _client_returning(_recognition())
    try:
        result = recognize_floorplan(
            PNG_BYTES,
            plan_width_mm=8000,
            plan_depth_mm=6000,
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1/",
            model="gpt-4.1-mini",
            timeout_seconds=30,
            http_client=client,
        )
    finally:
        client.close()

    assert len(requests) == 1
    request = requests[0]
    assert request.method == "POST"
    assert str(request.url) == "https://www.kuyaoapi.com/v1/chat/completions"
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    payload = json.loads(request.content)
    assert payload["model"] == "gpt-4.1-mini"
    image_url = payload["messages"][1]["content"][1]["image_url"]["url"]
    assert image_url.startswith("data:image/png;base64,")
    response_format = payload["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["strict"] is True
    assert response_format["json_schema"]["schema"] == VISION_RESPONSE_SCHEMA

    assert result["provider"] == "kuyao"
    assert result["model"] == "gpt-4.1-mini"
    assert result["confidence"] == 0.94
    assert result["drawing_bounds"] == {
        "coordinateSpace": "full_image_q10000",
        "xQ": 1000,
        "yQ": 2000,
        "widthQ": 8000,
        "depthQ": 6000,
    }
    serialized_result = json.dumps(result, ensure_ascii=False)
    assert API_KEY not in serialized_result
    assert "data:image" not in serialized_result


def test_q10000_geometry_compiles_to_caller_dimensions() -> None:
    layout = compile_vision_semantic_layout(
        _recognition(),
        plan_width_mm=8000,
        plan_depth_mm=6000,
        source_sha256="abc123",
    )

    assert layout["version"] == "0.5"
    assert layout["profileId"] == "vision_abc123"
    assert layout["plan"] == {
        "widthMm": 8000,
        "depthMm": 6000,
        "ceilingHeightMm": 2800,
        "scaleStatus": "user_confirmed",
        "scaleConfidence": 1.0,
    }
    assert layout["rooms"][0]["rect"] == {
        "xMm": 0,
        "yMm": 0,
        "widthMm": 8000,
        "depthMm": 6000,
    }
    assert layout["openings"][0]["widthMm"] == 1000
    assert layout["furniture"][0]["center"] == {"xMm": 2000, "yMm": 2500}
    assert layout["furniture"][0]["size"] == {
        "widthMm": 2000,
        "depthMm": 1000,
        "heightMm": 850,
    }


def test_missing_caller_dimensions_are_read_from_plan_annotations() -> None:
    client, requests = _client_returning(_recognition())
    try:
        result = recognize_floorplan(
            PNG_BYTES,
            plan_width_mm=None,
            plan_depth_mm=None,
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1",
            model="gpt-5.6-sol",
            timeout_seconds=30,
            http_client=client,
        )
    finally:
        client.close()

    plan = result["semantic_layout"]["plan"]
    assert plan == {
        "widthMm": 8000,
        "depthMm": 6000,
        "ceilingHeightMm": 2800,
        "scaleStatus": "vision_estimated",
        "scaleConfidence": 0.93,
    }
    assert result["dimension_source"] == "dimension_labels"
    assert result["dimension_confidence"] == 0.93
    assert result["dimension_evidence"] == ["outer width 8.0m", "outer depth 6.0m"]
    payload = json.loads(requests[0].content)
    prompt = payload["messages"][1]["content"][0]["text"]
    assert "No physical dimensions were supplied" in prompt
    assert any("视觉模型" in warning for warning in result["warnings"])


def test_unreadable_missing_dimensions_request_manual_input() -> None:
    recognition = _recognition()
    recognition["physicalPlan"] = {
        "widthMm": 0,
        "depthMm": 0,
        "source": "unavailable",
        "confidence": 0,
        "evidence": [],
    }
    client, _requests = _client_returning(recognition)
    try:
        with pytest.raises(ProcessorError) as error:
            recognize_floorplan(
                PNG_BYTES,
                plan_width_mm=None,
                plan_depth_mm=None,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                model="gpt-5.6-sol",
                timeout_seconds=30,
                http_client=client,
            )
    finally:
        client.close()

    assert error.value.code == "VISION_INPUT_REJECTED"
    assert "手动填写" in error.value.message


def test_dimensionless_plan_uses_low_confidence_door_scale_estimate() -> None:
    recognition = _recognition()
    recognition["physicalPlan"] = {
        "widthMm": 0,
        "depthMm": 0,
        "source": "unavailable",
        "confidence": 0,
        "evidence": [],
    }
    client, _requests = _client_returning(recognition)
    try:
        result = recognize_floorplan(
            PNG_BYTES,
            plan_width_mm=None,
            plan_depth_mm=None,
            source_image_width=1000,
            source_image_height=1000,
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1",
            model="gpt-5.6-sol",
            timeout_seconds=30,
            http_client=client,
        )
    finally:
        client.close()

    assert result["semantic_layout"]["plan"] == {
        "widthMm": 7200,
        "depthMm": 5400,
        "ceilingHeightMm": 2800,
        "scaleStatus": "vision_estimated",
        "scaleConfidence": 0.445,
    }
    assert result["dimension_source"] == "object_scale_estimate"
    assert result["dimension_confidence"] == 0.445
    assert "标准门洞" in result["dimension_evidence"][0]
    assert any("原图没有" in warning for warning in result["warnings"])


def test_zero_length_wall_candidate_is_discarded_without_losing_layout() -> None:
    recognition = _recognition()
    recognition["walls"].append(
        {
            "id": "wall_zero_length",
            "kind": "interior",
            "axis": "horizontal",
            "segment": {
                "start": {"xQ": 5000, "yQ": 5000},
                "end": {"xQ": 5000, "yQ": 5000},
            },
            "thicknessQ": 100,
            "confidence": 0.4,
        }
    )
    client, _requests = _client_returning(recognition)
    try:
        result = recognize_floorplan(
            PNG_BYTES,
            plan_width_mm=8000,
            plan_depth_mm=6000,
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1",
            model="gpt-5.6-sol",
            timeout_seconds=30,
            http_client=client,
        )
    finally:
        client.close()

    assert len(result["semantic_layout"]["walls"]) == 4
    assert any("wall_zero_length" in warning for warning in result["warnings"])


def test_successful_recognition_is_reused_from_content_cache(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(settings, "floorplan_vision_cache_dir", tmp_path)
    response = httpx.Response(
        200,
        json={"choices": [{"message": {"content": json.dumps(_recognition())}}]},
    )
    calls = 0

    def fake_post(**_kwargs):
        nonlocal calls
        calls += 1
        return response

    monkeypatch.setattr(floorplan_vision, "_post_chat_completion", fake_post)
    first = recognize_floorplan(
        PNG_BYTES,
        plan_width_mm=8000,
        plan_depth_mm=6000,
        api_key=API_KEY,
        base_url="https://www.kuyaoapi.com/v1",
        model="gpt-5.6-sol",
        timeout_seconds=30,
    )
    second = recognize_floorplan(
        PNG_BYTES,
        plan_width_mm=8000,
        plan_depth_mm=6000,
        api_key=API_KEY,
        base_url="https://www.kuyaoapi.com/v1",
        model="gpt-5.6-sol",
        timeout_seconds=30,
    )

    assert calls == 1
    assert first["cache_hit"] is False
    assert second["cache_hit"] is True
    assert second["semantic_layout"] == first["semantic_layout"]


def test_json_schema_forbids_extra_properties_for_every_object() -> None:
    assert VISION_RESPONSE_SCHEMA["additionalProperties"] is False
    assert set(VISION_RESPONSE_SCHEMA["required"]) == set(VISION_RESPONSE_SCHEMA["properties"])
    for definition in VISION_RESPONSE_SCHEMA["$defs"].values():
        if definition.get("type") != "object":
            continue
        assert definition["additionalProperties"] is False
        assert set(definition["required"]) == set(definition["properties"])


def test_image_generation_model_is_rejected_before_http_call() -> None:
    called = False

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            recognize_floorplan(
                PNG_BYTES,
                plan_width_mm=8000,
                plan_depth_mm=6000,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                model="gpt-image-2",
                timeout_seconds=30,
                http_client=client,
            )
    finally:
        client.close()

    assert error.value.code == VISION_CONFIG_INVALID
    assert called is False


def test_timeout_maps_to_stable_error_without_secret() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("secret transport details", request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProcessorError) as error:
            recognize_floorplan(
                PNG_BYTES,
                plan_width_mm=8000,
                plan_depth_mm=6000,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                model="gpt-4.1-mini",
                timeout_seconds=0.01,
                http_client=client,
            )
    finally:
        client.close()

    assert error.value.code == VISION_TIMEOUT
    assert API_KEY not in error.value.message
    assert "base64" not in error.value.message
    assert error.value.__cause__ is None


@pytest.mark.parametrize(
    ("response", "expected_code"),
    [
        (httpx.Response(401, json={"error": {"message": API_KEY}}), VISION_PROVIDER_REJECTED),
        (
            httpx.Response(200, json={"choices": [{"message": {"content": "not-json"}}]}),
            VISION_RESPONSE_INVALID,
        ),
    ],
)
def test_provider_errors_are_sanitized(
    response: httpx.Response,
    expected_code: str,
) -> None:
    client = httpx.Client(transport=httpx.MockTransport(lambda _request: response))
    try:
        with pytest.raises(ProcessorError) as error:
            recognize_floorplan(
                PNG_BYTES,
                plan_width_mm=8000,
                plan_depth_mm=6000,
                api_key=API_KEY,
                base_url="https://www.kuyaoapi.com/v1",
                model="gpt-4.1-mini",
                timeout_seconds=30,
                http_client=client,
            )
    finally:
        client.close()

    assert error.value.code == expected_code
    assert API_KEY not in error.value.message


def test_axis_mismatch_is_rejected() -> None:
    recognition = _recognition()
    recognition["walls"][0]["segment"]["end"]["yQ"] = 2500

    with pytest.raises(ProcessorError) as error:
        compile_vision_semantic_layout(
            recognition,
            plan_width_mm=8000,
            plan_depth_mm=6000,
        )

    assert error.value.code == VISION_RESPONSE_INVALID


def test_one_non_orthogonal_candidate_is_discarded_without_losing_draft() -> None:
    recognition = _recognition()
    recognition["walls"].append(
        {
            "id": "wall_false_door_leaf",
            "kind": "interior",
            "axis": "vertical",
            "segment": {
                "start": {"xQ": 3000, "yQ": 3000},
                "end": {"xQ": 3620, "yQ": 5000},
            },
            "thicknessQ": 80,
            "confidence": 0.74,
        }
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(recognition)}}]},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        result = recognize_floorplan(
            PNG_BYTES,
            plan_width_mm=8000,
            plan_depth_mm=6000,
            api_key=API_KEY,
            base_url="https://www.kuyaoapi.com/v1",
            model="gpt-5.4",
            timeout_seconds=30,
            http_client=client,
        )
    finally:
        client.close()

    assert len(result["semantic_layout"]["walls"]) == 4
    assert any("wall_false_door_leaf" in warning for warning in result["warnings"])


def test_small_axis_noise_is_snapped_before_mm_compilation() -> None:
    recognition = _recognition()
    recognition["walls"][0]["segment"]["end"]["yQ"] = 2020

    layout = compile_vision_semantic_layout(
        recognition,
        plan_width_mm=8000,
        plan_depth_mm=6000,
    )

    wall = layout["walls"][0]
    assert wall["start"]["yMm"] == wall["end"]["yMm"] == 10


def test_long_wall_uses_relative_axis_snap_tolerance() -> None:
    recognition = _recognition()
    recognition["walls"][0]["segment"]["end"]["yQ"] = 2120

    layout = compile_vision_semantic_layout(
        recognition,
        plan_width_mm=8000,
        plan_depth_mm=6000,
    )

    wall = layout["walls"][0]
    assert wall["start"]["yMm"] == wall["end"]["yMm"] == 60


@pytest.mark.parametrize("entity", ["wall", "room"])
def test_geometry_degenerate_after_drawing_bounds_clip_is_rejected(entity: str) -> None:
    recognition = _recognition()
    if entity == "wall":
        recognition["walls"][0]["segment"] = {
            "start": {"xQ": 0, "yQ": 2000},
            "end": {"xQ": 500, "yQ": 2000},
        }
    else:
        recognition["rooms"][0]["polygon"] = [
            {"xQ": 0, "yQ": 2000},
            {"xQ": 500, "yQ": 4000},
            {"xQ": 0, "yQ": 8000},
        ]

    with pytest.raises(ProcessorError) as error:
        compile_vision_semantic_layout(
            recognition,
            plan_width_mm=8000,
            plan_depth_mm=6000,
        )

    assert error.value.code == VISION_RESPONSE_INVALID


def test_opening_degenerate_after_drawing_bounds_clip_is_ignored() -> None:
    recognition = _recognition()
    recognition["openings"][0]["segment"] = {
        "start": {"xQ": 0, "yQ": 8000},
        "end": {"xQ": 500, "yQ": 8000},
    }

    layout = compile_vision_semantic_layout(
        recognition,
        plan_width_mm=8000,
        plan_depth_mm=6000,
    )

    assert layout["openings"] == []
