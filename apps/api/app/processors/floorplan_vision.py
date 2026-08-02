from __future__ import annotations

import base64
import hashlib
import json
import math
import statistics
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal, TypeAlias
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.config import settings
from app.processors.common import ProcessorError


VisionSource: TypeAlias = str | Path | bytes | bytearray | memoryview

VISION_INPUT_REJECTED = "VISION_INPUT_REJECTED"
VISION_CONFIG_INVALID = "VISION_CONFIG_INVALID"
VISION_TIMEOUT = "VISION_TIMEOUT"
VISION_PROVIDER_UNAVAILABLE = "VISION_PROVIDER_UNAVAILABLE"
VISION_PROVIDER_REJECTED = "VISION_PROVIDER_REJECTED"
VISION_RESPONSE_INVALID = "VISION_RESPONSE_INVALID"

MAX_IMAGE_BYTES = 20 * 1024 * 1024
DEFAULT_CEILING_HEIGHT_MM = 2800
AXIS_SNAP_MIN_TOLERANCE_Q = 50
AXIS_SNAP_MAX_TOLERANCE_Q = 150
AXIS_SNAP_RELATIVE_TOLERANCE = 0.08
VISION_PROMPT_VERSION = "floorplan-q10000-v3-object-scale"

RoomType = Literal[
    "living_room",
    "dining_room",
    "living_dining",
    "bedroom",
    "kitchen",
    "bathroom",
    "balcony",
    "entrance",
    "corridor",
    "study",
    "laundry",
    "storage",
    "closet",
    "other",
]
FurnitureType = Literal[
    "bed",
    "nightstand",
    "wardrobe",
    "desk",
    "chair",
    "sofa",
    "sectional_sofa",
    "coffee_table",
    "tv_console",
    "dining_table",
    "dining_chair",
    "kitchen_cabinet",
    "sink_cabinet",
    "cooktop_cabinet",
    "refrigerator",
    "bathtub",
    "shower",
    "toilet",
    "vanity",
    "washing_machine",
    "shelf",
    "other",
]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class _QPoint(_StrictModel):
    x_q: int = Field(alias="xQ", ge=0, le=10_000)
    y_q: int = Field(alias="yQ", ge=0, le=10_000)


class _DrawingBounds(_StrictModel):
    x_q: int = Field(alias="xQ", ge=0, le=9_999)
    y_q: int = Field(alias="yQ", ge=0, le=9_999)
    width_q: int = Field(alias="widthQ", ge=1, le=10_000)
    depth_q: int = Field(alias="depthQ", ge=1, le=10_000)

    @field_validator("width_q")
    @classmethod
    def _width_fits_canvas(cls, value: int, info: Any) -> int:
        x_q = info.data.get("x_q")
        if isinstance(x_q, int) and x_q + value > 10_000:
            raise ValueError("drawing bounds exceed the q10000 canvas")
        return value

    @field_validator("depth_q")
    @classmethod
    def _depth_fits_canvas(cls, value: int, info: Any) -> int:
        y_q = info.data.get("y_q")
        if isinstance(y_q, int) and y_q + value > 10_000:
            raise ValueError("drawing bounds exceed the q10000 canvas")
        return value


class _QSegment(_StrictModel):
    start: _QPoint
    end: _QPoint


class _VisionRoom(_StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-z][a-z0-9_]*$")
    type: RoomType
    name: str = Field(min_length=1, max_length=80)
    polygon: list[_QPoint] = Field(min_length=3, max_length=32)
    confidence: float = Field(ge=0, le=1)


class _VisionWall(_StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-z][a-z0-9_]*$")
    kind: Literal["exterior", "interior"]
    axis: Literal["horizontal", "vertical"]
    segment: _QSegment
    thickness_q: int = Field(alias="thicknessQ", ge=1, le=1_500)
    confidence: float = Field(ge=0, le=1)


class _VisionOpening(_StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-z][a-z0-9_]*$")
    type: Literal["door", "window"]
    wall_axis: Literal["horizontal", "vertical"] = Field(alias="wallAxis")
    segment: _QSegment
    room_ids: list[str] = Field(alias="roomIds", min_length=1, max_length=4)
    confidence: float = Field(ge=0, le=1)


class _FurnitureSizeQ(_StrictModel):
    width_q: int = Field(alias="widthQ", ge=1, le=10_000)
    depth_q: int = Field(alias="depthQ", ge=1, le=10_000)


class _VisionFurniture(_StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-z][a-z0-9_]*$")
    type: FurnitureType
    center: _QPoint
    size: _FurnitureSizeQ
    rotation_deg: float = Field(alias="rotationDeg", ge=-360, le=360)
    room_id: str = Field(alias="roomId", min_length=1, max_length=80)
    confidence: float = Field(ge=0, le=1)


class _PhysicalPlan(_StrictModel):
    width_mm: int = Field(alias="widthMm", ge=0, le=30_000)
    depth_mm: int = Field(alias="depthMm", ge=0, le=30_000)
    source: Literal[
        "caller_supplied",
        "dimension_labels",
        "dimension_chain",
        "scale_bar",
        "object_scale_estimate",
        "mixed",
        "unavailable",
    ]
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = Field(max_length=12)


