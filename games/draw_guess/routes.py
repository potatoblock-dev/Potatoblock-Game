import asyncio
import base64
import binascii
import json
import logging
import math
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
    reset_room_game_canvas,
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
from app.routers.auth import get_current_identity_ws, get_optional_identity


templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))
router = APIRouter()
logger = logging.getLogger(__name__)


GAME_DIR = Path(__file__).resolve().parent
GAME_ID = "draw_guess"
STATIC_URL = "/static/games/draw-guess"

game_info = {
    "id": GAME_ID,
    "name": "你画我猜",
    "logo": "/static/img/logo.svg",
    "url": "/draw-guess",
    "menu_order": 10,
    "router": router,
    "static_dir": GAME_DIR / "static",
    "static_url": STATIC_URL,
}


@router.get("/draw-guess", response_class=HTMLResponse)
async def draw_guess(request: Request, identity=Depends(get_optional_identity)):
    """渲染已登录用户的你画我猜页面。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/draw-guess", status_code=302)
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


RESERVED_DRAW_GUESS_SEGMENTS = frozenset({"random-room", "artworks", "ws"})


def is_valid_deep_link_room_id(room_id: str) -> bool:
    """校验可放进 /draw-guess/{room} 路径的房间号。"""
    return lobby_is_valid_deep_link_room_id(room_id, RESERVED_DRAW_GUESS_SEGMENTS)


def list_joinable_lobby_rooms() -> List[str]:
    """返回可随机加入的大厅房间：非 P 开头，且仍有在线玩家。"""
    return lobby_list_joinable_lobby_rooms(rooms)


def generate_random_room_id() -> str:
    """生成 4 位大写字母+数字房间号；首字符绝不使用 P。"""
    return lobby_generate_random_room_id(rooms)


@router.get("/draw-guess/random-room")
async def random_room(identity=Depends(get_optional_identity)):
    """为随机加入挑选空闲大厅房间，没有则生成新房间号。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    candidates = list_joinable_lobby_rooms()
    if candidates:
        return {"room_id": random.choice(candidates), "created": False}
    return {"room_id": generate_random_room_id(), "created": True}


@router.get("/draw-guess/artworks/{room_id}/{artwork_id}")
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
    if artwork is None:
        raise HTTPException(status_code=404, detail="画作不存在")
    if str(artwork.get("visibility") or "public") == "private" and artwork.get("author_id") != player_id:
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


@router.get("/draw-guess/{room_id}", response_class=HTMLResponse)
async def draw_guess_room(
    request: Request, room_id: str, identity=Depends(get_optional_identity)
):
    """带房间号的深链：登录后打开页面并自动进入该房间。"""
    if not is_valid_deep_link_room_id(room_id):
        raise HTTPException(status_code=404, detail="房间链接无效")
    next_path = "/draw-guess/" + quote(room_id, safe="")
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
ROUND_TRANSITION_SECONDS = 1
ARTWORK_DISPLAY_SECONDS = 3.0
# 慢设备导出大画作（含 PNG 降级重试）可能超过 3 秒，放宽等待避免丢图
ARTWORK_CAPTURE_TIMEOUT_SECONDS = 6.0
MAX_ARTWORK_BYTES = 1024 * 1024
ARTWORK_MIME_TYPES = frozenset({"image/webp", "image/png"})
DISCONNECT_GRACE_SECONDS = 30
ORIGINAL_PLAYER_ABSENCE_SECONDS = 60
BASE_WORD_BANK_PATH = GAME_DIR / "base_word_bank.txt"


def safe_bank_filename(filename: str) -> str:
    """只保留词库文件名本身，禁止路径穿越。"""
    name = Path(str(filename or "")).name.strip()
    if not name or name in {".", ".."}:
        return ""
    return name[:100]


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
        "scores": {},
        "question_count": 0,
        "guessed_this_round": set(),
        "skip_votes": set(),
        "enabled_banks": list(DEFAULT_BANK_IDS),
        "custom_banks": [],
        "hints_enabled": True,
        "lobby_strokes": [],
        "lobby_redo": {},
        "lobby_canvas": default_vector_canvas(),
        "game_strokes": [],
        "game_redo": {},
        "game_canvas": default_vector_canvas(),
        "artworks": [],
        "artwork_display_until": 0.0,
        "artwork_capture_token": "",
        "artwork_capture_round_id": "",
        "artwork_capture_future": None,
        "turn_roster": [],
        "turn_index": 0,
        "turns_completed": 0,
        "drawn_this_cycle": set(),
        "pending_players": [],
        "original_player_ids": set(),
        "original_absence_token": "",
        "round_transition_until": 0.0,
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


