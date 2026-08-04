"""W0-d: Canvas persistence CRUD tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import init_db
from app.main import app

# Ensure tables exist regardless of test execution order
init_db()


def test_canvas_crud_lifecycle() -> None:
    with TestClient(app) as client:
        # 1. Create a project
        pr = client.post("/v1/projects", json={"name": "Canvas Test Project"})
        assert pr.status_code == 201
        project_id = pr.json()["id"]

        # 2. Create a canvas
        c1 = client.post("/v1/canvases", json={
            "projectId": project_id,
            "name": "Test Canvas",
            "viewportJson": {"x": 0, "y": 0, "zoom": 1},
        })
        assert c1.status_code == 201
        canvas_id = c1.json()["id"]
        assert c1.json()["name"] == "Test Canvas"
        assert c1.json()["projectId"] == project_id

        # 3. List canvases by project
        lst = client.get(f"/v1/canvases?projectId={project_id}")
        assert lst.status_code == 200
        assert any(c["id"] == canvas_id for c in lst.json())

        # 4. Get canvas (empty nodes)
        get_resp = client.get(f"/v1/canvases/{canvas_id}")
        assert get_resp.status_code == 200
        data = get_resp.json()
        assert data["id"] == canvas_id
        assert "nodes" in data
        assert data["nodes"] == []

        # 5. Create nodes
        n1 = client.post(f"/v1/canvases/{canvas_id}/nodes", json={
            "canvasId": canvas_id,
            "x": 10,
            "y": 20,
            "w": 100,
            "h": 80,
            "z": 1,
        })
        assert n1.status_code == 201
        node1_id = n1.json()["id"]
        assert n1.json()["x"] == 10

        n2 = client.post(f"/v1/canvases/{canvas_id}/nodes", json={
            "canvasId": canvas_id,
            "x": 50,
            "y": 60,
            "w": 200,
            "h": 150,
            "z": 2,
        })
        assert n2.status_code == 201
        node2_id = n2.json()["id"]

        # 6. Get canvas with nodes
        get2 = client.get(f"/v1/canvases/{canvas_id}")
        assert get2.status_code == 200
        nodes = get2.json()["nodes"]
        assert len(nodes) == 2
        assert nodes[0]["id"] == node1_id

        # 7. Batch patch nodes
        patch = client.patch(f"/v1/canvases/{canvas_id}/nodes/batch", json={
            "nodes": [
                {"id": node1_id, "x": 99, "y": 88},
                {"id": node2_id, "z": 5},
            ]
        })
        assert patch.status_code == 200
        patched = patch.json()
        assert len(patched) == 2
        node1_after = next(n for n in patched if n["id"] == node1_id)
        assert node1_after["x"] == 99
        assert node1_after["y"] == 88

        # 8. Soft delete node
        del_node = client.delete(f"/v1/canvases/{canvas_id}/nodes/{node1_id}")
        assert del_node.status_code == 200
        assert del_node.json()["status"] == "deleted"

        # Node no longer in canvas
        get3 = client.get(f"/v1/canvases/{canvas_id}")
        assert len(get3.json()["nodes"]) == 1
        assert get3.json()["nodes"][0]["id"] == node2_id

        # 9. Update canvas
        upd = client.patch(f"/v1/canvases/{canvas_id}", json={
            "projectId": project_id,
            "name": "Renamed Canvas",
            "viewportJson": {"x": 10, "y": 10},
        })
        assert upd.status_code == 200
        assert upd.json()["name"] == "Renamed Canvas"

        # 10. Soft delete canvas
        del_canvas = client.delete(f"/v1/canvases/{canvas_id}")
        assert del_canvas.status_code == 200
        assert del_canvas.json()["status"] == "deleted"

        # Canvas no longer listable
        lst2 = client.get(f"/v1/canvases?projectId={project_id}")
        assert not any(c["id"] == canvas_id for c in lst2.json())

        # Canvas not gettable
        get404 = client.get(f"/v1/canvases/{canvas_id}")
        assert get404.status_code == 404


def test_canvas_not_found() -> None:
    with TestClient(app) as client:
        assert client.get("/v1/canvases/missing").status_code == 404
        assert client.patch("/v1/canvases/missing", json={
            "projectId": "p_1", "name": "x"
        }).status_code == 404
        assert client.delete("/v1/canvases/missing").status_code == 404
        assert client.post("/v1/canvases/missing/nodes", json={
            "canvasId": "missing", "x": 0, "y": 0
        }).status_code == 404
        assert client.patch("/v1/canvases/missing/nodes/batch", json={
            "nodes": [{"id": "n_1", "x": 1}]
        }).status_code == 404
        assert client.delete("/v1/canvases/missing/nodes/n_1").status_code == 404


def test_node_not_found_and_cross_canvas_guard() -> None:
    with TestClient(app) as client:
        pr = client.post("/v1/projects", json={"name": "Guard Project"})
        pid = pr.json()["id"]
        c1 = client.post("/v1/canvases", json={"projectId": pid, "name": "C1"})
        cid1 = c1.json()["id"]
        c2 = client.post("/v1/canvases", json={"projectId": pid, "name": "C2"})
        cid2 = c2.json()["id"]
        n = client.post(f"/v1/canvases/{cid1}/nodes", json={"canvasId": cid1, "x": 0, "y": 0})
        nid = n.json()["id"]

        # Node from canvas 1 should not be batch-patchable via canvas 2
        patch = client.patch(f"/v1/canvases/{cid2}/nodes/batch", json={
            "nodes": [{"id": nid, "x": 99}]
        })
        assert patch.status_code == 200
        assert patch.json() == []  # skipped because cross-canvas

        # Node from canvas 1 should not be deletable via canvas 2
        assert client.delete(f"/v1/canvases/{cid2}/nodes/{nid}").status_code == 404
