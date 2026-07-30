from __future__ import annotations

import json
import subprocess
from pathlib import Path

from app.config import API_ROOT, settings
from app.storage import artifact_path


def render_with_blender(payload: dict) -> Path | None:
    blender = Path(settings.blender_bin)
    script = API_ROOT / "app" / "processors" / "blender_scene.py"
    if not settings.blender_enabled or not blender.exists() or not script.exists():
        return None

    input_path = artifact_path("blender-scene", ".json")
    output_path = artifact_path("blender-render", ".png")
    input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    command = [
        str(blender),
        "--background",
        "--python",
        str(script),
        "--",
        str(input_path),
        str(output_path),
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=75,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0 or not output_path.exists():
        return None
    return output_path