def normalize_guess_text(text: str) -> str:
    """规范化猜词输入，去除空白和常见标点。"""
    cleaned = "".join(ch for ch in str(text or "").strip() if not ch.isspace())
    drop = set("，。！？、；：（）()[]【】《》…·-,.!?;:")
    drop.update(chr(code) for code in (34, 39, 0x201C, 0x201D, 0x2018, 0x2019))
    for mark in drop:
        cleaned = cleaned.replace(mark, "")
    return cleaned


def classify_guess_text(text: str, answer: str) -> str:
    """不区分大小写地将输入分类为正确答案、等长猜测或普通聊天。"""
    normalized = normalize_guess_text(text)
    answer_norm = normalize_guess_text(answer)
    if not normalized:
        return "message"
    if normalized.casefold() == answer_norm.casefold():
        return "correct"
    if len(normalized) == len(answer_norm):
        return "guess"
    return "message"


def get_drawer_name(room: Dict) -> str:
    """返回当前画师名称。"""
    drawer_id = room["drawer_id"]
    if drawer_id not in room["players"]:
        return "等待中"
    return room["players"][drawer_id]["name"]


def get_word_bank_options() -> List[Dict[str, object]]:
    """返回前端可勾选的内置词库。"""
    return [
        {"id": bank_id, "name": bank["name"], "count": len(bank["words"])}
        for bank_id, bank in BUILTIN_WORD_BANKS.items()
    ]


def player_list(room: Dict) -> List[Dict[str, object]]:
    """序列化房间玩家及大厅准备状态。"""
    return serialize_lobby_players(room)


def score_list(room: Dict) -> List[Dict[str, object]]:
    """按分数降序输出玩家成绩，相同分数按昵称排序。"""
    scores = [
        {
            "uid": uid,
            "nickname": pdata["name"],
            "score": room["scores"].get(uid, 0),
            "watching": bool(pdata.get("watching", False)),
            "spectator": bool(pdata.get("spectator", False)),
            "connected": bool(pdata.get("connected", True)),
        }
        for uid, pdata in room["players"].items()
    ]
    return sorted(scores, key=lambda item: (-item["score"], item["nickname"].casefold()))


def serialize_artworks(room: Dict, viewer_id: str = "") -> List[Dict[str, object]]:
    """只下发画廊元数据；私人画作仅对作者可见。正式游戏猜中画作对全员可见。"""
    items: List[Dict[str, object]] = []
    for artwork in reversed(room["artworks"]):
        visibility = str(artwork.get("visibility") or "public")
        if visibility == "private" and artwork.get("author_id") != viewer_id:
            continue
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
                "title": artwork.get("title") or artwork["author_name"],
                "preview_url": (
                    "/draw-guess/artworks/"
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
    """画作上限跟随正在游戏的人数，观众席进出与玩家增减时自动收缩。"""
    limit = max(1, count_playing_players(room))
    if len(room["artworks"]) > limit:
        room["artworks"] = room["artworks"][-limit:]


def get_artwork_display_remaining(room: Dict) -> float:
    """返回答对后画作展示阶段的剩余秒数。"""
    return max(0.0, room["artwork_display_until"] - time.monotonic())


def is_artwork_displaying(room: Dict) -> bool:
    """判断当前是否处于不清屏的画作展示阶段。"""
    return get_artwork_display_remaining(room) > 0


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
    }
    return state


def get_round_transition_remaining(room: Dict) -> int:
    """返回画师切换缓冲的剩余整秒数。"""
    return max(0, math.ceil(room["round_transition_until"] - time.monotonic()))


def is_round_transitioning(room: Dict) -> bool:
    """判断房间当前是否禁止绘图和猜词。"""
    return get_round_transition_remaining(room) > 0


