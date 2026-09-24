"""OAuth2/OIDC 客户端：向 Passport 换票并校验 id_token。"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import jwt
from jwt import PyJWKClient

_ISSUER = os.environ.get("OAUTH_ISSUER", "https://passport.potatoblock.com").rstrip("/")
_CLIENT_ID = os.environ.get("OAUTH_CLIENT_ID", "potatoblock-game")
_CLIENT_SECRET = os.environ.get("OAUTH_CLIENT_SECRET", "")
_JWKS_CLIENT: PyJWKClient | None = None


def _jwks_client() -> PyJWKClient:
    """懒加载 JWKS 客户端，缓存 Passport 公钥。"""
    global _JWKS_CLIENT
    if _JWKS_CLIENT is None:
        _JWKS_CLIENT = PyJWKClient(f"{_ISSUER}/oauth/jwks")
    return _JWKS_CLIENT


def exchange_authorization_code(
    code: str,
    redirect_uri: str,
    code_verifier: str,
) -> dict[str, Any]:
    """用 authorization code 向 Passport token 端点换 access_token 与 id_token。"""
    client_id = os.environ.get("OAUTH_CLIENT_ID", _CLIENT_ID)
    client_secret = os.environ.get("OAUTH_CLIENT_SECRET", _CLIENT_SECRET)
    if not client_secret:
        raise RuntimeError("OAUTH_CLIENT_SECRET not configured")
    body = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "client_secret": client_secret,
            "code_verifier": code_verifier,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{_ISSUER}/oauth/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"token exchange failed: {detail}") from exc


def validate_id_token(id_token: str, nonce: str | None = None) -> dict[str, Any]:
    """校验 OIDC id_token 签名与 aud/iss/exp；返回 claims。"""
    client_id = os.environ.get("OAUTH_CLIENT_ID", _CLIENT_ID)
    signing_key = _jwks_client().get_signing_key_from_jwt(id_token)
    claims = jwt.decode(
        id_token,
        signing_key.key,
        algorithms=["RS256"],
        audience=client_id,
        issuer=_ISSUER,
        options={"require": ["exp", "iat", "sub"]},
    )
    if nonce and claims.get("nonce") != nonce:
        raise jwt.InvalidTokenError("nonce mismatch")
    return claims
