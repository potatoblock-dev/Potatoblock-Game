"""阈限月台联机：姿态转发 + 共享列车/燃料 + 服务端权威库存。

角色物理暂由客户端权威（含瞄准朝向）；服务端钳制坐标并广播快照。
库存（个人背包/手/装备 + 房间仓库/地面/炮塔箱）由服务端权威；开火扣弹匣/箱弹。

约定（与 Avatar 大厅一致）：
- 共享状态（房间、列车、燃料、聊天、库存）服务端权威。
- 本地角色画面禁止每帧硬拽到 snapshot（会卡顿/闪现）；进房对齐，大误差才软校正。
- 远端用延迟插值；勿把本地预测关掉换成纯跟服。
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import secrets
import string
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from fastapi import WebSocket
from starlette.websockets import WebSocketState

from app.games.avatar_lobby import skins
from app.games.common.room_registry import evict_from_other_games, register_game
from app.games.liminal_platform import inventory_authority as Inv
from app.games.liminal_platform.protocol import (
    MAX_PLAYERS_PER_ROOM,
    PROTOCOL_VERSION,
    PUBLIC_ROOM_ID,
)

logger = logging.getLogger(__name__)

GAME_ID = "liminal_platform"
DISCONNECT_GRACE_SECONDS = 30
SNAPSHOT_HZ = 15
HALF_W = (40.0 * 1.35) / 2.0
# 与客户端 carriage-spec.js WORLD_SCALE 保持一致
WORLD_SCALE = 0.88
FLOOR_Y = 972.0 * WORLD_SCALE
# 与 carriage-spec.js ART_WALK_* 对齐（含两端外廊端台）
WALK_LEFT = 368.0 * WORLD_SCALE
WALK_RIGHT = 1882.0 * WORLD_SCALE
COUPLER_JOIN = 1526.0 * WORLD_SCALE
MAX_MESSAGE_BYTES = 16384
MAX_POSE_HZ = 30
ROOM_CODE_ALPHABET = string.ascii_uppercase + string.digits
ROOM_CODE_LENGTH = 6
DEFAULT_FUEL = 35.0
FUEL_MAX = 100.0
FUEL_PER_ADD = 18.0
CHAT_MAX_LEN = 40
INV_OP_MIN_INTERVAL = 0.04
ROOM_BAGS = frozenset(
    {
        "storage",
        "storage_facility",
        "platform_storage",
        "ground",
        "crate_ammo",
        "crate_recycle",
    }
)
# 月台/地牢场景位姿钳制（X 与客户端 LpDungeon.MAX_WIDTH=48000 对齐）。
# Y 为相对地板的物理高度（地面≈0，腾空为负），不是舞台绝对 Y。
PLATFORM_SCENE_X_MIN = 0.0
PLATFORM_SCENE_X_MAX = 48000.0
PLATFORM_SCENE_Y_MIN = -1200.0
PLATFORM_SCENE_Y_MAX = 200.0
# 无人机广播用世界舞台坐标（约 FLOOR_Y−80≈777；地牢上层可更小）。
DRONE_WORLD_Y_MIN = -1200.0
DRONE_WORLD_Y_MAX = 1400.0

CLOSE_REPLACED = 4002
CLOSE_ROOM_FULL = 4005
CLOSE_BAD_PROTOCOL = 4006


def _now() -> float:
    return time.monotonic()


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _default_appearance(user_id: str) -> Dict[str, Any]:
    return skins.get_appearance_for_broadcast(user_id, None) or {
        "skinId": None,
        "kind": "placeholder",
        "heightScale": 1.0,
        "contentHash": None,
    }


def _build_platforms() -> List[Dict[str, float]]:
    # 与 carriage-spec CARRIAGES 对齐：卫兵→塔莎→仓储→空车厢→动力→绘轨→枢机
    cars = [COUPLER_JOIN * i for i in range(7)]
    floors = [
        {"left": wx + WALK_LEFT, "right": wx + WALK_RIGHT, "y": FLOOR_Y} for wx in cars
    ]
    platforms: List[Dict[str, float]] = []
    for i, floor in enumerate(floors):
        if i > 0:
            prev = floors[i - 1]
            if floor["left"] > prev["right"]:
                platforms.append(
                    {
                        "left": prev["right"],
                        "right": floor["left"],
                        "y": FLOOR_Y,
                    }
                )
        platforms.append(floor)
    return platforms


PLATFORMS = _build_platforms()
WORLD_LEFT = PLATFORMS[0]["left"] + HALF_W
WORLD_RIGHT = PLATFORMS[-1]["right"] - HALF_W
# 开局出生在动力车厢（编组左→右：卫兵、仓储、空车厢、动力、绘轨、枢机）走道中心
POWER_CAR_WORLD_X = COUPLER_JOIN * 3
DEFAULT_X = POWER_CAR_WORLD_X + (WALK_LEFT + WALK_RIGHT) / 2.0


class PlayerConnection:
    """单个 WebSocket 连接及其发送队列。"""

    def __init__(self, websocket: WebSocket, user_id: str, nickname: str):
        self.websocket = websocket
        self.user_id = user_id
        self.nickname = nickname
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        self.sender_task: Optional[asyncio.Task] = None
        self.last_pose_at = _now()
        self.pose_window_start = _now()
        self.pose_count_window = 0

    async def start(self) -> None:
        if self.sender_task is not None and not self.sender_task.done():
            return
        self.sender_task = asyncio.create_task(self._sender_loop())

    async def enqueue(self, message: Dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.queue.put_nowait(message)
            except asyncio.QueueFull:
                pass

    async def _sender_loop(self) -> None:
        while True:
            message = await self.queue.get()
            try:
                if self.websocket.client_state != WebSocketState.CONNECTED:
                    break
                await self.websocket.send_json(message)
            except Exception:
                break

    async def close(self, code: int = 1000) -> None:
        if self.sender_task is not None:
            self.sender_task.cancel()
            try:
                await self.sender_task
            except asyncio.CancelledError:
                pass
            self.sender_task = None
        if self.websocket.client_state == WebSocketState.CONNECTED:
            try:
                await self.websocket.close(code=code)
            except Exception:
                pass

    def accept_pose_rate(self) -> bool:
        now = _now()
        if now - self.pose_window_start >= 1.0:
            self.pose_window_start = now
            self.pose_count_window = 0
        self.pose_count_window += 1
        self.last_pose_at = now
        return self.pose_count_window <= MAX_POSE_HZ


class LiminalPlayer:
    """房间内一名玩家（姿态由客户端上报；库存服务端权威）。"""

    def __init__(self, user_id: str, nickname: str, connection: PlayerConnection):
        self.user_id = user_id
        self.nickname = nickname
        self.connection = connection
        self.connected = True
        self.disconnect_token: Optional[str] = None
        self.x = DEFAULT_X
        self.y = 0.0
        self.vx = 0.0
        self.vy = 0.0
        self.facing = 1
        self.on_ground = True
        self.gait = "walk"
        self.head_look = 0.0
        self.ack_sequence = 0
        self.appearance = _default_appearance(user_id)
        self.held_id: Optional[str] = None
        self.aim_x: Optional[float] = None
        self.aim_y: Optional[float] = None
        self.turret_id: Optional[str] = None
        self.pressure = 0.0
        self.hp = 100.0
        self.life_state = "alive"
        self.downed_remain = None
        self.death_cause = None
        self.drone_x = None
        self.drone_y = None
        self.drone_vx = None
        self.drone_vy = None
        self.drone_aim = None
        self.drone_phase = None
        self.radar_open = False
        self.radar_lock_aim = None
        # 所在场景：train | platform（客户端上报；发车锁用）
        self.scene = "train"
        self.inventories = Inv.PlayerInventories()
        self.sync_held_from_inv()

    def sync_held_from_inv(self) -> None:
        """从手部库存同步持枪 id（忽略客户端 pose 上报）。"""
        self.held_id = Inv.held_weapon_id(self.inventories)

    def inv_message(self, room: "LiminalRoom") -> Dict[str, Any]:
        """组装发给本人的完整库存快照（个人 + 房间共享）。"""
        self.sync_held_from_inv()
        return {
            "type": "inv_snapshot",
            "protocolVersion": PROTOCOL_VERSION,
            "roomId": room.room_id,
            "personal": self.inventories.personal_snapshot(),
            "room": room.inventories.room_snapshot(),
        }

    def snapshot(self) -> Dict[str, Any]:
        """组装世界快照玩家条目；入座炮塔时不回显 heldId（远端不画手持枪）。"""
        self.sync_held_from_inv()
        manned = self.turret_id in ("left", "right")
        data = {
            "id": self.user_id,
            "nickname": self.nickname,
            "x": round(self.x, 2),
            "y": round(self.y, 3),
            "vx": round(self.vx, 3),
            "vy": round(self.vy, 3),
            "facing": self.facing,
            "onGround": self.on_ground,
            "gait": self.gait if self.gait in ("walk", "run") else "walk",
            "headLook": round(self.head_look, 3),
            "appearance": dict(self.appearance),
            "connected": self.connected,
            "heldId": None if manned else self.held_id,
            "pressure": round(self.pressure, 1),
            "hp": round(self.hp, 1),
            "lifeState": self.life_state if self.life_state in ("alive", "downed", "dead") else "alive",
        }
        if self.life_state == "downed" and self.downed_remain is not None:
            try:
                data["downedRemain"] = round(float(self.downed_remain), 2)
            except (TypeError, ValueError):
                pass
        if self.life_state == "dead" and self.death_cause in ("timer", "redeploy", "solo"):
            data["deathCause"] = self.death_cause
        if self.aim_x is not None and self.aim_y is not None:
            data["aimX"] = round(self.aim_x, 2)
            data["aimY"] = round(self.aim_y, 2)
        if manned:
            data["turretId"] = self.turret_id
        if self.drone_x is not None and self.drone_y is not None:
            try:
                data["droneX"] = round(float(self.drone_x), 2)
                data["droneY"] = round(float(self.drone_y), 2)
                if self.drone_vx is not None:
                    data["droneVx"] = round(float(self.drone_vx), 3)
                if self.drone_vy is not None:
                    data["droneVy"] = round(float(self.drone_vy), 3)
                if self.drone_aim is not None:
                    data["droneAim"] = round(float(self.drone_aim), 4)
                if self.drone_phase is not None:
                    phase = int(self.drone_phase)
                    if 0 <= phase <= 3:
                        data["dronePhase"] = phase
            except (TypeError, ValueError):
                pass
        scene = str(getattr(self, "scene", "train") or "train").strip().lower()
        if scene in ("train", "platform"):
            data["scene"] = scene
        if self.radar_open:
            data["radarOpen"] = True
            if self.radar_lock_aim is not None:
                try:
                    data["radarLockAim"] = round(float(self.radar_lock_aim), 4)
                except (TypeError, ValueError):
                    pass
        return data


class LiminalRoom:
    """阈限月台房间：姿态广播 + 共享列车/燃料/库存。"""

    def __init__(self, room_id: str, is_public: bool = False):
        self.room_id = room_id
        self.is_public = is_public
        self.players: Dict[str, LiminalPlayer] = {}
        self.server_tick = 0
        self.tick_task: Optional[asyncio.Task] = None
        self.running = False
        self.train = {"throttle": 0.0, "brake": 0.0, "speed": 0.0, "emergency": False}
        self.fuel_level = DEFAULT_FUEL
        # JS Number 安全整数范围内的房间世界种子（月台类型 / 地牢 / 月台仓）。
        self.world_seed = secrets.randbits(53)
        self.inventories = Inv.RoomInventories()
        self._fuel_add_times: Dict[str, float] = {}
        self._train_set_times: Dict[str, float] = {}
        self._inv_op_times: Dict[str, float] = {}
        self._fire_times: Dict[str, float] = {}
        self._heal_times: Dict[str, float] = {}
        # 已按站填装过的月台仓库 stationIndex。
        self._platform_loot_station: Optional[int] = None

    def connected_count(self) -> int:
        return sum(1 for player in self.players.values() if player.connected)

    def is_empty(self) -> bool:
        return len(self.players) == 0

    async def start(self) -> None:
        if self.running:
            return
        self.running = True
        self.tick_task = asyncio.create_task(self._tick_loop())

    async def stop(self) -> None:
        self.running = False
        if self.tick_task is not None:
            self.tick_task.cancel()
            try:
                await self.tick_task
            except asyncio.CancelledError:
                pass
            self.tick_task = None

    async def broadcast(self, message: Dict[str, Any], exclude_id: Optional[str] = None) -> None:
        for player_id, player in list(self.players.items()):
            if exclude_id is not None and player_id == exclude_id:
                continue
            if not player.connected:
                continue
            await player.connection.enqueue(message)

    def world_snapshot(self) -> Dict[str, Any]:
        return {
            "type": "world_snapshot",
            "protocolVersion": PROTOCOL_VERSION,
            "serverTick": self.server_tick,
            "serverTimeMs": int(time.time() * 1000),
            "roomId": self.room_id,
            "isPublic": self.is_public,
            "playerCount": self.connected_count(),
            "maxPlayers": MAX_PLAYERS_PER_ROOM,
            "players": [player.snapshot() for player in self.players.values()],
            "world": {
                "train": {
                    "throttle": round(self.train["throttle"], 3),
                    "brake": round(self.train["brake"], 3),
                    "speed": round(self.train["speed"], 3),
                    "emergencyActive": bool(self.train.get("emergency")),
                },
                "fuel": {"level": round(self.fuel_level, 2)},
                "seed": int(self.world_seed),
            },
        }

    async def broadcast_snapshot(self) -> None:
        await self.broadcast(self.world_snapshot())

    def step_train(self, dt: float) -> None:
        """列车积分：牵引力/功率包络 + 滚动与风阻（与客户端 lp-train-drive.js 对齐）。"""
        # 月台发车锁：有人在月台时保持空档
        if any(
            p.connected and str(getattr(p, "scene", "train")) == "platform"
            for p in self.players.values()
        ):
            self.train["throttle"] = 0.0
        throttle = float(self.train["throttle"])
        brake = float(self.train["brake"])
        speed = float(self.train["speed"])
        max_speed = 5.0
        notch_max = 5.0
        tractive_start = 1.75
        power_ref = 1.55
        resist_roll = 0.085
        resist_drag = 0.0175
        reverse_boost = 1.12
        stop_eps = 0.03
        emergency_decel = 9.0

        if brake >= 0.95:
            self.train["emergency"] = True
            self.train["throttle"] = 0.0
            throttle = 0.0

        if self.train.get("emergency"):
            self.train["throttle"] = 0.0
            if speed > 0.0:
                speed = max(0.0, speed - emergency_decel * dt)
            elif speed < 0.0:
                speed = min(0.0, speed + emergency_decel * dt)
            if abs(speed) < 0.02:
                speed = 0.0
                self.train["emergency"] = False
            self.train["speed"] = speed
            return

        demand = _clamp(throttle / notch_max, -1.0, 1.0) * (1.0 - brake * 0.92)
        abs_demand = abs(demand)
        accel = 0.0
        if abs_demand >= 0.01:
            direction = 1.0 if demand > 0.0 else -1.0
            v = abs(speed)
            effort = tractive_start * abs_demand
            power_limited = (tractive_start * abs_demand * power_ref) / max(v, power_ref)
            mag = min(effort, power_limited)
            if abs(speed) > 0.05 and ((speed > 0.0) != (demand > 0.0)):
                mag *= reverse_boost
            accel += direction * mag
        if abs(speed) >= 1e-5:
            v = abs(speed)
            accel -= (1.0 if speed > 0.0 else -1.0) * (resist_roll + resist_drag * v * v)

        speed += accel * dt
        if abs_demand < 0.01 and abs(speed) < stop_eps:
            speed = 0.0
        self.train["speed"] = _clamp(speed, -max_speed, max_speed)

    async def _tick_loop(self) -> None:
        step = 1.0 / SNAPSHOT_HZ
        try:
            while self.running:
                started = _now()
                self.server_tick += 1
                self.step_train(step)
                await self.broadcast_snapshot()
                elapsed = _now() - started
                await asyncio.sleep(max(0.0, step - elapsed))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("liminal room tick failed: %s", self.room_id)


class LiminalLobbyManager:
    """管理公共房与临时房间。"""

    def __init__(self) -> None:
        self.rooms: Dict[str, LiminalRoom] = {}
        self.player_rooms: Dict[str, str] = {}
        self._public = LiminalRoom(PUBLIC_ROOM_ID, is_public=True)
        self.rooms[PUBLIC_ROOM_ID] = self._public

    async def ensure_started(self) -> None:
        await self._public.start()

    def _generate_room_id(self) -> str:
        while True:
            code = "".join(random.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LENGTH))
            if code not in self.rooms:
                return code

    def _normalize_room_id(self, room_id: Optional[str]) -> str:
        if not room_id:
            return PUBLIC_ROOM_ID
        cleaned = "".join(ch for ch in str(room_id).strip().upper() if ch.isalnum())
        return cleaned or PUBLIC_ROOM_ID

    async def create_private_room(self) -> LiminalRoom:
        room_id = self._generate_room_id()
        room = LiminalRoom(room_id, is_public=False)
        self.rooms[room_id] = room
        await room.start()
        return room

    async def get_or_create_room(self, room_id: Optional[str], create: bool = False) -> LiminalRoom:
        if create:
            return await self.create_private_room()
        normalized = self._normalize_room_id(room_id)
        if normalized == PUBLIC_ROOM_ID:
            return self._public
        room = self.rooms.get(normalized)
        if room is None:
            raise ValueError("房间不存在")
        return room

    async def join(
        self,
        connection: PlayerConnection,
        room_id: Optional[str] = None,
        create: bool = False,
    ) -> LiminalRoom:
        await evict_from_other_games(GAME_ID, connection.user_id)
        room = await self.get_or_create_room(room_id, create=create)
        if (
            connection.user_id not in room.players
            and room.connected_count() >= MAX_PLAYERS_PER_ROOM
        ):
            raise ValueError("房间已满")

        previous_room_id = self.player_rooms.get(connection.user_id)
        if previous_room_id and previous_room_id in self.rooms:
            previous = self.rooms[previous_room_id]
            old = previous.players.get(connection.user_id)
            if old is not None and old.connection.websocket is not connection.websocket:
                await old.connection.close(code=CLOSE_REPLACED)
            if previous_room_id != room.room_id:
                await self._remove_player(previous, connection.user_id, announce=True)

        existing = room.players.get(connection.user_id)
        if existing is not None:
            existing.connection = connection
            existing.connected = True
            existing.disconnect_token = None
            existing.nickname = connection.nickname
        else:
            room.players[connection.user_id] = LiminalPlayer(
                connection.user_id, connection.nickname, connection
            )

        self.player_rooms[connection.user_id] = room.room_id
        await connection.start()
        await connection.enqueue(
            {
                "type": "room_joined",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "isPublic": room.is_public,
                "playerCount": room.connected_count(),
                "maxPlayers": MAX_PLAYERS_PER_ROOM,
            }
        )
        await connection.enqueue(room.world_snapshot())
        joined = room.players[connection.user_id]
        await connection.enqueue(joined.inv_message(room))
        await room.broadcast(
            {
                "type": "player_join",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "playerId": connection.user_id,
                "playerCount": room.connected_count(),
            },
            exclude_id=connection.user_id,
        )
        return room

    async def handle_pose(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        if not player.connection.accept_pose_rate():
            return
        if int(payload.get("protocolVersion") or 0) != PROTOCOL_VERSION:
            return
        sequence = int(payload.get("sequence") or 0)
        if sequence < player.ack_sequence:
            return
        scene_hint = str(payload.get("scene") or getattr(player, "scene", "train") or "train").strip().lower()
        on_platform = scene_hint == "platform"
        x_lo = PLATFORM_SCENE_X_MIN if on_platform else WORLD_LEFT
        x_hi = PLATFORM_SCENE_X_MAX if on_platform else WORLD_RIGHT
        y_lo = PLATFORM_SCENE_Y_MIN if on_platform else -800.0
        y_hi = PLATFORM_SCENE_Y_MAX if on_platform else 80.0
        try:
            player.x = _clamp(float(payload.get("x") or player.x), x_lo, x_hi)
            player.y = _clamp(float(payload.get("y") or 0.0), y_lo, y_hi)
            player.vx = _clamp(float(payload.get("vx") or 0.0), -800.0, 800.0)
            player.vy = _clamp(float(payload.get("vy") or 0.0), -1200.0, 1200.0)
            player.head_look = _clamp(float(payload.get("headLook") or 0.0), -0.6, 0.6)
        except (TypeError, ValueError):
            return
        facing = int(payload.get("facing") or player.facing)
        player.facing = 1 if facing >= 0 else -1
        player.on_ground = bool(payload.get("onGround"))
        gait = str(payload.get("gait") or "walk")
        player.gait = "run" if gait == "run" else "walk"
        player.ack_sequence = sequence
        # heldId 由库存权威决定，忽略客户端 pose
        player.sync_held_from_inv()
        if "aimX" in payload and "aimY" in payload:
            try:
                aim_pad = 400.0
                player.aim_x = _clamp(
                    float(payload["aimX"]), x_lo - aim_pad, x_hi + aim_pad
                )
                player.aim_y = _clamp(float(payload["aimY"]), y_lo - 100.0, y_hi + 100.0)
            except (TypeError, ValueError):
                player.aim_x = None
                player.aim_y = None
        else:
            player.aim_x = None
            player.aim_y = None
        self._apply_turret_claim(room, player, payload.get("turretId"))
        # HUD 透传：压力 / 生命（客户端本地权威，仅供队友条显示）
        if "pressure" in payload:
            try:
                player.pressure = _clamp(float(payload.get("pressure")), 0.0, 200.0)
            except (TypeError, ValueError):
                pass
        if "hp" in payload:
            try:
                player.hp = _clamp(float(payload.get("hp")), 0.0, 100.0)
            except (TypeError, ValueError):
                pass
        life = str(payload.get("lifeState") or "").strip().lower()
        if life in ("alive", "downed", "dead"):
            player.life_state = life
        if life == "downed":
            if "downedRemain" in payload:
                try:
                    raw = payload.get("downedRemain")
                    player.downed_remain = (
                        None if raw is None else _clamp(float(raw), 0.0, 60.0)
                    )
                except (TypeError, ValueError):
                    player.downed_remain = None
            player.death_cause = None
        elif life == "dead":
            cause = str(payload.get("deathCause") or "").strip().lower()
            player.death_cause = cause if cause in ("timer", "redeploy", "solo") else "timer"
            player.downed_remain = None
        elif life == "alive":
            player.death_cause = None
            player.downed_remain = None
        if scene_hint in ("train", "platform"):
            player.scene = scene_hint
        elif not getattr(player, "scene", None):
            player.scene = "train"
        self._apply_drone_pose(player, payload)
        self._apply_radar_pose(player, payload)

    def _apply_radar_pose(self, player: LiminalPlayer, payload: Dict[str, Any]) -> None:
        """绘轨雷达开闭与锁定角（供远端火控共享持续照射）。"""
        if not bool(payload.get("radarOpen")):
            player.radar_open = False
            player.radar_lock_aim = None
            return
        player.radar_open = True
        if "radarLockAim" in payload:
            try:
                player.radar_lock_aim = float(payload["radarLockAim"])
            except (TypeError, ValueError):
                player.radar_lock_aim = None
        else:
            player.radar_lock_aim = None

    def _apply_drone_pose(self, player: LiminalPlayer, payload: Dict[str, Any]) -> None:
        """写入伴飞无人机位姿（客户端权威，仅回显广播；缺字段则清掉）。

        droneX/Y 为世界舞台坐标（非玩家 physicsY）。月台地牢 X 可远超列车 WORLD_RIGHT。
        """
        if "droneX" not in payload or "droneY" not in payload:
            player.drone_x = None
            player.drone_y = None
            player.drone_vx = None
            player.drone_vy = None
            player.drone_aim = None
            player.drone_phase = None
            return
        on_platform = str(getattr(player, "scene", "train") or "train") == "platform"
        x_lo = PLATFORM_SCENE_X_MIN - 400.0 if on_platform else WORLD_LEFT - 400.0
        x_hi = PLATFORM_SCENE_X_MAX + 400.0 if on_platform else WORLD_RIGHT + 400.0
        try:
            player.drone_x = _clamp(float(payload["droneX"]), x_lo, x_hi)
            player.drone_y = _clamp(
                float(payload["droneY"]), DRONE_WORLD_Y_MIN, DRONE_WORLD_Y_MAX
            )
        except (TypeError, ValueError):
            player.drone_x = None
            player.drone_y = None
            player.drone_vx = None
            player.drone_vy = None
            player.drone_aim = None
            player.drone_phase = None
            return
        try:
            player.drone_vx = _clamp(float(payload.get("droneVx") or 0.0), -800.0, 800.0)
            player.drone_vy = _clamp(float(payload.get("droneVy") or 0.0), -800.0, 800.0)
        except (TypeError, ValueError):
            player.drone_vx = 0.0
            player.drone_vy = 0.0
        if "droneAim" in payload:
            try:
                player.drone_aim = float(payload["droneAim"])
            except (TypeError, ValueError):
                player.drone_aim = None
        else:
            player.drone_aim = None
        if "dronePhase" in payload:
            try:
                phase = int(payload["dronePhase"])
                player.drone_phase = phase if 0 <= phase <= 3 else 0
            except (TypeError, ValueError):
                player.drone_phase = 0
        else:
            player.drone_phase = 0

    def _apply_turret_claim(
        self, room: "LiminalRoom", player: LiminalPlayer, raw_turret_id: Any
    ) -> None:
        """写入炮位占用：仅 left/right；同侧已被其他在线玩家占用则拒绝（保持未占用）。"""
        want = str(raw_turret_id or "").strip().lower()
        if want not in ("left", "right"):
            player.turret_id = None
            return
        for other in room.players.values():
            if (
                other.user_id != player.user_id
                and other.connected
                and other.turret_id == want
            ):
                # 抢座失败：若本人原本不在该侧，清掉声明；已坐同一侧则保持
                if player.turret_id != want:
                    player.turret_id = None
                return
        player.turret_id = want

    def _any_player_on_platform(self, room: "LiminalRoom") -> bool:
        """房内是否有在线玩家仍在月台场景（发车锁）。"""
        for other in room.players.values():
            if other.connected and str(getattr(other, "scene", "train")) == "platform":
                return True
        return False

    async def handle_train(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        now = _now()
        last = room._train_set_times.get(user_id, 0.0)
        if now - last < 0.04:
            return
        room._train_set_times[user_id] = now
        if "throttle" in payload:
            try:
                want = _clamp(float(payload["throttle"]), -5.0, 5.0)
            except (TypeError, ValueError):
                want = room.train["throttle"]
            # 任一人在月台：禁止离开空档（发车锁）
            if abs(want) > 0.01 and self._any_player_on_platform(room):
                room.train["throttle"] = 0.0
            else:
                room.train["throttle"] = want
        if "brake" in payload:
            try:
                room.train["brake"] = _clamp(float(payload["brake"]), 0.0, 1.0)
            except (TypeError, ValueError):
                pass
        if float(room.train["brake"]) >= 0.95:
            room.train["emergency"] = True
            room.train["throttle"] = 0.0
        if room.train.get("emergency"):
            room.train["throttle"] = 0.0
        if self._any_player_on_platform(room):
            room.train["throttle"] = 0.0

    async def handle_fuel_add(self, user_id: str, payload: Dict[str, Any]) -> None:
        """加燃料：从个人库存扣煤，再提升房间燃料。"""
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        now = _now()
        last = room._fuel_add_times.get(user_id, 0.0)
        if now - last < 0.35:
            return
        room._fuel_add_times[user_id] = now
        if room.fuel_level >= FUEL_MAX - 0.01:
            return
        item_id = str(payload.get("itemId") or "coal")
        item = Inv.ITEMS.get(item_id) or {}
        if item.get("type") != "fuel" and item_id != "coal":
            return
        energy = float(item.get("boilerFuel") or FUEL_PER_ADD)
        spent = Inv.consume_from_personal(player.inventories, item_id, 1)
        if spent <= 0:
            await player.connection.enqueue(player.inv_message(room))
            return
        room.fuel_level = min(FUEL_MAX, room.fuel_level + energy * spent)
        if Inv.TEST_AUTO_REFILL_CONSUMABLES:
            Inv.refill_player_consumables(player.inventories)
            Inv.refill_room_consumables(room.inventories)
        await player.connection.enqueue(player.inv_message(room))
        await room.broadcast(
            {
                "type": "fuel_changed",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "level": round(room.fuel_level, 2),
                "by": user_id,
            }
        )

    async def handle_fire(self, user_id: str, payload: Dict[str, Any]) -> None:
        """开火：炮塔扣箱弹并写入回收弹壳，否则扣手持弹匣，再广播曳光。

        机炮在射击者位于月台、或房内任一人在月台时直接拒绝（防伪造与发车锁一致）。
        """
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        now = _now()
        last = room._fire_times.get(user_id, 0.0)
        if now - last < 0.05:
            return
        room._fire_times[user_id] = now
        source = str(payload.get("source") or "").strip().lower()
        weapon_id: Optional[str] = None
        room_changed = False
        if source == "turret":
            # 月台场景或房内有人在月台：拒绝列车机炮（与客户端 isTrainWeaponSuppressed 对齐）
            if str(getattr(player, "scene", "train")) == "platform":
                return
            if self._any_player_on_platform(room):
                return
            # 须已占炮位；若 fire 先于 pose 到达，用 payload.turretId 尝试认领
            if player.turret_id not in ("left", "right"):
                self._apply_turret_claim(room, player, payload.get("turretId"))
            if player.turret_id not in ("left", "right"):
                return
            ammo_bag = room.inventories.crates["ammo"]
            recycle_bag = room.inventories.crates["recycle"]
            if Inv.TEST_AUTO_REFILL_CONSUMABLES:
                if ammo_bag.count_item("turret_ammo") <= 0:
                    ammo_bag.add_item(
                        "turret_ammo", int(Inv.ITEMS["turret_ammo"]["maxStack"])
                    )
                Inv.refill_consumable_stacks(ammo_bag)
                spent = 1
            else:
                spent = ammo_bag.remove_item("turret_ammo", 1)
            if spent <= 0:
                await player.connection.enqueue(player.inv_message(room))
                return
            # 耗 1 发弹药 → 回收箱入 1 枚弹壳（箱满则丢弃多余）
            recycle_bag.add_item("shell_casing", 1)
            weapon_id = "guard_turret"
            room_changed = True
        else:
            hand_index = payload.get("handIndex")
            fired = self._consume_hand_mag(player, hand_index)
            if fired is None:
                await player.connection.enqueue(player.inv_message(room))
                return
            weapon_id = fired
            # 不在开火后 refill 玩家弹匣；测试无限只针对仓库/弹药堆，见 refill_storage_infinite。
        await player.connection.enqueue(player.inv_message(room))
        if room_changed:
            await self._broadcast_inv_room(room, exclude_id=user_id)
        shots_out: List[Dict[str, Any]] = []
        raw_shots = payload.get("shots")
        if isinstance(raw_shots, list):
            for entry in raw_shots[:2]:
                if not isinstance(entry, dict):
                    continue
                try:
                    shots_out.append(
                        {
                            "x": float(entry.get("x")),
                            "y": float(entry.get("y")),
                            "dirX": float(entry.get("dirX")),
                            "dirY": float(entry.get("dirY")),
                        }
                    )
                except (TypeError, ValueError):
                    continue
        if not shots_out:
            shots_out = [
                {
                    "x": payload.get("x"),
                    "y": payload.get("y"),
                    "dirX": payload.get("dirX"),
                    "dirY": payload.get("dirY"),
                }
            ]
        primary = shots_out[0]
        turret_id = str(payload.get("turretId") or "").strip().lower()
        fired: Dict[str, Any] = {
            "type": "weapon_fired",
            "protocolVersion": PROTOCOL_VERSION,
            "roomId": room.room_id,
            "playerId": user_id,
            "weaponId": weapon_id,
            "x": primary.get("x"),
            "y": primary.get("y"),
            "dirX": primary.get("dirX"),
            "dirY": primary.get("dirY"),
            "facing": payload.get("facing", player.facing),
            "source": source or None,
        }
        if source == "turret" and turret_id in ("left", "right"):
            fired["turretId"] = turret_id
        if len(shots_out) > 1:
            fired["shots"] = shots_out
        # 武装弹种透传（ap / t）；仅外观与后续玩法，不改扣弹逻辑
        ammo_type = str(payload.get("ammoType") or "").strip().lower()
        if ammo_type in ("ap", "t"):
            fired["ammoType"] = ammo_type
        await room.broadcast(fired, exclude_id=user_id)

    async def handle_heal(self, user_id: str, payload: Dict[str, Any]) -> None:
        """医疗箱治疗：校验手部医箱与距离，扣耐久，广播回血量（生命仍由客户端应用）。"""
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        now = _now()
        last = room._heal_times.get(user_id, 0.0)
        if now - last < 0.08:
            return
        room._heal_times[user_id] = now
        try:
            dt = float(payload.get("dt") or 0.1)
        except (TypeError, ValueError):
            dt = 0.1
        dt = max(0.02, min(0.25, dt))
        target_id = str(payload.get("targetId") or "").strip()
        ally = False
        target = player
        if target_id and target_id != user_id:
            other = room.players.get(target_id)
            if other is None or not other.connected:
                await player.connection.enqueue(player.inv_message(room))
                return
            item = Inv.ITEMS.get(Inv.MEDKIT_ID) or {}
            ally_range = float(item.get("allyRange") or 150)
            dist = ((other.x - player.x) ** 2 + (other.y - player.y) ** 2) ** 0.5
            if dist > ally_range + 40:
                await player.connection.enqueue(player.inv_message(room))
                return
            ally = True
            target = other
            if getattr(other, "life_state", "alive") == "downed":
                # 濒死须走 revive，不用持续 heal
                await player.connection.enqueue(player.inv_message(room))
                return
        result = Inv.apply_medkit_tick(
            player.inventories,
            hand_index=payload.get("handIndex"),
            dt=dt,
            ally=ally,
        )
        await player.connection.enqueue(player.inv_message(room))
        if not result or float(result.get("amount") or 0) <= 0:
            return
        await room.broadcast(
            {
                "type": "player_healed",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "by": user_id,
                "targetId": target.user_id,
                "amount": round(float(result["amount"]), 3),
                "ally": ally,
            }
        )

    async def handle_revive(self, user_id: str, payload: Dict[str, Any]) -> None:
        """消耗整箱医箱复活濒死队友；生命/压力由客户端按广播应用。"""
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        now = _now()
        last = room._heal_times.get(user_id, 0.0)
        if now - last < 0.15:
            return
        room._heal_times[user_id] = now
        target_id = str(payload.get("targetId") or "").strip()
        if not target_id or target_id == user_id:
            await player.connection.enqueue(player.inv_message(room))
            return
        other = room.players.get(target_id)
        if other is None or not other.connected:
            await player.connection.enqueue(player.inv_message(room))
            return
        if getattr(other, "life_state", "alive") != "downed":
            await player.connection.enqueue(player.inv_message(room))
            return
        item = Inv.ITEMS.get(Inv.FIRST_AID_KIT_ID) or Inv.ITEMS.get(Inv.MEDKIT_ID) or {}
        ally_range = float(item.get("allyRange") or 150)
        dist = ((other.x - player.x) ** 2 + (other.y - player.y) ** 2) ** 0.5
        if dist > ally_range + 40:
            await player.connection.enqueue(player.inv_message(room))
            return
        consumed = Inv.consume_held_first_aid(
            player.inventories, hand_index=payload.get("handIndex")
        )
        await player.connection.enqueue(player.inv_message(room))
        if not consumed:
            return
        other.life_state = "alive"
        other.downed_remain = None
        other.death_cause = None
        other.hp = max(1.0, round(100.0 * 0.2, 1))
        await room.broadcast(
            {
                "type": "player_revived",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "by": user_id,
                "targetId": other.user_id,
            }
        )

    async def handle_inv(self, user_id: str, payload: Dict[str, Any]) -> None:
        """处理库存意图：transfer / quick_transfer / consume / reload / crate / drop / rotate / sort / set_ammo。"""
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        now = _now()
        last = room._inv_op_times.get(user_id, 0.0)
        if now - last < INV_OP_MIN_INTERVAL:
            return
        room._inv_op_times[user_id] = now
        action = str(payload.get("action") or "").strip()
        room_changed = False
        if action == "transfer":
            room_changed = self._inv_transfer(room, player, payload)
        elif action == "quick_transfer":
            room_changed = self._inv_quick_transfer(room, player, payload)
        elif action == "consume":
            self._inv_consume(player, payload)
        elif action == "reload":
            room_changed = self._inv_reload(room, player, payload)
        elif action == "crate":
            room_changed = self._inv_crate(room, player, payload)
        elif action == "drop":
            room_changed = self._inv_drop(room, player, payload)
        elif action == "rotate":
            room_changed = self._inv_rotate(room, player, payload)
        elif action == "sort":
            room_changed = self._inv_sort(room, player, payload)
        elif action == "set_ammo":
            self._inv_set_ammo(room, player, payload)
        elif action == "ensure_platform_storage":
            room_changed = self._inv_ensure_platform_storage(room, payload)
        else:
            return
        overflow = Inv.sync_player_to_equip(player.inventories.player, player.inventories.equip)
        if overflow:
            room.inventories.drop_stacks(player.x, FLOOR_Y, overflow)
            room_changed = True
        if Inv.TEST_AUTO_REFILL_CONSUMABLES:
            Inv.refill_player_consumables(player.inventories)
            Inv.refill_room_consumables(room.inventories)
        await player.connection.enqueue(player.inv_message(room))
        if room_changed:
            await self._broadcast_inv_room(room, exclude_id=user_id)

    def _inv_ensure_platform_storage(
        self, room: LiminalRoom, payload: Dict[str, Any]
    ) -> bool:
        """按站首次用 world_seed 填装小型月台仓库袋。"""
        try:
            station_index = int(payload.get("stationIndex") or 0)
        except (TypeError, ValueError):
            station_index = 0
        station_index = max(0, station_index)
        if room._platform_loot_station == station_index:
            return False
        Inv.fill_platform_storage(
            room.inventories.platform_storage,
            int(room.world_seed),
            station_index,
        )
        room._platform_loot_station = station_index
        return True

    async def handle_chat(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        text = str(payload.get("text") or "").strip()
        text = " ".join(text.split())[:CHAT_MAX_LEN]
        if not text:
            return
        await room.broadcast(
            {
                "type": "chat",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "playerId": user_id,
                "nickname": player.nickname,
                "text": text,
            }
        )

    async def handle_appearance(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        appearance = skins.get_appearance_for_broadcast(user_id, payload.get("skinId"))
        if appearance is None:
            return
        player.appearance = appearance
        await room.broadcast(
            {
                "type": "appearance",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "playerId": user_id,
                "appearance": appearance,
            }
        )

    async def _broadcast_inv_room(
        self, room: LiminalRoom, exclude_id: Optional[str] = None
    ) -> None:
        """向房间其他人推送共享库存快照。"""
        await room.broadcast(
            {
                "type": "inv_room",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "room": room.inventories.room_snapshot(),
            },
            exclude_id=exclude_id,
        )

    def _resolve_bag(
        self,
        room: LiminalRoom,
        player: LiminalPlayer,
        ref: Any,
    ) -> Optional[Inv.Inventory]:
        """解析客户端 bag 引用为服务端 Inventory。"""
        if not isinstance(ref, dict):
            return None
        name = str(ref.get("bag") or ref.get("inv") or "").strip()
        pile_id = ref.get("pileId")
        pile = str(pile_id) if pile_id else None
        return room.inventories.get_bag(name, player.inventories, pile)

    def _bag_is_room(self, ref: Any) -> bool:
        if not isinstance(ref, dict):
            return False
        name = str(ref.get("bag") or ref.get("inv") or "").strip()
        return name in ROOM_BAGS

    def _consume_hand_mag(
        self, player: LiminalPlayer, hand_index: Any
    ) -> Optional[str]:
        """扣减手持武器一发弹匣；成功返回 weapon itemId。"""
        indices: List[int]
        if hand_index is None:
            indices = [1, 0]
        else:
            try:
                indices = [int(hand_index)]
            except (TypeError, ValueError):
                indices = [1, 0]
        for index in indices:
            stack = player.inventories.hands.get_slot(index)
            if not stack:
                continue
            item = Inv.ITEMS.get(stack["itemId"]) or {}
            if item.get("type") != "weapon":
                continue
            mag_size = item.get("magazineSize")
            if mag_size is None:
                return stack["itemId"]
            mag = int(stack.get("mag") or 0)
            # 手持武器始终扣弹匣；TEST_AUTO_REFILL 不跳过（仅仓库/弹药堆无限）。
            if mag <= 0:
                return None
            player.inventories.hands.update_slot(index, {"mag": mag - 1})
            return stack["itemId"]
        return None

    def _inv_transfer(
        self, room: LiminalRoom, player: LiminalPlayer, payload: Dict[str, Any]
    ) -> bool:
        """整格/部分数量从 from 移到 to；可选 rot（0/90）覆盖移动堆叠朝向。"""
        src_ref = payload.get("from")
        dst_ref = payload.get("to")
        src = self._resolve_bag(room, player, src_ref)
        dst = self._resolve_bag(room, player, dst_ref)
        if src is None or dst is None or not isinstance(src_ref, dict) or not isinstance(dst_ref, dict):
            return False
        try:
            src_index = int(src_ref.get("index"))
            dst_index = int(dst_ref.get("index"))
        except (TypeError, ValueError):
            return False
        origin = src.origin_index(src_index)
        stack = src.get_slot(origin)
        if not stack:
            return False
        qty = payload.get("qty")
        moving = dict(stack)
        if qty is not None:
            try:
                take = max(1, min(int(qty), int(stack["qty"])))
            except (TypeError, ValueError):
                take = int(stack["qty"])
            if take < int(stack["qty"]):
                src.slots[origin]["qty"] = int(stack["qty"]) - take
                moving = {"itemId": stack["itemId"], "qty": take}
                if stack.get("mag") is not None:
                    moving["mag"] = stack["mag"]
                try:
                    if int(stack.get("rot") or 0) == 90:
                        moving["rot"] = 90
                except (TypeError, ValueError):
                    pass
            else:
                taken = src.take_slot(origin)
                if not taken:
                    return False
                moving = taken
        else:
            taken = src.take_slot(origin)
            if not taken:
                return False
            moving = taken
        # 可选：客户端拖拽中源格足迹冲突时带最终朝向（0 / 90）
        rot_raw = payload.get("rot")
        if rot_raw is not None and isinstance(moving, dict):
            try:
                rot_v = int(rot_raw)
            except (TypeError, ValueError):
                rot_v = None
            if rot_v == 90:
                moving["rot"] = 90
            elif rot_v == 0:
                moving.pop("rot", None)
        leftover = Inv.place_on_slot(dst, dst_index, moving)
        if leftover:
            if not src.place_stack(origin, leftover) and leftover.get("qty"):
                room.inventories.drop_stacks(player.x, FLOOR_Y, [leftover])
                return True
        return self._bag_is_room(src_ref) or self._bag_is_room(dst_ref)

    def _inv_quick_transfer(
        self, room: LiminalRoom, player: LiminalPlayer, payload: Dict[str, Any]
    ) -> bool:
        """Shift 快速转移到目标背包。"""
        src_ref = payload.get("from")
        src = self._resolve_bag(room, player, src_ref)
        to_bag = str(payload.get("toBag") or "").strip()
        pile_id = payload.get("pileId") or (src_ref.get("pileId") if isinstance(src_ref, dict) else None)
        dst = room.inventories.get_bag(
            to_bag, player.inventories, str(pile_id) if pile_id else None
        )
        if src is None or dst is None or not isinstance(src_ref, dict):
            return False
        try:
            src_index = int(src_ref.get("index"))
        except (TypeError, ValueError):
            return False
        ok = Inv.quick_transfer(src, src_index, dst)
        if not ok:
            return False
        return to_bag in ROOM_BAGS or self._bag_is_room(src_ref)

    def _inv_consume(self, player: LiminalPlayer, payload: Dict[str, Any]) -> None:
        """从个人库存扣除物品。"""
        item_id = str(payload.get("itemId") or "").strip()
        if not item_id:
            return
        try:
            qty = max(1, int(payload.get("qty") or 1))
        except (TypeError, ValueError):
            qty = 1
        Inv.consume_from_personal(player.inventories, item_id, qty)

    def _inv_reload(
        self, room: LiminalRoom, player: LiminalPlayer, payload: Dict[str, Any]
    ) -> bool:
        """装填：拖放 ammo→weapon 指定格，或 R 键手持武器从个人备弹补匣。"""
        weapon_ref = payload.get("weapon")
        ammo_ref = payload.get("ammo")
        if weapon_ref is not None and ammo_ref is not None:
            return self._inv_reload_onto(room, player, weapon_ref, ammo_ref)

        hand_index = payload.get("handIndex")
        indices: List[int]
        if hand_index is None:
            indices = [1, 0]
        else:
            try:
                indices = [int(hand_index)]
            except (TypeError, ValueError):
                indices = [1, 0]
        for index in indices:
            stack = player.inventories.hands.get_slot(index)
            if not stack:
                continue
            item = Inv.ITEMS.get(stack["itemId"]) or {}
            mag_size = item.get("magazineSize")
            ammo_id = item.get("ammoId")
            if not mag_size or not ammo_id:
                continue
            need = int(mag_size) - int(stack.get("mag") or 0)
            if need <= 0:
                return False
            removed = Inv.consume_from_personal(player.inventories, str(ammo_id), need)
            if removed <= 0:
                return False
            player.inventories.hands.update_slot(
                index, {"mag": int(stack.get("mag") or 0) + removed}
            )
            return False
        return False

    def _inv_reload_onto(
        self,
        room: LiminalRoom,
        player: LiminalPlayer,
        weapon_ref: Any,
        ammo_ref: Any,
    ) -> bool:
        """把指定弹药堆装进指定武器格；不匹配则拒绝（弹药留在原格）。"""
        weapon_inv = self._resolve_bag(room, player, weapon_ref)
        ammo_inv = self._resolve_bag(room, player, ammo_ref)
        if (
            weapon_inv is None
            or ammo_inv is None
            or not isinstance(weapon_ref, dict)
            or not isinstance(ammo_ref, dict)
        ):
            return False
        try:
            weapon_index = int(weapon_ref.get("index"))
            ammo_index = int(ammo_ref.get("index"))
        except (TypeError, ValueError):
            return False
        ammo_origin = ammo_inv.origin_index(ammo_index)
        ammo_stack = ammo_inv.get_slot(ammo_origin)
        weapon_origin = weapon_inv.origin_index(weapon_index)
        weapon_stack = weapon_inv.get_slot(weapon_origin)
        if not Inv.is_ammo_onto_weapon_intent(ammo_stack, weapon_stack):
            return False
        if not ammo_stack:
            return False
        if not Inv.weapon_accepts_ammo(str(weapon_stack["itemId"]), str(ammo_stack["itemId"])):
            return False
        taken = ammo_inv.take_slot(ammo_origin)
        if not taken:
            return False
        ok, _loaded, leftover = Inv.try_load_ammo_onto_weapon(
            weapon_inv, weapon_origin, taken
        )
        if not ok:
            ammo_inv.place_stack(ammo_origin, taken)
            return False
        if leftover:
            ammo_inv.place_stack(ammo_origin, leftover)
        return self._bag_is_room(weapon_ref) or self._bag_is_room(ammo_ref)

    def _inv_rotate(
        self, room: LiminalRoom, player: LiminalPlayer, payload: Dict[str, Any]
    ) -> bool:
        """切换目标格堆叠朝向（0↔90）；足迹冲突时拒绝。"""
        bag_ref = payload.get("bag") or payload.get("from")
        inv = self._resolve_bag(room, player, bag_ref)
        if inv is None or not isinstance(bag_ref, dict):
            return False
        try:
            index = int(bag_ref.get("index"))
        except (TypeError, ValueError):
            return False
        origin = inv.origin_index(index)
        if not inv.toggle_rotation(origin):
            return False
        return self._bag_is_room(bag_ref)

    def _inv_sort(
        self, room: LiminalRoom, player: LiminalPlayer, payload: Dict[str, Any]
    ) -> bool:
        """整理 player / storage / storage_facility 网格：合并可叠加堆并左上紧凑重排。"""
        bag_ref = payload.get("bag") or payload.get("from")
        if not isinstance(bag_ref, dict):
            return False
        name = str(bag_ref.get("bag") or bag_ref.get("inv") or "").strip()
        if name not in ("player", "storage", "storage_facility", "platform_storage"):
            return False
        inv = self._resolve_bag(room, player, bag_ref)
        if inv is None:
            return False
        if not Inv.sort_inventory(inv):
            return False
        return name in ROOM_BAGS

    def _inv_set_ammo(
        self, room: LiminalRoom, player: LiminalPlayer, payload: Dict[str, Any]
    ) -> None:
        """设置个人袋中带 maxAmmo 的堆叠弹药（如灭火器）；钳制到图鉴上限。"""
        bag_ref = payload.get("bag")
        inv = self._resolve_bag(room, player, bag_ref)
        if inv is None or not isinstance(bag_ref, dict):
            return
        name = str(bag_ref.get("bag") or bag_ref.get("inv") or "").strip()
        if name not in ("player", "hands", "equip"):
            return
        try:
            index = int(bag_ref.get("index"))
            ammo = float(payload.get("ammo"))
        except (TypeError, ValueError):
            return
        if not math.isfinite(ammo):
            return
        origin = inv.origin_index(index)
        stack = inv.get_slot(origin)
        if not stack:
            return
        item = Inv.ITEMS.get(stack["itemId"]) or {}
        max_ammo = item.get("maxAmmo")
        if max_ammo is None:
            return
        clamped = max(0.0, min(float(max_ammo), ammo))
        inv.update_slot(origin, {"ammo": clamped})

    def _inv_crate(
        self, room: LiminalRoom, player: LiminalPlayer, payload: Dict[str, Any]
    ) -> bool:
        """弹药箱/回收箱存取。"""
        crate = str(payload.get("crate") or "ammo").strip()
        direction = str(payload.get("dir") or payload.get("direction") or "").strip()
        try:
            qty = max(1, int(payload.get("qty") or 1))
        except (TypeError, ValueError):
            qty = 1
        if crate not in ("ammo", "recycle"):
            return False
        item_id = "turret_ammo" if crate == "ammo" else "shell_casing"
        bag = room.inventories.crates[crate]
        if direction == "deposit":
            taken = Inv.consume_from_personal(player.inventories, item_id, qty)
            if taken <= 0:
                return False
            leftover = bag.add_item(item_id, taken)
            if leftover > 0:
                player.inventories.player.add_item(item_id, leftover)
            return True
        if direction == "withdraw":
            removed = bag.remove_item(item_id, qty)
            if removed <= 0:
                return False
            leftover = player.inventories.player.add_item(item_id, removed)
            if leftover > 0:
                bag.add_item(item_id, leftover)
            return True
        return False

    def _inv_drop(
        self, room: LiminalRoom, player: LiminalPlayer, payload: Dict[str, Any]
    ) -> bool:
        """从个人/其它背包丢到地面。"""
        src_ref = payload.get("from")
        src = self._resolve_bag(room, player, src_ref)
        if src is None or not isinstance(src_ref, dict):
            return False
        try:
            src_index = int(src_ref.get("index"))
        except (TypeError, ValueError):
            return False
        origin = src.origin_index(src_index)
        stack = src.get_slot(origin)
        if not stack:
            return False
        qty = payload.get("qty")
        if qty is not None:
            try:
                take = max(1, min(int(qty), int(stack["qty"])))
            except (TypeError, ValueError):
                take = int(stack["qty"])
            if take < int(stack["qty"]):
                src.slots[origin]["qty"] = int(stack["qty"]) - take
                dropped = {"itemId": stack["itemId"], "qty": take}
                if stack.get("mag") is not None:
                    dropped["mag"] = stack["mag"]
                try:
                    if int(stack.get("rot") or 0) == 90:
                        dropped["rot"] = 90
                except (TypeError, ValueError):
                    pass
            else:
                taken = src.take_slot(origin)
                if not taken:
                    return False
                dropped = taken
        else:
            taken = src.take_slot(origin)
            if not taken:
                return False
            dropped = taken
        try:
            x = float(payload.get("x", player.x))
            y = float(payload.get("y", FLOOR_Y))
        except (TypeError, ValueError):
            x, y = player.x, FLOOR_Y
        room.inventories.drop_stacks(x, y, [dropped])
        return True

    def _room_player(
        self, user_id: str
    ) -> Tuple[Optional[LiminalRoom], Optional[LiminalPlayer]]:
        room_id = self.player_rooms.get(user_id)
        if room_id is None:
            return None, None
        room = self.rooms.get(room_id)
        if room is None:
            return None, None
        return room, room.players.get(user_id)

    async def handle_disconnect(self, connection: PlayerConnection) -> None:
        room_id = self.player_rooms.get(connection.user_id)
        if room_id is None:
            await connection.close()
            return
        room = self.rooms.get(room_id)
        if room is None:
            await connection.close()
            return
        player = room.players.get(connection.user_id)
        if player is None:
            await connection.close()
            return
        if player.connection.websocket is not connection.websocket:
            return
        player.connected = False
        player.turret_id = None
        token = uuid.uuid4().hex
        player.disconnect_token = token
        await room.broadcast(
            {
                "type": "player_leave",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "playerId": connection.user_id,
                "temporary": True,
                "playerCount": room.connected_count(),
            }
        )
        asyncio.create_task(self._remove_after_grace(room.room_id, connection.user_id, token))

    async def _remove_after_grace(self, room_id: str, user_id: str, token: str) -> None:
        await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
        room = self.rooms.get(room_id)
        if room is None:
            return
        player = room.players.get(user_id)
        if player is None or player.disconnect_token != token or player.connected:
            return
        await self._remove_player(room, user_id, announce=True)

    async def evict_player_for_other_game(self, user_id: str) -> None:
        room_id = self.player_rooms.get(user_id)
        room = self.rooms.get(room_id) if room_id else None
        player = room.players.get(user_id) if room is not None else None
        if room is None or player is None:
            self.player_rooms.pop(user_id, None)
            return
        try:
            await player.connection.websocket.send_json(
                {"type": "room_removed", "reason": "joined_other_game"}
            )
        except Exception:
            pass
        await self._remove_player(room, user_id, announce=True, close_code=4004)

    async def _remove_player(
        self,
        room: LiminalRoom,
        user_id: str,
        announce: bool = False,
        close_code: int = 1000,
    ) -> None:
        player = room.players.pop(user_id, None)
        if player is not None:
            await player.connection.close(code=close_code)
        if self.player_rooms.get(user_id) == room.room_id:
            self.player_rooms.pop(user_id, None)
        if announce:
            await room.broadcast(
                {
                    "type": "player_leave",
                    "protocolVersion": PROTOCOL_VERSION,
                    "roomId": room.room_id,
                    "playerId": user_id,
                    "temporary": False,
                    "playerCount": room.connected_count(),
                }
            )
        if not room.is_public and room.is_empty():
            await room.stop()
            self.rooms.pop(room.room_id, None)


lobby_manager = LiminalLobbyManager()


def get_reconnect_session(user_id: str) -> Optional[Dict[str, str]]:
    room_id = lobby_manager.player_rooms.get(user_id)
    if not room_id or room_id == PUBLIC_ROOM_ID:
        return None
    room = lobby_manager.rooms.get(room_id)
    if not room or user_id not in room.players:
        return None
    return {
        "game_id": GAME_ID,
        "room_id": room_id,
        "url": "/liminal-platform?room=" + quote(room_id, safe=""),
    }


register_game(
    GAME_ID,
    get_player_room=lobby_manager.player_rooms.get,
    evict_player=lobby_manager.evict_player_for_other_game,
    get_reconnect_session=get_reconnect_session,
)