def can_modify_game_canvas(room: Dict, player_id: str, round_id: object) -> bool:
    """仅允许当前画师在当前稳定回合修改正式游戏画布。"""
    pdata = room["players"].get(player_id) or {}
    return (
        room["phase"] == "playing"
        and player_id == room["drawer_id"]
        and not pdata.get("spectator", False)
        and not pdata.get("watching", False)
        and not is_round_transitioning(room)
        and not is_artwork_displaying(room)
        and str(round_id or "") == room["round_id"]
    )


def can_change_lobby_canvas_mode(room: Dict, player_id: str) -> bool:
    """大厅公共画布模式仅房主可改，权限与改背景色相同。"""
    pdata = room["players"].get(player_id) or {}
    return (
        room["phase"] == "lobby"
        and player_id == room["owner_id"]
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


def get_skip_eligible_ids(room: Dict) -> set[str]:
    """返回本轮可参与跳过投票的在线猜词者 UID（不含画师与观战者）。"""
    drawer_id = room.get("drawer_id")
    return {
        pid
        for pid, pdata in room["players"].items()
        if pdata["connected"]
        and not pdata["spectator"]
        and pid != drawer_id
    }


def is_skip_vote_unanimous(room: Dict) -> bool:
    """清理无效票并判断当前在线参与者是否全部同意跳过。"""
    eligible_ids = get_skip_eligible_ids(room)
    room["skip_votes"].intersection_update(eligible_ids)
    return bool(eligible_ids) and eligible_ids.issubset(room["skip_votes"])


def build_game_state(
    room: Dict, player_id: str, *, include_strokes: bool = False
) -> Dict:
    """构造正式游戏状态；笔画仅在进房/换轮/修复时附带，常规靠 draw 增量。"""
    pdata = room["players"][player_id]
    is_spectator = pdata["spectator"]
    is_drawer = player_id == room["drawer_id"] and not is_spectator
    role = "spectator" if is_spectator else "drawer" if is_drawer else "guesser"
    skip_eligible_ids = get_skip_eligible_ids(room)
    room["skip_votes"].intersection_update(skip_eligible_ids)
    state = {
        "type": "state",
        "phase": "playing",
        "self_id": player_id,
        "role": role,
        "is_host": player_id == room["owner_id"],
        "drawer_name": get_drawer_name(room),
        "drawer_id": room["drawer_id"],
        "round_id": room["round_id"],
        "scores": score_list(room),
        "question_count": room["question_count"],
        "word_bank_name": room["word_bank_name"],
        "players": player_list(room),
        "artworks": serialize_artworks(room, player_id),
        "artwork_display_remaining": get_artwork_display_remaining(room),
        "pending_count": len(room["pending_players"]),
        "transition_remaining": get_round_transition_remaining(room),
        "skip_count": len(room["skip_votes"]),
        "skip_required": len(skip_eligible_ids),
        "skip_voted": player_id in room["skip_votes"],
        "watching": pdata.get("watching", False),
        "queued_for_game": player_id in room["pending_players"],
        "canvas": serialize_canvas(room.get("game_canvas") or default_vector_canvas()),
    }
    if include_strokes:
        state["strokes"] = serialize_strokes(room["game_strokes"])
    # 画作展示阶段全员公布答案；平时仅画师看题，猜词者只看遮罩提示
    if is_artwork_displaying(room):
        state["word"] = room["word"]
        state["answer_revealed"] = True
    elif is_drawer:
        state["word"] = room["word"]
    else:
        hint = room["word_hint"] if room["hints_enabled"] else ""
        state["hint"] = get_word_hint(room["word"], hint)
    return state


def return_room_to_lobby(room: Dict) -> None:
    """结束当前对局并把所有玩家恢复为大厅准备状态。"""
    room["phase"] = "lobby"
    capture_future = room.get("artwork_capture_future")
    if capture_future is not None and not capture_future.done():
        capture_future.cancel()
    room["artwork_display_until"] = 0.0
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
    room["guessed_this_round"] = set()
    room["skip_votes"] = set()
    room["turn_roster"] = []
    room["pending_players"] = []
    room["turn_index"] = 0
    room["turns_completed"] = 0
    room["drawn_this_cycle"] = set()
    room["round_transition_until"] = 0.0
    room["game_strokes"] = []
    room["game_redo"] = {}
    for player in room["players"].values():
        player["ready"] = False
        player["spectator"] = False
        player["watching"] = False


async def return_to_lobby_if_all_watching(room_id: str, room: Dict) -> bool:
    """游戏中若所有在房玩家都已观战，自动返回大厅。"""
    if room["phase"] != "playing" or not room["players"]:
        return False
    if count_playing_players(room) > 0:
        return False
    return_room_to_lobby(room)
    await send_room_states(room, include_strokes=True)
    await broadcast(
        room_id,
        {
            "type": "message",
            "sender": "系统", "sender_icon": "target",
            "text": "所有玩家都已观战，房间已返回准备阶段",
        },
    )
    return True


def active_turn_players(room: Dict) -> List[str]:
    """返回当前可参与画师轮换的在线玩家（不含观战/观众席）。"""
    return [
        pid
        for pid, pdata in room["players"].items()
        if not pdata.get("spectator", False) and not pdata.get("watching", False)
    ]


def pick_random_drawer(
    candidates: List[str], *, previous_drawer_id: Optional[str] = None
) -> Optional[str]:
    """在候选人中完全随机选画师；人数>1 时避开连续同一人。"""
    if not candidates:
        return None
    pool = list(candidates)
    if previous_drawer_id and len(pool) > 1:
        without_previous = [pid for pid in pool if pid != previous_drawer_id]
        if without_previous:
            pool = without_previous
    return random.choice(pool)


def start_room_game(room: Dict) -> None:
    """把准备完成的大厅切换为正式游戏。"""
    room["phase"] = "playing"
    room["round_transition_until"] = 0.0
    room["artwork_display_until"] = 0.0
    room["artwork_capture_token"] = ""
    room["artwork_capture_round_id"] = ""
    room["artwork_capture_future"] = None
    room["skip_votes"] = set()
    for pdata in room["players"].values():
        pdata["ready"] = False
        # 大厅观众席保留观战，不强制进本局轮换
        if pdata.get("watching", False):
            pdata["spectator"] = True
        else:
            pdata["spectator"] = False
            pdata["watching"] = False
    room["turn_roster"] = active_turn_players(room)
    room["pending_players"] = []
    room["original_player_ids"] = set(room["players"].keys())
    room["original_absence_token"] = ""
    room["turn_index"] = 0
    room["turns_completed"] = 0
    room["drawn_this_cycle"] = set()
    room["question_count"] = 0
    room["scores"] = {pid: 0 for pid in room["players"]}
    room["drawer_id"] = pick_random_drawer(room["turn_roster"])
    if room["drawer_id"]:
        room["drawn_this_cycle"].add(room["drawer_id"])
    room["round_id"] = uuid.uuid4().hex
    room["guessed_this_round"] = set()
    room["game_strokes"] = []
    room["game_redo"] = {}
    reset_room_game_canvas(room)
    choose_new_word(room)


def advance_game_turn(room: Dict, completed_turn: bool = True) -> List[str]:
    """随机推进画师：本轮每人至多一次，全部轮完才开新一轮，且不连续同一人。"""
    room["round_transition_until"] = 0.0
    room["artwork_display_until"] = 0.0
    room["skip_votes"] = set()
    previous_drawer_id = room.get("drawer_id")
    roster = [pid for pid in room["turn_roster"] if pid in room["players"]]
    room["turn_roster"] = roster
    drawn = {
        pid
        for pid in room.get("drawn_this_cycle", set())
        if pid in roster
    }
    if completed_turn and previous_drawer_id and previous_drawer_id in roster:
        drawn.add(previous_drawer_id)
    room["drawn_this_cycle"] = drawn
    if completed_turn:
        room["turns_completed"] = len(drawn)

    remaining = [pid for pid in roster if pid not in drawn]
    promoted_names: List[str] = []

    # 本轮所有人已当过画师（或名单已空）→ 吸收观战队列，开启新一轮
    if not remaining:
        for pid in list(room["pending_players"]):
            if pid in room["players"] and not room["players"][pid].get("watching", False):
                room["players"][pid]["spectator"] = False
                promoted_names.append(room["players"][pid]["name"])
        room["pending_players"] = []
        roster = active_turn_players(room)
        room["turn_roster"] = roster
        room["drawn_this_cycle"] = set()
        room["turns_completed"] = 0
        room["turn_index"] = 0
        remaining = list(roster)

    if not remaining:
        room["drawer_id"] = None
        return promoted_names

    room["drawer_id"] = pick_random_drawer(
        remaining, previous_drawer_id=previous_drawer_id
    )
    room["drawn_this_cycle"].add(room["drawer_id"])
    room["turns_completed"] = len(room["drawn_this_cycle"])
    room["round_id"] = uuid.uuid4().hex
    room["guessed_this_round"] = set()
    room["game_strokes"] = []
    room["game_redo"] = {}
    reset_room_game_canvas(room)
    choose_new_word(room)
    return promoted_names


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


async def complete_skipped_round(room_id: str, room: Dict) -> None:
    """公布答案并以无得分方式结束被全员跳过的题目。"""
    await broadcast(
        room_id,
        {
            "type": "message",
            "sender": "系统", "sender_icon": "target",
            "text": f"题目被跳过，答案是{room['word']}",
        },
    )
    await begin_round_transition(room_id, room)


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


async def request_and_cache_artwork(
    room_id: str, room: Dict, expected_round_id: str
) -> None:
    """向画师请求截图，缓存为全员可见的本局画作。"""
    drawer_id = room["drawer_id"]
    drawer = room["players"].get(drawer_id)
    if not drawer or not drawer["connected"]:
        return
    token = uuid.uuid4().hex
    future = asyncio.get_running_loop().create_future()
    room["artwork_capture_token"] = token
    room["artwork_capture_round_id"] = expected_round_id
    room["artwork_capture_future"] = future
    word = str(room.get("word") or "")
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
        or room["round_id"] != expected_round_id
    ):
        return
    title = f"{word}-{drawer['name']}" if word else drawer["name"]
    room["artworks"].append(
        {
            "id": uuid.uuid4().hex,
            "author_id": drawer_id,
            "author_name": drawer["name"],
            "title": title,
            "word": word,
            "visibility": "public",
            "source": "game",
            "created_at": time.time(),
            "mime_type": image_mime,
            "image_bytes": image_bytes,
        }
    )
    trim_artworks(room)
    await send_artwork_galleries(room_id, room)


