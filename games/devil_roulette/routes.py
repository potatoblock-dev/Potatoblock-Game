"""恶魔轮盘赌 HTTP 与 WebSocket 路由。"""

import asyncio
import json
import logging
import random
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.error_codes import create_error_code
from app.games.common.lobby import (
    generate_random_room_id as lobby_generate_random_room_id,
    is_valid_deep_link_room_id as lobby_is_valid_deep_link_room_id,
    list_joinable_lobby_rooms as lobby_list_joinable_lobby_rooms,
)
from app.games.common.room_registry import evict_from_other_games, register_game
from app.games.devil_roulette.game_logic import DevilRouletteGame, PlayerState
from app.games.devil_roulette.protocol import (
    DISCONNECT_GRACE_SECONDS,
    MAX_PLAYERS,
    MIN_PLAYERS,
    PROTOCOL_VERSION,
)
from app.routers.auth import get_current_identity_ws, get_optional_identity

templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))
router = APIRouter()
logger = logging.getLogger(__name__)

GAME_DIR = Path(__file__).resolve().parent
GAME_ID = "devil_roulette"
STATIC_URL = "/static/games/devil-roulette"

game_info = {
    "id": GAME_ID,
    "name": "恶魔轮盘赌",
    "logo": "/static/img/logo.svg",
    "url": "/devil-roulette",
    "menu_order": 25,
    "router": router,
    "static_dir": GAME_DIR / "static",
    "static_url": STATIC_URL,
}

RESERVED_SEGMENTS = frozenset({"random-room", "ws", "sprites-preview"})

rooms: Dict[str, Dict] = {}
player_rooms: Dict[str, str] = {}
timed_out_rooms: Dict[str, str] = {}


def is_valid_room_path_id(room_id: str) -> bool:
    """校验可放进 /devil-roulette/{room} 路径的房间号。"""
    return lobby_is_valid_deep_link_room_id(room_id, RESERVED_SEGMENTS)


def list_joinable_lobby_rooms() -> List[str]:
    """返回可随机加入的大厅房间。"""
    return lobby_list_joinable_lobby_rooms(rooms)


def generate_random_room_id() -> str:
    """生成随机房间号。"""
    return lobby_generate_random_room_id(rooms)


def create_room(room_id: str) -> Dict:
    """创建新房间容器。"""
    return {
        "room_id": room_id,
        "owner_id": None,
        "phase": "lobby",
        "players": {},
        "game": DevilRouletteGame(),
    }


def serialize_players(room: Dict) -> List[Dict[str, object]]:
    """序列化房间成员列表。"""
    owner_id = room.get("owner_id")
    return [
        {
            "uid": pid,
            "name": pdata["name"],
            "is_host": pid == owner_id,
            "connected": pdata["connected"],
        }
        for pid, pdata in room["players"].items()
    ]


def build_room_state(room: Dict, player_id: str) -> Dict:
    """构造进房/重连时的房间状态。"""
    game: DevilRouletteGame = room["game"]
    state = {
        "type": "room_state",
        "protocolVersion": PROTOCOL_VERSION,
        "room_id": room["room_id"],
        "self_id": player_id,
        "owner_id": room.get("owner_id") or "",
        "phase": room.get("phase", "lobby"),
        "players": serialize_players(room),
    }
    if room.get("phase") == "playing" or game.phase in ("playing", "game_over"):
        state["game"] = game.get_public_state(player_id)
    return state


async def send_json(websocket: WebSocket, message: Dict) -> None:
    """向单个连接发送 JSON。"""
    await websocket.send_text(json.dumps(message, ensure_ascii=False))


async def send_error(
    websocket: WebSocket, message: str, error_code: Optional[str] = None
) -> None:
    """发送业务错误。"""
    payload: Dict[str, object] = {"type": "error", "message": message}
    if error_code:
        payload["code"] = error_code
    await send_json(websocket, payload)


