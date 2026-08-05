"""
公网演示用简单账号鉴权。

环境变量同时配置 AUTH_USERNAME + AUTH_PASSWORD 后启用；
本地开发不配则关闭，行为与原来一致。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from fastapi import HTTPException, Request

from app.config import settings


def auth_enabled() -> bool:
    return bool(settings.auth_username.strip() and settings.auth_password)


def _signing_key() -> bytes:
    secret = (settings.auth_secret or "").strip()
    if not secret:
        # 未单独配置 secret 时，由账号密码派生（重启后旧 token 失效可接受）
        secret = f"{settings.auth_username}:{settings.auth_password}:room_design_demo"
    return hashlib.sha256(secret.encode("utf-8")).digest()


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def issue_token(username: str, *, ttl_seconds: int | None = None) -> dict[str, Any]:
    ttl = ttl_seconds if ttl_seconds is not None else int(settings.auth_token_ttl_hours * 3600)
    now = int(time.time())
    payload = {
        "sub": username,
        "iat": now,
        "exp": now + max(300, ttl),
        "jti": secrets.token_hex(8),
    }
    body = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    sig = _b64url_encode(
        hmac.new(_signing_key(), body.encode("ascii"), hashlib.sha256).digest()
    )
    return {
        "token": f"{body}.{sig}",
        "username": username,
        "expiresAt": payload["exp"],
        "tokenType": "Bearer",
    }


def verify_token(token: str) -> dict[str, Any]:
    try:
        body, sig = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="无效的登录凭证") from exc
    expected = _b64url_encode(
        hmac.new(_signing_key(), body.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录")
    try:
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="无效的登录凭证") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=401, detail="无效的登录凭证")
    exp = payload.get("exp")
    if not isinstance(exp, int) or exp < int(time.time()):
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        raise HTTPException(status_code=401, detail="无效的登录凭证")
    return payload


def authenticate_password(username: str, password: str) -> bool:
    user_ok = hmac.compare_digest(
        username.encode("utf-8"),
        settings.auth_username.strip().encode("utf-8"),
    )
    pass_ok = hmac.compare_digest(
        password.encode("utf-8"),
        settings.auth_password.encode("utf-8"),
    )
    return bool(user_ok and pass_ok)


def extract_bearer_token(request: Request) -> str | None:
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        token = auth[7:].strip()
        return token or None
    # 兼容 cookie（同源反代时 img/页面可用）
    cookie = request.cookies.get("room_design_token")
    if cookie and cookie.strip():
        return cookie.strip()
    return None


def is_public_path(path: str, method: str) -> bool:
    if method == "OPTIONS":
        return True
    if path in {"/health", "/docs", "/openapi.json", "/redoc"}:
        return True
    if path.startswith("/artifacts/") or path.startswith("/examples/"):
        return True
    prefix = settings.api_prefix.rstrip("/")
    if path in {
        f"{prefix}/auth/login",
        f"{prefix}/auth/status",
    }:
        return True
    return False


# 简易登录限流：IP → (window_start, count)
_login_hits: dict[str, tuple[float, int]] = {}
_LOGIN_WINDOW = 300.0
_LOGIN_MAX = 20


def check_login_rate_limit(client_ip: str) -> None:
    now = time.time()
    start, count = _login_hits.get(client_ip, (now, 0))
    if now - start > _LOGIN_WINDOW:
        _login_hits[client_ip] = (now, 1)
        return
    if count >= _LOGIN_MAX:
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后再试")
    _login_hits[client_ip] = (start, count + 1)
