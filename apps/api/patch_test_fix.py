#!/usr/bin/env python3
"""Fix test_job_list_filters project_id usage."""
from pathlib import Path

p = Path("tests/test_assets.py")
text = p.read_text()

old = '''            job = create_job(
                session,
                job_type="EFFECT_RENDER",
                payload={"room_type": "living_room", "use_blender": False, "project_id": pid},
            )'''

new = '''            job = create_job(
                session,
                job_type="EFFECT_RENDER",
                payload={"room_type": "living_room", "use_blender": False},
                project_id=pid,
            )'''

assert old in text
p.write_text(text.replace(old, new, 1))
print("fixed")
