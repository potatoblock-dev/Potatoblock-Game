import asyncio
import json
import logging
import random
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Set
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.error_codes import create_error_code
from app.games.collab_canvas.protocol import (
    DEFAULT_BOARD_ID,
    DEFAULT_LAYER_ID,
    DISCONNECT_GRACE_SECONDS,
    MAX_BOARDS_PER_ROOM,
    MAX_LAYERS_PER_BOARD,
    MAX_PLAYERS_PER_ROOM,
    PROTOCOL_VERSION,
)
from app.games.common.drawing_board import (
    append_stroke_segment,
    append_stroke_segments,
    clear_layer_strokes,
    default_layers,
    default_vector_canvas,
    get_layer,
    layer_has_strokes,
    migrate_board_layers,
    redo_player_stroke,
    serialize_canvas,
    serialize_layers,
    serialize_strokes,
    undo_player_stroke,
)
from app.games.common.lobby import (
    MAX_ROOM_ID_LENGTH,
    generate_random_room_id,
    is_valid_deep_link_room_id,
    list_joinable_collab_rooms,
)
from app.games.common.room_registry import evict_from_other_games, register_game
from app.routers.auth import get_current_identity_ws, get_optional_identity

templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))
router = APIRouter()
logger = logging.getLogger(__name__)

GAME_DIR = Path(__file__).resolve().parent
GAME_ID = "collab_canvas"
STATIC_URL = "/static/games/collab-canvas"

game_info = {
    "id": GAME_ID,
    "name": "合作画板",
    "logo": "/static/img/logo.svg",
    "url": "/collab-canvas",
    "menu_order": 15,
    "router": router,
    "static_dir": GAME_DIR / "static",
    "static_url": STATIC_URL,
}

RESERVED_SEGMENTS = frozenset({"random-room", "ws"})

rooms: Dict[str, Dict] = {}
player_rooms: Dict[str, str] = {}
timed_out_rooms: Dict[str, str] = {}


def is_valid_room_path_id(room_id: str) -> bool:
    """校验可放进 /collab-canvas/{room} 路径的房间号。"""
    return is_valid_deep_link_room_id(room_id, RESERVED_SEGMENTS)


def create_board(title: str, board_id: Optional[str] = None, created_by: Optional[str] = None) -> Dict:
    """创建一块独立画板的状态容器。"""
    return {
        "board_id": board_id or ("b_" + uuid.uuid4().hex[:10]),
        "title": str(title or "画板")[:40],
        "layers": default_layers(),
        "strokes": [],
        "redo": {},
        "canvas": default_vector_canvas(),
        "created_at": time.time(),
        "created_by": created_by,
    }


def create_room(room_id: str) -> Dict:
    """创建合作画板房间，含默认画板。"""
    default_board = create_board("画板 1", DEFAULT_BOARD_ID)
    return {
        "room_id": room_id,
        "owner_id": None,
        "players": {},
        "boards": {DEFAULT_BOARD_ID: default_board},
        "board_order": [DEFAULT_BOARD_ID],
    }


def get_board(room: Dict, board_id: str) -> Optional[Dict]:
    """按 id 取画板；不存在时返回 None。"""
    board = room.get("boards", {}).get(str(board_id or ""))
    if board:
        ensure_board(board)
    return board


def serialize_boards_meta(room: Dict) -> List[Dict[str, object]]:
    """返回画板列表元数据（不含 strokes）。"""
    result: List[Dict[str, object]] = []
    for board_id in room.get("board_order", []):
        board = get_board(room, board_id)
        if not board:
            continue
        result.append(
            {
                "board_id": board["board_id"],
                "title": board["title"],
                "canvas": serialize_canvas(board.get("canvas") or default_vector_canvas()),
                "created_at": board.get("created_at", 0),
                "created_by": board.get("created_by") or "",
            }
        )
    return result


def serialize_players(room: Dict) -> List[Dict[str, object]]:
    """序列化房间成员列表。"""
    owner_id = room.get("owner_id")
    return [
        {
            "uid": pid,
            "name": pdata["name"],
            "is_host": pid == owner_id,
            "connected": pdata["connected"],
            "active_board_id": pdata.get("active_board_id", DEFAULT_BOARD_ID),
        }
        for pid, pdata in room["players"].items()
    ]


def players_on_board(room: Dict, board_id: str) -> Set[str]:
    """返回正在查看指定画板的在线玩家 id。"""
    target = str(board_id or DEFAULT_BOARD_ID)
    return {
        pid
        for pid, pdata in room["players"].items()
        if pdata["connected"] and pdata.get("active_board_id", DEFAULT_BOARD_ID) == target
    }


