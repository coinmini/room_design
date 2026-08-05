"""公网演示鉴权：登录 + 保护业务 API。"""

from __future__ import annotations

from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.config import settings
from app.database import init_db
from app.main import app

init_db()


def test_auth_disabled_when_credentials_empty(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_username", "")
    monkeypatch.setattr(settings, "auth_password", "")
    client = TestClient(app)
    status = client.get("/v1/auth/status")
    assert status.status_code == 200
    assert status.json()["enabled"] is False
    projects = client.get("/v1/projects")
    assert projects.status_code == 200


def test_auth_required_when_credentials_configured(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_username", "tester")
    monkeypatch.setattr(settings, "auth_password", "s3cret-pass")
    monkeypatch.setattr(settings, "auth_secret", "unit-test-secret")
    monkeypatch.setattr(settings, "auth_token_ttl_hours", 24.0)

    client = TestClient(app)

    denied = client.get("/v1/projects")
    assert denied.status_code == 401

    bad = client.post(
        "/v1/auth/login",
        json={"username": "tester", "password": "wrong"},
    )
    assert bad.status_code == 401

    ok = client.post(
        "/v1/auth/login",
        json={"username": "tester", "password": "s3cret-pass"},
    )
    assert ok.status_code == 200, ok.text
    token = ok.json()["token"]
    assert token
    assert ok.json()["username"] == "tester"

    listed = client.get(
        "/v1/projects",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert listed.status_code == 200

    me = client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me.status_code == 200
    assert me.json()["username"] == "tester"

    assert client.get("/health").status_code == 200
    st = client.get("/v1/auth/status")
    assert st.status_code == 200
    assert st.json()["enabled"] is True