async def finish_correct_artwork_display(
    room_id: str, expected_room: Dict, expected_round_id: str
) -> None:
    """保存画作并等待独立展示时间结束，再进入原有换题缓冲。"""
    try:
        await request_and_cache_artwork(room_id, expected_room, expected_round_id)
        delay = max(0.0, expected_room["artwork_display_until"] - time.monotonic())
        await asyncio.sleep(delay)
        room = rooms.get(room_id)
        if (
            room is not expected_room
            or room["phase"] != "playing"
            or room["round_id"] != expected_round_id
            or room["artwork_display_until"] <= 0
        ):
            return
        room["artwork_display_until"] = 0.0
        await begin_round_transition(room_id, room)
    except Exception:
        logger.exception("答对后的画作展示与缓存处理失败")


async def begin_round_transition(room_id: str, room: Dict) -> None:
    """开始统一的题目结束缓冲，并清空当前画布。"""
    if room["round_transition_until"] <= time.monotonic():
        room["round_transition_until"] = time.monotonic() + ROUND_TRANSITION_SECONDS
    room["skip_votes"] = set()
    room["artwork_display_until"] = 0.0
    room["game_strokes"] = []
    room["game_redo"] = {}
    await broadcast(
        room_id,
        {"type": "round_transition", "seconds": ROUND_TRANSITION_SECONDS},
    )
    await send_room_states(room, include_strokes=True)
    await broadcast(room_id, {"type": "clear", "round_id": room["round_id"]})
    asyncio.create_task(finish_round_transition(room_id, room))