class _VisionRecognition(_StrictModel):
    schema_version: Literal["q10000-v1"] = Field(alias="schemaVersion")
    drawing_bounds: _DrawingBounds = Field(alias="drawingBounds")
    physical_plan: _PhysicalPlan = Field(alias="physicalPlan")
    rooms: list[_VisionRoom] = Field(min_length=1, max_length=80)
    walls: list[_VisionWall] = Field(min_length=4, max_length=500)
    openings: list[_VisionOpening] = Field(max_length=200)
    furniture: list[_VisionFurniture] = Field(max_length=500)
    confidence: float = Field(ge=0, le=1)
    warnings: list[str] = Field(max_length=30)


# This schema is sent verbatim as Chat Completions Structured Outputs. Every object
# forbids unknown keys and every field is required by the Pydantic models above.
VISION_RESPONSE_SCHEMA: dict[str, Any] = _VisionRecognition.model_json_schema(by_alias=True)


_SYSTEM_PROMPT = """You are an architectural floor-plan interpreter, not an image generator.
Return only the JSON object required by the supplied JSON Schema.

Coordinate contract:
- The complete uploaded image is a q10000 canvas: top-left is (0,0), bottom-right is
  (10000,10000), x points right, and y points down.
- drawingBounds is the tight architectural-plan boundary in that same image canvas.
- Every room polygon, wall/opening segment, furniture center, thickness and footprint uses
  the same full-image q10000 coordinates; do not renormalize them to drawingBounds.

Recognition rules:
- Determine the complete physical plan width (horizontal drawingBounds direction) and depth
  (vertical drawingBounds direction) in millimetres. Prefer a clearly printed overall dimension.
  Otherwise sum one unambiguous collinear outer dimension chain or use a printed scale bar.
  Convert metres or centimetres to millimetres. If no dimension annotation exists, estimate scale
  conservatively from recognizable architectural objects (prefer a standard 800-900 mm door;
  then fixed-depth kitchen cabinets, beds, bathtubs or toilets). In that case use
  source='object_scale_estimate', confidence no greater than 0.55, name the scale anchors in
  evidence, and warn that the dimensions require human confirmation. Use widthMm=0, depthMm=0,
  source='unavailable' only when neither dimensions nor reliable scale anchors are visible.
- Ignore title blocks, dimensions, labels, furniture outlines and door swing arcs when tracing walls.
- Emit wall CENTERLINES, not both faces of a thick wall.
- Emit only horizontal or vertical walls in this MVP. For a horizontal segment,
  start.yQ MUST equal end.yQ exactly. For a vertical segment, start.xQ MUST equal
  end.xQ exactly. Never emit door leaves, swing arcs, furniture edges or dimension
  lines as walls. Omit an uncertain segment and describe it in warnings rather than
  returning diagonal coordinates under a horizontal/vertical label.
- Split wall segments at every door and window: no wall segment may cross an opening.
- Preserve every visible room, opening and furniture item. Never replace the plan with a template.
- Room, wall, opening and furniture ids must be unique lowercase ASCII snake_case.
- Use room type 'other' or furniture type 'other' rather than inventing enum values.
- Confidence is 0..1. Add concise warnings for occlusion, uncertain scale, diagonal geometry,
  unreadable symbols, or ambiguous topology. Do not hallucinate hidden objects.
"""

_USER_PROMPT = """Interpret this residential floor-plan image into rooms, split wall centerlines,
doors/windows, furniture anchors and its complete physical width/depth. Carefully preserve its
actual topology and relative spacing. {dimension_instruction}
"""

_FURNITURE_HEIGHT_MM: dict[str, int] = {
    "bed": 550,
    "nightstand": 500,
    "wardrobe": 2200,
    "desk": 750,
    "chair": 850,
    "sofa": 850,
    "sectional_sofa": 850,
    "coffee_table": 420,
    "tv_console": 620,
    "dining_table": 760,
    "dining_chair": 850,
    "kitchen_cabinet": 900,
    "sink_cabinet": 900,
    "cooktop_cabinet": 900,
    "refrigerator": 1900,
    "bathtub": 600,
    "shower": 2100,
    "toilet": 760,
    "vanity": 850,
    "washing_machine": 850,
    "shelf": 1800,
    "other": 800,
}


def _source_bytes(source: VisionSource) -> tuple[bytes, str]:
    if isinstance(source, bytes):
        raw = source
        suffix = ""
    elif isinstance(source, (bytearray, memoryview)):
        raw = bytes(source)
        suffix = ""
    else:
        path = Path(source)
        suffix = path.suffix.lower()
        try:
            raw = path.read_bytes()
        except (OSError, ValueError) as exc:
            raise ProcessorError(VISION_INPUT_REJECTED, "无法读取上传的平面图") from exc

    if not raw:
        raise ProcessorError(VISION_INPUT_REJECTED, "上传的平面图为空")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ProcessorError(VISION_INPUT_REJECTED, "上传的平面图超过 20 MB")

    mime_type = _detect_image_mime(raw, suffix)
    if mime_type is None:
        raise ProcessorError(VISION_INPUT_REJECTED, "视觉识别仅支持 JPEG、PNG 或 WebP 图片")
    return raw, mime_type


