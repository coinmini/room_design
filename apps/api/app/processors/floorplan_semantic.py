from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, TypeAlias


SemanticSource: TypeAlias = str | Path | bytes | bytearray | memoryview

GOLDEN_FLOORPLAN_SHA256 = "0c9e270682e512189065dfdfd584a3bbe67629a06691bad080fcc7959c7002a9"
FIXTURE_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "floorplans"


def _source_bytes(source: SemanticSource) -> bytes:
    if isinstance(source, bytes):
        return source
    if isinstance(source, (bytearray, memoryview)):
        return bytes(source)
    return Path(source).read_bytes()


def _fixture_path(digest: str) -> Path:
    return FIXTURE_DIR / f"{digest}.json"


def compile_semantic_layout(source: SemanticSource) -> dict[str, Any] | None:
    """Return a deterministic semantic layout for a registered golden floor plan.

    V0.4 deliberately compiles only byte-identical, reviewed fixtures. Unknown images
    return ``None`` so callers can continue through the generic recognition pipeline
    without accidentally applying a layout that merely looks similar.
    """

    raw = _source_bytes(source)
    digest = hashlib.sha256(raw).hexdigest()
    fixture_path = _fixture_path(digest)
    if not fixture_path.is_file():
        return None

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    if fixture.get("sourceSha256") != digest:
        raise ValueError(f"Semantic fixture digest mismatch: {fixture_path.name}")

    layout = fixture.get("semanticLayout")
    if not isinstance(layout, dict):
        raise ValueError(f"Semantic fixture is missing semanticLayout: {fixture_path.name}")
    return layout
