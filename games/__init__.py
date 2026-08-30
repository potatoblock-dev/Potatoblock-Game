import importlib
import pkgutil
from pathlib import Path

from fastapi.staticfiles import StaticFiles

import app.games


def _iter_game_packages():
    """遍历 games 下的游戏包目录，跳过 common 等非游戏模块。"""
    for _, module_name, ispkg in pkgutil.iter_modules(app.games.__path__):
        if not ispkg or module_name.startswith("_") or module_name == "common":
            continue
        yield module_name


def get_games():
    """返回所有游戏信息列表（不含 router 与 static_dir），供导航页使用。"""
    games = []
    for module_name in _iter_game_packages():
        module = importlib.import_module(f"app.games.{module_name}")
        if hasattr(module, "game_info"):
            info = module.game_info.copy()
            info.pop("router", None)
            info.pop("static_dir", None)
            games.append(info)
    games.sort(key=lambda g: (g.get("menu_order", 1000), str(g.get("name") or "")))
    return games


def register_routers(fastapi_app):
    """注册每个游戏的路由，并挂载其静态资源目录；顺带挂上 git 自动更新。"""
    for module_name in _iter_game_packages():
        module = importlib.import_module(f"app.games.{module_name}")
        if not hasattr(module, "game_info"):
            continue
        info = module.game_info
        if "router" in info:
            fastapi_app.include_router(info["router"])
        static_dir = info.get("static_dir")
        static_url = info.get("static_url")
        if not static_dir or not static_url:
            continue
        path = Path(static_dir)
        if not path.is_dir():
            continue
        mount_name = f"game-static-{info.get('id', module_name)}"
        fastapi_app.mount(
            static_url,
            StaticFiles(directory=str(path)),
            name=mount_name,
        )
    try:
        from app.pwa_routes import attach_pwa_routes
        attach_pwa_routes(fastapi_app)
    except ImportError:
        pass
    try:
        from app.auto_update import attach_auto_update
        attach_auto_update(fastapi_app)
    except ImportError:
        pass