def _detect_image_mime(raw: bytes, suffix: str) -> str | None:
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(suffix)


def _vision_cache_path(
    *,
    source_sha256: str,
    model: str,
    plan_width_mm: int | None,
    plan_depth_mm: int | None,
) -> Path:
    cache_identity = json.dumps(
        {
            "sourceSha256": source_sha256,
            "model": model.strip().lower(),
            "promptVersion": VISION_PROMPT_VERSION,
            "planWidthMm": plan_width_mm,
            "planDepthMm": plan_depth_mm,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(cache_identity.encode("utf-8")).hexdigest()[:20]
    return settings.floorplan_vision_cache_dir / f"{source_sha256[:20]}-{digest}.json"


def _read_vision_cache(path: Path) -> dict[str, Any] | None:
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if (
            cached.get("cacheVersion") != 1
            or cached.get("promptVersion") != VISION_PROMPT_VERSION
            or not isinstance(cached.get("result"), dict)
        ):
            return None
        result = dict(cached["result"])
        if not isinstance(result.get("semantic_layout"), dict) or not isinstance(
            result.get("drawing_bounds"), dict
        ):
            return None
        result["cache_hit"] = True
        return result
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        return None


def _write_vision_cache(path: Path, result: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{uuid4().hex}.tmp")
    cache_result = {key: value for key, value in result.items() if key != "cache_hit"}
    payload = {
        "cacheVersion": 1,
        "promptVersion": VISION_PROMPT_VERSION,
        "result": cache_result,
    }
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(path)
    except OSError:
        temporary.unlink(missing_ok=True)


def _validate_provider_config(
    *,
    api_key: str,
    base_url: str,
    model: str,
    timeout_seconds: float,
) -> tuple[str, str, str]:
    if not api_key.strip():
        raise ProcessorError(VISION_CONFIG_INVALID, "未配置视觉识别 API Key")
    clean_model = model.strip()
    if not clean_model:
        raise ProcessorError(VISION_CONFIG_INVALID, "未配置视觉识别模型")
    lowered_model = clean_model.lower()
    if "gpt-image" in lowered_model or lowered_model.startswith("dall-e"):
        raise ProcessorError(
            VISION_CONFIG_INVALID,
            "图像生成模型不能用于户型语义识别，请配置支持视觉输入的聊天模型",
        )
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ProcessorError(VISION_CONFIG_INVALID, "视觉识别超时时间必须大于 0")

    clean_base_url = base_url.strip().rstrip("/")
    parsed = urlparse(clean_base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ProcessorError(VISION_CONFIG_INVALID, "视觉识别 API 地址无效")
    endpoint = f"{clean_base_url}/chat/completions"
    return clean_base_url, endpoint, clean_model


def _supplied_dimension(value: int | None, label: str) -> int | None:
    if value in (None, 0):
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 2_400 <= value <= 30_000:
        raise ProcessorError(
            VISION_INPUT_REJECTED,
            f"{label}必须是 2400–30000 mm，或留空由视觉模型识别",
        )
    return value


_FURNITURE_AREA_PRIORS_MM2: dict[str, int] = {
    "bed": 1_800 * 2_000,
    "nightstand": 500 * 450,
    "desk": 1_200 * 600,
    "chair": 500 * 500,
    "sofa": 2_200 * 900,
    "sectional_sofa": 2_800 * 1_800,
    "coffee_table": 1_200 * 600,
    "tv_console": 1_800 * 400,
    "dining_table": 1_600 * 850,
    "dining_chair": 500 * 500,
    "sink_cabinet": 800 * 600,
    "cooktop_cabinet": 750 * 600,
    "refrigerator": 700 * 700,
    "bathtub": 1_700 * 750,
    "shower": 900 * 900,
    "toilet": 700 * 400,
    "vanity": 900 * 500,
    "washing_machine": 600 * 600,
}


def _object_scale_estimate(
    recognition: _VisionRecognition,
    *,
    image_width: int | None,
    image_height: int | None,
) -> dict[str, Any] | None:
    """Estimate plan dimensions when an otherwise usable drawing has no scale labels.

    A raster plan without dimensions has no mathematically exact physical scale.  This
    fallback deliberately produces a low-confidence, human-reviewable estimate from
    standard-size architectural anchors instead of discarding all recognized geometry.
    """

    if (
        not isinstance(image_width, int)
        or not isinstance(image_height, int)
        or image_width <= 0
        or image_height <= 0
    ):
        return None

    door_scales: list[float] = []
    for opening in recognition.openings:
        if opening.type != "door" or opening.confidence < 0.55:
            continue
        if opening.wall_axis == "horizontal":
            span_px = (
                abs(opening.segment.end.x_q - opening.segment.start.x_q)
                / 10_000
                * image_width
            )
        else:
            span_px = (
                abs(opening.segment.end.y_q - opening.segment.start.y_q)
                / 10_000
                * image_height
            )
        if span_px >= 4:
            scale = 900 / span_px
            if 1 <= scale <= 100:
                door_scales.append(scale)

    furniture_scales: list[float] = []
    for item in recognition.furniture:
        area_prior = _FURNITURE_AREA_PRIORS_MM2.get(item.type)
        if area_prior is None or item.confidence < 0.65:
            continue
        width_px = item.size.width_q / 10_000 * image_width
        depth_px = item.size.depth_q / 10_000 * image_height
        footprint_px = width_px * depth_px
        if footprint_px < 16:
            continue
        scale = math.sqrt(area_prior / footprint_px)
        if 1 <= scale <= 100:
            furniture_scales.append(scale)

    # Door openings are the strongest repeatable scale anchor.  Furniture-area
    # priors are used only when the recognizer found no reliable door geometry.
    candidates = door_scales or furniture_scales
    if not candidates:
        return None
    millimetres_per_pixel = statistics.median(candidates)
    bounds = recognition.drawing_bounds
    drawing_width_px = bounds.width_q / 10_000 * image_width
    drawing_depth_px = bounds.depth_q / 10_000 * image_height

    def rounded_dimension(value: float) -> int:
        return int(round(value / 50) * 50)

    width_mm = rounded_dimension(drawing_width_px * millimetres_per_pixel)
    depth_mm = rounded_dimension(drawing_depth_px * millimetres_per_pixel)
    if not 2_400 <= width_mm <= 30_000 or not 2_400 <= depth_mm <= 30_000:
        return None
    if door_scales:
        evidence = [f"按 {len(door_scales)} 个标准门洞（约 900 mm）估算图纸比例"]
        confidence = min(0.55, 0.42 + len(door_scales) * 0.025)
    else:
        evidence = [f"按 {len(furniture_scales)} 件标准家具占地估算图纸比例"]
        confidence = min(0.48, 0.32 + len(furniture_scales) * 0.02)
    return {
        "width_mm": width_mm,
        "depth_mm": depth_mm,
        "source": "object_scale_estimate",
        "confidence": round(confidence, 3),
        "evidence": evidence,
    }


def _dimension_instruction(plan_width_mm: int | None, plan_depth_mm: int | None) -> str:
    known: list[str] = []
    if plan_width_mm is not None:
        known.append(f"widthMm={plan_width_mm}")
    if plan_depth_mm is not None:
        known.append(f"depthMm={plan_depth_mm}")
    if len(known) == 2:
        return (
            "The caller supplied authoritative dimensions "
            + ", ".join(known)
            + "; copy them into physicalPlan with source='caller_supplied' and confidence=1."
        )
    if known:
        return (
            "The caller supplied "
            + known[0]
            + ". Keep it authoritative and read the missing dimension from the drawing; "
            "use source='mixed'."
        )
    return (
        "No physical dimensions were supplied. First read printed overall dimensions, an "
        "unambiguous outer dimension chain, or a scale bar. If none exists, make a conservative "
        "low-confidence object_scale_estimate from standard doors or fixed-size furniture and "
        "include the anchors in evidence."
    )


def _request_payload(
    *,
    raw: bytes,
    mime_type: str,
    model: str,
    plan_width_mm: int | None,
    plan_depth_mm: int | None,
) -> dict[str, Any]:
    encoded = base64.b64encode(raw).decode("ascii")
    image_url = f"data:{mime_type};base64,{encoded}"
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": _USER_PROMPT.format(
                            dimension_instruction=_dimension_instruction(
                                plan_width_mm,
                                plan_depth_mm,
                            )
                        ),
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": image_url, "detail": "high"},
                    },
                ],
            },
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "floorplan_semantic_q10000",
                "strict": True,
                "schema": VISION_RESPONSE_SCHEMA,
            },
        },
        "max_completion_tokens": 16_000,
    }