def ensure_board(board: Dict) -> None:
    """确保画板含 layers 且 strokes 带 layer_id。"""
    migrate_board_layers(board)


def top_layer_id(board: Dict) -> str:
    """返回 order 最高的图层 id。"""
    ensure_board(board)
    layers = sorted(board.get("layers") or [], key=lambda item: int(item.get("order", 0)))
    if not layers:
        return DEFAULT_LAYER_ID
    return str(layers[-1]["layer_id"])


def build_drawing_sync(board: Dict, board_id: str) -> Dict[str, object]:
    """构造单画板快照（含图层）。"""
    ensure_board(board)
    return {
        "type": "drawing_sync",
        "board_id": board_id,
        "layers": serialize_layers(board.get("layers") or []),
        "strokes": serialize_strokes(board.get("strokes") or []),
        "canvas": serialize_canvas(board.get("canvas") or default_vector_canvas()),
    }


def resolve_layer_id(board: Dict, pdata: Dict, data: Dict) -> str:
    """解析本次操作的目标图层 id。"""
    ensure_board(board)
    layer_id = str(data.get("layer_id") or pdata.get("active_layer_id") or top_layer_id(board))
    if get_layer(board, layer_id):
        return layer_id
    return top_layer_id(board)
def build_room_state(room: Dict, player_id: str, *, include_strokes: bool = True) -> Dict:
    """构造进房/重连时的全量房间状态。"""
    pdata = room["players"][player_id]
    board_id = pdata.get("active_board_id", DEFAULT_BOARD_ID)
    board = get_board(room, board_id) or room["boards"][DEFAULT_BOARD_ID]
    ensure_board(board)
    active_layer = pdata.get("active_layer_id") or top_layer_id(board)
    if not get_layer(board, active_layer):
        active_layer = top_layer_id(board)
        pdata["active_layer_id"] = active_layer
    state: Dict[str, object] = {
        "type": "room_state",
        "protocolVersion": PROTOCOL_VERSION,
        "room_id": room["room_id"],
        "self_id": player_id,
        "owner_id": room.get("owner_id") or "",
        "players": serialize_players(room),
        "boards": serialize_boards_meta(room),
        "board_order": list(room.get("board_order", [])),
        "active_board_id": board["board_id"],
        "active_layer_id": active_layer,
        "layers": serialize_layers(board.get("layers") or []),
        "canvas": serialize_canvas(board.get("canvas") or default_vector_canvas()),
    }
    if include_strokes:
        state["strokes"] = serialize_strokes(board.get("strokes") or [])
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


async def broadcast_to_board(
    room_id: str,
    board_id: str,
    message: Dict,
    exclude_id: Optional[str] = None,
) -> None:
    """仅向正在查看同一画板的玩家广播。"""
    room = rooms.get(room_id)
    if not room:
        return
    targets = players_on_board(room, board_id)
    for player_id in targets:
        if player_id == exclude_id:
            continue
        player = room["players"].get(player_id)
        if not player or not player["connected"]:
            continue
        try:
            await send_json(player["ws"], message)
        except Exception:
            continue


def close_room_if_empty(room_id: str) -> None:
    """最后一人离开时销毁房间并释放占用。"""
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
        connected = [
            pid for pid, p in room["players"].items() if p["connected"]
        ]
        room["owner_id"] = random.choice(connected) if connected else None
    close_room_if_empty(room_id)
    if room_id in rooms:
        await broadcast_room_state(room)


async def broadcast_room_state(room: Dict) -> None:
    """向所有在线玩家推送轻量 room_state（不含 strokes）。"""
    room_id = room["room_id"]
    for pid, pdata in list(room["players"].items()):
        if not pdata["connected"]:
            continue
        try:
            await send_json(pdata["ws"], build_room_state(room, pid, include_strokes=False))
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
        "url": "/collab-canvas/" + quote(room_id, safe=""),
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
    player = room["players"].get(player_id)
    if not player or player["connected"] or player.get("disconnect_token") != disconnect_token:
        return
    timed_out_rooms[player_id] = room_id
    await remove_player_from_room(
        room_id, player_id, f"{player['name']} 断线超过30秒，已退出房间"
    )


