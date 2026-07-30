from __future__ import annotations

import re
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile

from app.config import settings


ALLOWED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def safe_stem(value: str) -> str:
    stem = Path(value).stem
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", stem).strip("-")
    return cleaned[:48] or "upload"


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
    path = settings.artifact_dir / (
        f"{safe_stem(upload.filename or 'upload')}-{uuid4().hex[:10]}{suffix}"
    )
    path.write_bytes(data)
    return path


def artifact_path(prefix: str, suffix: str) -> Path:
    return settings.artifact_dir / f"{prefix}-{uuid4().hex[:12]}{suffix}"


def artifact_url(path: str | Path) -> str:
    return f"/artifacts/{Path(path).name}"

