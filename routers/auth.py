"""生产鉴权：OIDC 与 JWT 桥接共用 signed session cookie。

部署路径：/app/routers/auth.py（由 platform 同步到 Game 仓）。
环境：SESSION_SECRET、OAUTH_COOKIE_SECURE（生产建议 1）。
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import Request, WebSocket
from fastapi.responses import JSONResponse, Response
from itsdangerous import URLSafeTimedSerializer

from app.passport_token import fetch_passport_profile

SESSION_COOKIE = "pb_session"
SERIALIZER = URLSafeTimedSerializer(os.environ["SESSION_SECRET"], salt="potatoblock-session")


def _cookie_secure() -> bool:
    """HTTPS 生产环境为 session cookie 设置 Secure。"""
    return os.environ.get("OAUTH_COOKIE_SECURE", "1").lower() in ("1", "true", "yes")


def _write_session_cookie(response: Response, user_id: str, nickname: str) -> None:
    """签发本站 signed session cookie。"""
    payload = {"user_id": str(user_id), "nickname": str(nickname or "")}
    token = SERIALIZER.dumps(payload)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        max_age=86400 * 7,
    )


async def establish_session_from_oidc(
    request: Request,
    response: JSONResponse,
    claims: dict[str, Any],
    access_token: str,
    id_token: str,
) -> None:
    """OIDC id_token 校验通过后写入 session cookie。"""
    user_id = str(claims["sub"])
    nickname = str(claims.get("nickname") or claims.get("email") or user_id)
    _write_session_cookie(response, user_id, nickname)


async def establish_session_from_passport_token(
    request: Request,
    token: str,
    response: Response,
    profile: dict[str, Any] | None = None,
) -> None:
    """JWT 桥接：校验 Passport token 后写入 session cookie。"""
    data = profile if profile is not None else fetch_passport_profile(token)
    user_id = str(data["user_id"])
    nickname = str(data.get("nickname") or "")
    _write_session_cookie(response, user_id, nickname)


async def get_optional_identity(request: Request):
    """从 session cookie 解析 (user_id, nickname)。"""
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return None
    try:
        data = SERIALIZER.loads(raw, max_age=86400 * 7)
        return str(data["user_id"]), str(data.get("nickname") or "")
    except Exception:
        return None


async def get_current_identity_ws(websocket: WebSocket):
    """WebSocket：从 cookie 读取身份。"""
    raw = websocket.cookies.get(SESSION_COOKIE)
    if not raw:
        return None
    try:
        data = SERIALIZER.loads(raw, max_age=86400 * 7)
        return str(data["user_id"]), str(data.get("nickname") or "")
    except Exception:
        return None


async def get_passport_nickname(user_id) -> str:
    """session 无昵称时的兜底（JWT 桥接登录时 nickname 已写入 cookie）。"""
    return ""
