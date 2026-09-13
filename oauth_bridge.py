"""Passport OAuth2/OIDC 客户端：Authorization Code + PKCE。

对齐 Passport 的 OIDC 实现（见 Passport 仓库 docs/OAUTH.md）：

* 端点全部来自 ``/.well-known/openid-configuration``，不硬编码路径；
* Provider 强制 PKCE，因此必须带 ``code_challenge``(S256) / ``code_verifier``；
* token 端点用 ``client_secret_post``（Provider 同时支持 basic）；
* id_token 用 JWKS 验签，并校验 iss / aud / exp / nonce。

client_id、client_secret、redirect_uri 由 ``config/site.yml`` 的 ``oauth.clients``
按访问域名选择（本地走 ``localhost`` profile，其余走 ``default``）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

import jwt
from jwt import PyJWKClient

from app.config import (
    OAUTH_CLIENT_PROFILES,
    OAUTH_ISSUER,
    OAUTH_REDIRECT_PATH,
    OAUTH_SCOPE,
    oauth_profile_name,
)

# Discovery 文档缓存时长（秒）
DISCOVERY_TTL_SECONDS = 3600
_HTTP_TIMEOUT_SECONDS = 15

_DISCOVERY_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_JWKS_CLIENTS: dict[str, PyJWKClient] = {}


class OAuthError(RuntimeError):
    """OAuth/OIDC 流程中的可预期错误（配置缺失、换票失败、校验不通过）。"""


@dataclass(frozen=True)
class OAuthSettings:
    """一次登录所使用的 OIDC client 配置。"""

    issuer: str
    client_id: str
    client_secret: str
    redirect_uri: str
    scope: str

    @property
    def configured(self) -> bool:
        """三项都齐全才算可用；缺 secret 时 Provider 会直接 invalid_client。"""
        return bool(self.issuer and self.client_id and self.client_secret and self.redirect_uri)


def resolve_settings(host: str, base_url: str) -> OAuthSettings:
    """按访问域名选择 config/site.yml 里的 client profile。"""
    profile = OAUTH_CLIENT_PROFILES.get(oauth_profile_name(host)) or {}
    if not isinstance(profile, dict):
        profile = {}

    redirect_uri = str(profile.get("redirect_uri") or "").strip()
    if not redirect_uri:
        # 未显式配置时按请求 origin 推导，方便本地起在注册过的端口上
        redirect_uri = str(base_url or "").rstrip("/") + OAUTH_REDIRECT_PATH

    return OAuthSettings(
        issuer=OAUTH_ISSUER,
        client_id=str(profile.get("client_id") or "").strip(),
        client_secret=str(profile.get("client_secret") or "").strip(),
        redirect_uri=redirect_uri,
        scope=OAUTH_SCOPE,
    )


# ---------- PKCE / state / nonce ----------


def new_code_verifier() -> str:
    """生成 43–128 字符的 code_verifier（RFC 7636 §4.1）。"""
    return secrets.token_urlsafe(48)


def code_challenge(verifier: str) -> str:
    """code_verifier 的 S256 challenge。"""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def new_state() -> str:
    """防 CSRF 的 state。"""
    return secrets.token_urlsafe(24)


def new_nonce() -> str:
    """防重放的 OIDC nonce。"""
    return secrets.token_urlsafe(24)


# ---------- HTTP ----------


def _request_json(
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    method: str = "GET",
) -> dict[str, Any]:
    """请求 JSON 端点；HTTP 错误体里的 OAuth error 直接冒泡为 OAuthError。"""
    request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise OAuthError(_describe_error(detail, exc.code)) from exc
    except urllib.error.URLError as exc:
        raise OAuthError(f"无法连接通行证服务: {exc.reason}") from exc
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise OAuthError(f"通行证响应不是合法 JSON: {raw[:200]}") from exc
    if not isinstance(payload, dict):
        raise OAuthError("通行证响应不是 JSON 对象")
    return payload


def _describe_error(detail: str, status: int) -> str:
    """从 OAuth 错误响应里取出可读原因，不回显整段 body。"""
    try:
        payload = json.loads(detail)
    except ValueError:
        return f"HTTP {status}"
    if isinstance(payload, dict):
        message = payload.get("error_description") or payload.get("error") or payload.get("msg")
        if message:
            return str(message)
    return f"HTTP {status}"


def discovery(settings: OAuthSettings) -> dict[str, Any]:
    """读取并缓存 OIDC Discovery 文档。"""
    now = time.time()
    cached = _DISCOVERY_CACHE.get(settings.issuer)
    if cached and cached[0] > now:
        return cached[1]

    url = f"{settings.issuer}/.well-known/openid-configuration"
    document = _request_json(url)
    for required in ("authorization_endpoint", "token_endpoint"):
        if not document.get(required):
            raise OAuthError(f"Discovery 文档缺少 {required}")
    # OIDC Discovery 1.0 §4.3：issuer 必须与配置一致
    if str(document.get("issuer") or "").rstrip("/") != settings.issuer:
        raise OAuthError(f"Discovery issuer 不匹配: {document.get('issuer')}")

    _DISCOVERY_CACHE[settings.issuer] = (now + DISCOVERY_TTL_SECONDS, document)
    return document


def build_authorize_url(
    settings: OAuthSettings,
    *,
    state: str,
    nonce: str,
    challenge: str,
) -> str:
    """拼接 /oauth/authorize 跳转 URL（response_type=code + PKCE S256）。"""
    params = {
        "response_type": "code",
        "client_id": settings.client_id,
        "redirect_uri": settings.redirect_uri,
        "scope": settings.scope,
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    endpoint = str(discovery(settings)["authorization_endpoint"])
    return f"{endpoint}?{urllib.parse.urlencode(params)}"


def exchange_code(
    settings: OAuthSettings,
    code: str,
    code_verifier: str,
    redirect_uri: str,
) -> dict[str, Any]:
    """用 authorization code 换 token（client_secret_post + PKCE）。"""
    if not settings.configured:
        raise OAuthError("OAuth client 未配置完整（缺少 client_id/client_secret/redirect_uri）")
    body = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": settings.client_id,
            "client_secret": settings.client_secret,
            "code_verifier": code_verifier,
        }
    ).encode("utf-8")
    endpoint = str(discovery(settings)["token_endpoint"])
    tokens = _request_json(
        endpoint,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    if not tokens.get("access_token"):
        raise OAuthError("token 响应缺少 access_token")
    return tokens


def verify_id_token(settings: OAuthSettings, id_token: str, nonce: str | None = None) -> dict[str, Any]:
    """用 JWKS 验签 id_token，并校验 iss / aud / exp / nonce。"""
    document = discovery(settings)
    jwks_uri = str(document.get("jwks_uri") or f"{settings.issuer}/oauth/jwks")
    algorithms = list(document.get("id_token_signing_alg_values_supported") or ["RS256"])

    client = _JWKS_CLIENTS.get(jwks_uri)
    if client is None:
        client = PyJWKClient(jwks_uri)
        _JWKS_CLIENTS[jwks_uri] = client

    try:
        signing_key = client.get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=algorithms,
            audience=settings.client_id,
            issuer=settings.issuer,
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise OAuthError(f"id_token 校验失败: {exc}") from exc

    if nonce is not None and not hmac.compare_digest(str(claims.get("nonce") or ""), nonce):
        raise OAuthError("id_token nonce 不匹配")
    return claims


def fetch_userinfo(settings: OAuthSettings, access_token: str) -> dict[str, Any]:
    """用 access_token 拉取 OIDC userinfo（补充昵称等资料）。"""
    endpoint = discovery(settings).get("userinfo_endpoint")
    if not endpoint:
        raise OAuthError("Discovery 文档缺少 userinfo_endpoint")
    return _request_json(
        str(endpoint),
        headers={"Authorization": f"Bearer {access_token}"},
    )