async def finish_round_transition(room_id: str, expected_room: Dict) -> None:
    """缓冲结束后安全推进画师，房间已关闭时直接取消。"""
    try:
        delay = max(0.0, expected_room["round_transition_until"] - time.monotonic())
        await asyncio.sleep(delay)
        room = rooms.get(room_id)
        if room is not expected_room or room["round_transition_until"] <= 0:
            return
        promoted = advance_game_turn(room, completed_turn=True)
        await send_room_states(room, include_strokes=True)
        await broadcast(room_id, {"type": "clear", "round_id": room["round_id"]})
        if promoted:
            await broadcast(
                room_id,
                {
                    "type": "message",
                    "sender": "系统", "sender_icon": "target",
                    "text": "新一轮开始，" + "、".join(promoted) + " 已加入游戏",
                },
            )
    except Exception:
        logger.exception("画师切换缓冲处理失败")


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


async def remove_player_from_room(
    room_id: str,
    player_id: str,
    message: str,
    *,
    skip_active_drawer_round: bool = False,
) -> None:
    """移除玩家并统一处理房主转移、画师轮换和状态广播。"""
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        return
    was_owner = room["owner_id"] == player_id
    was_drawer = room["drawer_id"] == player_id
    await broadcast(
        room_id,
        {"type": "message", "sender": "系统", "sender_icon": "door", "text": message},
        exclude_id=player_id,
    )
    del room["players"][player_id]
    if player_rooms.get(player_id) == room_id:
        del player_rooms[player_id]
    room["pending_players"] = [pid for pid in room["pending_players"] if pid != player_id]
    room["turn_roster"] = [pid for pid in room["turn_roster"] if pid != player_id]
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
    if await return_to_lobby_if_all_watching(room_id, room):
        return
    if (
        room["phase"] == "playing"
        and was_drawer
        and not is_round_transitioning(room)
        and not is_artwork_displaying(room)
    ):
        if skip_active_drawer_round:
            await complete_skipped_round(room_id, room)
            return
        advance_game_turn(room, completed_turn=False)
        await send_room_states(room, include_strokes=True)
        await broadcast(room_id, {"type": "clear", "round_id": room["round_id"]})
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
        "url": "/draw-guess/" + quote(room_id, safe=""),
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
    """原子更新基础词库、自定义文件启用状态和提示设置。"""
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
    if not selected_banks and not selected_custom_ids:
        raise ValueError("至少勾选一个基础词库或自定义词库")
    room["enabled_banks"] = selected_banks
    for bank in room["custom_banks"]:
        bank["enabled"] = bank["id"] in selected_custom_ids
    room["hints_enabled"] = hints_enabled


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
    if (
        room["phase"] == "playing"
        and is_skip_vote_unanimous(room)
        and not is_round_transitioning(room)
        and not is_artwork_displaying(room)
    ):
        await complete_skipped_round(room_id, room)
    else:
        await send_room_states(room)
    asyncio.create_task(
        remove_disconnected_player_after_timeout(
            room_id, player_id, room, disconnect_token
        )
    )