def _post_chat_completion(
    *,
    endpoint: str,
    api_key: str,
    timeout_seconds: float,
    payload: dict[str, Any],
    http_client: httpx.Client | None,
) -> httpx.Response:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    try:
        if http_client is not None:
            return http_client.post(
                endpoint,
                headers=headers,
                json=payload,
                timeout=timeout_seconds,
            )
        with httpx.Client(timeout=timeout_seconds) as client:
            return client.post(endpoint, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        # Do not retain the HTTP exception as ``__cause__``: it owns the request
        # object, whose headers and body contain the API key and image data URL.
        del exc
        raise ProcessorError(VISION_TIMEOUT, "外部视觉模型识别超时") from None
    except httpx.RequestError as exc:
        del exc
        raise ProcessorError(VISION_PROVIDER_UNAVAILABLE, "无法连接外部视觉模型服务") from None


def _message_content(response: httpx.Response) -> Any:
    if not 200 <= response.status_code < 300:
        raise ProcessorError(
            VISION_PROVIDER_REJECTED,
            f"外部视觉模型服务拒绝请求（HTTP {response.status_code}）",
        )
    try:
        payload = response.json()
        message = payload["choices"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise ProcessorError(VISION_RESPONSE_INVALID, "外部视觉模型返回格式无效") from exc

    if message.get("refusal"):
        raise ProcessorError(VISION_PROVIDER_REJECTED, "外部视觉模型拒绝识别该平面图")
    return message.get("content")


def _decode_recognition(content: Any) -> _VisionRecognition:
    if isinstance(content, Mapping):
        parsed: Any = dict(content)
    elif isinstance(content, str):
        text = content.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            if len(lines) >= 3 and lines[-1].strip() == "```":
                text = "\n".join(lines[1:-1])
                if text.lstrip().lower().startswith("json\n"):
                    text = text.lstrip()[5:]
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError) as exc:
            raise ProcessorError(VISION_RESPONSE_INVALID, "外部视觉模型未返回有效 JSON") from exc
    elif isinstance(content, list):
        text_parts = [
            item.get("text", "")
            for item in content
            if isinstance(item, Mapping) and item.get("type") in {"text", "output_text"}
        ]
        return _decode_recognition("".join(text_parts))
    else:
        raise ProcessorError(VISION_RESPONSE_INVALID, "外部视觉模型未返回识别结果")

    try:
        recognition = _VisionRecognition.model_validate(parsed)
    except ValidationError as exc:
        raise ProcessorError(
            VISION_RESPONSE_INVALID,
            "外部视觉模型结果不符合 q10000 语义契约",
        ) from exc
    recognition = _normalize_axis_segments(recognition)
    _validate_semantics(recognition)
    return recognition


def _normalize_axis_segments(recognition: _VisionRecognition) -> _VisionRecognition:
    """Snap small VLM noise and isolate unusable non-orthogonal candidates.

    A single door leaf or dimension line must not discard an otherwise useful semantic
    draft. Segments that are far outside the declared axis are removed and surfaced as
    review warnings; the downstream topology gate still prevents Blender submission
    until the user repairs any structurally important omission.
    """

    normalized = recognition.model_copy(deep=True)
    snapped = False
    discarded_walls: list[str] = []
    discarded_openings: list[str] = []

    def normalize_item(
        item: _VisionWall | _VisionOpening,
        axis: Literal["horizontal", "vertical"],
    ) -> bool:
        nonlocal snapped
        segment = item.segment
        if axis == "horizontal":
            delta = abs(segment.start.y_q - segment.end.y_q)
            primary_span = abs(segment.start.x_q - segment.end.x_q)
            if primary_span < 2:
                return False
            tolerance = min(
                AXIS_SNAP_MAX_TOLERANCE_Q,
                max(
                    AXIS_SNAP_MIN_TOLERANCE_Q,
                    round(primary_span * AXIS_SNAP_RELATIVE_TOLERANCE),
                ),
            )
            if delta > tolerance:
                return False
            coordinate = round((segment.start.y_q + segment.end.y_q) / 2)
            snapped = snapped or delta > 0
            segment.start.y_q = coordinate
            segment.end.y_q = coordinate
        else:
            delta = abs(segment.start.x_q - segment.end.x_q)
            primary_span = abs(segment.start.y_q - segment.end.y_q)
            if primary_span < 2:
                return False
            tolerance = min(
                AXIS_SNAP_MAX_TOLERANCE_Q,
                max(
                    AXIS_SNAP_MIN_TOLERANCE_Q,
                    round(primary_span * AXIS_SNAP_RELATIVE_TOLERANCE),
                ),
            )
            if delta > tolerance:
                return False
            coordinate = round((segment.start.x_q + segment.end.x_q) / 2)
            snapped = snapped or delta > 0
            segment.start.x_q = coordinate
            segment.end.x_q = coordinate
        return True

    retained_walls: list[_VisionWall] = []
    for wall in normalized.walls:
        if normalize_item(wall, wall.axis):
            retained_walls.append(wall)
        else:
            discarded_walls.append(wall.id)
    normalized.walls = retained_walls

    retained_openings: list[_VisionOpening] = []
    for opening in normalized.openings:
        if normalize_item(opening, opening.wall_axis):
            retained_openings.append(opening)
        else:
            discarded_openings.append(opening.id)
    normalized.openings = retained_openings

    if len(normalized.walls) < 4:
        raise ProcessorError(
            VISION_RESPONSE_INVALID,
            "过滤非正交候选后有效墙体少于 4 条，无法形成可校正户型草稿",
        )

    if snapped and len(normalized.warnings) < 30:
        normalized.warnings.append("已将视觉模型的轻微轴向误差吸附为水平或垂直线")
    if discarded_walls and len(normalized.warnings) < 30:
        ids = "、".join(discarded_walls[:8])
        suffix = "等" if len(discarded_walls) > 8 else ""
        normalized.warnings.append(
            f"已丢弃零长度或非正交墙体候选 {ids}{suffix}，请在网页检查并补画必要墙线"
        )
    if discarded_openings and len(normalized.warnings) < 30:
        ids = "、".join(discarded_openings[:8])
        suffix = "等" if len(discarded_openings) > 8 else ""
        normalized.warnings.append(
            f"已丢弃零长度或非正交门窗候选 {ids}{suffix}，请在网页检查并补录必要开口"
        )
    return normalized


def _validate_semantics(recognition: _VisionRecognition) -> None:
    ids: list[str] = []
    ids.extend(item.id for item in recognition.rooms)
    ids.extend(item.id for item in recognition.walls)
    ids.extend(item.id for item in recognition.openings)
    ids.extend(item.id for item in recognition.furniture)
    if len(ids) != len(set(ids)):
        raise ProcessorError(VISION_RESPONSE_INVALID, "外部视觉模型返回了重复的对象 ID")

    room_ids = {room.id for room in recognition.rooms}
    for wall in recognition.walls:
        _validate_axis_segment(wall.segment, wall.axis, "墙体")
    for opening in recognition.openings:
        _validate_axis_segment(opening.segment, opening.wall_axis, "门窗")
        if not set(opening.room_ids).issubset(room_ids):
            raise ProcessorError(VISION_RESPONSE_INVALID, "门窗引用了不存在的房间")
    for item in recognition.furniture:
        if item.room_id not in room_ids:
            raise ProcessorError(VISION_RESPONSE_INVALID, "家具引用了不存在的房间")


def _validate_axis_segment(
    segment: _QSegment,
    axis: Literal["horizontal", "vertical"],
    label: str,
) -> None:
    if segment.start == segment.end:
        raise ProcessorError(VISION_RESPONSE_INVALID, f"{label}包含零长度线段")
    aligned = (
        segment.start.y_q == segment.end.y_q
        if axis == "horizontal"
        else segment.start.x_q == segment.end.x_q
    )
    if not aligned:
        raise ProcessorError(VISION_RESPONSE_INVALID, f"{label}轴向与坐标不一致")


def _q_to_mm(value_q: int, *, origin_q: int, extent_q: int, extent_mm: int) -> int:
    normalized = (value_q - origin_q) / extent_q
    return round(min(1.0, max(0.0, normalized)) * extent_mm)


def _point_mm(
    point: _QPoint,
    *,
    bounds: _DrawingBounds,
    plan_width_mm: int,
    plan_depth_mm: int,
) -> dict[str, int]:
    return {
        "xMm": _q_to_mm(
            point.x_q,
            origin_q=bounds.x_q,
            extent_q=bounds.width_q,
            extent_mm=plan_width_mm,
        ),
        "yMm": _q_to_mm(
            point.y_q,
            origin_q=bounds.y_q,
            extent_q=bounds.depth_q,
            extent_mm=plan_depth_mm,
        ),
    }


def _size_mm(value_q: int, *, extent_q: int, extent_mm: int) -> int:
    return max(1, round(value_q / extent_q * extent_mm))


def _polygon_area_mm(points: list[dict[str, int]]) -> float:
    return abs(
        sum(
            first["xMm"] * second["yMm"] - second["xMm"] * first["yMm"]
            for first, second in zip(points, [*points[1:], points[0]], strict=True)
        )
    ) / 2


def _compile_recognition(
    recognition: _VisionRecognition,
    *,
    plan_width_mm: int,
    plan_depth_mm: int,
    source_sha256: str,
    ceiling_height_mm: int,
    scale_status: Literal["user_confirmed", "vision_estimated"] = "user_confirmed",
    scale_confidence: float = 1.0,
) -> tuple[dict[str, Any], list[str]]:
    bounds = recognition.drawing_bounds
    compile_warnings: list[str] = []

    def point_mm(point: _QPoint) -> dict[str, int]:
        if not (
            bounds.x_q <= point.x_q <= bounds.x_q + bounds.width_q
            and bounds.y_q <= point.y_q <= bounds.y_q + bounds.depth_q
        ):
            warning = "部分识别坐标超出图框，编译时已裁剪到户型边界"
            if warning not in compile_warnings:
                compile_warnings.append(warning)
        return _point_mm(
            point,
            bounds=bounds,
            plan_width_mm=plan_width_mm,
            plan_depth_mm=plan_depth_mm,
        )

    rooms: list[dict[str, Any]] = []
    for room in recognition.rooms:
        polygon = [point_mm(point) for point in room.polygon]
        unique_points = {(point["xMm"], point["yMm"]) for point in polygon}
        if len(unique_points) < 3 or _polygon_area_mm(polygon) < 1:
            raise ProcessorError(
                VISION_RESPONSE_INVALID,
                f"房间 {room.id} 在边界裁剪后退化，无法形成有效多边形",
            )
        x_values = [point["xMm"] for point in polygon]
        y_values = [point["yMm"] for point in polygon]
        rect = {
            "xMm": min(x_values),
            "yMm": min(y_values),
            "widthMm": max(1, max(x_values) - min(x_values)),
            "depthMm": max(1, max(y_values) - min(y_values)),
        }
        rooms.append(
            {
                "id": room.id,
                "type": room.type,
                "name": room.name,
                "rect": rect,
                "polygon": polygon,
                "confidence": room.confidence,
                "reviewStatus": "pending" if room.confidence < 0.9 else "recognized",
            }
        )

    walls: list[dict[str, Any]] = []
    for wall in recognition.walls:
        scale_mm = (
            _size_mm(
                wall.thickness_q,
                extent_q=bounds.depth_q,
                extent_mm=plan_depth_mm,
            )
            if wall.axis == "horizontal"
            else _size_mm(
                wall.thickness_q,
                extent_q=bounds.width_q,
                extent_mm=plan_width_mm,
            )
        )
        start = point_mm(wall.segment.start)
        end = point_mm(wall.segment.end)
        if start == end:
            compile_warnings.append(f"墙体 {wall.id} 在图框裁剪后退化，已自动忽略")
            continue
        walls.append(
            {
                "id": wall.id,
                "kind": wall.kind,
                "start": start,
                "end": end,
                "thicknessMm": min(600, max(60, scale_mm)),
                "confidence": wall.confidence,
                "reviewStatus": "pending" if wall.confidence < 0.9 else "recognized",
            }
        )
    if len(walls) < 4:
        raise ProcessorError(
            VISION_RESPONSE_INVALID,
            "过滤退化候选后有效墙体少于 4 条，无法形成可校正户型草稿",
        )

    openings: list[dict[str, Any]] = []
    for opening in recognition.openings:
        start = point_mm(opening.segment.start)
        end = point_mm(opening.segment.end)
        width_mm = (
            abs(end["xMm"] - start["xMm"])
            if opening.wall_axis == "horizontal"
            else abs(end["yMm"] - start["yMm"])
        )
        if start == end or width_mm <= 0:
            compile_warnings.append(f"门窗 {opening.id} 在图框裁剪后退化，已自动忽略")
            continue
        openings.append(
            {
                "id": opening.id,
                "type": opening.type,
                "wallAxis": opening.wall_axis,
                "segment": {"start": start, "end": end},
                "widthMm": max(1, width_mm),
                "roomIds": opening.room_ids,
                "confidence": opening.confidence,
                "reviewStatus": "pending" if opening.confidence < 0.9 else "recognized",
            }
        )

    furniture: list[dict[str, Any]] = []
    for item in recognition.furniture:
        furniture.append(
            {
                "id": item.id,
                "type": item.type,
                "center": point_mm(item.center),
                "size": {
                    "widthMm": _size_mm(
                        item.size.width_q,
                        extent_q=bounds.width_q,
                        extent_mm=plan_width_mm,
                    ),
                    "depthMm": _size_mm(
                        item.size.depth_q,
                        extent_q=bounds.depth_q,
                        extent_mm=plan_depth_mm,
                    ),
                    "heightMm": _FURNITURE_HEIGHT_MM[item.type],
                },
                "rotationDeg": item.rotation_deg,
                "roomId": item.room_id,
                "confidence": item.confidence,
                "reviewStatus": "pending" if item.confidence < 0.9 else "recognized",
            }
        )

    layout = {
        "version": "0.5",
        "profileId": f"vision_{source_sha256[:12]}",
        "sourceSha256": source_sha256,
        "coordinateSystem": {
            "unit": "mm",
            "origin": "top_left",
            "xAxis": "right",
            "yAxis": "down",
        },
        "plan": {
            "widthMm": plan_width_mm,
            "depthMm": plan_depth_mm,
            "ceilingHeightMm": ceiling_height_mm,
            "scaleStatus": scale_status,
            "scaleConfidence": round(min(1.0, max(0.0, scale_confidence)), 3),
        },
        "rooms": rooms,
        "walls": walls,
        "openings": openings,
        "furniture": furniture,
    }
    return layout, compile_warnings


def compile_vision_semantic_layout(
    recognition: Mapping[str, Any],
    *,
    plan_width_mm: int,
    plan_depth_mm: int,
    source_sha256: str = "",
    ceiling_height_mm: int = DEFAULT_CEILING_HEIGHT_MM,
) -> dict[str, Any]:
    """Compile validated image-q10000 recognition into millimetre semanticLayout."""

    if plan_width_mm <= 0 or plan_depth_mm <= 0 or ceiling_height_mm <= 0:
        raise ProcessorError(VISION_INPUT_REJECTED, "语义户型物理尺寸必须大于 0")
    try:
        validated = _VisionRecognition.model_validate(recognition)
    except ValidationError as exc:
        raise ProcessorError(VISION_RESPONSE_INVALID, "q10000 识别结果不符合语义契约") from exc
    validated = _normalize_axis_segments(validated)
    _validate_semantics(validated)
    layout, _warnings = _compile_recognition(
        validated,
        plan_width_mm=plan_width_mm,
        plan_depth_mm=plan_depth_mm,
        source_sha256=source_sha256,
        ceiling_height_mm=ceiling_height_mm,
    )
    return layout


def recognize_floorplan(
    source_path: VisionSource,
    *,
    plan_width_mm: int | None,
    plan_depth_mm: int | None,
    source_image_width: int | None = None,
    source_image_height: int | None = None,
    api_key: str,
    base_url: str,
    model: str,
    timeout_seconds: float,
    http_client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Recognize any supported floor-plan image through an OpenAI-compatible VLM.

    ``drawing_bounds`` and all provider-side geometry are q10000 coordinates relative
    to the complete uploaded image (not the detected drawing bounds). Caller-supplied
    dimensions remain authoritative; missing dimensions are read from explicit drawing
    annotations or conservatively estimated from standard architectural objects before
    compiling ``semantic_layout``. API keys and image data are used only in the outbound
    request and are never included in return values.
    """

    supplied_width = _supplied_dimension(plan_width_mm, "平面图总宽")
    supplied_depth = _supplied_dimension(plan_depth_mm, "平面图总深")
    clean_base_url, endpoint, clean_model = _validate_provider_config(
        api_key=api_key,
        base_url=base_url,
        model=model,
        timeout_seconds=timeout_seconds,
    )
    raw, mime_type = _source_bytes(source_path)
    source_sha256 = hashlib.sha256(raw).hexdigest()
    cache_path = _vision_cache_path(
        source_sha256=source_sha256,
        model=clean_model,
        plan_width_mm=supplied_width,
        plan_depth_mm=supplied_depth,
    )
    if http_client is None:
        cached = _read_vision_cache(cache_path)
        if cached is not None:
            return cached
    payload = _request_payload(
        raw=raw,
        mime_type=mime_type,
        model=clean_model,
        plan_width_mm=supplied_width,
        plan_depth_mm=supplied_depth,
    )
    response = _post_chat_completion(
        endpoint=endpoint,
        api_key=api_key,
        timeout_seconds=timeout_seconds,
        payload=payload,
        http_client=http_client,
    )
    recognition = _decode_recognition(_message_content(response))
    physical_plan = recognition.physical_plan
    object_estimate = None
    if (
        (supplied_width is None and physical_plan.width_mm < 2_400)
        or (supplied_depth is None and physical_plan.depth_mm < 2_400)
    ):
        object_estimate = _object_scale_estimate(
            recognition,
            image_width=source_image_width,
            image_height=source_image_height,
        )
    resolved_width = (
        supplied_width
        or (physical_plan.width_mm if physical_plan.width_mm >= 2_400 else None)
        or (object_estimate["width_mm"] if object_estimate else 0)
    )
    resolved_depth = (
        supplied_depth
        or (physical_plan.depth_mm if physical_plan.depth_mm >= 2_400 else None)
        or (object_estimate["depth_mm"] if object_estimate else 0)
    )
    if not 2_400 <= resolved_width <= 30_000 or not 2_400 <= resolved_depth <= 30_000:
        raise ProcessorError(
            VISION_INPUT_REJECTED,
            "未能从图纸标注识别有效的总宽和总深，请在网页手动填写后重试",
        )
    dimensions_inferred = supplied_width is None or supplied_depth is None
    if not dimensions_inferred:
        dimension_source = "user_input"
        dimension_confidence = 1.0
        dimension_evidence = physical_plan.evidence
    elif supplied_width is not None or supplied_depth is not None:
        dimension_source = "mixed"
        dimension_confidence = (
            physical_plan.confidence
            if physical_plan.source != "unavailable"
            else object_estimate["confidence"]
            if object_estimate
            else 0
        )
        dimension_evidence = (
            physical_plan.evidence
            if physical_plan.evidence
            else object_estimate["evidence"]
            if object_estimate
            else []
        )
    elif physical_plan.source != "unavailable":
        dimension_source = physical_plan.source
        dimension_confidence = physical_plan.confidence
        dimension_evidence = physical_plan.evidence
    else:
        dimension_source = object_estimate["source"] if object_estimate else "unavailable"
        dimension_confidence = object_estimate["confidence"] if object_estimate else 0
        dimension_evidence = object_estimate["evidence"] if object_estimate else []
    semantic_layout, compile_warnings = _compile_recognition(
        recognition,
        plan_width_mm=resolved_width,
        plan_depth_mm=resolved_depth,
        source_sha256=source_sha256,
        ceiling_height_mm=DEFAULT_CEILING_HEIGHT_MM,
        scale_status="vision_estimated" if dimensions_inferred else "user_confirmed",
        scale_confidence=dimension_confidence,
    )
    bounds = recognition.drawing_bounds
    parsed_url = urlparse(clean_base_url)
    hostname = parsed_url.hostname or "openai-compatible"
    provider = "kuyao" if "kuyaoapi.com" in hostname else hostname
    if dimension_source == "object_scale_estimate":
        dimension_warnings = [
            "原图没有可读的总尺寸标注，系统已按门洞或标准家具尺度估算；请在网页核对总宽和总深",
        ]
    elif dimensions_inferred:
        dimension_warnings = [
            "总宽/总深由视觉模型从图纸尺寸标注推断，请在网页核对后再确认结构",
        ]
    else:
        dimension_warnings = []
    warnings = [*recognition.warnings, *dimension_warnings, *compile_warnings]
    semantic_layout["source"] = {
        "provider": provider,
        "model": clean_model,
        "promptVersion": VISION_PROMPT_VERSION,
        "requiresHumanReview": True,
    }
    semantic_layout["validation"] = {
        "status": "review_required",
        "errors": [],
        "warnings": warnings,
    }
    result = {
        "semantic_layout": semantic_layout,
        "drawing_bounds": {
            "coordinateSpace": "full_image_q10000",
            "xQ": bounds.x_q,
            "yQ": bounds.y_q,
            "widthQ": bounds.width_q,
            "depthQ": bounds.depth_q,
        },
        "confidence": recognition.confidence,
        "dimension_source": dimension_source,
        "dimension_confidence": dimension_confidence,
        "dimension_evidence": dimension_evidence,
        "warnings": warnings,
        "provider": provider,
        "model": clean_model,
        "cache_hit": False,
    }
    if http_client is None:
        _write_vision_cache(cache_path, result)
    return result