async def broadcast(room_id: str, message: Dict, exclude_id: Optional[str] = None) -> None:
    """向房间全员广播。"""
    room = rooms.get(room_id)
    if not room:
        return
    for pid, pdata in list(room["players"].items()):
        if pid == exclude_id or not pdata["connected"]:
            continue
        try:
            await send_json(pdata["ws"], message)
        except Exception:
            continue


async def broadcast_game_state(room: Dict) -> None:
    """向所有在线玩家推送各自视角的对局状态。"""
    room_id = room["room_id"]
    game: DevilRouletteGame = room["game"]
    for pid, pdata in list(room["players"].items()):
        if not pdata["connected"]:
            continue
        try:
            await send_json(
                pdata["ws"],
                {
                    "type": "game_state",
                    "game": game.get_public_state(pid),
                },
            )
        except Exception:
            continue


def close_room_if_empty(room_id: str) -> None:
    """最后一人离开时销毁房间。"""
    room = rooms.get(room_id)
    if not room or room["players"]:
        return
    rooms.pop(room_id, None)


async def remove_player_from_room(room_id: str, player_id: str, message: str) -> None:
    """从房间移除玩家并处理房主转移。"""
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        return
    removed_name = str(room["players"][player_id].get("name") or "玩家")
    was_owner = room.get("owner_id") == player_id
    await broadcast(
        room_id,
        {
            "type": "player_leave",
            "player_id": player_id,
            "name": removed_name,
            "message": message,
        },
        exclude_id=player_id,
    )
    del room["players"][player_id]
    if player_rooms.get(player_id) == room_id:
        del player_rooms[player_id]
    if was_owner:
        connected = [pid for pid, p in room["players"].items() if p["connected"]]
        room["owner_id"] = random.choice(connected) if connected else None
    close_room_if_empty(room_id)
    if room_id in rooms:
        await broadcast_room_state(room)


async def broadcast_room_state(room: Dict) -> None:
    """向所有在线玩家推送 room_state。"""
    for pid, pdata in list(room["players"].items()):
        if not pdata["connected"]:
            continue
        try:
            await send_json(pdata["ws"], build_room_state(room, pid))
        except Exception:
            continue


async def evict_player_for_other_game(player_id: str) -> None:
    """玩家加入其他游戏时移出本游戏房间。"""
    room_id = player_rooms.get(player_id)
    if not room_id:
        return
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        player_rooms.pop(player_id, None)
        return
    player = room["players"][player_id]
    old_ws = player.get("ws")
    name = str(player.get("name") or "玩家")
    await remove_player_from_room(room_id, player_id, f"{name} 离开了房间")
    if old_ws is not None:
        try:
            await send_json(old_ws, {"type": "room_removed", "message": "你已加入其他游戏的房间"})
            await old_ws.close(code=4004)
        except Exception:
            pass


def get_reconnect_session(player_id: str) -> Optional[Dict[str, str]]:
    """返回可重连的会话 URL。"""
    room_id = player_rooms.get(player_id)
    if not room_id or timed_out_rooms.get(player_id) == room_id:
        return None
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        return None
    return {
        "game_id": GAME_ID,
        "room_id": room_id,
        "url": "/devil-roulette/" + quote(room_id, safe=""),
    }


register_game(
    GAME_ID,
    get_player_room=player_rooms.get,
    evict_player=evict_player_for_other_game,
    get_reconnect_session=get_reconnect_session,
)


async def remove_disconnected_player_after_timeout(
    room_id: str, player_id: str, expected_room: Dict, disconnect_token: str
) -> None:
    """宽限期后移除仍未重连的玩家。"""
    await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
    room = rooms.get(room_id)
    if room is not expected_room:
        return
    player = room.get("players", {}).get(player_id)
    if not player or player.get("disconnect_token") != disconnect_token:
        return
    if player.get("connected"):
        return
    timed_out_rooms[player_id] = room_id
    await remove_player_from_room(room_id, player_id, f"{player.get('name', '玩家')} 断线超时")


