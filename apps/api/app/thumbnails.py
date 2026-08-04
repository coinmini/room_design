from __future__ import annotations

from pathlib import Path
from typing import Literal

from PIL import Image

from app.config import settings
from app.storage import artifact_url

THUMB_SIZES: list[int] = [256, 512]
SUPPORTED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def _thumb_path(original: Path, size: int) -> Path:
    """Return thumbnail path like original_stem-thumb-256.webp."""
    return original.with_name(f"{original.stem}-thumb-{size}.webp")


def _is_thumb_path(path: Path) -> bool:
    return "-thumb-" in path.stem and path.suffix == ".webp"


def generate_thumbnail(
    source: Path,
    size: int,
    *,
    quality: int = 85,
) -> Path | None:
    """Generate a single webp thumbnail; return its path or None on failure."""
    if not source.is_file():
        return None
    if source.suffix.lower() not in SUPPORTED_IMAGE_SUFFIXES:
        return None
    output = _thumb_path(source, size)
    if output.exists():
        return output
    try:
        with Image.open(source) as img:
            img = img.convert("RGB")
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            img.save(output, "WEBP", quality=quality, method=6)
        return output
    except Exception:
        return None


def ensure_thumbnails(source: Path) -> dict[Literal["256", "512"], Path] | None:
    """Generate 256/512 webp thumbnails for a source image.

    Returns a dict of size->path if at least the 256 thumbnail was created,
    otherwise None.
    """
    if not source.is_file():
        return None
    thumb_256 = generate_thumbnail(source, 256)
    if thumb_256 is None:
        return None
    thumb_512 = generate_thumbnail(source, 512)
    return {
        "256": thumb_256,
        "512": thumb_512 if thumb_512 is not None else thumb_256,
    }


def thumbnail_url(source: Path, size: int) -> str | None:
    thumb = _thumb_path(source, size)
    return artifact_url(thumb) if thumb.is_file() else None


def maybe_upgrade_thumbnail_url(url: str | None) -> tuple[str | None, str | None]:
    """Given an artifact image URL, generate thumbnails and return (thumb_256_url, full_url).

    If the URL is not a local artifact or not an image, returns (url, None).
    If thumbnails already exist, returns the existing thumbnail URL.
    """
    if not isinstance(url, str) or not url:
        return url, None
    if not url.startswith("/artifacts/"):
        return url, None
    name = url[len("/artifacts/") :]
    if not name or "/" in name:
        return url, None
    source = settings.artifact_dir / name
    if not source.is_file():
        return url, None
    if _is_thumb_path(source):
        # Already a thumbnail – don't re-thumbnail a thumbnail
        return url, None
    thumbs = ensure_thumbnails(source)
    if thumbs is None:
        return url, None
    thumb_url = artifact_url(thumbs["256"])
    full_url = artifact_url(source)
    return thumb_url, full_url
