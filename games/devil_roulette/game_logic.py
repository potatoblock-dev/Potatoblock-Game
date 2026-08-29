"""恶魔轮盘赌权威对局逻辑（纯 Python，可单测）。"""

from __future__ import annotations

import random
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional, Sequence, Tuple

from app.games.devil_roulette.protocol import (
    ITEM_IDS,
    ITEMS_PER_ROUND,
    MAX_PLAYERS,
    MIN_PLAYERS,
    STARTING_HP,
)

BulletType = Literal["live", "blank"]
Phase = Literal["lobby", "playing", "game_over"]


@dataclass
class ActiveEffects:
    """玩家已激活、待下次开火结算的道具效果。"""

    auto: bool = False
    split: bool = False
    accelerater: bool = False
    extra_shots: int = 0


@dataclass
class PlayerState:
    """单个玩家的对局状态。"""

    player_id: str
    name: str
    hp: int = STARTING_HP
    alive: bool = True
    inventory: List[str] = field(default_factory=list)
    used_items: List[str] = field(default_factory=list)
    effects: ActiveEffects = field(default_factory=ActiveEffects)

    def reset_for_new_round(self, new_items: Sequence[str]) -> None:
        """新装填轮次：刷新道具栏并重置已用/效果。"""
        self.inventory = list(new_items)
        self.used_items = []
        self.effects = ActiveEffects()


@dataclass
class ShotResult:
    """单次开火结算结果。"""

    shooter_id: str
    target_id: str
    bullet: BulletType
    base_damage: int
    total_damage: int
    aoe_damage: Dict[str, int]
    keep_turn: bool
    effects_applied: List[str]
    animation: str
    eliminated: List[str]


@dataclass
class GameActionResult:
    """一次玩家动作（用道具或开火）的聚合结果。"""

    ok: bool
    error: str = ""
    shots: List[ShotResult] = field(default_factory=list)
    reloaded: bool = False
    game_over: bool = False
    winners: List[str] = field(default_factory=list)
    turn_player_id: str = ""