@router.get("/devil-roulette", response_class=HTMLResponse)
async def devil_roulette_index(request: Request, identity=Depends(get_optional_identity)):
    """渲染恶魔轮盘赌主页。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/devil-roulette", status_code=302)
    user_id, nickname = identity
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "game": game_info,
            "user_id": user_id,
            "nickname": nickname,
            "initial_room": "",
        },
    )


@router.get("/devil-roulette/random-room")
async def random_room(identity=Depends(get_optional_identity)):
    """为随机加入挑选空闲大厅房间。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    candidates = list_joinable_lobby_rooms()
    if candidates:
        return {"room_id": random.choice(candidates), "created": False}
    return {"room_id": generate_random_room_id(), "created": True}


@router.get("/devil-roulette/sprites-preview", response_class=HTMLResponse)
async def sprites_preview(request: Request):
    """本地贴图布局预览页（无需登录）。"""
    return templates.TemplateResponse(
        request=request,
        name="sprites-preview.html",
        context={"game": game_info},
    )


@router.get("/devil-roulette/{room_id}", response_class=HTMLResponse)
async def devil_roulette_room(
    request: Request, room_id: str, identity=Depends(get_optional_identity)
):
    """带房间号的深链。"""
    if not is_valid_room_path_id(room_id):
        raise HTTPException(status_code=404, detail="房间链接无效")
    if identity is None:
        return RedirectResponse(
            url=f"/login?next=/devil-roulette/{quote(room_id, safe='')}",
            status_code=302,
        )
    user_id, nickname = identity
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "game": game_info,
            "user_id": user_id,
            "nickname": nickname,
            "initial_room": room_id,
        },
    )


