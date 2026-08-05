"""删除项目：必须先清 canvas_nodes，否则 Postgres FK 500。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal, init_db
from app.main import app
from app.models import Canvas, CanvasNode, Project, new_id, utc_now

init_db()


def test_delete_project_with_canvas_nodes() -> None:
    client = TestClient(app)
    created = client.post("/v1/projects", json={"name": "to-delete-with-canvas"})
    assert created.status_code in {200, 201}
    project_id = created.json()["id"]

    session = SessionLocal()
    try:
        canvas = Canvas(
            id=new_id("canvas"),
            project_id=project_id,
            name="画布 1",
            viewport_json={},
        )
        session.add(canvas)
        session.flush()
        node = CanvasNode(
            id=new_id("node"),
            canvas_id=canvas.id,
            asset_id=None,
            variant_id="v1",
            x=0,
            y=0,
            w=100,
            h=100,
            z=0,
        )
        session.add(node)
        session.commit()
    finally:
        session.close()

    deleted = client.delete(f"/v1/projects/{project_id}")
    assert deleted.status_code == 204, deleted.text
    listed = client.get("/v1/projects")
    assert listed.status_code == 200
    assert all(item["id"] != project_id for item in listed.json())