@router.websocket("/draw-guess/ws")
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
                if requested_room_id.casefold() in RESERVED_DRAW_GUESS_SEGMENTS:
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
                room["scores"][player_id] = room["scores"].get(player_id, 0)
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
                    skip_active_drawer_round=True,
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
                if room["phase"] == "playing" and is_artwork_displaying(room):
                    await send_error(websocket, "画作展示结束后再离开房间")
                    continue
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
                if is_round_transitioning(room) or is_artwork_displaying(room):
                    await send_error(websocket, "当前阶段不能切换观战状态")
                    continue
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
                if room["phase"] != "playing":
                    await send_error(websocket, "当前不能切换观战状态")
                    continue
                # 游戏中允许房主观战；离开观战后与房客一样排队加入
                entering_watch = not pdata.get("watching", False)
                room["skip_votes"] = set()
                if entering_watch:
                    was_drawer = player_id == room["drawer_id"]
                    pdata["watching"] = True
                    pdata["spectator"] = True
                    room["pending_players"] = [pid for pid in room["pending_players"] if pid != player_id]
                    room["turn_roster"] = [pid for pid in room["turn_roster"] if pid != player_id]
                    trim_artworks(room)
                    await broadcast(
                        room_id,
                        {"type": "message", "sender": "系统", "sender_icon": "target", "text": f"{pdata['name']} 进入了观战状态"},
                    )
                    if await return_to_lobby_if_all_watching(room_id, room):
                        continue
                    if was_drawer:
                        room["game_strokes"] = []
                        room["game_redo"] = {}
                        advance_game_turn(room, completed_turn=False)
                        await send_room_states(room, include_strokes=True)
                        await broadcast(room_id, {"type": "clear", "round_id": room["round_id"]})
                        continue
                else:
                    pdata["watching"] = False
                    if player_id not in room["pending_players"]:
                        room["pending_players"].append(player_id)
                    joined_immediately = not room["turn_roster"] or room["drawer_id"] is None
                    if joined_immediately:
                        advance_game_turn(room, completed_turn=False)
                        await broadcast(
                            room_id,
                            {
                                "type": "message",
                                "sender": "系统", "sender_icon": "target",
                                "text": f"{pdata['name']} 结束观战并加入了游戏",
                            },
                        )
                        await send_room_states(room, include_strokes=True)
                        await broadcast(room_id, {"type": "clear", "round_id": room["round_id"]})
                        continue
                    await broadcast(
                        room_id,
                        {
                            "type": "message",
                            "sender": "系统", "sender_icon": "target",
                            "text": f"{pdata['name']} 结束观战，将在下一轮加入游戏",
                        },
                    )
                await send_room_states(room)
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
                start_room_game(room)
                await send_room_states(room, include_strokes=True)
                await broadcast(
                    room_id,
                    {"type": "clear", "round_id": room["round_id"]},
                )
                await broadcast(
                    room_id,
                    {"type": "message", "sender": "系统", "sender_icon": "target", "text": "房主开始了游戏"},
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
                            {"type": "word_bank_updated", "message": "词库与提示设置已更新"},
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
                capture_mime = str(data.get("mime_type") or "")
                valid_capture = (
                    room["phase"] == "playing"
                    and player_id == room["drawer_id"]
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
                if room["phase"] == "lobby":
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
                if room["phase"] != "lobby":
                    continue
                if pdata.get("watching", False) or pdata.get("spectator", False):
                    await send_error(websocket, "观众席不能修改大厅画布")
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
                    await broadcast(
                        room_id,
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
                await broadcast(
                    room_id,
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
                if room["phase"] != "lobby":
                    continue
                if pdata.get("watching", False) or pdata.get("spectator", False):
                    await send_error(websocket, "观众席不能修改大厅画布")
                    continue
                stroke = (
                    undo_player_stroke(
                        room["lobby_strokes"], room["lobby_redo"], player_id
                    )
                    if msg_type == "lobby_undo"
                    else redo_player_stroke(room["lobby_redo"], player_id)
                )
                if stroke:
                    await broadcast(
                        room_id,
                        {
                            "type": "lobby_stroke_visibility",
                            "stroke_id": stroke["stroke_id"],
                            "owner_id": player_id,
                            "visible": msg_type == "lobby_redo",
                        },
                    )
                continue

            if msg_type == "lobby_clear":
                if room["phase"] != "lobby" or player_id != room["owner_id"]:
                    await send_error(websocket, "只有房主可以清空大厅画布")
                    continue
                room["lobby_strokes"] = keep_background_strokes(room["lobby_strokes"])
                room["lobby_redo"] = {}
                lobby_clear_message = {"type": "lobby_clear"}
                await send_json(websocket, lobby_clear_message)
                await broadcast(room_id, lobby_clear_message, exclude_id=player_id)
                continue

            if msg_type == "lobby_canvas_mode":
                if not can_change_lobby_canvas_mode(room, player_id):
                    await send_error(websocket, "只有房主可以修改大厅公共画布")
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
                await broadcast(room_id, canvas_message, exclude_id=player_id)
                continue

            if msg_type == "skip_vote":
                if room["phase"] != "playing":
                    await send_error(websocket, "只有游戏中可以投票跳过")
                    continue
                if pdata["spectator"]:
                    await send_error(websocket, "观战者不能投票跳过")
                    continue
                if is_round_transitioning(room):
                    await send_error(websocket, "换题缓冲中不能投票跳过")
                    continue
                if is_artwork_displaying(room):
                    await send_error(websocket, "画作展示中不能投票跳过")
                    continue
                eligible_ids = get_skip_eligible_ids(room)
                if not eligible_ids:
                    await send_error(websocket, "当前没有可投票跳过的猜词者")
                    continue
                if player_id not in eligible_ids:
                    await send_error(websocket, "当前画师不能投票跳过")
                    continue
                if player_id in room["skip_votes"]:
                    room["skip_votes"].remove(player_id)
                else:
                    room["skip_votes"].add(player_id)
                if is_skip_vote_unanimous(room):
                    await complete_skipped_round(room_id, room)
                else:
                    await send_room_states(room)
                continue

            if msg_type == "chat":
                text = str(data.get("text", "")).strip()[:500]
                if text:
                    await broadcast(
                        room_id,
                        {
                            "type": "message",
                            "sender": pdata["name"],
                            "sender_id": player_id,
                            "text": text,
                        },
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
                    await broadcast(
                        room_id,
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
                await broadcast(
                    room_id,
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
                    await broadcast(
                        room_id,
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
                await broadcast(room_id, clear_message, exclude_id=player_id)
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
                await broadcast(room_id, canvas_message, exclude_id=player_id)
                continue

            if msg_type == "guess":
                text = str(data.get("text", "")).strip()[:500]
                if not text or room["phase"] != "playing":
                    continue
                if is_round_transitioning(room) or is_artwork_displaying(room):
                    await broadcast(
                        room_id,
                        {
                            "type": "message",
                            "sender": pdata["name"],
                            "sender_id": player_id,
                            "text": text,
                        },
                    )
                    continue
                if pdata["spectator"] or player_id == room["drawer_id"]:
                    await broadcast(
                        room_id,
                        {
                            "type": "message",
                            "sender": pdata["name"],
                            "sender_id": player_id,
                            "text": text,
                        },
                    )
                    continue
                if player_id in room["guessed_this_round"]:
                    await send_error(websocket, "你已经猜对了，等待下一轮")
                    continue
                result = classify_guess_text(text, room["word"])
                if result == "correct":
                    room["guessed_this_round"].add(player_id)
                    room["artwork_display_until"] = time.monotonic() + ARTWORK_DISPLAY_SECONDS
                    expected_round_id = room["round_id"]
                    drawer_id = room["drawer_id"]
                    room["scores"][player_id] = room["scores"].get(player_id, 0) + 1
                    if drawer_id and drawer_id in room["players"]:
                        room["scores"][drawer_id] = room["scores"].get(drawer_id, 0) + 1
                    await broadcast(
                        room_id,
                        {
                            "type": "correct",
                            "guesser": pdata["name"],
                            "guesser_id": player_id,
                            "word": room["word"],
                            "scores": score_list(room),
                        },
                    )
                    await broadcast(
                        room_id,
                        {
                            "type": "artwork_display",
                            "seconds": ARTWORK_DISPLAY_SECONDS,
                            "word": room["word"],
                            "word_bank_name": room["word_bank_name"],
                        },
                    )
                    await send_room_states(room)
                    asyncio.create_task(
                        finish_correct_artwork_display(
                            room_id, room, expected_round_id
                        )
                    )
                elif result == "guess":
                    await broadcast(
                        room_id,
                        {
                            "type": "guess",
                            "guesser": pdata["name"],
                            "guesser_id": player_id,
                            "text": text,
                        },
                    )
                else:
                    await broadcast(
                        room_id,
                        {
                            "type": "message",
                            "sender": pdata["name"],
                            "sender_id": player_id,
                            "text": text,
                        },
                    )

    except WebSocketDisconnect:
        await handle_player_disconnect(room_id, player_id, websocket)
    except Exception:
        error_code = create_error_code("DGWS")
        logger.exception("你画我猜 WebSocket 未预期错误 [%s]", error_code)
        try:
            await send_error(
                websocket,
                "抱歉，发生了无法自动恢复的错误，请重新连接后再试",
                error_code,
            )
        except Exception:
            logger.debug("错误提示发送失败，连接可能已关闭", exc_info=True)
        await handle_player_disconnect(room_id, player_id, websocket)