@router.websocket("/devil-roulette/ws")
async def devil_roulette_websocket(websocket: WebSocket):
    """恶魔轮盘赌 WebSocket 主循环。"""
    try:
        identity = await get_current_identity_ws(websocket)
    except Exception:
        await websocket.close(code=4401)
        return

    player_id, nickname = identity
    await websocket.accept()

    room_id: Optional[str] = None
    disconnect_token = uuid.uuid4().hex

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await send_error(websocket, "无效 JSON", create_error_code("DR-JSON"))
                continue

            msg_type = str(data.get("type") or "")

            if msg_type == "join":
                new_room_id = str(data.get("room") or "").strip()
                name = str(data.get("name") or nickname or "玩家").strip()[:20]
                if not new_room_id:
                    await send_error(websocket, "请输入房间号", create_error_code("DR-ROOM"))
                    continue

                existing = rooms.get(new_room_id)
                if existing and len(existing["players"]) >= MAX_PLAYERS and player_id not in existing["players"]:
                    await send_error(websocket, f"房间已满（最多 {MAX_PLAYERS} 人）", create_error_code("DR-FULL"))
                    continue

                await evict_from_other_games(GAME_ID, player_id)

                if new_room_id not in rooms:
                    rooms[new_room_id] = create_room(new_room_id)
                room = rooms[new_room_id]

                if player_id in room["players"]:
                    old = room["players"][player_id]
                    old["ws"] = websocket
                    old["connected"] = True
                    old["name"] = name
                    old.pop("disconnect_token", None)
                else:
                    if len(room["players"]) >= MAX_PLAYERS:
                        await send_error(websocket, f"房间已满（最多 {MAX_PLAYERS} 人）", create_error_code("DR-FULL"))
                        continue
                    room["players"][player_id] = {
                        "ws": websocket,
                        "name": name,
                        "connected": True,
                    }
                    if not room.get("owner_id"):
                        room["owner_id"] = player_id
                    game: DevilRouletteGame = room["game"]
                    if player_id not in game.players:
                        game.players[player_id] = PlayerState(player_id=player_id, name=name)
                        if player_id not in game.player_order:
                            game.player_order.append(player_id)

                room_id = new_room_id
                player_rooms[player_id] = room_id
                timed_out_rooms.pop(player_id, None)

                await send_json(websocket, build_room_state(room, player_id))
                await broadcast(
                    room_id,
                    {
                        "type": "player_join",
                        "player_id": player_id,
                        "name": name,
                    },
                    exclude_id=player_id,
                )
                await broadcast_room_state(room)
                continue

            if not room_id or room_id not in rooms:
                await send_error(websocket, "请先加入房间", create_error_code("DR-NOROOM"))
                continue

            room = rooms[room_id]
            if player_id not in room["players"]:
                await send_error(websocket, "你不在此房间", create_error_code("DR-NOTIN"))
                continue

            game = room["game"]

            if msg_type == "leave":
                await remove_player_from_room(room_id, player_id, f"{nickname} 离开了房间")
                room_id = None
                continue

            if msg_type == "start_game":
                if room.get("owner_id") != player_id:
                    await send_error(websocket, "只有房主可以开始", create_error_code("DR-HOST"))
                    continue
                if room.get("phase") != "lobby" and game.phase != "lobby":
                    await send_error(websocket, "游戏已开始", create_error_code("DR-STARTED"))
                    continue
                ok, err = game.start_game()
                if not ok:
                    await send_error(websocket, err, create_error_code("DR-START"))
                    continue
                room["phase"] = "playing"
                await broadcast_game_state(room)
                await broadcast(
                    room_id,
                    {
                        "type": "turn_changed",
                        "current_turn": game.get_public_state(player_id)["current_turn"],
                    },
                )
                continue

            if msg_type == "use_item":
                item_id = str(data.get("item_id") or "")
                ok, err, bullet = game.use_item(player_id, item_id)
                if not ok:
                    await send_error(websocket, err, create_error_code("DR-ITEM"))
                    continue
                if bullet is not None:
                    await send_json(
                        websocket,
                        {"type": "detector_result", "bullet": bullet},
                    )
                await broadcast_game_state(room)
                continue

            if msg_type == "shoot":
                target = str(data.get("target") or "")
                if target == "self":
                    target = player_id
                action = game.shoot(player_id, target)
                if not action.ok:
                    await send_error(websocket, action.error, create_error_code("DR-SHOOT"))
                    continue

                for shot in action.shots:
                    await broadcast(
                        room_id,
                        {
                            "type": "shot_fired",
                            "shooter": shot.shooter_id,
                            "target": shot.target_id,
                            "bullet": shot.bullet,
                            "damage": shot.total_damage,
                            "aoe_damage": shot.aoe_damage,
                            "effects_applied": shot.effects_applied,
                            "animation": shot.animation,
                            "eliminated": shot.eliminated,
                            "chamber_remaining": len(game.chamber),
                        },
                    )
                    for elim_id in shot.eliminated:
                        await broadcast(
                            room_id,
                            {
                                "type": "player_eliminated",
                                "player_id": elim_id,
                                "name": game.players[elim_id].name,
                            },
                        )

                if action.reloaded:
                    live, blank = game._chamber_counts()
                    await broadcast(
                        room_id,
                        {
                            "type": "reload",
                            "round_number": game.round_number,
                            "chamber_live": live,
                            "chamber_blank": blank,
                        },
                    )

                await broadcast_game_state(room)

                if action.game_over:
                    await broadcast(
                        room_id,
                        {
                            "type": "game_over",
                            "winners": action.winners,
                            "winner_names": [
                                game.players[w].name for w in action.winners if w in game.players
                            ],
                        },
                    )
                    room["phase"] = "game_over"
                elif action.turn_player_id:
                    await broadcast(
                        room_id,
                        {
                            "type": "turn_changed",
                            "current_turn": action.turn_player_id,
                        },
                    )
                continue

            await send_error(websocket, f"未知消息类型: {msg_type}", create_error_code("DR-TYPE"))

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("devil_roulette ws error room=%s player=%s", room_id, player_id)
    finally:
        if room_id and room_id in rooms:
            room = rooms[room_id]
            player = room.get("players", {}).get(player_id)
            if player and player.get("ws") is websocket:
                player["connected"] = False
                player["disconnect_token"] = disconnect_token
                asyncio.create_task(
                    remove_disconnected_player_after_timeout(
                        room_id, player_id, room, disconnect_token
                    )
                )