async def handle_player_disconnect(
    room_id: Optional[str], player_id: Optional[str], websocket: WebSocket
) -> None:
    """标记断线并启动宽限期。"""
    if not room_id or room_id not in rooms or not player_id:
        return
    room = rooms[room_id]
    current = room["players"].get(player_id)
    if current is None or current["ws"] is not websocket:
        return
    current["connected"] = False
    token = uuid.uuid4().hex
    current["disconnect_token"] = token
    if room.get("owner_id") == player_id:
        guests = [pid for pid, p in room["players"].items() if pid != player_id and p["connected"]]
        if guests:
            room["owner_id"] = random.choice(guests)
    await broadcast(
        room_id,
        {"type": "player_leave", "player_id": player_id, "name": current["name"], "temporary": True},
        exclude_id=player_id,
    )
    asyncio.create_task(remove_disconnected_player_after_timeout(room_id, player_id, room, token))


def board_has_drawn_strokes(board: Dict) -> bool:
    """判断画板是否含非背景笔触。"""
    for stroke in board.get("strokes") or []:
        for segment in stroke.get("segments") or []:
            if segment.get("tool", "brush") != "background":
                return True
    return False


@router.get("/collab-canvas", response_class=HTMLResponse)
async def collab_canvas_page(request: Request, identity=Depends(get_optional_identity)):
    """渲染合作画板主页。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/collab-canvas", status_code=302)
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


@router.get("/collab-canvas/random-room")
async def random_room(identity=Depends(get_optional_identity)):
    """为随机加入挑选在线房间（跳过 P 开头），没有则生成新房间号。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    candidates = list_joinable_collab_rooms(rooms)
    if candidates:
        return {"room_id": random.choice(candidates), "created": False}
    return {"room_id": generate_random_room_id(rooms), "created": True}


@router.get("/collab-canvas/{room_id}", response_class=HTMLResponse)
async def collab_canvas_room(
    request: Request, room_id: str, identity=Depends(get_optional_identity)
):
    """带房间号的深链。"""
    if not is_valid_room_path_id(room_id):
        raise HTTPException(status_code=404, detail="房间链接无效")
    next_path = "/collab-canvas/" + quote(room_id, safe="")
    if identity is None:
        return RedirectResponse(url="/login?next=" + quote(next_path, safe=""), status_code=302)
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


