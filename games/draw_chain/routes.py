import asyncio
import base64
import binascii
import copy
import json
import logging
import random
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates

from app.error_codes import create_error_code
from app.games.common.drawing_board import (
    append_stroke_segment,
    append_stroke_segments,
    canvases_equal,
    default_vector_canvas,
    normalize_canvas_mode,
    redo_player_stroke,
    serialize_canvas,
    serialize_strokes,
    undo_player_stroke,
)
from app.games.common.lobby import (
    generate_random_room_id as lobby_generate_random_room_id,
    get_owner_name,
    is_valid_deep_link_room_id as lobby_is_valid_deep_link_room_id,
    keep_background_strokes,
    list_joinable_lobby_rooms as lobby_list_joinable_lobby_rooms,
    serialize_lobby_players,
)
from app.games.common.room_registry import evict_from_other_games, register_game
from app.games.draw_chain.replay import (
    ARTWORK_VOTE_SECONDS,
    REPLAY_ARTWORKS,
    REPLAY_PHASES,
    REPLAY_VERDICT,
    REPLAY_WINNER,
    VERDICT_SECONDS,
    WINNER_SECONDS,
    resolve_artwork_winner,
    resolve_verdict,
    replay_voter_ids,
    serialize_replay,
    start_artwork_vote,
    start_replay,
    start_winner_display,
    vote_artwork,
    vote_verdict,
)
from app.routers.auth import get_current_identity_ws, get_optional_identity


templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))
router = APIRouter()
logger = logging.getLogger(__name__)


GAME_DIR = Path(__file__).resolve().parent
GAME_ID = "draw_chain"
STATIC_URL = "/static/games/draw-chain"

game_info = {
    "id": GAME_ID,
    "name": "画画接龙",
    "logo": "/static/img/logo.svg",
    "url": "/draw-chain",
    "menu_order": 20,
    "router": router,
    "static_dir": GAME_DIR / "static",
    "static_url": STATIC_URL,
}


@router.get("/draw-chain", response_class=HTMLResponse)
async def draw_chain(request: Request, identity=Depends(get_optional_identity)):
    """渲染已登录用户的画画接龙页面。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/draw-chain", status_code=302)
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


RESERVED_DRAW_CHAIN_SEGMENTS = frozenset({"random-room", "artworks", "ws"})


def is_valid_deep_link_room_id(room_id: str) -> bool:
    """校验可放进 /draw-chain/{room} 路径的房间号。"""
    return lobby_is_valid_deep_link_room_id(room_id, RESERVED_DRAW_CHAIN_SEGMENTS)


def list_joinable_lobby_rooms() -> List[str]:
    """返回可随机加入的大厅房间：非 P 开头，且仍有在线玩家。"""
    return lobby_list_joinable_lobby_rooms(rooms)


def generate_random_room_id() -> str:
    """生成 4 位大写字母+数字房间号；首字符绝不使用 P。"""
    return lobby_generate_random_room_id(rooms)


@router.get("/draw-chain/random-room")
async def random_room(identity=Depends(get_optional_identity)):
    """为随机加入挑选空闲大厅房间，没有则生成新房间号。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    candidates = list_joinable_lobby_rooms()
    if candidates:
        return {"room_id": random.choice(candidates), "created": False}
    return {"room_id": generate_random_room_id(), "created": True}


