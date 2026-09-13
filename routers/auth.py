"""认证：Passport OAuth2/OIDC（Authorization Code + PKCE）唯一登录入口。

流程：
    GET  /login            → 生成 state/PKCE/nonce 存 session，302 到 Passport /oauth/authorize
    GET  /pwa/login-done   → Passport 带 code+state 回跳：校验 state → 换 token →
                             验 id_token（JWKS/iss/aud/exp/nonce）→ 写本站 session → 回跳 next
    POST /logout           → 清本站 session

本站 session 只保存身份（user_id / nickname / auth_time），不保存任何 token：
Starlette 的会话 Cookie 是「签名可见」而非加密，放 token 等于把凭证交给浏览器。
"""

import hmac
import logging
import time
from typing import Any, Optional, Tuple
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from app import oauth_bridge
from app.config import PASSPORT_API_KEY, PASSPORT_BASE_URL
from app.passport_sdk import PotatoblockError, PotatoblockPassport

passport = PotatoblockPassport(
    base_url=PASSPORT_BASE_URL,
    api_key=PASSPORT_API_KEY
)
templates = Jinja2Templates(directory="app/templates")
router = APIRouter()
logger = logging.getLogger(__name__)

# session 里暂存的 OAuth 一次性上下文
FLOW_SESSION_KEY = "oauth_flow"
# 单次授权流程的有效期（秒）
FLOW_TTL_SECONDS = 600


def _safe_next_url(next_url: Optional[str]) -> str:
    """只允许站内跳转，避免登录接口被用于开放重定向。

    仅靠 ``startswith("/")`` 不够：浏览器会把 URL 里的 ``\\`` 规范化为 ``/``，
    于是 ``/\\evil.example`` 会变成协议相对的 ``//evil.example``；``%2f`` / ``%5c``
    这类编码同理。因此这里直接拒绝反斜杠、控制字符与编码后的分隔符。
    """
    raw = str(next_url or "").strip()
    if not raw:
        return "/"

    lowered = raw.lower()
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in raw):
        return "/"
    if "\\" in raw or "%2f" in lowered or "%5c" in lowered:
        return "/"

    try:
        parsed = urlsplit(raw)
    except ValueError:
        return "/"

    path = parsed.path
    if (
        parsed.scheme
        or parsed.netloc
        or not path.startswith("/")
        or path.startswith("//")
        or "\\" in path
    ):
        return "/"
    return path + (f"?{parsed.query}" if parsed.query else "")


def _error_response(request: Request, message: str, status_code: int) -> HTMLResponse:
    """登录失败页：给出原因并允许重试，不泄露底层细节。"""
    return templates.TemplateResponse(
        request=request,
        name="oauth_error.html",
        context={"message": message, "login_url": "/login"},
        status_code=status_code,
    )


@router.get("/login", response_class=HTMLResponse)
async def login(request: Request):
    """登录入口：302 跳转 Passport 授权页（Authorization Code + PKCE）。"""
    next_url = _safe_next_url(request.query_params.get("next"))
    if request.session.get("user_id") is not None:
        return RedirectResponse(url=next_url, status_code=302)

    settings = oauth_bridge.resolve_settings(
        request.url.hostname or "", str(request.base_url)
    )
    if not settings.configured:
        logger.error(
            "OAuth 登录不可用：client_id/client_secret/redirect_uri 未配置完整"
        )
        return _error_response(request, "通行证登录未配置，请联系站点管理员。", 503)

    verifier = oauth_bridge.new_code_verifier()
    flow = {
        "state": oauth_bridge.new_state(),
        "verifier": verifier,
        "nonce": oauth_bridge.new_nonce(),
        "next": next_url,
        # 换票时必须与授权请求逐字符一致
        "redirect_uri": settings.redirect_uri,
        "started_at": time.time(),
    }
    request.session[FLOW_SESSION_KEY] = flow

    try:
        authorize_url = oauth_bridge.build_authorize_url(
            settings,
            state=flow["state"],
            nonce=flow["nonce"],
            challenge=oauth_bridge.code_challenge(verifier),
        )
    except oauth_bridge.OAuthError as error:
        logger.error("构造 Passport 授权地址失败: %s", error)
        request.session.pop(FLOW_SESSION_KEY, None)
        return _error_response(request, "通行证服务暂不可用，请稍后再试。", 502)

    logger.info("跳转 Passport 授权，client_id=%s", settings.client_id)
    return RedirectResponse(url=authorize_url, status_code=302)


