"""PWA 与 OAuth 登录路由：挂载到 FastAPI 应用根路径。

由 app.games.register_routers 调用 attach_pwa_routes，无需改服务器 main.py。
"""

from __future__ import annotations

import importlib
import os
from pathlib import Path
from urllib.parse import quote, urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from app.games.common.room_registry import find_reconnect_session
from app.oauth_bridge import exchange_authorization_code, validate_id_token
from app.passport_token import fetch_passport_profile
from app.routers.auth import get_optional_identity, get_passport_nickname

APP_ROOT = Path(__file__).resolve().parent
TEMPLATES = Jinja2Templates(directory=str(APP_ROOT / "templates"))
SW_PATH = APP_ROOT / "static" / "js" / "service-worker.js"
MANIFEST_PATH = APP_ROOT / "static" / "manifest.webmanifest"
FAVICON_PATH = APP_ROOT / "static" / "icons" / "favicon.ico"
PASSPORT_ORIGIN = "https://passport.potatoblock.com"


def _passport_cors_headers(request: Request) -> dict[str, str]:
    """允许 passport 站跨域调用 passport-session（fetch 桥接备用）。"""
    origin = (request.headers.get("origin") or "").strip()
    if origin == PASSPORT_ORIGIN:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
        }
    return {}


def _passport_login_retry_url(return_url: str | None) -> str:
    """桥接失败时回到 Passport 登录页，并尽量保留 return_url。"""
    base = f"{PASSPORT_ORIGIN}/login"
    raw = str(return_url or "").strip()
    if not raw:
        return base
    return f"{base}?return_url={quote(raw, safe='')}"


def _bridge_error_response(
    request: Request,
    *,
    message: str,
    status_code: int,
    wants_json: bool,
    return_url: str | None = None,
) -> HTMLResponse | JSONResponse:
    """表单 POST 失败时返回 HTML 错误页，避免平板出现 JSON 白屏。"""
    if wants_json:
        return JSONResponse({"ok": False, "error": message}, status_code=status_code)
    retry = _passport_login_retry_url(return_url)
    return TEMPLATES.TemplateResponse(
        request=request,
        name="passport_bridge_error.html",
        context={"message": message, "retry_url": retry},
        status_code=status_code,
    )


async def _resolve_display_nickname(user_id: str, nickname: str) -> str:
    """会话昵称为空时向通行证重查，得到可展示的昵称。"""
    nick = str(nickname or "").strip()
    if nick:
        return nick
    fresh = await get_passport_nickname(user_id)
    return str(fresh or "").strip()


def _safe_return_url(raw: str | None, request: Request) -> str:
    """仅允许站内相对路径回跳。"""
    if not raw:
        return "/"
    try:
        parsed = urlsplit(str(raw).strip())
    except ValueError:
        return "/"
    if parsed.scheme or parsed.netloc:
        if parsed.netloc and parsed.netloc != request.url.netloc:
            return "/"
        path = parsed.path or "/"
        if not path.startswith("/"):
            return "/"
        return path + (f"?{parsed.query}" if parsed.query else "")
    path = parsed.path or str(raw)
    if not path.startswith("/"):
        return "/"
    return path + (f"?{parsed.query}" if parsed.query else "")


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
        """OAuth 回调页：用 code 换票并通知原标签页。"""
        return TEMPLATES.TemplateResponse(
            request=request,
            name="login_popup_done.html",
            context={},
        )

    @app.post("/pwa/oauth/callback", include_in_schema=False)
    async def oauth_callback(request: Request) -> JSONResponse:
        """服务端用 authorization code 换 OIDC token 并建立本站 session。"""
        body = await request.json()
        code = str(body.get("code") or "").strip()
        code_verifier = str(body.get("code_verifier") or "").strip()
        nonce = str(body.get("nonce") or "").strip() or None
        if not code or not code_verifier:
            return JSONResponse({"ok": False, "error": "missing code"}, status_code=400)
        redirect_uri = str(body.get("redirect_uri") or "").strip()
        if not redirect_uri:
            redirect_uri = str(request.base_url).rstrip("/") + "/pwa/login-done"
        host = request.url.hostname or ""
        client_id = "potatoblock-game-dev" if host in ("localhost", "127.0.0.1") else "potatoblock-game"
        os.environ["OAUTH_CLIENT_ID"] = client_id
        try:
            tokens = exchange_authorization_code(code, redirect_uri, code_verifier)
        except RuntimeError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        id_token = str(tokens.get("id_token") or "")
        access_token = str(tokens.get("access_token") or "")
        if not id_token:
            return JSONResponse({"ok": False, "error": "missing id_token"}, status_code=400)
        try:
            claims = validate_id_token(id_token, nonce=nonce)
        except Exception as exc:
            return JSONResponse({"ok": False, "error": f"invalid id_token: {exc}"}, status_code=400)
        auth_mod = importlib.import_module("app.routers.auth")
        handler = getattr(auth_mod, "establish_session_from_oidc", None)
        if handler is None:
            raise HTTPException(status_code=501, detail="oidc session bridge not configured")
        json_resp = JSONResponse({"ok": True, "sub": claims.get("sub")})
        await handler(request, json_resp, claims, access_token, id_token)
        return json_resp

    @app.options("/pwa/passport-session", include_in_schema=False)
    async def passport_session_options(request: Request) -> Response:
        """CORS 预检：passport 桥接页 fetch 备用。"""
        headers = _passport_cors_headers(request)
        headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        headers["Access-Control-Allow-Headers"] = "Content-Type"
        return Response(status_code=204, headers=headers)

    @app.post("/pwa/passport-session", include_in_schema=False)
    async def passport_session(request: Request):
        """Passport JWT 桥接：校验 token 后写入本站 session（旧登录后端）。"""
        token = ""
        return_url = "/"
        content_type = (request.headers.get("content-type") or "").lower()
        wants_json = "application/json" in content_type
        if wants_json:
            body = await request.json()
            token = str(body.get("token") or "").strip()
            return_url = str(body.get("return") or body.get("return_url") or "/")
        else:
            form = await request.form()
            token = str(form.get("token") or "").strip()
            return_url = str(form.get("return") or form.get("return_url") or "/")

        cors = _passport_cors_headers(request)

        if not token:
            resp = _bridge_error_response(
                request,
                message="缺少登录凭证，请重新登录。",
                status_code=400,
                wants_json=wants_json,
                return_url=return_url,
            )
            if cors and isinstance(resp, JSONResponse):
                resp.headers.update(cors)
            return resp

        try:
            profile = await run_in_threadpool(fetch_passport_profile, token)
        except ValueError as exc:
            resp = _bridge_error_response(
                request,
                message=f"通行证验证失败（{exc}），请重新登录。",
                status_code=401,
                wants_json=wants_json,
                return_url=return_url,
            )
            if cors and isinstance(resp, JSONResponse):
                resp.headers.update(cors)
            return resp

        safe_return = _safe_return_url(return_url, request)
        if wants_json:
            resp = JSONResponse({"ok": True, "user_id": profile["user_id"], "return": safe_return})
        else:
            resp = RedirectResponse(url=safe_return, status_code=303)

        auth_mod = importlib.import_module("app.routers.auth")
        handler = getattr(auth_mod, "establish_session_from_passport_token", None)
        if handler is not None:
            try:
                await handler(request, token, resp, profile)
            except TypeError:
                await handler(request, token)
        elif hasattr(request, "session"):
            request.session.clear()
            request.session["user_id"] = profile["user_id"]
            request.session["nickname"] = profile.get("nickname") or ""

        if wants_json:
            resp.headers.update(cors)
        return resp

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