class DevilRouletteGame:
    """服务端权威对局状态机。"""

    def __init__(self, rng: Optional[random.Random] = None) -> None:
        self._rng = rng or random.Random()
        self.phase: Phase = "lobby"
        self.player_order: List[str] = []
        self.players: Dict[str, PlayerState] = {}
        self.current_turn_idx: int = 0
        self.chamber: List[BulletType] = []
        self.round_number: int = 0

    def can_start(self) -> bool:
        """是否满足开局人数。"""
        return MIN_PLAYERS <= len(self.players) <= MAX_PLAYERS

    def start_game(self) -> Tuple[bool, str]:
        """从大厅进入对局：初始化玩家顺序与首轮装填。"""
        if not self.can_start():
            return False, f"需要 {MIN_PLAYERS}–{MAX_PLAYERS} 名玩家"
        self.phase = "playing"
        self.player_order = list(self.players.keys())
        self._rng.shuffle(self.player_order)
        self.current_turn_idx = 0
        self.round_number = 1
        for player in self.players.values():
            player.hp = STARTING_HP
            player.alive = True
            player.used_items = []
            player.effects = ActiveEffects()
        self._reload_chamber()
        self._deal_items()
        return True, ""

    def _alive_players(self) -> List[str]:
        """返回仍存活的玩家 id 列表（按 player_order 顺序）。"""
        return [pid for pid in self.player_order if self.players[pid].alive]

    def _current_player_id(self) -> str:
        """返回当前回合玩家 id。"""
        alive = self._alive_players()
        if not alive:
            return ""
        idx = self.current_turn_idx % len(alive)
        return alive[idx]

    def _chamber_counts(self) -> Tuple[int, int]:
        """返回 chamber 中剩余实弹/空弹数量。"""
        live = sum(1 for b in self.chamber if b == "live")
        return live, len(self.chamber) - live

    def _reload_chamber(self) -> None:
        """随机装填新 chamber 并洗牌。"""
        total = self._rng.randint(2, 8)
        live = self._rng.randint(1, total - 1)
        blank = total - live
        self.chamber = ["live"] * live + ["blank"] * blank
        self._rng.shuffle(self.chamber)

    def _deal_items(self) -> None:
        """为每位存活玩家发放随机道具。"""
        for pid in self._alive_players():
            items = [self._rng.choice(ITEM_IDS) for _ in range(ITEMS_PER_ROUND)]
            self.players[pid].reset_for_new_round(items)

    def peek_next_bullet(self) -> Optional[BulletType]:
        """查看 chamber 下一发（不移除）。"""
        if not self.chamber:
            return None
        return self.chamber[0]

    def use_item(self, player_id: str, item_id: str) -> Tuple[bool, str, Optional[BulletType]]:
        """使用道具；检测器立即返回下一发弹种。"""
        if self.phase != "playing":
            return False, "对局未开始", None
        if player_id != self._current_player_id():
            return False, "还没轮到你", None
        player = self.players.get(player_id)
        if not player or not player.alive:
            return False, "玩家无效", None
        if item_id not in ITEM_IDS:
            return False, "未知道具", None
        if item_id not in player.inventory:
            return False, "你没有该道具", None
        if item_id in player.used_items:
            return False, "该道具本轮已使用", None

        player.used_items.append(item_id)
        player.inventory.remove(item_id)

        if item_id == "detector":
            bullet = self.peek_next_bullet()
            if bullet is None:
                return False, "弹仓已空", None
            return True, "", bullet

        if item_id == "auto":
            player.effects.auto = True
        elif item_id == "split":
            player.effects.split = True
        elif item_id == "accelerater":
            player.effects.accelerater = True
        return True, "", None

    def shoot(self, player_id: str, target_id: str) -> GameActionResult:
        """执行一次或多次开火（含 auto / split 额外射击）。"""
        result = GameActionResult(ok=False)
        if self.phase != "playing":
            result.error = "对局未开始"
            return result
        if player_id != self._current_player_id():
            result.error = "还没轮到你"
            return result
        shooter = self.players.get(player_id)
        if not shooter or not shooter.alive:
            result.error = "玩家无效"
            return result
        if target_id not in self.players or not self.players[target_id].alive:
            result.error = "目标无效"
            return result
        if target_id != player_id:
            alive_others = [p for p in self._alive_players() if p != player_id]
            if target_id not in alive_others:
                result.error = "不能射该目标"
                return result

        shots: List[ShotResult] = []
        keep_turn = False
        fire_auto = shooter.effects.auto
        if fire_auto:
            shooter.effects.auto = False

        while True:
            if not self.chamber:
                self._reload_chamber()
                self._deal_items()
                result.reloaded = True

            shot = self._fire_once(player_id, target_id)
            shots.append(shot)
            keep_turn = shot.keep_turn

            if fire_auto and self.chamber:
                fire_auto = False
                auto_shot = self._fire_once(player_id, target_id)
                shots.append(auto_shot)
                keep_turn = auto_shot.keep_turn

            if shooter.effects.extra_shots > 0 and self.chamber:
                shooter.effects.extra_shots -= 1
                continue

            break

        result.ok = True
        result.shots = shots

        winners = self._check_game_over()
        if winners is not None:
            result.game_over = True
            result.winners = winners
            self.phase = "game_over"
            result.turn_player_id = ""
            return result

        if not keep_turn:
            self._advance_turn()

        result.turn_player_id = self._current_player_id()
        return result

    def _fire_once(self, shooter_id: str, target_id: str) -> ShotResult:
        """从 chamber 取出一发并结算伤害与换手。"""
        shooter = self.players[shooter_id]
        bullet = self.chamber.pop(0)
        is_live = bullet == "live"
        is_self = target_id == shooter_id
        effects_applied: List[str] = []
        aoe_damage: Dict[str, int] = {}
        base_damage = 1 if is_live else 0
        total_damage = base_damage
        keep_turn = False
        animation = "fire" if is_live else "blank_smoke"
        eliminated: List[str] = []

        if is_live and shooter.effects.accelerater:
            total_damage += 1
            effects_applied.append("accelerater")
            shooter.effects.accelerater = False

        if is_live and shooter.effects.split and not is_self:
            effects_applied.append("split")
            dmg = total_damage
            for pid in self._alive_players():
                if pid == shooter_id:
                    continue
                self._apply_damage(pid, dmg)
                aoe_damage[pid] = dmg
                if not self.players[pid].alive:
                    eliminated.append(pid)
            shooter.effects.split = False
            keep_turn = False
        elif is_self and shooter.effects.split:
            effects_applied.append("split")
            if is_live:
                total_damage += 1
                self._apply_damage(target_id, total_damage)
                if not self.players[target_id].alive:
                    eliminated.append(target_id)
                keep_turn = False
            else:
                shooter.effects.extra_shots += 2
                keep_turn = True
            shooter.effects.split = False
        elif is_live:
            self._apply_damage(target_id, total_damage)
            if not self.players[target_id].alive:
                eliminated.append(target_id)
            keep_turn = False
        else:
            keep_turn = is_self

        return ShotResult(
            shooter_id=shooter_id,
            target_id=target_id,
            bullet=bullet,
            base_damage=base_damage,
            total_damage=total_damage,
            aoe_damage=aoe_damage,
            keep_turn=keep_turn,
            effects_applied=effects_applied,
            animation=animation,
            eliminated=eliminated,
        )

    def _apply_damage(self, player_id: str, damage: int) -> None:
        """对玩家扣血并在 HP 归零时标记出局。"""
        player = self.players[player_id]
        player.hp = max(0, player.hp - damage)
        if player.hp <= 0:
            player.alive = False

    def _advance_turn(self) -> None:
        """推进到下一存活玩家。"""
        alive = self._alive_players()
        if not alive:
            return
        current = self._current_player_id()
        if current in alive:
            idx = alive.index(current)
            self.current_turn_idx = (idx + 1) % len(alive)
        else:
            self.current_turn_idx = 0

    def _check_game_over(self) -> Optional[List[str]]:
        """若仅剩一名存活者则返回胜者列表。"""
        alive = self._alive_players()
        if len(alive) <= 1:
            return alive
        return None

    def get_public_state(self, for_player_id: str) -> Dict:
        """序列化对局公开状态；道具栏仅对本人可见。"""
        live, blank = self._chamber_counts()
        players_out = []
        for pid in self.player_order:
            p = self.players[pid]
            entry = {
                "uid": pid,
                "name": p.name,
                "hp": p.hp,
                "alive": p.alive,
            }
            if pid == for_player_id:
                entry["inventory"] = list(p.inventory)
                entry["used_items"] = list(p.used_items)
                entry["effects"] = {
                    "auto": p.effects.auto,
                    "split": p.effects.split,
                    "accelerater": p.effects.accelerater,
                    "extra_shots": p.effects.extra_shots,
                }
            players_out.append(entry)

        return {
            "phase": self.phase,
            "round_number": self.round_number,
            "current_turn": self._current_player_id(),
            "chamber_live": live,
            "chamber_blank": blank,
            "chamber_total": live + blank,
            "players": players_out,
            "player_order": list(self.player_order),
        }

    def clone(self) -> DevilRouletteGame:
        """深拷贝对局（测试用）。"""
        return deepcopy(self)
