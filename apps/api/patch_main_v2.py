#!/usr/bin/env python3
"""Patch app/main.py for W0-a."""
from pathlib import Path

p = Path("app/main.py")
lines = p.read_text().splitlines(keepends=True)
if lines and not lines[-1].endswith("\n"):
    lines[-1] += "\n"

# 1. Import SessionLocal
for i, line in enumerate(lines):
    if "from app.database import get_session, init_db" in line:
        lines[i] = line.replace("get_session, init_db", "SessionLocal, get_session, init_db")
        break

# 2. lifespan: insert backfill BEFORE yield (after reclaim_stale_jobs)
# Find yield inside lifespan
yield_idx = None
for i, line in enumerate(lines):
    if line.strip() == "yield":
        # Make sure it's in lifespan (after reclaim_stale_jobs)
        yield_idx = i
        break
assert yield_idx is not None, "yield not found"

backfill_block = [
    "    # W0-a：启动时一次性回填历史资产，之后不再在请求热路径调用\n",
    "    backfill_session = SessionLocal()\n",
    "    try:\n",
    '        count = backfill_scene_assets(backfill_session)\n',
    '        if count:\n',
    '            print(f"backfilled {count} scene assets")\n',
    "    except Exception:\n",
    "        import traceback\n",
    "        traceback.print_exc()\n",
    "    finally:\n",
    "        backfill_session.close()\n",
]
# Insert BEFORE yield
lines = lines[:yield_idx] + backfill_block + lines[yield_idx:]
# Update yield_idx since we added 10 lines
yield_idx += 10

# 3. list_scene_assets: add project_id, remove backfill, fix SQL/offset/limit
# Find and remove backfill inside list_scene_assets
for i in range(yield_idx, len(lines)):
    if lines[i].strip() == "backfill_scene_assets(session)":
        lines.pop(i)
        break

# Find the ) -> list[dict]: line after workflow_stage and insert project_id before it
for i in range(yield_idx, len(lines)):
    if lines[i].strip() == ") -> list[dict]:":
        # Check it's in list_scene_assets by looking backward for function def
        lines[i] = (
            "    project_id: Annotated[\n"
            '        str | None,\n'
            '        Query(alias="projectId", min_length=1, max_length=40),\n'
            "    ] = None,\n"
            ") -> list[dict]:\n"
        )
        break

# Find the SQL block: after generation_mode if-block, add project_id + offset/limit
# First find "    if generation_mode:" inside list_scene_assets
gen_idx = None
for i in range(yield_idx, len(lines)):
    if lines[i].strip() == "if generation_mode:":
        # Make sure next line is the statement assignment
        if i+1 < len(lines) and "statement = statement.where(SceneAsset.generation_mode == generation_mode)" in lines[i+1]:
            gen_idx = i
            break
assert gen_idx is not None, "generation_mode block not found"

# Find the line after the if generation_mode block
after_gen = gen_idx + 2  # skip the if and its body
while after_gen < len(lines) and lines[after_gen].strip() == "":
    after_gen += 1

# The next line should be "assets = list(session.scalars(statement.order_by...))"
assert "assets = list(session.scalars(statement.order_by(SceneAsset.created_at.desc())))" in lines[after_gen], f"Expected assets line, got: {lines[after_gen]!r}"

# Replace this line and add project_id filter before it
old_assets_line = lines[after_gen]
new_block = [
    "    if project_id:\n",
    "        statement = statement.where(SceneAsset.project_id == project_id)\n",
    "    statement = statement.order_by(SceneAsset.created_at.desc()).offset(offset).limit(limit)\n",
    "    assets = list(session.scalars(statement))\n",
]
lines = lines[:after_gen] + new_block + lines[after_gen+1:]

# Fix return line: find "return values[offset : offset + limit]"
for i in range(after_gen, len(lines)):
    if "return values[offset : offset + limit]" in lines[i]:
        lines[i] = "    return values\n"
        break

# 4. Remove backfill from other 3 endpoints (list_scene_assets already done)
removed = 0
i = 0
while i < len(lines):
    if lines[i].strip() == "backfill_scene_assets(session)":
        lines.pop(i)
        removed += 1
    else:
        i += 1
print(f"Removed {removed} remaining backfill lines")

# 5. Add POST /v1/assets/backfill after list_asset_modules
modules_idx = None
for i, line in enumerate(lines):
    if 'def list_asset_modules() -> list[dict[str, str]]:' in line:
        modules_idx = i
        break
assert modules_idx is not None
# Find return asset_modules() and the blank line after
for i in range(modules_idx, len(lines)):
    if lines[i].strip() == "return asset_modules()":
        insert_pos = i + 1
        while insert_pos < len(lines) and lines[insert_pos].strip() == "":
            insert_pos += 1
        break

backfill_endpoint = [
    "\n",
    '\n',
    f'@app.post(f"{{settings.api_prefix}}/assets/backfill")\n',
    "def trigger_backfill(session: SessionDep) -> dict[str, int]:\n",
    "    count = backfill_scene_assets(session)\n",
    '    return {"backfilled": count}\n',
]
lines = lines[:insert_pos] + backfill_endpoint + lines[insert_pos:]

# 6. Add GET /v1/jobs after cancel_job
cancel_idx = None
for i, line in enumerate(lines):
    if 'def cancel_job(' in line:
        cancel_idx = i
        break
assert cancel_idx is not None
# Find last return job in cancel_job
for i in range(cancel_idx, len(lines)):
    if lines[i].strip() == "return job":
        insert_pos = i + 1
        break

jobs_endpoint = [
    "\n",
    '\n',
    f'@app.get(f"{{settings.api_prefix}}/jobs", response_model=list[JobRead])\n',
    "def list_jobs(\n",
    "    session: SessionDep,\n",
    "    project_id: Annotated[\n",
    '        str | None,\n',
    '        Query(alias="projectId", min_length=1, max_length=40),\n',
    "    ] = None,\n",
    "    status: Annotated[str | None, Query(min_length=1, max_length=20)] = None,\n",
    "    limit: Annotated[int, Query(ge=1, le=100)] = 50,\n",
    "    offset: Annotated[int, Query(ge=0)] = 0,\n",
    ") -> list[Job]:\n",
    "    statement = select(Job).order_by(Job.created_at.desc())\n",
    "    if project_id:\n",
    "        statement = statement.where(Job.project_id == project_id)\n",
    "    if status:\n",
    "        statement = statement.where(Job.status == status)\n",
    "    statement = statement.offset(offset).limit(limit)\n",
    "    return list(session.scalars(statement))\n",
]
lines = lines[:insert_pos] + jobs_endpoint + lines[insert_pos:]

p.write_text("".join(lines))
print("main.py patched successfully")
