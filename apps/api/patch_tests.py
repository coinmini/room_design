#!/usr/bin/env python3
"""Patch tests/test_assets.py for W0-a."""
from pathlib import Path

p = Path("tests/test_assets.py")
text = p.read_text()

# 1. Fix test_asset_list_backfills_historical_success_and_rejects_direct_variants
old = '''        finally:
            session.close()

        first_list = client.get("/v1/assets?generationMode=ai_direct")'''
new = '''        finally:
            session.close()

        client.post("/v1/assets/backfill")

        first_list = client.get("/v1/assets?generationMode=ai_direct")'''
assert old in text, "first backfill test pattern not found"
text = text.replace(old, new, 1)

# 2. Fix test_visual_module_jobs_are_saved_and_filterable_without_provider_calls
old = '''        for job_id in runnable_job_ids:
            run_job(job_id)

        modules_response = client.get("/v1/assets/modules")'''
new = '''        for job_id in runnable_job_ids:
            run_job(job_id)

        client.post("/v1/assets/backfill")

        modules_response = client.get("/v1/assets/modules")'''
assert old in text, "visual module test pattern not found"
text = text.replace(old, new, 1)

# 3. Fix test_asset_backfill_infers_module_for_historical_non_scene_job
old = '''        finally:
            session.close()

        response = client.get("/v1/assets?moduleKey=white_model&limit=100")'''
new = '''        finally:
            session.close()

        client.post("/v1/assets/backfill")

        response = client.get("/v1/assets?moduleKey=white_model&limit=100")'''
assert old in text, "non-scene test pattern not found"
text = text.replace(old, new, 1)

# 4. Fix test_child_asset_inherits_parent_module_before_explicit_job_hint
old = '''        finally:
            session.close()
        parent_asset = next('''
new = '''        finally:
            session.close()

        client.post("/v1/assets/backfill")

        parent_asset = next('''
assert old in text, "child asset test pattern not found"
text = text.replace(old, new, 1)

# 5. Add new tests at end of file
new_tests = '''

def test_asset_list_filters_by_project_id(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setitem(PROCESSORS, "FLOORPLAN_SCENE", fake_scene_result)

    with TestClient(app) as client:
        # Create two projects
        p1 = client.post("/v1/projects", json={"name": "Project A"})
        assert p1.status_code == 201
        pid1 = p1.json()["id"]
        p2 = client.post("/v1/projects", json={"name": "Project B"})
        assert p2.status_code == 201
        pid2 = p2.json()["id"]

        # Create a job in each project
        req1 = scene_request()
        req1["projectId"] = pid1
        r1 = client.post("/v1/floorplan-scenes", json=req1)
        assert r1.status_code == 202
        job1 = completed_job(client, r1.json()["id"])

        req2 = scene_request()
        req2["projectId"] = pid2
        r2 = client.post("/v1/floorplan-scenes", json=req2)
        assert r2.status_code == 202
        job2 = completed_job(client, r2.json()["id"])

        # Filter by project_id
        a1 = client.get(f"/v1/assets?projectId={pid1}").json()
        assert any(a["jobId"] == job1["id"] for a in a1)
        assert not any(a["jobId"] == job2["id"] for a in a1)

        a2 = client.get(f"/v1/assets?projectId={pid2}").json()
        assert any(a["jobId"] == job2["id"] for a in a2)
        assert not any(a["jobId"] == job1["id"] for a in a2)


def test_asset_list_sql_pagination() -> None:
    with TestClient(app) as client:
        # Create 3 projects and jobs
        job_ids: list[str] = []
        for i in range(3):
            pr = client.post("/v1/projects", json={"name": f"Paginate {i}"})
            assert pr.status_code == 201
            pid = pr.json()["id"]
            session = SessionLocal()
            try:
                job = create_job(
                    session,
                    job_type="EFFECT_RENDER",
                    payload={"room_type": "living_room", "use_blender": False, "project_id": pid},
                )
                job.result = {
                    "outputUrl": f"/artifacts/paginate-{i}.png",
                    "provider": "mock",
                }
                job.status = "SUCCEEDED"
                session.commit()
                job_ids.append(job.id)
            finally:
                session.close()

        client.post("/v1/assets/backfill")

        all_assets = client.get("/v1/assets?limit=100").json()
        # Should have at least our 3
        assert len([a for a in all_assets if a["jobId"] in job_ids]) == 3

        page1 = client.get("/v1/assets?limit=1&offset=0").json()
        page2 = client.get("/v1/assets?limit=1&offset=1").json()
        page3 = client.get("/v1/assets?limit=1&offset=2").json()

        # Each page should have at most 1 asset
        assert len(page1) <= 1
        assert len(page2) <= 1
        assert len(page3) <= 1
        # Pages should not overlap
        ids1 = {a["id"] for a in page1}
        ids2 = {a["id"] for a in page2}
        ids3 = {a["id"] for a in page3}
        assert not (ids1 & ids2)
        assert not (ids2 & ids3)


def test_backfill_post_endpoint() -> None:
    with TestClient(app) as client:
        resp = client.post("/v1/assets/backfill")
        assert resp.status_code == 200
        data = resp.json()
        assert "backfilled" in data
        assert isinstance(data["backfilled"], int)
        assert data["backfilled"] >= 0


def test_job_list_filters() -> None:
    with TestClient(app) as client:
        pr = client.post("/v1/projects", json={"name": "JobList Filter"})
        assert pr.status_code == 201
        pid = pr.json()["id"]

        session = SessionLocal()
        try:
            job = create_job(
                session,
                job_type="EFFECT_RENDER",
                payload={"room_type": "living_room", "use_blender": False, "project_id": pid},
            )
            job.status = "SUCCEEDED"
            session.commit()
            job_id = job.id
        finally:
            session.close()

        # Filter by project_id
        resp = client.get(f"/v1/jobs?projectId={pid}")
        assert resp.status_code == 200
        jobs = resp.json()
        assert any(j["id"] == job_id for j in jobs)

        # Filter by status
        resp2 = client.get("/v1/jobs?status=SUCCEEDED")
        assert resp2.status_code == 200
        assert any(j["id"] == job_id for j in resp2.json())

        # No match
        resp3 = client.get("/v1/jobs?status=FAILED")
        assert resp3.status_code == 200
        assert not any(j["id"] == job_id for j in resp3.json())
'''

text = text.rstrip() + new_tests

p.write_text(text)
print("test_assets.py patched successfully")
