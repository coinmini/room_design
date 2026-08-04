#!/usr/bin/env python3
"""Patch app/main.py for W0-a using line-based edits."""

from pathlib import Path

p = Path("app/main.py")
lines = p.read_text().splitlines(keepends=True)

# Ensure newline consistency
if lines and not lines[-1].endswith("\n"):
    lines[-1] += "\n"

# 1. Import SessionLocal (line 37, 0-indexed 36)
idx = 36
assert "from app.database import get_session, init_db" in lines[idx], f"import line mismatch: {lines[idx]!r}"
lines[idx] = lines[idx].replace("get_session, init_db", "SessionLocal, get_session, init_db")

# 2. lifespan: insert backfill before yield (line 76, after reclaim_stale_jobs)
# Insert after line 75 (0-indexed 75)
insert_lifespan = [
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
# line 75 is "    reclaim_stale_jobs()\n", insert after it
lines = lines[:76] + insert_lifespan + lines[76:]
# Adjust subsequent indices due to +11 lines
offset = 11

# Helper to find a line containing a pattern
def find_line(lines, pattern, start=0):
    for i in range(start, len(lines)):
        if pattern in lines[i]:
            return i
    raise ValueError(f"Pattern not found: {pattern!r}")

# 3. list_scene_assets modifications
# Find the function
def_idx = find_line(lines, "def list_scene_assets(")
# Find backfill line inside it
backfill_idx = find_line(lines, "    backfill_scene_assets(session)", def_idx)
# Remove backfill line
lines.pop(backfill_idx)
offset -= 1  # total offset now +10

# Find and add project_id parameter before ) -> list[dict]:
workflow_stage_line = find_line(lines, "    workflow_stage: Annotated[", def_idx)
# Find the closing ) -> list[dict]: after workflow_stage
closing_idx = None
for i in range(workflow_stage_line, len(lines)):
    if ") -> list[dict]:" in lines[i]:
        closing_idx = i
        break
assert closing_idx is not None

# Replace the closing line with project_id parameter + new closing
old_closing = lines[closing_idx]
assert old_closing.strip() == ") -> list[dict]:"
lines[closing_idx] = (
    "    project_id: Annotated[\n"
    '        str | None,\n'
    '        Query(alias="projectId", min_length=1, max_length=40),\n'
    "    ] = None,\n"
    ") -> list[dict]:\n"
)

# Now modify the SQL statement: after generation_mode block, add project_id + offset/limit
# Find "    assets = list(session.scalars(statement.order_by(SceneAsset.created_at.desc())))"
assets_line = find_line(lines, "    assets = list(session.scalars(statement.order_by(SceneAsset.created_at.desc())))")
old_assets = lines[assets_line]
assert old_assets.strip() == "assets = list(session.scalars(statement.order_by(SceneAsset.created_at.desc())))"

# Find the line before assets to insert project_id filter
# After "    if generation_mode:" block
# Let's find the statement = select... line
statement_idx = find_line(lines, "    statement = select(SceneAsset).where(")
# Find end of if generation_mode block
gen_mode_if = find_line(lines, "    if generation_mode:", statement_idx)
# Next line after the if block is the assets line. Insert before it.
insert_sql = [
    "    if project_id:\n",
    "        statement = statement.where(SceneAsset.project_id == project_id)\n",
    "    statement = statement.order_by(SceneAsset.created_at.desc()).offset(offset).limit(limit)\n",
]
lines = lines[:assets_line] + insert_sql + lines[assets_line:]
# The old assets line should now be removed since we replaced it with statement = ...offset().limit()
# Wait, we inserted BEFORE assets_line, so old assets line is now at assets_line + 3
old_assets_new_idx = assets_line + 3
assert "assets = list(session.scalars(statement.order_by(SceneAsset.created_at.desc())))" in lines[old_assets_new_idx]
lines.pop(old_assets_new_idx)

# Also need to change the return to remove Python slicing
return_idx = find_line(lines, "    return values[offset : offset + limit]")
lines[return_idx] = "    return values\n"

# 4. Remove backfill from 4 endpoints
for pattern in [
    "    backfill_scene_assets(session)\n",
]:
    count = 0
    i = 0
    while i < len(lines):
        if lines[i] == pattern:
            lines.pop(i)
            count += 1
        else:
            i += 1
    print(f"Removed {count} backfill lines")

# 5. Insert POST /v1/assets/backfill after list_asset_modules
modules_end = find_line(lines, "def list_asset_modules() -> list[dict[str, str]]:")
# Find the return line and blank line after
for i in range(modules_end, len(lines)):
    if lines[i].strip() == "return asset_modules()":
        modules_end = i + 1  # after the return line
        break
# Skip blank lines
while modules_end < len(lines) and lines[modules_end].strip() == "":
    modules_end += 1

backfill_endpoint = [
    "\n",
    '@app.post(f"{settings.api_prefix}/assets/backfill")\n',
    "def trigger_backfill(session: SessionDep) -> dict[str, int]:\n",
    "    count = backfill_scene_assets(session)\n",
    '    return {"backfilled": count}\n',
]
lines = lines[:modules_end] + backfill_endpoint + lines[modules_end:]

# 6. Append GET /v1/jobs after cancel_job
cancel_end = find_line(lines, "    return job\n")
# Find the last occurrence (cancel_job's return)
# Actually there are multiple return job. Let's find cancel_job function.
cancel_def = find_line(lines, "def cancel_job(")
cancel_return = find_line(lines, "    return job", cancel_def)
# Make sure it's the one in cancel_job
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
lines = lines[:cancel_return+1] + jobs_endpoint + lines[cancel_return+1:]

p.write_text("".join(lines))
print("main.py patched successfully")
