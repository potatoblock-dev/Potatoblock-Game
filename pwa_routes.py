"""PWA 与弹窗登录路由：挂载到 FastAPI 应用根路径。

由 app.games.register_routers 调用 attach_pwa_routes，无需改服务器 main.py。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from app.games.common.room_registry import find_reconnect_session
from app.routers.auth import get_optional_identity, get_passport_nickname

APP_ROOT = Path(__file__).resolve().parent
TEMPLATES = Jinja2Templates(directory=str(APP_ROOT / "templates"))
SW_PATH = APP_ROOT / "static" / "js" / "service-worker.js"
MANIFEST_PATH = APP_ROOT / "static" / "manifest.webmanifest"
FAVICON_PATH = APP_ROOT / "static" / "icons" / "favicon.ico"


async def _resolve_display_nickname(user_id: str, nickname: str) -> str:
    """会话昵称为空时向通行证重查，得到可展示的昵称。"""
    nick = str(nickname or "").strip()
    if nick:
        return nick
    fresh = await get_passport_nickname(user_id)
    return str(fresh or "").strip()


def attach_pwa_routes(app: FastAPI) -> None:
    """注册 Service Worker、Web Manifest 与弹窗登录完成页。"""

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon() -> FileResponse:
        """浏览器默认请求的标签页图标，与 PWA 图标同源。"""
        return FileResponse(
            FAVICON_PATH,
            media_type="image/x-icon",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    @app.get("/sw.js", include_in_schema=False)
    async def service_worker() -> FileResponse:
        """根路径 SW，scope 覆盖全站。"""
        return FileResponse(
            SW_PATH,
            media_type="application/javascript",
            headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
        )

    @app.get("/manifest.webmanifest", include_in_schema=False)
    @app.get("/static/manifest.webmanifest", include_in_schema=False)
    async def web_manifest() -> FileResponse:
        """返回 PWA 清单；带 charset，避免手机浏览器当纯文本打开时乱码。"""
        return FileResponse(
            MANIFEST_PATH,
            media_type="application/manifest+json; charset=utf-8",
            headers={"Cache-Control": "no-cache"},
        )

    @app.get("/pwa/login-done", response_class=HTMLResponse, include_in_schema=False)
    async def pwa_login_done(request: Request) -> HTMLResponse:
        """弹窗登录成功后通知 opener 并关闭。"""
        return TEMPLATES.TemplateResponse(
            request=request,
            name="login_popup_done.html",
            context={},
        )

    @app.get("/api/me", include_in_schema=False)
    async def current_user(identity=Depends(get_optional_identity)) -> JSONResponse:
        """返回当前登录用户的 UID 与可展示昵称（优先通行证昵称）。"""
        if identity is None:
            return JSONResponse({"user_id": None, "nickname": None})
        user_id, nickname = identity
        display = await _resolve_display_nickname(str(user_id), str(nickname or ""))
        return JSONResponse(
            {
                "user_id": str(user_id),
                "nickname": display or None,
            }
        )

    @app.get("/api/active-session", include_in_schema=False)
    async def active_session(identity=Depends(get_optional_identity)) -> JSONResponse:
        """返回当前登录用户可重连的游戏房间，供首页自动跳转。"""
        if identity is None:
            return JSONResponse({"session": None})
        user_id, _ = identity
        session = find_reconnect_session(str(user_id))
        return JSONResponse({"session": session})
