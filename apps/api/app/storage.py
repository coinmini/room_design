from __future__ import annotations

import re
import struct
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile

from app.config import settings


ALLOWED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
MAX_IMAGE_PIXELS = 40_000_000
MAX_IMAGE_DIMENSION = 10_000


def safe_stem(value: str) -> str:
    stem = Path(value).stem
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", stem).strip("-")
    return cleaned[:48] or "upload"


def validate_image_payload(data: bytes) -> tuple[int, int]:
    """Inspect image headers before OpenCV can allocate a decompression-bomb canvas."""

    dimensions = _image_header_dimensions(data)
    if dimensions is None:
        raise HTTPException(status_code=415, detail="无法解析上传图片")
    width, height = dimensions
    if (
        width <= 0
        or height <= 0
        or width > MAX_IMAGE_DIMENSION
        or height > MAX_IMAGE_DIMENSION
        or width * height > MAX_IMAGE_PIXELS
    ):
        raise HTTPException(
            status_code=413,
            detail="图片像素尺寸过大，最长边不得超过 10000，且总像素不得超过 4000 万",
        )
    return width, height


def _image_header_dimensions(data: bytes) -> tuple[int, int] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(data) < 24 or data[12:16] != b"IHDR":
            return None
        return struct.unpack(">II", data[16:24])
    if data.startswith(b"\xff\xd8"):
        return _jpeg_dimensions(data)
    if len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8X":
            width = int.from_bytes(data[24:27], "little") + 1
            height = int.from_bytes(data[27:30], "little") + 1
            return width, height
        if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
            width = int.from_bytes(data[26:28], "little") & 0x3FFF
            height = int.from_bytes(data[28:30], "little") & 0x3FFF
            return width, height
        if chunk == b"VP8L" and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    start_of_frame = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    offset = 2
    while offset + 3 < len(data):
        while offset < len(data) and data[offset] != 0xFF:
            offset += 1
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            return None
        marker = data[offset]
        offset += 1
        if marker in {0x01, *range(0xD0, 0xDA)}:
            continue
        if offset + 2 > len(data):
            return None
        segment_length = int.from_bytes(data[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(data):
            return None
        if marker in start_of_frame:
            if segment_length < 7:
                return None
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            return width, height
        offset += segment_length
    return None


async def save_upload(
    upload: UploadFile,
    *,
    allowed_suffixes: set[str] = ALLOWED_IMAGE_SUFFIXES,
) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in allowed_suffixes:
        raise HTTPException(
            status_code=415,
            detail=f"不支持的文件格式：{suffix or 'unknown'}",
        )
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="上传文件为空")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件不能超过 20 MB")
    validate_image_payload(data)
    path = settings.artifact_dir / (
        f"{safe_stem(upload.filename or 'upload')}-{uuid4().hex[:10]}{suffix}"
    )
    path.write_bytes(data)
    return path


def artifact_path(prefix: str, suffix: str) -> Path:
    return settings.artifact_dir / f"{prefix}-{uuid4().hex[:12]}{suffix}"


def artifact_url(path: str | Path) -> str:
    return f"/artifacts/{Path(path).name}"