@router.websocket("/collab-canvas/ws")
async def collab_websocket(websocket: WebSocket):
    """合作画板实时协议。"""
    identity = await get_current_identity_ws(websocket)
    if identity is None:
        return
    passport_user_id, passport_nickname = identity
    await websocket.accept()
    room_id: Optional[str] = None
    player_id: Optional[str] = None

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await send_error(websocket, "消息格式无效")
                continue
            if not isinstance(data, dict):
                await send_error(websocket, "消息内容无效")
                continue
            msg_type = data.get("type")

            if msg_type == "ping":
                await send_json(websocket, {"type": "pong"})
                continue

            if msg_type == "join":
                requested_room_id = str(data.get("room", "")).strip()[:MAX_ROOM_ID_LENGTH].upper()
                fallback_name = str(data.get("name", "")).strip()[:24]
                display_name = passport_nickname or fallback_name
                if not requested_room_id:
                    await send_error(websocket, "房间号不能为空")
                    continue
                if not is_valid_room_path_id(requested_room_id):
                    await send_error(websocket, f"房间号须为 2–{MAX_ROOM_ID_LENGTH} 位字母或数字")
                    continue
                if requested_room_id.casefold() in RESERVED_SEGMENTS:
                    await send_error(websocket, "该房间号不可用")
                    continue
                if not display_name:
                    await send_error(websocket, "请输入昵称")
                    continue
                player_id = str(passport_user_id)
                if timed_out_rooms.get(player_id) == requested_room_id:
                    del timed_out_rooms[player_id]
                    await send_json(websocket, {"type": "room_removed", "message": "已退出房间"})
                    await websocket.close(code=4004)
                    return

                await evict_from_other_games(GAME_ID, player_id)
                occupied = player_rooms.get(player_id)
                if occupied and occupied != requested_room_id:
                    occ_room = rooms.get(occupied)
                    if occ_room and player_id in occ_room["players"]:
                        old_ws = occ_room["players"][player_id].get("ws")
                        await remove_player_from_room(
                            occupied, player_id, f"{display_name} 离开了房间"
                        )
                        if old_ws and old_ws is not websocket:
                            try:
                                await send_json(
                                    old_ws,
                                    {"type": "room_removed", "message": "你已切换到其他房间"},
                                )
                                await old_ws.close(code=4004)
                            except Exception:
                                pass

                room_id = requested_room_id
                room = rooms.setdefault(room_id, create_room(room_id))
                existing = room["players"].get(player_id)
                if existing is not None:
                    old_ws = existing["ws"]
                    if old_ws is websocket:
                        await send_error(websocket, "你已加入该房间")
                        continue
                    was_offline = not existing["connected"]
                    existing["name"] = display_name
                    existing["ws"] = websocket
                    existing["connected"] = True
                    existing["disconnect_token"] = ""
                    if not existing.get("active_layer_id"):
                        existing["active_layer_id"] = DEFAULT_LAYER_ID
                    player_rooms[player_id] = room_id
                    await send_json(websocket, build_room_state(room, player_id, include_strokes=True))
                    if was_offline:
                        await broadcast(
                            room_id,
                            {"type": "player_join", "player_id": player_id, "name": display_name},
                            exclude_id=player_id,
                        )
                    try:
                        await old_ws.close(code=4002)
                    except Exception:
                        pass
                    continue

                if len(room["players"]) >= MAX_PLAYERS_PER_ROOM:
                    await send_error(websocket, "房间已满")
                    continue

                room["players"][player_id] = {
                    "ws": websocket,
                    "name": display_name,
                    "connected": True,
                    "disconnect_token": "",
                    "active_board_id": DEFAULT_BOARD_ID,
                    "active_layer_id": DEFAULT_LAYER_ID,
                }
                player_rooms[player_id] = room_id
                if room.get("owner_id") is None:
                    room["owner_id"] = player_id
                await send_json(websocket, build_room_state(room, player_id, include_strokes=True))
                await broadcast(
                    room_id,
                    {"type": "player_join", "player_id": player_id, "name": display_name},
                    exclude_id=player_id,
                )
                continue

            if not room_id or not player_id or room_id not in rooms:
                await send_error(websocket, "请先加入房间")
                continue
            room = rooms[room_id]
            if player_id not in room["players"]:
                continue
            pdata = room["players"][player_id]

            if msg_type == "board_create":
                if len(room.get("board_order", [])) >= MAX_BOARDS_PER_ROOM:
                    await send_error(websocket, "画板数量已达上限")
                    continue
                title = str(data.get("title") or f"画板 {len(room['board_order']) + 1}")[:40]
                board = create_board(title, created_by=player_id)
                room["boards"][board["board_id"]] = board
                room["board_order"].append(board["board_id"])
                payload = {
                    "type": "board_added",
                    "board_id": board["board_id"],
                    "title": board["title"],
                    "canvas": serialize_canvas(board["canvas"]),
                    "created_by": player_id,
                }
                await broadcast(room_id, payload)
                continue

            if msg_type == "board_switch":
                board_id = str(data.get("board_id") or "")
                if not get_board(room, board_id):
                    await send_error(websocket, "画板不存在")
                    continue
                pdata["active_board_id"] = board_id
                board = get_board(room, board_id)
                assert board is not None
                pdata["active_layer_id"] = top_layer_id(board)
                await send_json(websocket, build_drawing_sync(board, board_id))
                continue

            if msg_type == "board_rename":
                board_id = str(data.get("board_id") or "")
                board = get_board(room, board_id)
                if not board:
                    await send_error(websocket, "画板不存在")
                    continue
                if board.get("created_by") != player_id and room.get("owner_id") != player_id:
                    await send_error(websocket, "只有创建者或房主可以重命名")
                    continue
                board["title"] = str(data.get("title") or board["title"])[:40]
                await broadcast(
                    room_id,
                    {"type": "board_renamed", "board_id": board_id, "title": board["title"]},
                )
                continue

            if msg_type == "board_delete":
                board_id = str(data.get("board_id") or "")
                if board_id == DEFAULT_BOARD_ID:
                    await send_error(websocket, "默认画板不能删除")
                    continue
                board = get_board(room, board_id)
                if not board:
                    await send_error(websocket, "画板不存在")
                    continue
                if board.get("created_by") != player_id:
                    await send_error(websocket, "只有创建者可以删除画板")
                    continue
                if board_has_drawn_strokes(board):
                    await send_error(websocket, "画板上还有内容，请先清空")
                    continue
                room["boards"].pop(board_id, None)
                if board_id in room["board_order"]:
                    room["board_order"].remove(board_id)
                for pid, pl in room["players"].items():
                    if pl.get("active_board_id") == board_id:
                        pl["active_board_id"] = DEFAULT_BOARD_ID
                await broadcast(room_id, {"type": "board_removed", "board_id": board_id})
                continue

            if msg_type == "drawing_sync_request":
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                board = get_board(room, board_id)
                if not board:
                    continue
                await send_json(websocket, build_drawing_sync(board, board_id))
                continue

            if msg_type == "layer_switch":
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                board = get_board(room, board_id)
                if not board:
                    continue
                layer_id = str(data.get("layer_id") or "")
                ensure_board(board)
                if not get_layer(board, layer_id):
                    await send_error(websocket, "图层不存在")
                    continue
                pdata["active_layer_id"] = layer_id
                continue

            if msg_type == "layer_create":
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                board = get_board(room, board_id)
                if not board:
                    continue
                ensure_board(board)
                if len(board["layers"]) >= MAX_LAYERS_PER_BOARD:
                    await send_error(websocket, "图层数量已达上限")
                    continue
                new_id = "l_" + uuid.uuid4().hex[:10]
                max_order = max(int(layer.get("order", 0)) for layer in board["layers"])
                name = str(data.get("name") or f"图层 {len(board['layers']) + 1}")[:40]
                layer = {
                    "layer_id": new_id,
                    "name": name,
                    "visible": True,
                    "opacity": 255,
                    "locked": False,
                    "order": max_order + 1,
                }
                board["layers"].append(layer)
                pdata["active_layer_id"] = new_id
                payload = {
                    "type": "layer_added",
                    "board_id": board_id,
                    "layer": serialize_layers([layer])[0],
                    "created_by": player_id,
                }
                await broadcast_to_board(room_id, board_id, payload)
                continue

            if msg_type == "layer_delete":
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                layer_id = str(data.get("layer_id") or "")
                board = get_board(room, board_id)
                if not board:
                    continue
                ensure_board(board)
                if len(board["layers"]) <= 1:
                    await send_error(websocket, "至少保留一个图层")
                    continue
                if layer_id == DEFAULT_LAYER_ID and len(board["layers"]) == 1:
                    await send_error(websocket, "默认图层不能删除")
                    continue
                if not get_layer(board, layer_id):
                    await send_error(websocket, "图层不存在")
                    continue
                if layer_has_strokes(board, layer_id):
                    await send_error(websocket, "图层上还有内容，请先清空")
                    continue
                board["layers"] = [layer for layer in board["layers"] if layer["layer_id"] != layer_id]
                if pdata.get("active_layer_id") == layer_id:
                    pdata["active_layer_id"] = top_layer_id(board)
                await broadcast_to_board(
                    room_id,
                    board_id,
                    {"type": "layer_removed", "board_id": board_id, "layer_id": layer_id},
                )
                continue

            if msg_type == "layer_rename":
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                layer_id = str(data.get("layer_id") or "")
                board = get_board(room, board_id)
                if not board:
                    continue
                layer = get_layer(board, layer_id)
                if not layer:
                    await send_error(websocket, "图层不存在")
                    continue
                layer["name"] = str(data.get("name") or layer["name"])[:40]
                await broadcast_to_board(
                    room_id,
                    board_id,
                    {
                        "type": "layer_renamed",
                        "board_id": board_id,
                        "layer_id": layer_id,
                        "name": layer["name"],
                    },
                )
                continue

            if msg_type == "layer_reorder":
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                board = get_board(room, board_id)
                if not board:
                    continue
                ensure_board(board)
                order_ids = data.get("layer_ids")
                if not isinstance(order_ids, list):
                    continue
                id_set = {layer["layer_id"] for layer in board["layers"]}
                if set(order_ids) != id_set:
                    await send_error(websocket, "图层顺序无效")
                    continue
                order_map = {layer_id: index for index, layer_id in enumerate(order_ids)}
                for layer in board["layers"]:
                    layer["order"] = order_map.get(layer["layer_id"], layer.get("order", 0))
                board["layers"].sort(key=lambda item: int(item.get("order", 0)))
                await broadcast_to_board(
                    room_id,
                    board_id,
                    {
                        "type": "layer_reordered",
                        "board_id": board_id,
                        "layers": serialize_layers(board["layers"]),
                    },
                )
                continue

            if msg_type == "layer_update":
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                layer_id = str(data.get("layer_id") or "")
                board = get_board(room, board_id)
                if not board:
                    continue
                layer = get_layer(board, layer_id)
                if not layer:
                    await send_error(websocket, "图层不存在")
                    continue
                if "visible" in data:
                    layer["visible"] = bool(data.get("visible"))
                if "opacity" in data:
                    layer["opacity"] = max(0, min(255, int(data.get("opacity"))))
                if "locked" in data:
                    layer["locked"] = bool(data.get("locked"))
                await broadcast_to_board(
                    room_id,
                    board_id,
                    {
                        "type": "layer_updated",
                        "board_id": board_id,
                        "layer_id": layer_id,
                        "visible": layer.get("visible", True),
                        "opacity": layer.get("opacity", 255),
                        "locked": layer.get("locked", False),
                    },
                )
                continue

            if msg_type in {"draw", "draw_batch"}:
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                board = get_board(room, board_id)
                if not board:
                    continue
                layer_id = resolve_layer_id(board, pdata, data)
                layer = get_layer(board, layer_id)
                if layer and layer.get("locked"):
                    continue
                stroke_id = str(data.get("stroke_id") or "")[:100]
                if msg_type == "draw_batch":
                    raw_segments = data.get("segments")
                    if not isinstance(raw_segments, list) or not raw_segments:
                        continue
                    try:
                        stroke, applied = append_stroke_segments(
                            board["strokes"],
                            board["redo"],
                            player_id,
                            stroke_id,
                            [seg for seg in raw_segments if isinstance(seg, dict)],
                            layer_id,
                        )
                    except (KeyError, TypeError, ValueError, AssertionError):
                        continue
                    await broadcast_to_board(
                        room_id,
                        board_id,
                        {
                            "type": "draw_batch",
                            "board_id": board_id,
                            "layer_id": layer_id,
                            "stroke_id": stroke["stroke_id"],
                            "owner_id": player_id,
                            "segments": applied,
                        },
                        exclude_id=player_id,
                    )
                    continue
                packet = dict(data)
                packet["layer_id"] = layer_id
                try:
                    stroke = append_stroke_segment(board["strokes"], board["redo"], player_id, packet, layer_id)
                except (KeyError, TypeError, ValueError):
                    continue
                segment = stroke["segments"][-1]
                await broadcast_to_board(
                    room_id,
                    board_id,
                    {
                        "type": "draw",
                        "board_id": board_id,
                        "layer_id": layer_id,
                        "stroke_id": stroke["stroke_id"],
                        "owner_id": player_id,
                        **segment,
                    },
                    exclude_id=player_id,
                )
                continue

            if msg_type in {"undo", "redo"}:
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                board = get_board(room, board_id)
                if not board:
                    continue
                layer_id = resolve_layer_id(board, pdata, data)
                stroke = (
                    undo_player_stroke(board["strokes"], board["redo"], player_id, layer_id)
                    if msg_type == "undo"
                    else redo_player_stroke(board["redo"], player_id)
                )
                if stroke:
                    await broadcast_to_board(
                        room_id,
                        board_id,
                        {
                            "type": "stroke_visibility",
                            "board_id": board_id,
                            "layer_id": stroke.get("layer_id", layer_id),
                            "stroke_id": stroke["stroke_id"],
                            "owner_id": player_id,
                            "visible": msg_type == "redo",
                        },
                    )
                continue

            if msg_type == "clear":
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                board = get_board(room, board_id)
                if not board:
                    continue
                layer_id = resolve_layer_id(board, pdata, data)
                clear_layer_strokes(board, layer_id)
                board["redo"] = {}
                clear_msg = {"type": "clear", "board_id": board_id, "layer_id": layer_id}
                await broadcast_to_board(room_id, board_id, clear_msg)
                continue

            if msg_type == "cursor_move":
                board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
                try:
                    x = max(0.0, min(1.0, float(data.get("x", 0))))
                    y = max(0.0, min(1.0, float(data.get("y", 0))))
                except (TypeError, ValueError):
                    continue
                drawing = bool(data.get("drawing"))
                await broadcast_to_board(
                    room_id,
                    board_id,
                    {
                        "type": "cursor_update",
                        "board_id": board_id,
                        "player_id": player_id,
                        "nickname": pdata["name"],
                        "x": x,
                        "y": y,
                        "drawing": drawing,
                    },
                    exclude_id=player_id,
                )
                continue

    except WebSocketDisconnect:
        await handle_player_disconnect(room_id, player_id, websocket)
    except Exception:
        code = create_error_code("CCWS")
        logger.exception("合作画板 WebSocket 未预期错误 [%s]", code)
        try:
            await send_error(websocket, "连接异常，请重新加入房间", code)
        except Exception:
            pass
        await handle_player_disconnect(room_id, player_id, websocket)
