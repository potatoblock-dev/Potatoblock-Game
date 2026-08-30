"""向 Passport 校验用户 JWT 并读取 profile。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


def passport_base_url() -> str:
    """读取通行证服务地址（生产 config 或环境变量）。"""
    try:
        from app.config import PASSPORT_BASE_URL

        return str(PASSPORT_BASE_URL).rstrip("/")
    except ImportError:
        return os.environ.get("PASSPORT_BASE_URL", "https://passport.potatoblock.com").rstrip("/")


def fetch_passport_profile(token: str) -> dict[str, Any]:
    """用 Bearer JWT 拉取 /api/v1/users/profile；失败抛 ValueError。"""
    token = str(token or "").strip()
    if not token:
        raise ValueError("missing passport token")
    url = f"{passport_base_url()}/api/v1/users/profile"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ValueError(f"passport profile HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ValueError(f"passport unreachable: {exc.reason}") from exc
    if payload.get("code") != 0:
        raise ValueError(str(payload.get("msg") or "invalid passport token"))
    data = payload.get("data") or {}
    user_id = data.get("id")
    if user_id is None:
        raise ValueError("passport profile missing user id")
    nickname = str(data.get("nickname") or "").strip()
    return {"user_id": int(user_id), "nickname": nickname}
