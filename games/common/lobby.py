"""Reusable lobby helpers shared by drawing-room games.

Game packages keep their own WebSocket loops; this module only covers
room-id rules, joinable-lobby discovery, and lobby stroke housekeeping.
"""

from __future__ import annotations

import random
import re
import string
from typing import Dict, Iterable, List, Optional, Sequence, Set


RANDOM_ROOM_ALPHABET = string.ascii_uppercase + string.digits
RANDOM_ROOM_FIRST_CHARS = RANDOM_ROOM_ALPHABET.replace("P", "")
MAX_ROOM_ID_LENGTH = 6


def is_valid_deep_link_room_id(
    room_id: str, reserved_segments: Iterable[str] | None = None
) -> bool:
    """校验可放进 /{game}/{room} 路径的房间号（2–6 位）。"""
    text = str(room_id or "").strip()
    if len(text) < 2 or len(text) > MAX_ROOM_ID_LENGTH:
        return False
    reserved: Set[str] = {
        str(item).casefold() for item in (reserved_segments or ())
    }
    if text.casefold() in reserved:
        return False
    suffix_len = MAX_ROOM_ID_LENGTH - 1
    return bool(re.fullmatch(rf"[A-Za-z0-9][A-Za-z0-9_-]{{1,{suffix_len}}}", text))


def list_joinable_lobby_rooms(rooms: Dict[str, Dict]) -> List[str]:
    """返回可随机加入的大厅房间：非 P 开头，且仍有在线玩家。"""
    result: List[str] = []
    for room_id, room in rooms.items():
        if room.get("phase") != "lobby":
            continue
        if str(room_id).upper().startswith("P"):
            continue
        if not any(player.get("connected") for player in room.get("players", {}).values()):
            continue
        result.append(str(room_id))
    return result


def list_joinable_collab_rooms(rooms: Dict[str, Dict]) -> List[str]:
    """返回合作画板可随机加入的房间：非 P 开头，且仍有在线玩家。"""
    result: List[str] = []
    for room_id, room in rooms.items():
        if str(room_id).upper().startswith("P"):
            continue
        if not any(player.get("connected") for player in room.get("players", {}).values()):
            continue
        result.append(str(room_id))
    return result


def generate_random_room_id(rooms: Dict[str, Dict]) -> str:
    """生成 4 位大写字母+数字房间号；首字符绝不使用 P。"""
    for _ in range(64):
        code = random.choice(RANDOM_ROOM_FIRST_CHARS) + "".join(
            random.choices(RANDOM_ROOM_ALPHABET, k=3)
        )
        if code not in rooms:
            return code
    while True:
        code = random.choice(RANDOM_ROOM_FIRST_CHARS) + "".join(
            random.choices(RANDOM_ROOM_ALPHABET, k=3)
        )
        if code not in rooms:
            return code


def keep_background_strokes(strokes: Sequence[Dict]) -> List[Dict]:
    """清空笔迹时保留背景色笔画。"""
    kept: List[Dict] = []
    for stroke in strokes:
        segments = stroke.get("segments", [])
        if segments and all(
            segment.get("tool", "brush") == "background" for segment in segments
        ):
            kept.append(stroke)
    return kept


def serialize_lobby_players(
    room: Dict, *, owner_id: Optional[str] = None
) -> List[Dict[str, object]]:
    """序列化大厅/游戏共用的玩家列表字段。"""
    host_id = owner_id if owner_id is not None else room.get("owner_id")
    return [
        {
            "uid": pid,
            "name": pdata["name"],
            "is_host": pid == host_id,
            "ready": pdata["ready"],
            "spectator": pdata["spectator"],
            "watching": pdata.get("watching", False),
            "connected": pdata["connected"],
        }
        for pid, pdata in room["players"].items()
    ]


def get_owner_name(room: Dict) -> str:
    """返回当前房主昵称；无房主或房主已不在房间时返回空字符串。"""
    owner_id = room.get("owner_id")
    if not owner_id:
        return ""
    owner = room.get("players", {}).get(owner_id)
    if not owner:
        return ""
    return str(owner.get("name") or "")