@router.get("/draw-chain/artworks/{room_id}/{artwork_id}")
async def get_room_artwork(
    room_id: str,
    artwork_id: str,
    download: bool = False,
    identity=Depends(get_optional_identity),
):
    """仅向当前房间成员返回保存在内存中的画作。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    player_id = str(identity[0])
    room = rooms.get(room_id)
    if room is None or player_id not in room["players"]:
        raise HTTPException(status_code=404, detail="画作不存在")
    artwork = next(
        (item for item in room["artworks"] if item["id"] == artwork_id),
        None,
    )
    if artwork is None or not can_view_artwork(room, player_id, artwork):
        raise HTTPException(status_code=404, detail="画作不存在")
    headers = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
    if download:
        extension = "png" if artwork["mime_type"] == "image/png" else "webp"
        headers["Content-Disposition"] = f'attachment; filename="artwork-{artwork_id}.{extension}"'
    return Response(
        content=artwork["image_bytes"],
        media_type=artwork["mime_type"],
        headers=headers,
    )


@router.get("/draw-chain/{room_id}", response_class=HTMLResponse)
async def draw_chain_room(
    request: Request, room_id: str, identity=Depends(get_optional_identity)
):
    """带房间号的深链：登录后打开页面并自动进入该房间。"""
    if not is_valid_deep_link_room_id(room_id):
        raise HTTPException(status_code=404, detail="房间链接无效")
    next_path = "/draw-chain/" + quote(room_id, safe="")
    if identity is None:
        return RedirectResponse(
            url="/login?next=" + quote(next_path, safe=""),
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


MAX_WORD_BANK_BYTES = 64 * 1024
MAX_CUSTOM_WORDS = 500
MAX_CUSTOM_BANKS = 20
MAX_TOTAL_CUSTOM_WORDS = 2000
# 慢设备导出大画作（含 PNG 降级重试）可能超过 3 秒，放宽等待避免丢图
ARTWORK_CAPTURE_TIMEOUT_SECONDS = 6.0
MAX_ARTWORK_BYTES = 1024 * 1024
ARTWORK_MIME_TYPES = frozenset({"image/webp", "image/png"})
DISCONNECT_GRACE_SECONDS = 30
ORIGINAL_PLAYER_ABSENCE_SECONDS = 60
MIN_DRAW_SECONDS = 10
MAX_DRAW_SECONDS = 120
DEFAULT_DRAW_SECONDS = 60
BASE_WORD_BANK_PATH = GAME_DIR / "base_word_bank.txt"


def safe_bank_filename(filename: str) -> str:
    """只保留词库文件名本身，禁止路径穿越。"""
    name = Path(str(filename or "")).name.strip()
    if not name or name in {".", ".."}:
        return ""
    return name[:100]


def parse_word_bank_content(
    content: str, max_words: int, limit_message: str
) -> List[Dict[str, str]]:
    """统一解析内置与自定义的“答案；提示”词库文本。"""
    words: List[Dict[str, str]] = []
    for line_number, raw_line in enumerate(content.splitlines(), start=1):
        line = raw_line.lstrip("\ufeff").strip()
        if line_number == 1 and line.startswith(("!", "！")):
            continue
        if not line or line.startswith("#"):
            continue
        delimiter = "；" if "；" in line else ";" if ";" in line else None
        answer, hint = line.split(delimiter, 1) if delimiter else (line, "")
        answer = answer.strip()
        hint = hint.strip()
        if not answer:
            raise ValueError(f"第{line_number}行缺少答案")
        if len(answer) > 40:
            raise ValueError(f"第{line_number}行答案不能超过40个字符")
        if len(hint) > 100:
            raise ValueError(f"第{line_number}行提示不能超过100个字符")
        words.append({"answer": answer, "hint": hint})
        if len(words) > max_words:
            raise ValueError(limit_message)
    if not words:
        raise ValueError("词库中没有可用题目")
    return words


def parse_word_bank_header(content: str) -> Optional[str]:
    """读取第一物理行的可选“!词库名”或“！词库名”声明。"""
    lines = content.splitlines()
    if not lines:
        return None
    first_line = lines[0].lstrip("\ufeff").strip()
    if not first_line.startswith(("!", "！")):
        return None
    name = first_line[1:].strip()
    return name[:80] or None


def get_custom_word_bank_name(content: str, filename: str) -> str:
    """优先使用首行声明的词库名，否则沿用上传文件名。"""
    return parse_word_bank_header(content) or filename


def load_base_word_bank() -> List[Dict[str, str]]:
    """从应用数据文件加载生活场景基础词库。"""
    content = BASE_WORD_BANK_PATH.read_text(encoding="utf-8")
    return parse_word_bank_content(content, 5000, "基础词库题目数量过多")


BUILTIN_WORD_BANKS = {
    "life_scenes": {
        "name": "生活场景",
        "words": load_base_word_bank(),
    }
}
DEFAULT_BANK_IDS = list(BUILTIN_WORD_BANKS.keys())
rooms: Dict[str, Dict] = {}
player_rooms: Dict[str, str] = {}
timed_out_rooms: Dict[str, str] = {}


def close_room(room_id: str) -> None:
    """关闭房间并释放其中所有 UID 的房间占用。"""
    room = rooms.pop(room_id, None)
    if room is None:
        return
    for uid in room["players"]:
        if player_rooms.get(uid) == room_id:
            del player_rooms[uid]


def create_room(room_id: str) -> Dict:
    """创建处于大厅阶段的新房间状态。"""
    return {
        "room_id": room_id,
        "phase": "lobby",
        "players": {},
        "owner_id": None,
        "drawer_id": None,
        "round_id": "",
        "word": "",
        "word_hint": "",
        "word_bank_name": "",
        "question_count": 0,
        "enabled_banks": list(DEFAULT_BANK_IDS),
        "custom_banks": [],
        "hints_enabled": True,
        "draw_seconds": DEFAULT_DRAW_SECONDS,
        "draw_deadline": 0.0,
        "draw_turn_token": "",
        "lobby_strokes": [],
        "lobby_redo": {},
        "lobby_canvas": default_vector_canvas(),
        "game_strokes": [],
        "game_redo": {},
        "game_canvas": default_vector_canvas(),
        "previous_game_strokes": [],
        "guess_prompt_word": "",
        "artworks": [],
        "artwork_capture_token": "",
        "artwork_capture_round_id": "",
        "artwork_capture_future": None,
        "turn_phase": "",
        "chain_roster": [],
        "chain_index": 0,
        "chain_steps": [],
        "active_player_id": None,
        "prompt_word": "",
        "replay_original_word": "",
        "replay_final_guess": "",
        "replay_artworks": [],
        "replay_verdict_votes": {},
        "replay_artwork_votes": {},
        "replay_is_correct": None,
        "replay_winner_id": "",
        "replay_token": "",
        "replay_deadline": 0.0,
        "pending_players": [],
        "original_player_ids": set(),
        "original_absence_token": "",
    }


def parse_word_bank(content: str) -> List[Dict[str, str]]:
    """解析自定义 TXT 内容，并应用上传大小与题目数量限制。"""
    if len(content.encode("utf-8")) > MAX_WORD_BANK_BYTES:
        raise ValueError("TXT 文件不能超过 64 KB")
    return parse_word_bank_content(
        content,
        MAX_CUSTOM_WORDS,
        "自定义词库最多包含500道题",
    )


def build_word_pool(room: Dict) -> List[Dict[str, str]]:
    """合并启用词库，并为每道题附加不泄露答案的来源名称。"""
    pool: List[Dict[str, str]] = []
    for bank_id in room["enabled_banks"]:
        bank = BUILTIN_WORD_BANKS[bank_id]
        pool.extend({**word, "bank_name": bank["name"]} for word in bank["words"])
    for bank in room["custom_banks"]:
        if bank["enabled"]:
            pool.extend(
                {**word, "bank_name": bank.get("name") or bank["filename"]}
                for word in bank["words"]
            )
    return pool


def serialize_custom_banks(room: Dict) -> List[Dict[str, object]]:
    """返回自定义词库元数据（id/文件名/题数/启用），不含题目正文。"""
    return [
        {
            "id": bank["id"],
            "filename": bank["filename"],
            "name": bank.get("name") or bank["filename"],
            "count": len(bank["words"]),
            "enabled": bank["enabled"],
        }
        for bank in room["custom_banks"]
    ]


def choose_new_word(room: Dict) -> None:
    """从房间词库中选择并保存新题目。"""
    pool = build_word_pool(room)
    if not pool:
        raise ValueError("当前没有可用题目，请先启用至少一个词库")
    word = random.choice(pool)
    room["question_count"] += 1
    room["word"] = word["answer"]
    room["word_hint"] = word["hint"]
    room["word_bank_name"] = word["bank_name"]


def get_word_hint(word: str, hint: str) -> str:
    """返回不泄露答案字符的长度和可选提示。"""
    masked_word = " ".join("＿" for _ in word)
    length_hint = f"{masked_word}（{len(word)}个字）"
    return f"{length_hint} · 提示：{hint}" if hint else length_hint


def active_chain_players(room: Dict) -> List[str]:
    """返回按加入顺序排列的活跃玩家（非观众席/非观战）。"""
    return [
        pid
        for pid, pdata in room["players"].items()
        if not pdata.get("spectator", False) and not pdata.get("watching", False)
    ]


def get_active_player_name(room: Dict) -> str:
    """返回当前接龙回合玩家昵称。"""
    active_id = room.get("active_player_id")
    if not active_id or active_id not in room["players"]:
        return ""
    return room["players"][active_id]["name"]


def player_chain_position(room: Dict, player_id: str) -> int:
    """返回玩家从 1 开始的接龙棒次；非本局玩家返回 0。"""
    roster = room.get("chain_roster", [])
    return roster.index(player_id) + 1 if player_id in roster else 0


def chain_player_zone(room: Dict, player_id: str) -> str:
    """返回玩家在当前接龙中的区域，用于隔离画布和聊天。"""
    player = room["players"].get(player_id) or {}
    if player.get("spectator", False) or player.get("watching", False):
        return "spectator"
    if room.get("turn_phase") in REPLAY_PHASES:
        return "replay"
    roster = room.get("chain_roster", [])
    active_id = room.get("active_player_id")
    if player_id == active_id:
        return "active"
    if player_id not in roster or active_id not in roster:
        return "spectator"
    return "finished" if roster.index(player_id) < roster.index(active_id) else "waiting"


def lobby_canvas_player_ids(room: Dict) -> set[str]:
    """返回当前可接收大厅公共画布消息的玩家。"""
    if room["phase"] == "lobby":
        return set(room["players"])
    return {
        player_id
        for player_id in room["players"]
        if chain_player_zone(room, player_id) == "waiting"
    }


def game_canvas_player_ids(room: Dict) -> set[str]:
    """返回当前可查看正式接龙画布的玩家。"""
    return {
        player_id
        for player_id in room["players"]
        if chain_player_zone(room, player_id) in {"active", "finished", "spectator", "replay"}
    }


def chat_player_ids(room: Dict, player_id: str) -> set[str]:
    """返回与玩家处于同一聊天室的成员。"""
    if room["phase"] == "lobby" or room.get("turn_phase") in REPLAY_PHASES:
        return set(room["players"])
    zone = chain_player_zone(room, player_id)
    return {
        other_id
        for other_id in room["players"]
        if chain_player_zone(room, other_id) == zone
    }


def player_chat_message(room: Dict, player_id: str, text: str) -> Dict[str, object]:
    """构造带接龙棒次与发送者 ID 的玩家聊天消息。"""
    return {
        "type": "message",
        "sender": room["players"][player_id]["name"],
        "sender_id": player_id,
        "text": text,
        "chain_position": player_chain_position(room, player_id),
    }


def can_modify_lobby_canvas(room: Dict, player_id: str) -> bool:
    """判断玩家当前是否可以修改大厅公共或私人画布。"""
    player = room["players"].get(player_id) or {}
    if player.get("spectator", False) or player.get("watching", False):
        return False
    return room["phase"] == "lobby" or chain_player_zone(room, player_id) == "waiting"


def can_view_artwork(room: Dict, player_id: str, artwork: Dict) -> bool:
    """判断玩家是否可查看画作，防止候场者从画廊提前看到接龙内容。"""
    visibility = str(artwork.get("visibility") or "public")
    if visibility == "private" and artwork.get("author_id") != player_id:
        return False
    if (
        room["phase"] == "playing"
        and str(artwork.get("source") or "") == "game"
        and chain_player_zone(room, player_id) in {"active", "waiting"}
    ):
        return False
    return True


def has_drawing_strokes(strokes: List[Dict]) -> bool:
    """判断是否至少有一条非背景笔画。"""
    for stroke in strokes:
        segments = stroke.get("segments", [])
        if any(segment.get("tool", "brush") != "background" for segment in segments):
            return True
    return False


def get_word_bank_options() -> List[Dict[str, object]]:
    """返回前端可勾选的内置词库。"""
    return [
        {"id": bank_id, "name": bank["name"], "count": len(bank["words"])}
        for bank_id, bank in BUILTIN_WORD_BANKS.items()
    ]


def player_list(room: Dict) -> List[Dict[str, object]]:
    """序列化房间玩家及大厅准备状态。"""
    return serialize_lobby_players(room)


def game_player_list(room: Dict) -> List[Dict[str, object]]:
    """按接龙棒次排序的玩家列表；非本局玩家排在末尾。"""
    roster = room.get("chain_roster", [])
    roster_set = set(roster)
    entries: List[Dict[str, object]] = []
    for player_id in roster:
        pdata = room["players"].get(player_id)
        if pdata is None:
            continue
        entries.append(
            {
                "uid": player_id,
                "nickname": pdata["name"],
                "chain_position": roster.index(player_id) + 1,
                "watching": bool(pdata.get("watching", False)),
                "spectator": bool(pdata.get("spectator", False)),
                "connected": bool(pdata.get("connected", True)),
            }
        )
    extras = [
        {
            "uid": player_id,
            "nickname": pdata["name"],
            "chain_position": 0,
            "watching": bool(pdata.get("watching", False)),
            "spectator": bool(pdata.get("spectator", False)),
            "connected": bool(pdata.get("connected", True)),
        }
        for player_id, pdata in room["players"].items()
        if player_id not in roster_set
    ]
    extras.sort(key=lambda item: str(item["nickname"]).casefold())
    entries.extend(extras)
    return entries


def serialize_artworks(room: Dict, viewer_id: str = "") -> List[Dict[str, object]]:
    """按私人权限和接龙区域下发玩家可见的画廊元数据。"""
    items: List[Dict[str, object]] = []
    for artwork in reversed(room["artworks"]):
        if not can_view_artwork(room, viewer_id, artwork):
            continue
        visibility = str(artwork.get("visibility") or "public")
        items.append(
            {
                "id": artwork["id"],
                "author_id": artwork["author_id"],
                "author_name": artwork["author_name"],
                "created_at": artwork["created_at"],
                "mime_type": artwork["mime_type"],
                "visibility": visibility,
                "source": artwork.get("source") or "lobby",
                "word": artwork.get("word") or "",
                "guess": artwork.get("guess") or "",
                "title": artwork.get("title") or artwork["author_name"],
                "preview_url": (
                    "/draw-chain/artworks/"
                    + quote(room["room_id"], safe="")
                    + "/"
                    + quote(artwork["id"], safe="")
                ),
            }
        )
    return items


async def send_artwork_galleries(room_id: str, room: Dict) -> None:
    """按查看者权限分别下发画廊列表。"""
    for pid, pdata in list(room["players"].items()):
        if not pdata["connected"]:
            continue
        try:
            await send_json(
                pdata["ws"],
                {"type": "artwork_gallery", "artworks": serialize_artworks(room, pid)},
            )
        except Exception:
            continue


def count_playing_players(room: Dict) -> int:
    """统计观众席以外的玩家数，作为房间画作缓存上限。"""
    return sum(
        1 for pdata in room["players"].values() if not pdata.get("watching", False)
    )


def trim_artworks(room: Dict) -> None:
    """画作上限跟随正在游戏的人数；进行中接龙引用的画作不清理，避免回放缺图。"""
    limit = max(1, count_playing_players(room))
    overflow = len(room["artworks"]) - limit
    if overflow <= 0:
        return
    protected_ids = (
        {str(step.get("artwork_id") or "") for step in room.get("chain_steps", [])}
        if room["phase"] == "playing"
        else set()
    )
    kept: List[Dict] = []
    for artwork in room["artworks"]:
        if overflow > 0 and artwork["id"] not in protected_ids:
            overflow -= 1
            continue
        kept.append(artwork)
    room["artworks"] = kept


def build_lobby_state(
    room: Dict, player_id: str, *, include_strokes: bool = False
) -> Dict:
    """构造大厅玩家状态；笔画仅在进房/修复时附带，常规同步走 lobby_draw 增量。"""
    state = {
        "type": "lobby_state",
        "phase": "lobby",
        "self_id": player_id,
        "is_host": player_id == room["owner_id"],
        "owner_name": get_owner_name(room),
        "players": player_list(room),
        "artworks": serialize_artworks(room, player_id),
        "canvas": serialize_canvas(room.get("lobby_canvas") or default_vector_canvas()),
    }
    if include_strokes:
        state["strokes"] = serialize_strokes(room["lobby_strokes"])
    pdata = room["players"][player_id]
    state["watching"] = pdata.get("watching", False)
    state["spectator"] = pdata.get("spectator", False)
    # 全员可见元数据（不含题目正文），房客只读、房主可改
    state["word_bank_options"] = get_word_bank_options()
    state["word_bank_settings"] = {
        "builtin_banks": room["enabled_banks"],
        "custom_banks": serialize_custom_banks(room),
        "hints_enabled": room["hints_enabled"],
        "draw_seconds": room["draw_seconds"],
    }
    return state


def can_modify_game_canvas(room: Dict, player_id: str, round_id: object) -> bool:
    """仅允许当前绘画回合的画师修改正式游戏画布。"""
    pdata = room["players"].get(player_id) or {}
    return (
        room["phase"] == "playing"
        and room.get("turn_phase") == "draw"
        and player_id == room.get("drawer_id")
        and player_id == room.get("active_player_id")
        and not pdata.get("spectator", False)
        and not pdata.get("watching", False)
        and str(round_id or "") == room["round_id"]
    )


def can_change_lobby_canvas_mode(room: Dict, player_id: str) -> bool:
    """候场公共画布模式仅房主可改，且该玩家当前必须在大厅画布上。"""
    pdata = room["players"].get(player_id) or {}
    return (
        player_id == room["owner_id"]
        and player_id in lobby_canvas_player_ids(room)
        and not pdata.get("spectator", False)
        and not pdata.get("watching", False)
    )


def canvas_broadcast_payload(
    event_type: str, canvas: Dict, strokes: List[Dict], extra: Optional[Dict] = None
) -> Dict:
    """组装画布模式广播：模式、尺寸，以及清笔触后的快照。"""
    payload = {
        "type": event_type,
        "mode": canvas["mode"],
        "width": canvas["width"],
        "height": canvas["height"],
        "strokes": serialize_strokes(strokes),
        "canvas": serialize_canvas(canvas),
    }
    if extra:
        payload.update(extra)
    return payload


def build_game_state(
    room: Dict, player_id: str, *, include_strokes: bool = False
) -> Dict:
    """构造画画接龙游戏状态；笔画在进房/换轮/修复时附带，常规靠 draw 增量。"""
    pdata = room["players"][player_id]
    is_spectator = pdata["spectator"] or pdata.get("watching", False)
    turn_phase = str(room.get("turn_phase") or "")
    active_id = room.get("active_player_id")
    chain_roster = room.get("chain_roster", [])
    chain_position = player_chain_position(room, player_id)
    activity_zone = chain_player_zone(room, player_id)
    canvas_scope = "lobby" if activity_zone == "waiting" else "game"

    if is_spectator:
        role = "spectator"
    elif turn_phase in REPLAY_PHASES:
        role = "waiting"
    elif player_id == active_id:
        role = "drawer" if turn_phase == "draw" else "guesser" if turn_phase == "guess" else "waiting"
    else:
        role = "waiting"

    state: Dict[str, object] = {
        "type": "state",
        "phase": "playing",
        "self_id": player_id,
        "role": role,
        "is_host": player_id == room["owner_id"],
        "turn_phase": turn_phase,
        "chain_index": room.get("chain_index", 0),
        "chain_position": chain_position,
        "chain_length": len(chain_roster),
        "draw_remaining": (
            max(0, int(room["draw_deadline"] - time.monotonic() + 0.999))
            if turn_phase == "draw"
            else 0
        ),
        "active_name": get_active_player_name(room),
        "active_player_id": room.get("active_player_id") or "",
        "round_id": room["round_id"],
        "word_bank_name": room["word_bank_name"],
        "players": game_player_list(room),
        "artworks": serialize_artworks(room, player_id),
        "skip_count": 0,
        "skip_required": 0,
        "skip_voted": False,
        "watching": pdata.get("watching", False),
        "queued_for_game": player_id in room["pending_players"],
        "activity_zone": activity_zone,
        "canvas_scope": canvas_scope,
        "chat_scope": (
            "room"
            if activity_zone == "replay"
            else activity_zone
        ),
        "canvas": serialize_canvas(
            (room.get("lobby_canvas") if canvas_scope == "lobby" else room.get("game_canvas"))
            or default_vector_canvas()
        ),
    }

    if turn_phase == "draw" and role == "drawer":
        state["word"] = room.get("prompt_word", "")
        state["prompt"] = "请画出题目"
    elif turn_phase == "guess":
        prompt_word = str(room.get("prompt_word") or "")
        if role == "guesser" and prompt_word:
            bank_hint = (
                room["word_hint"]
                if room["hints_enabled"] and prompt_word == room.get("word")
                else ""
            )
            state["prompt"] = get_word_hint(prompt_word, bank_hint)
        else:
            state["prompt"] = "请根据画作猜词"
    elif turn_phase in REPLAY_PHASES:
        state["replay"] = serialize_replay(room, player_id)

    if canvas_scope == "lobby" and include_strokes:
        state["strokes"] = serialize_strokes(room["lobby_strokes"])
    elif turn_phase == "guess" and activity_zone != "waiting":
        state["strokes"] = serialize_strokes(room["game_strokes"])
    elif include_strokes and turn_phase == "draw" and activity_zone != "waiting":
        state["strokes"] = serialize_strokes(room["game_strokes"])

    return state


def return_room_to_lobby(
    room: Dict,
    *,
    auto_ready_ids: Optional[set[str]] = None,
    preserve_audience_ids: Optional[set[str]] = None,
) -> None:
    """结束当前接龙并把所有玩家恢复为大厅准备状态。"""
    auto_ready_ids = auto_ready_ids or set()
    preserve_audience_ids = preserve_audience_ids or set()
    room["phase"] = "lobby"
    capture_future = room.get("artwork_capture_future")
    if capture_future is not None and not capture_future.done():
        capture_future.cancel()
    room["artwork_capture_token"] = ""
    room["artwork_capture_round_id"] = ""
    room["artwork_capture_future"] = None
    room["original_player_ids"] = set()
    room["original_absence_token"] = ""
    room["drawer_id"] = None
    room["round_id"] = ""
    room["word"] = ""
    room["word_hint"] = ""
    room["question_count"] = 0
    room["turn_phase"] = ""
    room["chain_roster"] = []
    room["chain_index"] = 0
    room["chain_steps"] = []
    room["active_player_id"] = None
    room["prompt_word"] = ""
    room["draw_deadline"] = 0.0
    room["draw_turn_token"] = ""
    room["replay_original_word"] = ""
    room["replay_final_guess"] = ""
    room["replay_artworks"] = []
    room["replay_verdict_votes"] = {}
    room["replay_artwork_votes"] = {}
    room["replay_is_correct"] = None
    room["replay_winner_id"] = ""
    room["replay_token"] = ""
    room["replay_deadline"] = 0.0
    room["pending_players"] = []
    room["game_strokes"] = []
    room["game_redo"] = {}
    room["previous_game_strokes"] = []
    room["guess_prompt_word"] = ""
    for player_id, player in room["players"].items():
        is_audience = player_id in preserve_audience_ids
        player["ready"] = (
            player_id in auto_ready_ids
            and player.get("connected", True)
            and not is_audience
        )
        player["spectator"] = is_audience
        player["watching"] = is_audience
    trim_artworks(room)


def start_draw_turn(room_id: str, room: Dict) -> None:
    """启动当前绘画阶段的服务端倒计时。"""
    seconds = int(room["draw_seconds"])
    room["draw_turn_token"] = uuid.uuid4().hex
    room["draw_deadline"] = time.monotonic() + seconds
    schedule_draw_timeout(room_id, room, seconds)


def start_room_game(room_id: str, room: Dict) -> None:
    """把准备完成的大厅切换为画画接龙对局。"""
    room["phase"] = "playing"
    room["artwork_capture_token"] = ""
    room["artwork_capture_round_id"] = ""
    room["artwork_capture_future"] = None
    for pdata in room["players"].values():
        pdata["ready"] = False
        if pdata.get("watching", False):
            pdata["spectator"] = True
        else:
            pdata["spectator"] = False
            pdata["watching"] = False
    roster = active_chain_players(room)
    room["chain_roster"] = roster
    room["chain_index"] = 0
    room["chain_steps"] = []
    room["replay_original_word"] = ""
    room["replay_final_guess"] = ""
    room["replay_artworks"] = []
    room["replay_verdict_votes"] = {}
    room["replay_artwork_votes"] = {}
    room["replay_is_correct"] = None
    room["replay_winner_id"] = ""
    room["replay_token"] = ""
    room["replay_deadline"] = 0.0
    room["pending_players"] = []
    room["original_player_ids"] = set(room["players"].keys())
    room["original_absence_token"] = ""
    room["question_count"] = 0
    room["game_strokes"] = []
    room["game_redo"] = {}
    room["previous_game_strokes"] = []
    room["guess_prompt_word"] = ""
    choose_new_word(room)
    initial_word = room["word"]
    room["chain_steps"].append({"kind": "word", "text": initial_word})
    room["prompt_word"] = initial_word
    room["active_player_id"] = roster[0]
    room["drawer_id"] = roster[0]
    room["turn_phase"] = "draw"
    room["round_id"] = uuid.uuid4().hex
    start_draw_turn(room_id, room)


async def advance_after_submit_drawing(
    room_id: str, room: Dict, *, expected_token: Optional[str] = None
) -> bool:
    """认领并提交当前画作；过期或重复请求返回 False。"""
    token = str(room.get("draw_turn_token") or "")
    if (
        room.get("phase") != "playing"
        or room.get("turn_phase") != "draw"
        or not token
        or (expected_token is not None and token != expected_token)
    ):
        return False
    room["draw_turn_token"] = ""
    room["draw_deadline"] = 0.0
    drawer_id = room.get("active_player_id")
    drawer = room["players"].get(drawer_id) or {}
    prompt_word = str(room.get("prompt_word") or room.get("word") or "")
    expected_round_id = room["round_id"]
    # 先截图再换回合，避免客户端 round_id 已更新导致 capture 被丢弃
    artwork_id = await request_and_cache_artwork(
        room_id,
        room,
        expected_round_id,
        artist_id=str(drawer_id or ""),
        word=prompt_word,
    )
    if (
        rooms.get(room_id) is not room
        or room.get("phase") != "playing"
        or room.get("turn_phase") != "draw"
        or room.get("round_id") != expected_round_id
    ):
        return False
    drawing_step: Dict[str, object] = {
        "kind": "drawing",
        "player_id": drawer_id,
        "player_name": drawer.get("name", ""),
    }
    if artwork_id:
        drawing_step["artwork_id"] = artwork_id
    room["chain_steps"].append(drawing_step)
    room["chain_index"] += 1
    room["drawer_id"] = None
    room["active_player_id"] = room["chain_roster"][room["chain_index"]]
    room["turn_phase"] = "guess"
    room["round_id"] = uuid.uuid4().hex
    return True


async def advance_after_guess(room_id: str, room: Dict, guess_text: str) -> None:
    """猜词玩家提交答案后写入接龙步骤并推进到绘画或揭晓。"""
    active_id = room.get("active_player_id")
    active = room["players"].get(active_id) or {}
    room["chain_steps"].append(
        {
            "kind": "guess",
            "player_id": active_id,
            "player_name": active.get("name", ""),
            "text": guess_text,
        }
    )
    previous_drawing = next(
        (
            step
            for step in reversed(room["chain_steps"][:-1])
            if step.get("kind") == "drawing"
        ),
        None,
    )
    if previous_drawing is not None:
        artwork_id = str(previous_drawing.get("artwork_id") or "")
        artwork = next(
            (item for item in room["artworks"] if item["id"] == artwork_id),
            None,
        )
        if artwork is not None:
            artwork["guess"] = guess_text
            artwork["title"] = f"{artwork['author_name']}-{guess_text}"
    roster_len = len(room["chain_roster"])
    if room["chain_index"] == roster_len - 1:
        start_replay(room)
        schedule_replay_timeout(room_id, room, VERDICT_SECONDS)
        room["active_player_id"] = None
        room["drawer_id"] = None
        room["prompt_word"] = ""
        room["previous_game_strokes"] = []
        room["guess_prompt_word"] = ""
    else:
        room["guess_prompt_word"] = str(room.get("prompt_word") or "")
        room["previous_game_strokes"] = copy.deepcopy(room["game_strokes"])
        room["prompt_word"] = guess_text
        room["drawer_id"] = active_id
        room["active_player_id"] = active_id
        room["turn_phase"] = "draw"
        room["game_strokes"] = []
        room["game_redo"] = {}
        room["round_id"] = uuid.uuid4().hex
        start_draw_turn(room_id, room)


def schedule_draw_timeout(room_id: str, room: Dict, delay_seconds: int) -> None:
    """安排当前绘画阶段到时自动交画。"""
    asyncio.create_task(
        finish_draw_after_timeout(
            room_id,
            room,
            str(room["draw_turn_token"]),
            delay_seconds,
        )
    )


async def finish_draw_after_timeout(
    room_id: str,
    expected_room: Dict,
    expected_token: str,
    delay_seconds: int,
) -> None:
    """倒计时结束后自动提交画布；已提前交画的任务自动失效。"""
    try:
        await asyncio.sleep(delay_seconds)
        room = rooms.get(room_id)
        if room is not expected_room:
            return
        advanced = await advance_after_submit_drawing(
            room_id,
            room,
            expected_token=expected_token,
        )
        if not advanced:
            return
        await send_room_states(room, include_strokes=True)
        await broadcast(
            room_id,
            {
                "type": "message",
                "sender": "系统",
                "sender_icon": "timer",
                "text": "作画时间到，已自动交画",
            },
        )
    except Exception:
        logger.exception("画画接龙作画倒计时自动交画失败")


def schedule_replay_timeout(room_id: str, room: Dict, delay_seconds: int) -> None:
    """为当前回放阶段安排一次带令牌校验的自动推进。"""
    asyncio.create_task(
        finish_replay_stage_after_timeout(
            room_id,
            room,
            str(room.get("replay_token") or ""),
            str(room.get("turn_phase") or ""),
            delay_seconds,
        )
    )


async def finish_replay_stage_after_timeout(
    room_id: str,
    expected_room: Dict,
    expected_token: str,
    expected_stage: str,
    delay_seconds: int,
) -> None:
    """倒计时结束后推进回放；过期任务不会修改房间。"""
    try:
        await asyncio.sleep(delay_seconds)
        room = rooms.get(room_id)
        if (
            room is not expected_room
            or room.get("phase") != "playing"
            or room.get("turn_phase") != expected_stage
            or room.get("replay_token") != expected_token
        ):
            return
        await advance_replay_stage(room_id, room, expected_stage=expected_stage)
    except Exception:
        logger.exception("画画接龙回放阶段自动推进失败")


async def advance_replay_stage(
    room_id: str, room: Dict, *, expected_stage: Optional[str] = None
) -> None:
    """依次推进正确性投票、最佳画作投票、冠军展示和自动回厅。"""
    stage = str(room.get("turn_phase") or "")
    if expected_stage is not None and stage != expected_stage:
        return
    if stage == REPLAY_VERDICT:
        resolve_verdict(room)
        start_artwork_vote(room)
        schedule_replay_timeout(room_id, room, ARTWORK_VOTE_SECONDS)
        await send_room_states(room)
        return
    if stage == REPLAY_ARTWORKS:
        resolve_artwork_winner(room)
        start_winner_display(room)
        schedule_replay_timeout(room_id, room, WINNER_SECONDS)
        await send_room_states(room)
        return
    if stage != REPLAY_WINNER:
        return

    auto_ready_ids = set(room.get("chain_roster", []))
    preserve_audience_ids = {
        player_id
        for player_id, player in room["players"].items()
        if player.get("watching", False)
    }
    return_room_to_lobby(
        room,
        auto_ready_ids=auto_ready_ids,
        preserve_audience_ids=preserve_audience_ids,
    )
    await send_room_states(room, include_strokes=True)
    await broadcast(
        room_id,
        {
            "type": "message",
            "sender": "系统", "sender_icon": "film",
            "text": "回放结束，参赛玩家已自动准备",
        },
    )


async def send_json(websocket: WebSocket, message: Dict) -> None:
    """向单个连接发送 JSON。"""
    await websocket.send_text(json.dumps(message, ensure_ascii=False))


async def broadcast(room_id: str, message: Dict, exclude_id: Optional[str] = None) -> None:
    """向房间广播消息，可排除一个玩家。"""
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


async def broadcast_to_players(
    room_id: str,
    player_ids: set[str],
    message: Dict,
    exclude_id: Optional[str] = None,
) -> None:
    """只向指定的在线玩家发送消息。"""
    room = rooms.get(room_id)
    if not room:
        return
    for player_id in player_ids:
        player = room["players"].get(player_id)
        if player_id == exclude_id or not player or not player["connected"]:
            continue
        try:
            await send_json(player["ws"], message)
        except Exception:
            continue


async def send_room_states(room: Dict, *, include_strokes: bool = False) -> None:
    """按房间阶段向所有玩家发送其专属状态；默认不附带笔画（增量同步）。"""
    for pid, pdata in list(room["players"].items()):
        if not pdata["connected"]:
            continue
        state = (
            build_lobby_state(room, pid, include_strokes=include_strokes)
            if room["phase"] == "lobby"
            else build_game_state(room, pid, include_strokes=include_strokes)
        )
        try:
            await send_json(pdata["ws"], state)
        except Exception:
            continue


async def send_player_state(
    room: Dict, player_id: str, *, include_strokes: bool = True
) -> None:
    """向单个玩家发送状态；进房/重连默认带笔画快照。"""
    pdata = room["players"].get(player_id)
    if not pdata or not pdata["connected"]:
        return
    state = (
        build_lobby_state(room, player_id, include_strokes=include_strokes)
        if room["phase"] == "lobby"
        else build_game_state(room, player_id, include_strokes=include_strokes)
    )
    await send_json(pdata["ws"], state)


async def send_error(
    websocket: WebSocket, message: str, error_code: Optional[str] = None
) -> None:
    """发送业务错误；不可恢复错误可以附带追踪代码。"""
    payload = {"type": "error", "message": message}
    if error_code:
        payload["code"] = error_code
    await send_json(websocket, payload)


async def request_and_cache_artwork(
    room_id: str,
    room: Dict,
    expected_round_id: str,
    *,
    artist_id: str = "",
    word: str = "",
) -> Optional[str]:
    """向指定画师请求截图并缓存，返回新画作 id；失败时返回 None。"""
    drawer_id = str(artist_id or room.get("drawer_id") or room.get("active_player_id") or "")
    drawer = room["players"].get(drawer_id)
    if not drawer or not drawer["connected"]:
        return None
    token = uuid.uuid4().hex
    future = asyncio.get_running_loop().create_future()
    room["artwork_capture_token"] = token
    room["artwork_capture_round_id"] = expected_round_id
    room["artwork_capture_future"] = future
    capture_word = str(word or room.get("prompt_word") or room.get("word") or "")
    await send_json(
        drawer["ws"],
        {
            "type": "capture_artwork",
            "capture_id": token,
            "round_id": expected_round_id,
            "mime_type": "image/webp",
        },
    )
    try:
        capture_result = await asyncio.wait_for(
            future, timeout=ARTWORK_CAPTURE_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        capture_result = None
    finally:
        if room.get("artwork_capture_token") == token:
            room["artwork_capture_token"] = ""
            room["artwork_capture_round_id"] = ""
            room["artwork_capture_future"] = None
    image_bytes, image_mime = capture_result or (None, "")
    if (
        image_bytes is None
        or rooms.get(room_id) is not room
        or room["phase"] != "playing"
    ):
        return None
    artwork_id = uuid.uuid4().hex
    title = f"{capture_word}-{drawer['name']}" if capture_word else drawer["name"]
    room["artworks"].append(
        {
            "id": artwork_id,
            "author_id": drawer_id,
            "author_name": drawer["name"],
            "title": title,
            "word": capture_word,
            "visibility": "public",
            "source": "game",
            "created_at": time.time(),
            "mime_type": image_mime,
            "image_bytes": image_bytes,
        }
    )
    trim_artworks(room)
    await send_artwork_galleries(room_id, room)
    return artwork_id


def decode_artwork_image(encoded_image: object, mime_type: object) -> Optional[bytes]:
    """校验 MIME、Base64 和解码后大小；WebP 优先，PNG 兼容不支持 WebP 编码的浏览器。"""
    if mime_type not in ARTWORK_MIME_TYPES:
        return None
    if not isinstance(encoded_image, str) or len(encoded_image) > MAX_ARTWORK_BYTES * 2:
        return None
    try:
        image_bytes = base64.b64decode(encoded_image, validate=True)
    except (binascii.Error, ValueError):
        return None
    if mime_type == "image/webp":
        header_ok = (
            len(image_bytes) >= 12
            and image_bytes[:4] == b"RIFF"
            and image_bytes[8:12] == b"WEBP"
        )
    else:
        header_ok = image_bytes[:8] == b"\x89PNG\r\n\x1a\n"
    if not header_ok or len(image_bytes) > MAX_ARTWORK_BYTES:
        return None
    return image_bytes


def has_connected_original_player(room: Dict) -> bool:
    """判断当前对局是否仍有开局时的玩家在线。"""
    return any(
        pid in room["players"] and room["players"][pid]["connected"]
        for pid in room["original_player_ids"]
    )


def update_original_player_absence_timer(room_id: str, room: Dict) -> None:
    """按原玩家在线状态启动或取消连续60秒缺席检查。"""
    if room["phase"] != "playing" or has_connected_original_player(room):
        room["original_absence_token"] = ""
        return
    if room["original_absence_token"]:
        return
    token = uuid.uuid4().hex
    room["original_absence_token"] = token
    asyncio.create_task(resolve_original_player_absence(room_id, room, token))


async def resolve_original_player_absence(
    room_id: str, expected_room: Dict, expected_token: str
) -> None:
    """捕获原玩家缺席检查中的意外错误，避免后台任务静默失败。"""
    try:
        await apply_original_player_absence_resolution(
            room_id, expected_room, expected_token
        )
    except Exception:
        logger.exception("原玩家缺席60秒后的房间处理失败")


async def apply_original_player_absence_resolution(
    room_id: str, expected_room: Dict, expected_token: str
) -> None:
    """原玩家持续缺席60秒后关闭房间或交给在线的中途加入者。"""
    await asyncio.sleep(ORIGINAL_PLAYER_ABSENCE_SECONDS)
    room = rooms.get(room_id)
    if (
        room is not expected_room
        or room["phase"] != "playing"
        or room["original_absence_token"] != expected_token
        or has_connected_original_player(room)
    ):
        return
    original_ids = room["original_player_ids"]
    replacement_ids = [
        pid
        for pid, player in room["players"].items()
        if pid not in original_ids and player["connected"]
    ]
    if not replacement_ids:
        close_room(room_id)
        return
    new_owner_id = random.choice(replacement_ids)
    new_owner_name = room["players"][new_owner_id]["name"]
    room["owner_id"] = new_owner_id
    return_room_to_lobby(room)
    await send_room_states(room, include_strokes=True)
    await broadcast(
        room_id,
        {
            "type": "message",
            "sender": "系统", "sender_icon": "home",
            "text": f"原玩家已离线超过60秒，{new_owner_name} 已成为房主，房间返回准备阶段",
        },
    )


async def abort_chain_to_lobby(room_id: str, room: Dict, reason: str) -> None:
    """中断接龙并返回大厅，同时作废绘画超时令牌。"""
    room["draw_turn_token"] = ""
    room["draw_deadline"] = 0.0
    return_room_to_lobby(room)
    await send_room_states(room, include_strokes=True)
    await broadcast(
        room_id,
        {"type": "message", "sender": "系统", "sender_icon": "target", "text": reason},
    )


def clear_last_guess_on_artwork(room: Dict, guess_text: str) -> None:
    """撤销猜词时写入画作标题的猜词结果。"""
    previous_drawing = next(
        (
            step
            for step in reversed(room.get("chain_steps", []))
            if step.get("kind") == "drawing"
        ),
        None,
    )
    if previous_drawing is None:
        return
    artwork_id = str(previous_drawing.get("artwork_id") or "")
    artwork = next(
        (item for item in room["artworks"] if item["id"] == artwork_id),
        None,
    )
    if artwork is None:
        return
    if artwork.get("guess") == guess_text:
        artwork["guess"] = ""
        artwork["title"] = artwork["author_name"]


def chain_can_continue(room: Dict) -> bool:
    """判断踢人后是否仍满足接龙最低人数与棒次索引。"""
    roster = room.get("chain_roster", [])
    return (
        room.get("phase") == "playing"
        and len(active_chain_players(room)) >= 2
        and len(roster) >= 2
        and 0 <= int(room.get("chain_index", 0)) < len(roster)
    )


async def continue_chain_after_active_removed(
    room_id: str,
    room: Dict,
    *,
    removed_name: str,
    turn_phase: str,
    had_submitted_guess: bool,
) -> bool:
    """当前行动玩家离开后尽量交给下一棒；无法接续时返回 False。"""
    if not chain_can_continue(room):
        return False
    roster = room["chain_roster"]
    next_id = roster[room["chain_index"]]
    next_name = room["players"][next_id]["name"]

    if turn_phase == "guess":
        room["active_player_id"] = next_id
        room["drawer_id"] = None
        room["round_id"] = uuid.uuid4().hex
        await send_room_states(room, include_strokes=True)
        await broadcast(
            room_id,
            {
                "type": "message",
                "sender": "系统", "sender_icon": "target",
                "text": f"{removed_name} 离开，由 {next_name} 继续猜词",
            },
        )
        return True

    if turn_phase != "draw":
        return False

    if had_submitted_guess:
        steps = room.get("chain_steps", [])
        if not steps or steps[-1].get("kind") != "guess":
            return False
        guess_step = steps.pop()
        guess_text = str(guess_step.get("text") or "")
        clear_last_guess_on_artwork(room, guess_text)
        if not room.get("previous_game_strokes"):
            return False
        room["game_strokes"] = copy.deepcopy(room["previous_game_strokes"])
        room["game_redo"] = {}
        room["prompt_word"] = str(room.get("guess_prompt_word") or room.get("word") or "")
        room["guess_prompt_word"] = ""
        room["previous_game_strokes"] = []
        room["active_player_id"] = next_id
        room["drawer_id"] = None
        room["turn_phase"] = "guess"
        room["draw_turn_token"] = ""
        room["draw_deadline"] = 0.0
        room["round_id"] = uuid.uuid4().hex
        await send_room_states(room, include_strokes=True)
        await broadcast(
            room_id,
            {
                "type": "message",
                "sender": "系统", "sender_icon": "target",
                "text": f"{removed_name} 离开，已撤销其猜词，由 {next_name} 重新猜词",
            },
        )
        return True

    # 首棒或尚未提交猜词的画师：下一棒直接沿用当前提示词作画
    room["active_player_id"] = next_id
    room["drawer_id"] = next_id
    room["game_strokes"] = []
    room["game_redo"] = {}
    room["round_id"] = uuid.uuid4().hex
    start_draw_turn(room_id, room)
    await send_room_states(room, include_strokes=True)
    await broadcast_to_players(
        room_id,
        game_canvas_player_ids(room),
        {"type": "clear", "round_id": room["round_id"]},
    )
    await broadcast(
        room_id,
        {
            "type": "message",
            "sender": "系统", "sender_icon": "target",
            "text": f"{removed_name} 离开，由 {next_name} 接手作画",
        },
    )
    return True


async def maybe_advance_replay_after_voter_left(room_id: str, room: Dict) -> bool:
    """踢出投票者后，若剩余合资格玩家均已投票则立刻推进回放。"""
    turn_phase = str(room.get("turn_phase") or "")
    eligible = replay_voter_ids(room)
    if not eligible:
        return False
    if turn_phase == REPLAY_VERDICT:
        if all(voter_id in room["replay_verdict_votes"] for voter_id in eligible):
            await advance_replay_stage(room_id, room, expected_stage=REPLAY_VERDICT)
            return True
    elif turn_phase == REPLAY_ARTWORKS:
        if all(voter_id in room["replay_artwork_votes"] for voter_id in eligible):
            await advance_replay_stage(room_id, room, expected_stage=REPLAY_ARTWORKS)
            return True
    return False


async def remove_player_from_room(room_id: str, player_id: str, message: str) -> None:
    """移除玩家并统一处理房主转移、接龙续局/中断和状态广播。"""
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        return
    removed_name = str(room["players"][player_id].get("name") or "玩家")
    was_owner = room["owner_id"] == player_id
    was_active = room.get("active_player_id") == player_id
    turn_phase = str(room.get("turn_phase") or "")
    removed_index = (
        room["chain_roster"].index(player_id)
        if player_id in room.get("chain_roster", [])
        else -1
    )
    had_submitted_guess = False
    if (
        was_active
        and turn_phase == "draw"
        and room.get("chain_steps")
        and room["chain_steps"][-1].get("kind") == "guess"
        and room["chain_steps"][-1].get("player_id") == player_id
    ):
        had_submitted_guess = True

    await broadcast(
        room_id,
        {"type": "message", "sender": "系统", "sender_icon": "door", "text": message},
        exclude_id=player_id,
    )
    del room["players"][player_id]
    if player_rooms.get(player_id) == room_id:
        del player_rooms[player_id]
    room["pending_players"] = [pid for pid in room["pending_players"] if pid != player_id]
    roster = room.get("chain_roster", [])
    if player_id in roster:
        roster.remove(player_id)
        if removed_index >= 0 and removed_index < room.get("chain_index", 0):
            room["chain_index"] -= 1
    room["replay_verdict_votes"].pop(player_id, None)
    room["replay_artwork_votes"].pop(player_id, None)
    update_original_player_absence_timer(room_id, room)
    trim_artworks(room)
    if not room["players"]:
        if room["phase"] == "playing" and room["original_absence_token"]:
            room["owner_id"] = None
            return
        close_room(room_id)
        return
    if was_owner:
        waiting_for_original = (
            room["phase"] == "playing"
            and room["original_absence_token"]
            and not has_connected_original_player(room)
        )
        room["owner_id"] = (
            None if waiting_for_original else random.choice(list(room["players"]))
        )

    if room["phase"] != "playing":
        await send_room_states(room)
        return

    if turn_phase in REPLAY_PHASES:
        if await maybe_advance_replay_after_voter_left(room_id, room):
            return
        await send_room_states(room)
        return

    # 踢候场玩家后，当前画师若变成最后一棒仍在作画，无法再有猜词者
    if (
        not was_active
        and turn_phase == "draw"
        and room.get("chain_index", 0) >= len(room.get("chain_roster", [])) - 1
    ):
        await abort_chain_to_lobby(
            room_id,
            room,
            "剩余棒次不足，接龙已中断，房间返回准备阶段",
        )
        return

    if was_active and turn_phase in {"draw", "guess"}:
        continued = await continue_chain_after_active_removed(
            room_id,
            room,
            removed_name=removed_name,
            turn_phase=turn_phase,
            had_submitted_guess=had_submitted_guess,
        )
        if continued:
            return
        await abort_chain_to_lobby(
            room_id,
            room,
            "无法继续接龙，房间返回准备阶段",
        )
        return

    if count_playing_players(room) == 0:
        await abort_chain_to_lobby(
            room_id,
            room,
            "所有玩家都已观战，房间已返回准备阶段",
        )
        return

    if len(active_chain_players(room)) < 2 or len(room.get("chain_roster", [])) < 2:
        await abort_chain_to_lobby(
            room_id,
            room,
            "剩余玩家不足，接龙已中断，房间返回准备阶段",
        )
        return

    await send_room_states(room)


async def evict_player_for_other_game(player_id: str) -> None:
    """玩家加入其他游戏的房间时，把他从本游戏的房间移出并关闭旧连接。"""
    room_id = player_rooms.get(player_id)
    if not room_id:
        return
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        player_rooms.pop(player_id, None)
        return
    player = room["players"][player_id]
    old_websocket = player.get("ws")
    player_name = str(player.get("name") or "玩家")
    await remove_player_from_room(room_id, player_id, f"{player_name} 离开了房间")
    if old_websocket is not None:
        try:
            await send_json(
                old_websocket,
                {"type": "room_removed", "message": "你已加入其他游戏的房间"},
            )
            await old_websocket.close(code=4004)
        except Exception:
            pass


def get_reconnect_session(player_id: str) -> Optional[Dict[str, str]]:
    """若玩家仍在房间内（含断线宽限期），返回首页可跳转的重连目标。"""
    room_id = player_rooms.get(player_id)
    if not room_id:
        return None
    if timed_out_rooms.get(player_id) == room_id:
        return None
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        return None
    return {
        "game_id": GAME_ID,
        "room_id": room_id,
        "url": "/draw-chain/" + quote(room_id, safe=""),
    }


register_game(
    GAME_ID,
    get_player_room=player_rooms.get,
    evict_player=evict_player_for_other_game,
    get_reconnect_session=get_reconnect_session,
)


def import_custom_word_banks(
    room: Dict, data: Dict, *, owner_user_id: Optional[str] = None
) -> List[Dict[str, object]]:
    """逐个导入 TXT 到本局房间内存；不写服务端长期词库存储。"""
    files = data.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("请选择要导入的 TXT 文件")
    results: List[Dict[str, object]] = []
    existing_names = {bank["filename"].casefold() for bank in room["custom_banks"]}
    total_words = sum(len(bank["words"]) for bank in room["custom_banks"])
    for item in files:
        raw_name = str(item.get("filename", "")) if isinstance(item, dict) else ""
        filename = safe_bank_filename(raw_name)
        try:
            if not filename or not filename.lower().endswith(".txt"):
                raise ValueError("仅支持 TXT 文件")
            if filename.casefold() in existing_names:
                raise ValueError("同名文件已存在，请先删除旧文件")
            if len(room["custom_banks"]) >= MAX_CUSTOM_BANKS:
                raise ValueError("每个房间最多导入20个自定义词库")
            content = item.get("content") if isinstance(item, dict) else None
            if not isinstance(content, str):
                raise ValueError("TXT 内容无效")
            words = parse_word_bank(content)
            bank_name = get_custom_word_bank_name(content, filename)
            if total_words + len(words) > MAX_TOTAL_CUSTOM_WORDS:
                raise ValueError("每个房间的自定义词库合计最多2000道题")
            bank = {
                "id": uuid.uuid4().hex,
                "filename": filename,
                "name": bank_name,
                "words": words,
                "enabled": True,
                "owner_user_id": str(owner_user_id or ""),
            }
            room["custom_banks"].append(bank)
            existing_names.add(filename.casefold())
            total_words += len(words)
            results.append(
                {
                    "filename": filename,
                    "name": bank_name,
                    "success": True,
                    "count": len(words),
                }
            )
        except (AttributeError, TypeError, ValueError) as error:
            results.append({"filename": filename or "未命名文件", "success": False, "message": str(error)})
    return results


def apply_word_bank_update(room: Dict, data: Dict) -> None:
    """原子更新词库、提示和每棒作画时长。"""
    requested_banks = data.get("builtin_banks", [])
    requested_custom_ids = data.get("enabled_custom_bank_ids", [])
    if not isinstance(requested_banks, list) or not isinstance(requested_custom_ids, list):
        raise ValueError("词库选项无效")
    selected_banks = [bank_id for bank_id in BUILTIN_WORD_BANKS if bank_id in requested_banks]
    known_custom_ids = {bank["id"] for bank in room["custom_banks"]}
    selected_custom_ids = {str(bank_id) for bank_id in requested_custom_ids}
    if not selected_custom_ids.issubset(known_custom_ids):
        raise ValueError("自定义词库列表已变化，请刷新后重试")
    hints_enabled = data.get("hints_enabled", room["hints_enabled"])
    if not isinstance(hints_enabled, bool):
        raise ValueError("提示词设置无效")
    draw_seconds = data.get("draw_seconds", room["draw_seconds"])
    if (
        isinstance(draw_seconds, bool)
        or not isinstance(draw_seconds, int)
        or not MIN_DRAW_SECONDS <= draw_seconds <= MAX_DRAW_SECONDS
    ):
        raise ValueError("每棒作画时长必须为10至120秒")
    if not selected_banks and not selected_custom_ids:
        raise ValueError("至少勾选一个基础词库或自定义词库")
    room["enabled_banks"] = selected_banks
    for bank in room["custom_banks"]:
        bank["enabled"] = bank["id"] in selected_custom_ids
    room["hints_enabled"] = hints_enabled
    room["draw_seconds"] = draw_seconds


def delete_custom_word_bank(room: Dict, bank_id: str) -> Tuple[str, str]:
    """按服务端 ID 删除本局自定义词库，并返回 (文件名, owner_user_id)。

    删光所有词库也允许：开始游戏时会单独校验词池非空。
    """
    bank = next((item for item in room["custom_banks"] if item["id"] == bank_id), None)
    if bank is None:
        raise ValueError("该自定义词库已不存在")
    filename = str(bank["filename"])
    owner_user_id = str(bank.get("owner_user_id") or "")
    room["custom_banks"].remove(bank)
    return filename, owner_user_id


async def remove_disconnected_player_after_timeout(
    room_id: str, player_id: str, expected_room: Dict, disconnect_token: str
) -> None:
    """宽限期结束后移除仍未重连的玩家。"""
    await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
    room = rooms.get(room_id)
    if room is not expected_room:
        return
    player = room["players"].get(player_id)
    if not player or player["connected"] or player.get("disconnect_token") != disconnect_token:
        return
    timed_out_rooms[player_id] = room_id
    await remove_player_from_room(
        room_id,
        player_id,
        f"{player['name']} 断线超过30秒，已退出房间",
    )


async def handle_player_disconnect(
    room_id: Optional[str], player_id: Optional[str], websocket: WebSocket
) -> None:
    """标记玩家断线，并启动可由重连自动失效的30秒宽限期。"""
    if not room_id or room_id not in rooms or not player_id:
        return
    room = rooms[room_id]
    current_player = room["players"].get(player_id)
    if current_player is None or current_player["ws"] is not websocket:
        return
    current_player["connected"] = False
    update_original_player_absence_timer(room_id, room)
    disconnect_token = uuid.uuid4().hex
    current_player["disconnect_token"] = disconnect_token
    leave_name = current_player["name"]
    if room["phase"] == "lobby" and room["owner_id"] == player_id:
        connected_guests = [
            pid
            for pid, player in room["players"].items()
            if pid != player_id and player["connected"]
        ]
        if connected_guests:
            room["owner_id"] = random.choice(connected_guests)
    await broadcast(
        room_id,
        {
            "type": "message",
            "sender": "系统", "sender_icon": "break",
            "text": f"{leave_name} 断线",
        },
        exclude_id=player_id,
    )
    await send_room_states(room)
    asyncio.create_task(
        remove_disconnected_player_after_timeout(
            room_id, player_id, room, disconnect_token
        )
    )


@router.websocket("/draw-chain/ws")
async def game_websocket(websocket: WebSocket):
    """处理大厅和正式游戏的实时协议。"""
    identity = await get_current_identity_ws(websocket)
    if identity is None:
        return
    passport_user_id, passport_nickname = identity
    await websocket.accept()
    room_id: Optional[str] = None
    player_id: Optional[str] = None

    try:
        while True:
            raw_message = await websocket.receive_text()
            try:
                data = json.loads(raw_message)
            except json.JSONDecodeError:
                await send_error(websocket, "抱歉，消息格式无法识别，请重试")
                continue
            if not isinstance(data, dict):
                await send_error(websocket, "抱歉，消息内容无效，请重试")
                continue
            msg_type = data.get("type")

            if msg_type == "join":
                requested_room_id = str(data.get("room", "")).strip()[:32]
                fallback_nickname = str(data.get("name", "")).strip()[:24]
                display_name = passport_nickname or fallback_nickname
                if not requested_room_id:
                    await send_error(websocket, "房间号不能为空")
                    continue
                if requested_room_id.casefold() in RESERVED_DRAW_CHAIN_SEGMENTS:
                    await send_error(websocket, "该房间号不可用，请换一个")
                    continue
                if not display_name:
                    await send_error(websocket, "请输入玩家昵称")
                    continue
                player_id = str(passport_user_id)
                if timed_out_rooms.get(player_id) == requested_room_id:
                    del timed_out_rooms[player_id]
                    await send_json(
                        websocket,
                        {"type": "room_removed", "message": "已退出房间"},
                    )
                    await websocket.close(code=4004)
                    return
                # 全站一人一房：先把该玩家从其他游戏的房间中移出
                await evict_from_other_games(GAME_ID, player_id)
                occupied_room_id = player_rooms.get(player_id)
                if occupied_room_id and occupied_room_id != requested_room_id:
                    occupied_room = rooms.get(occupied_room_id)
                    if occupied_room and player_id in occupied_room["players"]:
                        old_player = occupied_room["players"][player_id]
                        old_websocket = old_player.get("ws")
                        old_name = str(old_player.get("name", display_name))
                        await remove_player_from_room(
                            occupied_room_id,
                            player_id,
                            f"{old_name} 离开了房间",
                        )
                        if old_websocket is not None and old_websocket is not websocket:
                            try:
                                await send_json(
                                    old_websocket,
                                    {
                                        "type": "room_removed",
                                        "message": "你已切换到其他房间",
                                    },
                                )
                                await old_websocket.close(code=4004)
                            except Exception:
                                pass
                    elif player_id in player_rooms:
                        del player_rooms[player_id]
                room_id = requested_room_id
                room = rooms.setdefault(room_id, create_room(room_id))
                existing_player = room["players"].get(player_id)
                if existing_player is not None:
                    old_websocket = existing_player["ws"]
                    if old_websocket is websocket:
                        await send_error(websocket, "你已加入该房间")
                        continue
                    was_disconnected = not existing_player["connected"]
                    existing_player["name"] = display_name
                    existing_player["ws"] = websocket
                    existing_player["connected"] = True
                    existing_player["disconnect_token"] = ""
                    player_rooms[player_id] = room_id
                    update_original_player_absence_timer(room_id, room)
                    await send_room_states(room)
                    await send_player_state(room, player_id, include_strokes=True)
                    if was_disconnected:
                        await broadcast(
                            room_id,
                            {
                                "type": "message",
                                "sender": "系统", "sender_icon": "link",
                                "text": f"{display_name} 已重新连接",
                            },
                            exclude_id=player_id,
                        )
                    try:
                        await old_websocket.close(code=4002)
                    except Exception:
                        pass
                    continue
                is_spectator = room["phase"] == "playing"
                room["players"][player_id] = {
                    "ws": websocket,
                    "name": display_name,
                    "passport_user_id": passport_user_id,
                    "ready": False,
                    "spectator": is_spectator,
                    "watching": False,
                    "connected": True,
                    "disconnect_token": "",
                }
                player_rooms[player_id] = room_id
                if room["owner_id"] is None and (
                    room["phase"] != "playing"
                    or player_id in room["original_player_ids"]
                ):
                    room["owner_id"] = player_id
                if is_spectator:
                    room["pending_players"].append(player_id)
                update_original_player_absence_timer(room_id, room)
                await send_room_states(room)
                await send_player_state(room, player_id, include_strokes=True)
                await broadcast(
                    room_id,
                    {
                        "type": "message",
                        "sender": "系统", "sender_icon": "target",
                        "text": f"{display_name} 加入了房间" + ("，当前为观战状态" if is_spectator else ""),
                    },
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

            if msg_type == "transfer_host":
                if player_id != room["owner_id"]:
                    await send_error(websocket, "只有房主可以移交房主身份")
                    continue
                target_id = str(data.get("player_id", ""))
                if target_id == player_id:
                    await send_error(websocket, "不能把房主身份移交给自己")
                    continue
                target_player = room["players"].get(target_id)
                if target_player is None:
                    await send_error(websocket, "该玩家已离开房间")
                    continue
                if not target_player["connected"]:
                    await send_error(websocket, "不能把房主身份移交给断线玩家")
                    continue
                old_host_name = pdata["name"]
                room["owner_id"] = target_id
                pdata["ready"] = False
                target_player["ready"] = False
                await broadcast(
                    room_id,
                    {
                        "type": "message",
                        "sender": "系统", "sender_icon": "crown",
                        "text": f"{old_host_name} 已将房主移交给 {target_player['name']}",
                    },
                )
                await send_room_states(room)
                continue

            if msg_type == "kick_player":
                if player_id != room["owner_id"]:
                    await send_error(websocket, "只有房主可以移出玩家")
                    continue
                target_id = str(data.get("player_id", ""))
                if target_id == player_id:
                    await send_error(websocket, "房主不能移出自己")
                    continue
                target_player = room["players"].get(target_id)
                if target_player is None:
                    await send_error(websocket, "该玩家已离开房间")
                    continue
                target_websocket = target_player["ws"]
                target_name = target_player["name"]
                await send_json(
                    target_websocket,
                    {"type": "kicked", "message": "你已被房主移出房间"},
                )
                await remove_player_from_room(
                    room_id,
                    target_id,
                    f"{target_name} 被房主移出房间",
                )
                try:
                    await target_websocket.close(code=4003)
                except Exception:
                    pass
                continue

            if msg_type == "return_lobby":
                if room["phase"] != "playing" or player_id != room["owner_id"]:
                    await send_error(websocket, "只有游戏中的房主可以返回大厅")
                    continue
                # return_room_to_lobby 会清掉含房主在内的观战/观众席标记
                return_room_to_lobby(room)
                await send_room_states(room, include_strokes=True)
                await broadcast(
                    room_id,
                    {
                        "type": "message",
                        "sender": "系统", "sender_icon": "target",
                        "text": "房主结束了当前游戏，所有玩家已返回准备阶段",
                    },
                )
                continue

            if msg_type in {"leave_room", "leave_game"}:
                leave_name = pdata["name"]
                await send_json(
                    websocket,
                    {"type": "room_removed", "message": "已退出房间"},
                )
                await remove_player_from_room(
                    room_id,
                    player_id,
                    f"{leave_name} 离开了房间",
                )
                await websocket.close(code=4004)
                return

            if msg_type == "spectator_toggle":
                if room["phase"] == "lobby":
                    if player_id == room["owner_id"]:
                        await send_error(websocket, "房主不能进入观众席")
                        continue
                    entering = not pdata.get("watching", False)
                    pdata["watching"] = entering
                    pdata["spectator"] = entering
                    if entering:
                        pdata["ready"] = False
                    trim_artworks(room)
                    await broadcast(
                        room_id,
                        {
                            "type": "message",
                            "sender": "系统", "sender_icon": "target",
                            "text": f"{pdata['name']} {'进入了观众席' if entering else '回到了准备区'}",
                        },
                    )
                    await send_room_states(room)
                    continue
                if room["phase"] == "playing":
                    if player_id == room.get("active_player_id"):
                        await send_error(websocket, "当前回合玩家不能进入观众席")
                        continue
                    await send_error(websocket, "游戏中不能切换观众席")
                    continue
                await send_error(websocket, "当前不能切换观战状态")
                continue

            if msg_type == "ready_toggle":
                if room["phase"] != "lobby":
                    await send_error(websocket, "只有大厅阶段可以准备")
                    continue
                if player_id == room["owner_id"]:
                    await send_error(websocket, "房主无需准备")
                    continue
                if pdata.get("watching", False):
                    await send_error(websocket, "观众席玩家无需准备，请先回到准备区")
                    continue
                pdata["ready"] = not pdata["ready"]
                await send_room_states(room)
                continue

            if msg_type == "start_game":
                if room["phase"] != "lobby" or player_id != room["owner_id"]:
                    await send_error(websocket, "只有房主可以开始游戏")
                    continue
                active_players = [
                    pid
                    for pid, guest in room["players"].items()
                    if not guest.get("watching", False)
                ]
                if len(active_players) < 2:
                    await send_error(websocket, "至少需要两名非观众席玩家才能开始接龙")
                    continue
                guests = [
                    guest
                    for pid, guest in room["players"].items()
                    if pid != room["owner_id"] and not guest.get("watching", False)
                ]
                if not guests:
                    await send_error(websocket, "至少需要一名房客加入并准备")
                    continue
                unready = [guest["name"] for guest in guests if not guest["ready"]]
                if unready:
                    await send_error(websocket, "尚未准备：" + "、".join(unready))
                    continue
                if not build_word_pool(room):
                    await send_error(websocket, "当前没有可用词库，请先启用至少一个词库")
                    continue
                start_room_game(room_id, room)
                await send_room_states(room, include_strokes=True)
                await broadcast(
                    room_id,
                    {"type": "clear", "round_id": room["round_id"]},
                )
                await broadcast(
                    room_id,
                    {"type": "message", "sender": "系统", "sender_icon": "target", "text": "房主开始了画画接龙"},
                )
                continue

            if msg_type in {"word_bank_import", "word_bank_update", "word_bank_delete"}:
                if room["phase"] != "lobby" or player_id != room["owner_id"]:
                    await send_error(websocket, "只有大厅中的房主可以管理词库")
                    continue
                try:
                    if msg_type == "word_bank_import":
                        results = import_custom_word_banks(
                            room, data, owner_user_id=player_id
                        )
                        await send_json(websocket, {"type": "word_bank_imported", "results": results})
                    elif msg_type == "word_bank_delete":
                        filename, _owner_user_id = delete_custom_word_bank(
                            room, str(data.get("bank_id", ""))
                        )
                        await send_json(
                            websocket,
                            {"type": "word_bank_deleted", "message": f"已删除 {filename}"},
                        )
                    else:
                        apply_word_bank_update(room, data)
                        await send_json(
                            websocket,
                            {"type": "word_bank_updated", "message": "游戏设置已更新"},
                        )
                except ValueError as error:
                    await send_json(
                        websocket, {"type": "word_bank_error", "message": str(error)}
                    )
                    continue
                await send_room_states(room)
                continue

            if msg_type == "lobby_artwork_submit":
                if room["phase"] != "playing":
                    continue
                visibility = str(data.get("visibility") or "")
                if visibility not in {"public", "private"}:
                    continue
                if visibility == "public" and player_id != room["owner_id"]:
                    continue
                submit_mime = str(data.get("mime_type") or "")
                image_bytes = decode_artwork_image(
                    data.get("image_base64"), submit_mime
                )
                if not image_bytes:
                    continue
                author_name = (
                    "公共画布"
                    if visibility == "public"
                    else (pdata["name"] + "的私人画布")
                )
                room["artworks"].append(
                    {
                        "id": uuid.uuid4().hex,
                        "author_id": player_id,
                        "author_name": author_name,
                        "title": author_name,
                        "visibility": visibility,
                        "source": "lobby",
                        "created_at": time.time(),
                        "mime_type": submit_mime,
                        "image_bytes": image_bytes,
                    }
                )
                trim_artworks(room)
                await send_artwork_galleries(room_id, room)
                continue

            if msg_type == "artwork_capture":
                future = room.get("artwork_capture_future")
                drawer_id = room.get("drawer_id") or room.get("active_player_id")
                capture_mime = str(data.get("mime_type") or "")
                valid_capture = (
                    room["phase"] == "playing"
                    and player_id == drawer_id
                    and str(data.get("capture_id", "")) == room["artwork_capture_token"]
                    and str(data.get("round_id", "")) == room["artwork_capture_round_id"]
                    and capture_mime in ARTWORK_MIME_TYPES
                )
                if valid_capture and future is not None and not future.done():
                    future.set_result(
                        (
                            decode_artwork_image(
                                data.get("image_base64"), capture_mime
                            ),
                            capture_mime,
                        )
                    )
                continue

            if msg_type == "drawing_sync_request":
                if player_id in lobby_canvas_player_ids(room):
                    lobby_canvas = room.get("lobby_canvas") or default_vector_canvas()
                    await send_json(
                        websocket,
                        {
                            "type": "drawing_sync",
                            "scope": "lobby",
                            "strokes": serialize_strokes(room["lobby_strokes"]),
                            "canvas": serialize_canvas(lobby_canvas),
                        },
                    )
                elif str(data.get("round_id", "")) == room["round_id"]:
                    game_canvas = room.get("game_canvas") or default_vector_canvas()
                    await send_json(
                        websocket,
                        {
                            "type": "drawing_sync",
                            "scope": "game",
                            "round_id": room["round_id"],
                            "strokes": serialize_strokes(room["game_strokes"]),
                            "canvas": serialize_canvas(game_canvas),
                        },
                    )
                continue

            if msg_type in {"lobby_draw", "lobby_draw_batch"}:
                if not can_modify_lobby_canvas(room, player_id):
                    await send_error(websocket, "当前不能修改候场画布")
                    continue
                stroke_id = str(data.get("stroke_id") or "")[:100]
                if msg_type == "lobby_draw_batch":
                    raw_segments = data.get("segments")
                    if not isinstance(raw_segments, list) or not raw_segments:
                        continue
                    if any(
                        str(seg.get("tool", "brush")) == "background"
                        and player_id != room["owner_id"]
                        for seg in raw_segments
                        if isinstance(seg, dict)
                    ):
                        await send_error(websocket, "只有房主可以修改公共画布背景色")
                        continue
                    try:
                        stroke, applied = append_stroke_segments(
                            room["lobby_strokes"],
                            room["lobby_redo"],
                            player_id,
                            stroke_id,
                            [seg for seg in raw_segments if isinstance(seg, dict)],
                        )
                    except (KeyError, TypeError, ValueError, AssertionError):
                        continue
                    await broadcast_to_players(
                        room_id,
                        lobby_canvas_player_ids(room),
                        {
                            "type": "lobby_draw_batch",
                            "stroke_id": stroke["stroke_id"],
                            "owner_id": player_id,
                            "segments": applied,
                        },
                        exclude_id=player_id,
                    )
                    continue
                if (
                    str(data.get("tool", "brush")) == "background"
                    and player_id != room["owner_id"]
                ):
                    await send_error(websocket, "只有房主可以修改公共画布背景色")
                    continue
                try:
                    stroke = append_stroke_segment(
                        room["lobby_strokes"], room["lobby_redo"], player_id, data
                    )
                except (KeyError, TypeError, ValueError):
                    continue
                segment = stroke["segments"][-1]
                await broadcast_to_players(
                    room_id,
                    lobby_canvas_player_ids(room),
                    {
                        "type": "lobby_draw",
                        "stroke_id": stroke["stroke_id"],
                        "owner_id": player_id,
                        **segment,
                    },
                    exclude_id=player_id,
                )
                continue

            if msg_type in {"lobby_undo", "lobby_redo"}:
                if not can_modify_lobby_canvas(room, player_id):
                    await send_error(websocket, "当前不能修改候场画布")
                    continue
                stroke = (
                    undo_player_stroke(
                        room["lobby_strokes"], room["lobby_redo"], player_id
                    )
                    if msg_type == "lobby_undo"
                    else redo_player_stroke(room["lobby_redo"], player_id)
                )
                if stroke:
                    await broadcast_to_players(
                        room_id,
                        lobby_canvas_player_ids(room),
                        {
                            "type": "lobby_stroke_visibility",
                            "stroke_id": stroke["stroke_id"],
                            "owner_id": player_id,
                            "visible": msg_type == "lobby_redo",
                        },
                    )
                continue

            if msg_type == "lobby_clear":
                if not can_modify_lobby_canvas(room, player_id) or player_id != room["owner_id"]:
                    await send_error(websocket, "只有候场中的房主可以清空公共画布")
                    continue
                room["lobby_strokes"] = keep_background_strokes(room["lobby_strokes"])
                room["lobby_redo"] = {}
                lobby_clear_message = {"type": "lobby_clear"}
                await send_json(websocket, lobby_clear_message)
                await broadcast_to_players(
                    room_id,
                    lobby_canvas_player_ids(room),
                    lobby_clear_message,
                    exclude_id=player_id,
                )
                continue

            if msg_type == "lobby_canvas_mode":
                if not can_change_lobby_canvas_mode(room, player_id):
                    await send_error(websocket, "只有候场中的房主可以修改公共画布")
                    continue
                try:
                    next_canvas = normalize_canvas_mode(data)
                except (TypeError, ValueError) as exc:
                    await send_error(websocket, str(exc) or "画布设置无效")
                    continue
                current_canvas = room.get("lobby_canvas") or default_vector_canvas()
                if not canvases_equal(current_canvas, next_canvas):
                    room["lobby_strokes"] = keep_background_strokes(room["lobby_strokes"])
                    room["lobby_redo"] = {}
                room["lobby_canvas"] = next_canvas
                canvas_message = canvas_broadcast_payload(
                    "lobby_canvas_mode", next_canvas, room["lobby_strokes"]
                )
                await send_json(websocket, canvas_message)
                await broadcast_to_players(
                    room_id,
                    lobby_canvas_player_ids(room),
                    canvas_message,
                    exclude_id=player_id,
                )
                continue

            if msg_type == "skip_vote":
                await send_error(websocket, "接龙模式无需跳过投票")
                continue

            if msg_type == "replay_verdict_vote":
                if room.get("turn_phase") != REPLAY_VERDICT:
                    await send_error(websocket, "当前不在正确性投票阶段")
                    continue
                if player_id not in replay_voter_ids(room):
                    await send_error(websocket, "观众不能参与投票")
                    continue
                vote = data.get("is_correct")
                if not isinstance(vote, bool):
                    await send_error(websocket, "投票内容无效")
                    continue
                all_voted = vote_verdict(room, player_id, vote)
                if all_voted:
                    await advance_replay_stage(
                        room_id, room, expected_stage=REPLAY_VERDICT
                    )
                else:
                    await send_room_states(room)
                continue

            if msg_type == "replay_artwork_vote":
                if room.get("turn_phase") != REPLAY_ARTWORKS:
                    await send_error(websocket, "当前不在最佳画作投票阶段")
                    continue
                if player_id not in replay_voter_ids(room):
                    await send_error(websocket, "观众不能参与投票")
                    continue
                artwork_id = str(data.get("artwork_id") or "")
                candidate_ids = {
                    str(item.get("artwork_id") or "")
                    for item in room.get("replay_artworks", [])
                }
                if artwork_id not in candidate_ids:
                    await send_error(websocket, "请选择有效画作")
                    continue
                all_voted = vote_artwork(room, player_id, artwork_id)
                if all_voted:
                    await advance_replay_stage(
                        room_id, room, expected_stage=REPLAY_ARTWORKS
                    )
                else:
                    await send_room_states(room)
                continue

            if msg_type == "chat":
                text = str(data.get("text", "")).strip()[:500]
                if text:
                    await broadcast_to_players(
                        room_id,
                        chat_player_ids(room, player_id),
                        player_chat_message(room, player_id, text),
                    )
                continue

            if msg_type in {"draw", "draw_batch"}:
                if pdata["spectator"] or not can_modify_game_canvas(
                    room, player_id, data.get("round_id")
                ):
                    continue
                stroke_id = str(data.get("stroke_id") or "")[:100]
                if msg_type == "draw_batch":
                    raw_segments = data.get("segments")
                    if not isinstance(raw_segments, list) or not raw_segments:
                        continue
                    try:
                        stroke, applied = append_stroke_segments(
                            room["game_strokes"],
                            room["game_redo"],
                            player_id,
                            stroke_id,
                            [seg for seg in raw_segments if isinstance(seg, dict)],
                        )
                    except (KeyError, TypeError, ValueError, AssertionError):
                        continue
                    await broadcast_to_players(
                        room_id,
                        game_canvas_player_ids(room),
                        {
                            "type": "draw_batch",
                            "stroke_id": stroke["stroke_id"],
                            "owner_id": player_id,
                            "round_id": room["round_id"],
                            "segments": applied,
                        },
                        exclude_id=player_id,
                    )
                    continue
                try:
                    stroke = append_stroke_segment(
                        room["game_strokes"], room["game_redo"], player_id, data
                    )
                except (KeyError, TypeError, ValueError):
                    continue
                segment = stroke["segments"][-1]
                await broadcast_to_players(
                    room_id,
                    game_canvas_player_ids(room),
                    {
                        "type": "draw",
                        "stroke_id": stroke["stroke_id"],
                        "owner_id": player_id,
                        "round_id": room["round_id"],
                        **segment,
                    },
                    exclude_id=player_id,
                )
                continue

            if msg_type in {"undo", "redo"}:
                if not can_modify_game_canvas(room, player_id, data.get("round_id")):
                    continue
                stroke = (
                    undo_player_stroke(room["game_strokes"], room["game_redo"], player_id)
                    if msg_type == "undo"
                    else redo_player_stroke(room["game_redo"], player_id)
                )
                if stroke:
                    await broadcast_to_players(
                        room_id,
                        game_canvas_player_ids(room),
                        {
                            "type": msg_type,
                            "round_id": room["round_id"],
                            "stroke_id": stroke["stroke_id"],
                            "owner_id": player_id,
                        },
                    )
                continue

            if msg_type == "clear":
                if not can_modify_game_canvas(room, player_id, data.get("round_id")):
                    await send_error(websocket, "当前不能清空画布")
                    continue
                room["game_strokes"] = keep_background_strokes(room["game_strokes"])
                room["game_redo"] = {}
                clear_message = {"type": "clear", "round_id": room["round_id"]}
                await send_json(websocket, clear_message)
                await broadcast_to_players(
                    room_id,
                    game_canvas_player_ids(room),
                    clear_message,
                    exclude_id=player_id,
                )
                continue

            if msg_type == "canvas_mode":
                if not can_modify_game_canvas(room, player_id, data.get("round_id")):
                    await send_error(websocket, "当前不能修改画布模式")
                    continue
                try:
                    next_canvas = normalize_canvas_mode(data)
                except (TypeError, ValueError) as exc:
                    await send_error(websocket, str(exc) or "画布设置无效")
                    continue
                current_canvas = room.get("game_canvas") or default_vector_canvas()
                if not canvases_equal(current_canvas, next_canvas):
                    room["game_strokes"] = keep_background_strokes(room["game_strokes"])
                    room["game_redo"] = {}
                room["game_canvas"] = next_canvas
                canvas_message = canvas_broadcast_payload(
                    "canvas_mode",
                    next_canvas,
                    room["game_strokes"],
                    {"round_id": room["round_id"]},
                )
                await send_json(websocket, canvas_message)
                await broadcast_to_players(
                    room_id,
                    game_canvas_player_ids(room),
                    canvas_message,
                    exclude_id=player_id,
                )
                continue

            if msg_type == "submit_drawing":
                if room["phase"] != "playing":
                    continue
                if room.get("turn_phase") != "draw":
                    await send_error(websocket, "当前不是绘画阶段")
                    continue
                if player_id != room.get("active_player_id") or player_id != room.get("drawer_id"):
                    await send_error(websocket, "只有当前画师可以提交画作")
                    continue
                if not has_drawing_strokes(room["game_strokes"]):
                    await send_error(websocket, "请先画些什么再提交")
                    continue
                advanced = await advance_after_submit_drawing(room_id, room)
                if not advanced:
                    continue
                await send_room_states(room, include_strokes=True)
                continue

            if msg_type == "guess":
                text = str(data.get("text", "")).strip()[:500]
                if not text or room["phase"] != "playing":
                    continue
                if room.get("turn_phase") != "guess":
                    await broadcast_to_players(
                        room_id,
                        chat_player_ids(room, player_id),
                        player_chat_message(room, player_id, text),
                    )
                    continue
                if player_id != room.get("active_player_id"):
                    await broadcast_to_players(
                        room_id,
                        chat_player_ids(room, player_id),
                        player_chat_message(room, player_id, text),
                    )
                    continue
                if pdata["spectator"] or pdata.get("watching", False):
                    await broadcast_to_players(
                        room_id,
                        chat_player_ids(room, player_id),
                        player_chat_message(room, player_id, text),
                    )
                    continue
                await advance_after_guess(room_id, room, text)
                await broadcast_to_players(
                    room_id,
                    game_canvas_player_ids(room),
                    {
                        "type": "guess",
                        "guesser": pdata["name"],
                        "guesser_id": player_id,
                        "text": text,
                        "chain_position": player_chain_position(room, player_id),
                    },
                )
                await send_room_states(room, include_strokes=True)
                if room.get("turn_phase") == "draw":
                    await broadcast_to_players(
                        room_id,
                        game_canvas_player_ids(room),
                        {"type": "clear", "round_id": room["round_id"]},
                    )
                elif room.get("turn_phase") == REPLAY_VERDICT:
                    await broadcast(
                        room_id,
                        {
                            "type": "message",
                            "sender": "系统", "sender_icon": "target",
                            "text": "接龙结束，请投票判断最后猜词是否正确",
                        },
                    )
                continue

    except WebSocketDisconnect:
        await handle_player_disconnect(room_id, player_id, websocket)
    except Exception:
        error_code = create_error_code("DCWS")
        logger.exception("画画接龙 WebSocket 未预期错误 [%s]", error_code)
        try:
            await send_error(
                websocket,
                "抱歉，发生了无法自动恢复的错误，请重新连接后再试",
                error_code,
            )
        except Exception:
            logger.debug("错误提示发送失败，连接可能已关闭", exc_info=True)
        await handle_player_disconnect(room_id, player_id, websocket)
