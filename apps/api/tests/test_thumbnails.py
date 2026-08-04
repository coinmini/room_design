"""W0-c: Thumbnail generation and URL upgrade tests."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from app.config import settings
from app.thumbnails import (
    _is_thumb_path,
    _thumb_path,
    ensure_thumbnails,
    generate_thumbnail,
    maybe_upgrade_thumbnail_url,
    thumbnail_url,
)


def _create_test_image(path: Path, width: int = 800, height: int = 600) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (width, height), color=(255, 0, 0))
    img.save(path, "PNG")
    return path


def test_thumb_path_returns_correct_name() -> None:
    source = Path("/tmp/test-image.png")
    thumb = _thumb_path(source, 256)
    assert thumb.name == "test-image-thumb-256.webp"


def test_is_thumb_path_detects_thumbnails() -> None:
    assert _is_thumb_path(Path("/tmp/img-thumb-256.webp")) is True
    assert _is_thumb_path(Path("/tmp/img.png")) is False
    assert _is_thumb_path(Path("/tmp/img.webp")) is False


def test_generate_thumbnail_creates_webp() -> None:
    artifact_dir = Path(settings.artifact_dir)
    source = _create_test_image(artifact_dir / "test-gen-thumb.png")
    thumb = generate_thumbnail(source, 256)
    assert thumb is not None
    assert thumb.exists()
    assert thumb.suffix == ".webp"
    assert "-thumb-256" in thumb.stem
    with Image.open(thumb) as img:
        assert img.width <= 256
        assert img.height <= 256


def test_generate_thumbnail_returns_none_for_missing_file() -> None:
    missing = Path(settings.artifact_dir) / "missing.png"
    assert generate_thumbnail(missing, 256) is None


def test_generate_thumbnail_returns_none_for_unsupported_format() -> None:
    artifact_dir = Path(settings.artifact_dir)
    path = artifact_dir / "test.txt"
    path.write_text("not an image")
    assert generate_thumbnail(path, 256) is None


def test_ensure_thumbnails_generates_both_sizes() -> None:
    artifact_dir = Path(settings.artifact_dir)
    source = _create_test_image(artifact_dir / "test-ensure.png", width=1024, height=1024)
    thumbs = ensure_thumbnails(source)
    assert thumbs is not None
    assert "256" in thumbs
    assert "512" in thumbs
    assert thumbs["256"].exists()
    assert thumbs["512"].exists()


def test_thumbnail_url_returns_correct_path() -> None:
    artifact_dir = Path(settings.artifact_dir)
    source = _create_test_image(artifact_dir / "test-url.png")
    thumb = generate_thumbnail(source, 256)
    assert thumb is not None
    url = thumbnail_url(source, 256)
    assert url is not None
    assert url.startswith("/artifacts/")
    assert "-thumb-256.webp" in url


def test_maybe_upgrade_thumbnail_url_for_nonexistent_file() -> None:
    thumb_url, full_url = maybe_upgrade_thumbnail_url("/artifacts/nonexistent.png")
    assert thumb_url == "/artifacts/nonexistent.png"
    assert full_url is None


def test_maybe_upgrade_thumbnail_url_for_external_url() -> None:
    thumb_url, full_url = maybe_upgrade_thumbnail_url("https://example.com/img.png")
    assert thumb_url == "https://example.com/img.png"
    assert full_url is None


def test_maybe_upgrade_thumbnail_url_generates_and_upgrades() -> None:
    artifact_dir = Path(settings.artifact_dir)
    source = _create_test_image(artifact_dir / "test-upgrade.png", width=800, height=600)
    original_url = f"/artifacts/{source.name}"

    thumb_url, full_url = maybe_upgrade_thumbnail_url(original_url)
    assert thumb_url is not None
    assert full_url is not None
    assert thumb_url != original_url
    assert "-thumb-256.webp" in thumb_url
    assert full_url == original_url


def test_maybe_upgrade_thumbnail_url_skips_existing_thumb() -> None:
    artifact_dir = Path(settings.artifact_dir)
    source = _create_test_image(artifact_dir / "test-skip.png")
    # First call generates thumbnail
    maybe_upgrade_thumbnail_url(f"/artifacts/{source.name}")
    # Second call should use existing thumbnail
    thumb_url, full_url = maybe_upgrade_thumbnail_url(f"/artifacts/{source.name}")
    assert thumb_url is not None
    assert full_url is not None
    assert "-thumb-256.webp" in thumb_url
