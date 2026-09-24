"""弹跳旋转贴图工具：提供首页入口与单页 HTML。"""

from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, RedirectResponse

from app.routers.auth import get_optional_identity

router = APIRouter()

GAME_DIR = Path(__file__).resolve().parent
GAME_ID = "bounce_texture"
STATIC_URL = "/static/games/bounce-texture"

game_info = {
    "id": GAME_ID,
    "name": "弹跳旋转贴图",
    "logo": "/static/img/logo.svg",
    "url": "/bounce-texture",
    "menu_order": 25,
    "category": "tool",
    "router": router,
    "static_dir": GAME_DIR / "static",
    "static_url": STATIC_URL,
}


@router.get("/bounce-texture")
async def bounce_texture_page(request: Request, identity=Depends(get_optional_identity)):
    """登录后打开弹跳旋转贴图单页工具。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/bounce-texture", status_code=302)
    index = GAME_DIR / "static" / "index.html"
    return FileResponse(index, media_type="text/html; charset=utf-8")