async def oauth_callback(request: Request) -> RedirectResponse | HTMLResponse:
    """Passport 授权回调：校验 state → 换 token → 验 id_token → 建立本站会话。"""
    flow = request.session.pop(FLOW_SESSION_KEY, None) or {}
    settings = oauth_bridge.resolve_settings(
        request.url.hostname or "", str(request.base_url)
    )

    error = (request.query_params.get("error") or "").strip()
    if error:
        logger.warning(
            "Passport 返回授权错误: %s (%s)",
            error,
            request.query_params.get("error_description") or "",
        )
        return _error_response(request, "通行证授权未完成，请重新登录。", 401)

    code = (request.query_params.get("code") or "").strip()
    state = (request.query_params.get("state") or "").strip()
    saved_state = str(flow.get("state") or "")
    verifier = str(flow.get("verifier") or "")

    if not code or not saved_state or not verifier:
        logger.warning("OAuth 回调缺少 code 或一次性上下文（可能重复回调/换浏览器）")
        return _error_response(request, "登录状态已失效，请重新登录。", 400)
    if not hmac.compare_digest(state, saved_state):
        logger.warning("OAuth 回调 state 不匹配，已拒绝")
        return _error_response(request, "登录状态校验失败，请重新登录。", 400)
    if time.time() - float(flow.get("started_at") or 0) > FLOW_TTL_SECONDS:
        logger.warning("OAuth 授权流程超时")
        return _error_response(request, "登录已超时，请重新登录。", 400)
    if not settings.configured:
        return _error_response(request, "通行证登录未配置，请联系站点管理员。", 503)

    redirect_uri = str(flow.get("redirect_uri") or settings.redirect_uri)
    try:
        tokens = await run_in_threadpool(
            oauth_bridge.exchange_code, settings, code, verifier, redirect_uri
        )
        id_token = str(tokens.get("id_token") or "")
        if not id_token:
            raise oauth_bridge.OAuthError("token 响应缺少 id_token")
        claims = await run_in_threadpool(
            oauth_bridge.verify_id_token, settings, id_token, flow.get("nonce")
        )
    except oauth_bridge.OAuthError as exc:
        logger.warning("OAuth 换取/校验 token 失败: %s", exc)
        return _error_response(request, "通行证校验失败，请重新登录。", 401)

    try:
        user_id = int(str(claims.get("sub") or ""))
    except ValueError:
        logger.warning("id_token sub 不是本站可用的用户 ID: %r", claims.get("sub"))
        return _error_response(request, "通行证身份异常，请重新登录。", 401)

    nickname = await _resolve_nickname(
        user_id, claims, tokens.get("access_token"), settings
    )

    request.session.clear()
    request.session["user_id"] = user_id
    request.session["nickname"] = nickname
    request.session["auth_time"] = int(claims.get("auth_time") or time.time())
    logger.info("OAuth 登录成功: user_id=%s", user_id)

    return RedirectResponse(url=_safe_next_url(flow.get("next")), status_code=303)


async def _resolve_nickname(
    user_id: int,
    claims: dict[str, Any],
    access_token: Any,
    settings: oauth_bridge.OAuthSettings,
) -> str:
    """昵称优先级：id_token claims → userinfo → 通行证资料接口。"""
    nickname = str(claims.get("nickname") or "").strip()
    if nickname:
        return nickname

    token = str(access_token or "")
    if token:
        try:
            info = await run_in_threadpool(oauth_bridge.fetch_userinfo, settings, token)
        except oauth_bridge.OAuthError:
            logger.warning("userinfo 拉取失败，尝试通行证资料接口", exc_info=True)
        else:
            info = info if isinstance(info, dict) else {}
            nickname = str(info.get("nickname") or "").strip()
            if nickname:
                return nickname

    try:
        return await get_passport_nickname(user_id)
    except PotatoblockError:
        logger.warning("通行证昵称读取失败，使用空昵称降级", exc_info=True)
        return ""


@router.post("/logout")
async def logout(request: Request):
    """登出：只清本站会话（Provider 无 end_session 端点，Passport SSO 保持）。"""
    request.session.clear()
    return RedirectResponse(url="/", status_code=303)


async def get_current_user(request: Request) -> int:
    user_id = request.session.get("user_id")
    if user_id is None:
        raise HTTPException(status_code=401, detail="未登录")
    return int(user_id)


async def get_optional_user(request: Request) -> Optional[int]:
    user_id = request.session.get("user_id")
    return int(user_id) if user_id is not None else None


async def get_passport_nickname(user_id: int) -> str:
    """从通行证用户信息接口读取用于展示的昵称。"""
    user_info = await run_in_threadpool(passport.get_user_info, user_id)
    return str(user_info.get("nickname", "")).strip()


async def get_optional_identity(request: Request) -> Optional[Tuple[int, str]]:
    """获取 HTTP 会话中的 UID 和通行证昵称。"""
    user_id = request.session.get("user_id")
    if user_id is None:
        return None
    user_id = int(user_id)
    if "nickname" not in request.session:
        try:
            request.session["nickname"] = await get_passport_nickname(user_id)
        except PotatoblockError:
            logger.warning("页面读取通行证昵称失败，使用空昵称降级", exc_info=True)
            request.session["nickname"] = ""
    nickname = str(request.session.get("nickname", "")).strip()
    return user_id, nickname


async def get_current_identity_ws(websocket: WebSocket) -> Optional[Tuple[int, str]]:
    """获取 WebSocket 会话中的 UID 和可信通行证昵称。"""
    session = websocket.scope.get("session", {})
    user_id = session.get("user_id")
    if user_id is None:
        await websocket.close(code=4001, reason="未登录")
        return None
    user_id = int(user_id)
    if "nickname" not in session:
        try:
            session["nickname"] = await get_passport_nickname(user_id)
        except PotatoblockError:
            logger.warning("WebSocket 读取通行证昵称失败，使用备用昵称", exc_info=True)
            session["nickname"] = ""
    nickname = str(session.get("nickname", "")).strip()
    return user_id, nickname


async def get_current_user_ws(websocket: WebSocket) -> Optional[int]:
    user_id = websocket.scope.get("session", {}).get("user_id")
    if user_id is None:
        await websocket.close(code=4001, reason="未登录")
        return None
    return int(user_id)
