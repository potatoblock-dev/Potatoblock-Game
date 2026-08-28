"""阈限月台服务端物品栏权威：网格、堆叠、共享仓库/地面/弹药箱。

与客户端 lp-inventory-core.js 的 JSON 形状对齐（id/cols/rows/slots/mag）。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple

# TEST_ONLY — remove after playtest：燃料/弹药堆与仓储种子物资自动补满；炮塔箱同。
# 不含手持武器弹匣（开火必须扣弹）。正式上线前改为 False。
TEST_AUTO_REFILL_CONSUMABLES = True
CONSUMABLE_TYPES = frozenset({"fuel", "ammo"})

# 与 create_default_storage 对齐；无限仓储按此种子补到图鉴 maxStack（或缺省 qty）。
STORAGE_BAG_ID = "storage"
# 设施专用仓库（可摆放 facility_*）；与物资仓并列，房间共享。
FACILITY_STORAGE_BAG_ID = "storage_facility"
# 小型月台地牢仓库房本地仓（与列车 storage 分离）。
PLATFORM_STORAGE_BAG_ID = "platform_storage"
# 仓储可叠加物叠加上限；背包/手部仍用物品 maxStack（与 LpItemCatalog.maxStackIn 对齐）。
STORAGE_MAX_STACK = 9999
STORAGE_BAG_IDS = frozenset(
    {STORAGE_BAG_ID, FACILITY_STORAGE_BAG_ID, PLATFORM_STORAGE_BAG_ID}
)

STORAGE_SEED: List[Tuple[int, Dict[str, Any]]] = [
    (0, {"itemId": "coal", "qty": 100}),
    (1, {"itemId": "lumber", "qty": 64}),
    (2, {"itemId": "iron_ingot", "qty": 40}),
    (3, {"itemId": "scrap", "qty": 20}),
    (4, {"itemId": "turret_ammo", "qty": 80}),
    (5, {"itemId": "small_caliber_ammo", "qty": 90}),
    (6, {"itemId": "medkit", "qty": 1, "dur": 40}),
    (8, {"itemId": "first_aid_kit", "qty": 1}),
    (16, {"itemId": "gur65", "qty": 1, "mag": 27}),
    (19, {"itemId": "hummingbird_drone", "qty": 1, "mag": 120}),
    (24, {"itemId": "fire_extinguisher", "qty": 1, "ammo": 100}),
]

# 设施仓库开局种子（与客户端 FACILITY_STORAGE_SEED 对齐）。
FACILITY_STORAGE_SEED: List[Tuple[int, Dict[str, Any]]] = [
    (0, {"itemId": "facility_crate", "qty": 8}),
    (1, {"itemId": "facility_workbench", "qty": 2}),
    (3, {"itemId": "facility_shelf", "qty": 4}),
    (5, {"itemId": "facility_locker", "qty": 3}),
    (8, {"itemId": "facility_fire_extinguisher_station", "qty": 2}),
]

# 与 lp-item-catalog.js 关键字段对齐（校验用）
ITEMS: Dict[str, Dict[str, Any]] = {
    "coal": {"maxStack": 100, "w": 1, "h": 1, "type": "fuel", "boilerFuel": 18, "canHold": True},
    "lumber": {"maxStack": 100, "w": 1, "h": 1, "type": "material", "canHold": True},
    "iron_ingot": {"maxStack": 50, "w": 1, "h": 1, "type": "metal", "canHold": True},
    "scrap": {"maxStack": 50, "w": 1, "h": 1, "type": "material", "canHold": True},
    "wrench": {"maxStack": 1, "w": 2, "h": 1, "type": "tool", "canHold": True},
    "turret_ammo": {"maxStack": 100, "w": 1, "h": 2, "type": "ammo", "canHold": True},
    "shell_casing": {"maxStack": 100, "w": 1, "h": 2, "type": "material", "canHold": True},
    "small_caliber_ammo": {"maxStack": 240, "w": 1, "h": 1, "type": "ammo", "canHold": True},
    "gur65": {
        "maxStack": 1,
        "w": 3,
        "h": 2,
        "type": "weapon",
        "magazineSize": 27,
        "ammoId": "small_caliber_ammo",
        "canHold": True,
        "weaponId": "gur65",
    },
    "hummingbird_drone": {
        "maxStack": 1,
        "w": 3,
        "h": 2,
        "type": "weapon",
        "magazineSize": 120,
        "ammoId": "small_caliber_ammo",
        "canHold": True,
        "weaponId": "hummingbird_drone",
        "weaponClass": "companion_drone",
        "companion": True,
    },
    "work_cap": {"maxStack": 1, "w": 1, "h": 1, "type": "apparel", "equip": "head", "canHold": True},
    "work_vest": {"maxStack": 1, "w": 2, "h": 2, "type": "apparel", "equip": "chest", "canHold": False},
    "work_pants": {"maxStack": 1, "w": 2, "h": 2, "type": "apparel", "equip": "legs", "canHold": False},
    "signal_lamp": {
        "maxStack": 1,
        "w": 1,
        "h": 1,
        "type": "accessory",
        "equip": "accessory",
        "canHold": True,
    },
    "work_satchel": {
        "maxStack": 1,
        "w": 2,
        "h": 2,
        "type": "apparel",
        "equip": "backpack",
        "bagCols": 6,
        "bagRows": 4,
        "canHold": False,
    },
    "medkit": {
        "maxStack": 1,
        "w": 1,
        "h": 2,
        "type": "medical",
        "canHold": True,
        "maxDurability": 40,
        "selfHealPerSec": 12,
        "allyHealPerSec": 28,
        "durCostPerSec": 8,
        "allyRange": 150,
        "handSlot": 2,
        "canHeal": True,
        "canRevive": False,
    },
    "first_aid_kit": {
        "maxStack": 3,
        "w": 2,
        "h": 2,
        "type": "medical",
        "canHold": True,
        "allyRange": 150,
        "handSlot": 2,
        "canHeal": False,
        "canRevive": True,
    },
    "facility_crate": {
        "maxStack": 20,
        "w": 1,
        "h": 1,
        "type": "facility",
        "placeable": True,
        "canHold": False,
    },
    "facility_workbench": {
        "maxStack": 10,
        "w": 2,
        "h": 1,
        "type": "facility",
        "placeable": True,
        "canHold": False,
    },
    "facility_shelf": {
        "maxStack": 10,
        "w": 1,
        "h": 2,
        "type": "facility",
        "placeable": True,
        "canHold": False,
    },
    "facility_locker": {
        "maxStack": 10,
        "w": 1,
        "h": 2,
        "type": "facility",
        "placeable": True,
        "canHold": False,
    },
    "fire_extinguisher": {
        "maxStack": 1,
        "w": 1,
        "h": 2,
        "type": "tool",
        "canHold": True,
        "canHoldAnyHandSlot": True,
        "maxAmmo": 100,
        "sprayDurationSec": 15,
    },
    "facility_fire_extinguisher_station": {
        "maxStack": 8,
        "w": 2,
        "h": 3,
        "type": "facility",
        "placeable": True,
        "canHold": False,
    },
}

EQUIP_SLOT_KEYS = ["head", "chest", "legs", "accessory", "accessory", "backpack"]
PLAYER_BASE = (4, 2)
HANDS_UTILITY = 2  # 手部 3 号槽（0-based）；医疗箱等工具类
HANDS_WEAPON_SLOTS = (0, 1)
PLAYER_MAX_HP = 100
MEDKIT_ID = "medkit"
FIRST_AID_KIT_ID = "first_aid_kit"


def max_stack_in(bag_id: Optional[str], item: Optional[Dict[str, Any]]) -> int:
    """按库存返回叠加上限：物资/设施仓储对可叠加物用 STORAGE_MAX_STACK，其它用图鉴 maxStack。"""
    base = max(1, int((item or {}).get("maxStack") or 1))
    if base <= 1:
        return base
    if bag_id in STORAGE_BAG_IDS:
        return STORAGE_MAX_STACK
    return base


def _is_placeable_facility(item_id: str) -> bool:
    """是否为舱内可摆放设施（type=facility 或 placeable）。"""
    item = ITEMS.get(str(item_id)) or {}
    return bool(item.get("type") == "facility" or item.get("placeable"))


def _is_weapon(item_id: str) -> bool:
    """与客户端 Catalog.isWeapon 对齐：type==weapon 或声明 weaponId。"""
    item = ITEMS.get(item_id) or {}
    return item.get("type") == "weapon" or bool(item.get("weaponId"))


def _stack_rot(stack: Optional[Dict[str, Any]]) -> int:
    """读取堆叠朝向：仅 0 与顺时针 90。"""
    if not stack:
        return 0
    try:
        return 90 if int(stack.get("rot") or 0) == 90 else 0
    except (TypeError, ValueError):
        return 0


def _toggled_rot(rot: int) -> int:
    """在 0° / 90° 之间切换。"""
    return 0 if int(rot) == 90 else 90


def _oriented_size(item_id: str, rot: int = 0) -> Tuple[int, int]:
    """按朝向返回占格宽高（90° 时交换 w/h）。"""
    item = ITEMS.get(item_id) or {}
    w = int(item.get("w", 1))
    h = int(item.get("h", 1))
    if int(rot) == 90:
        return h, w
    return w, h


def _norm_stack(
    stack: Optional[Dict[str, Any]], bag_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """规范化堆叠；bag_id 为 storage 时放宽可叠加上限。"""
    if not stack or not stack.get("itemId") or not stack.get("qty"):
        return None
    if stack.get("occupiedBy") is not None:
        return None
    item = ITEMS.get(str(stack["itemId"]))
    if not item:
        return None
    qty = max(1, min(int(stack["qty"]), max_stack_in(bag_id, item)))
    out: Dict[str, Any] = {"itemId": str(stack["itemId"]), "qty": qty}
    mag_size = item.get("magazineSize")
    if mag_size:
        mag_raw = stack.get("mag", mag_size)
        try:
            mag = int(mag_raw)
        except (TypeError, ValueError):
            mag = int(mag_size)
        out["mag"] = max(0, min(int(mag_size), mag))
    max_dur = item.get("maxDurability")
    if max_dur:
        dur_raw = stack.get("dur", max_dur)
        try:
            dur = int(dur_raw)
        except (TypeError, ValueError):
            dur = int(max_dur)
        out["dur"] = max(0, min(int(max_dur), dur))
    max_ammo = item.get("maxAmmo")
    if max_ammo:
        ammo_raw = stack.get("ammo", max_ammo)
        try:
            ammo = float(ammo_raw)
        except (TypeError, ValueError):
            ammo = float(max_ammo)
        out["ammo"] = max(0.0, min(float(max_ammo), ammo))
    if _stack_rot(stack) == 90:
        out["rot"] = 90
    return out


class Inventory:
    """服务端网格库存。"""

    def __init__(
        self,
        inv_id: str,
        cols: int,
        rows: int,
        *,
        ignore_item_size: bool = False,
        slot_keys: Optional[List[str]] = None,
    ):
        self.id = inv_id
        self.cols = cols
        self.rows = rows
        self.ignore_item_size = ignore_item_size
        self.slot_keys = list(slot_keys) if slot_keys else None
        self.slots: List[Optional[Dict[str, Any]]] = [None] * (cols * rows)

    def size(self) -> int:
        return len(self.slots)

    def size_for(self, item_id: str, rot: int = 0) -> Tuple[int, int]:
        if self.ignore_item_size:
            return 1, 1
        return _oriented_size(item_id, rot)

    def accepts(self, item_id: str, index: Optional[int] = None) -> bool:
        """手部 0/1 仅武器（或 canHoldAnyHandSlot）；快捷槽禁止武器；装备栏按 slot_keys；双仓储分流设施。"""
        item = ITEMS.get(item_id)
        if not item:
            return False
        if self.id == "hands" or self.id.startswith("hands"):
            if not item.get("canHold", True):
                return False
            if item.get("canHoldAnyHandSlot"):
                return True
            is_weapon = _is_weapon(item_id)
            if index is None:
                # 未指定槽：武器可进 0/1，其它可进快捷槽；具体格由 can_place_at 判定。
                return True
            if index == HANDS_UTILITY:
                return not is_weapon
            return is_weapon
        if self.slot_keys:
            if index is None:
                return any(
                    item.get("equip") == key and self.get_slot(i) is None
                    for i, key in enumerate(self.slot_keys)
                )
            if index < 0 or index >= len(self.slot_keys):
                return False
            return item.get("equip") == self.slot_keys[index]
        if self.id == STORAGE_BAG_ID:
            return not _is_placeable_facility(item_id)
        if self.id == FACILITY_STORAGE_BAG_ID:
            return _is_placeable_facility(item_id)
        return True

    def index_at(self, col: int, row: int) -> int:
        if col < 0 or row < 0 or col >= self.cols or row >= self.rows:
            return -1
        return row * self.cols + col

    def coords_of(self, index: int) -> Tuple[int, int]:
        return index % self.cols, index // self.cols

    def footprint(self, origin: int, item_id: str, rot: int = 0) -> Optional[List[int]]:
        w, h = self.size_for(item_id, rot)
        col, row = self.coords_of(origin)
        cells: List[int] = []
        for dy in range(h):
            for dx in range(w):
                idx = self.index_at(col + dx, row + dy)
                if idx < 0:
                    return None
                cells.append(idx)
        return cells

    def origin_index(self, index: int) -> int:
        raw = self.slots[index] if 0 <= index < self.size() else None
        if raw and raw.get("occupiedBy") is not None:
            return int(raw["occupiedBy"])
        return index

    def get_slot(self, index: int) -> Optional[Dict[str, Any]]:
        origin = self.origin_index(index)
        raw = self.slots[origin] if 0 <= origin < self.size() else None
        if not raw or raw.get("occupiedBy") is not None:
            return None
        return dict(raw)

    def is_covered(self, index: int) -> bool:
        raw = self.slots[index] if 0 <= index < self.size() else None
        return bool(raw and raw.get("occupiedBy") is not None)

    def can_place_at(
        self, origin: int, item_id: str, ignore_origin: int = -1, rot: int = 0
    ) -> bool:
        if not self.accepts(item_id, origin):
            return False
        cells = self.footprint(origin, item_id, rot)
        if cells is None:
            return False
        for idx in cells:
            raw = self.slots[idx]
            if not raw:
                continue
            owner = int(raw["occupiedBy"]) if raw.get("occupiedBy") is not None else idx
            if owner == ignore_origin:
                continue
            return False
        return True

    def clear_footprint(self, origin: int) -> None:
        raw = self.slots[origin] if 0 <= origin < self.size() else None
        if not raw or raw.get("occupiedBy") is not None:
            if 0 <= origin < self.size():
                self.slots[origin] = None
            return
        cells = self.footprint(origin, str(raw["itemId"]), _stack_rot(raw)) or [origin]
        for idx in cells:
            self.slots[idx] = None

    def place_stack(self, origin: int, stack: Dict[str, Any], ignore_origin: int = -1) -> bool:
        """在 origin 写入堆叠并标记占位；失败返回 False。"""
        normalized = _norm_stack(stack, self.id)
        if not normalized:
            return False
        if not self.can_place_at(
            origin, normalized["itemId"], ignore_origin, _stack_rot(normalized)
        ):
            return False
        if ignore_origin >= 0:
            self.clear_footprint(ignore_origin)
        else:
            self.clear_footprint(origin)
        cells = self.footprint(
            origin, normalized["itemId"], _stack_rot(normalized)
        ) or [origin]
        self.slots[origin] = normalized
        for idx in cells:
            if idx == origin:
                continue
            self.slots[idx] = {"occupiedBy": origin}
        return True

    def take_slot(self, index: int) -> Optional[Dict[str, Any]]:
        origin = self.origin_index(index)
        stack = self.get_slot(origin)
        if not stack:
            return None
        self.clear_footprint(origin)
        return stack

    def toggle_rotation(self, origin: int) -> bool:
        """切换原点堆叠朝向；新足迹放不下则拒绝。"""
        stack = self.get_slot(origin)
        if not stack or self.origin_index(origin) != origin:
            return False
        next_rot = _toggled_rot(_stack_rot(stack))
        if not self.can_place_at(origin, stack["itemId"], origin, next_rot):
            return False
        next_stack = dict(stack)
        if next_rot == 90:
            next_stack["rot"] = 90
        else:
            next_stack.pop("rot", None)
        self.clear_footprint(origin)
        return self.place_stack(origin, next_stack)

    def find_place_index(self, item_id: str, rot: int = 0) -> int:
        for i in range(self.size()):
            if self.can_place_at(i, item_id, -1, rot):
                return i
        return -1

    def add_item(self, item_id: str, qty: int) -> int:
        """合并同类堆叠，返回剩余数量（仓储可叠加上限见 max_stack_in）。"""
        item = ITEMS.get(item_id)
        if not item or qty <= 0:
            return qty
        if not self.accepts(item_id):
            return qty
        cap = max_stack_in(self.id, item)
        remaining = qty
        for i in range(self.size()):
            if remaining <= 0:
                break
            raw = self.slots[i]
            if not raw or raw.get("occupiedBy") is not None or raw.get("itemId") != item_id:
                continue
            space = cap - int(raw["qty"])
            if space <= 0:
                continue
            moved = min(space, remaining)
            raw["qty"] = int(raw["qty"]) + moved
            remaining -= moved
        while remaining > 0:
            origin = self.find_place_index(item_id)
            if origin < 0:
                break
            moved = min(cap, remaining)
            self.place_stack(origin, {"itemId": item_id, "qty": moved})
            remaining -= moved
        return remaining

    def remove_item(self, item_id: str, qty: int) -> int:
        if qty <= 0:
            return 0
        need = qty
        removed = 0
        for i in range(self.size()):
            if need <= 0:
                break
            raw = self.slots[i]
            if not raw or raw.get("occupiedBy") is not None or raw.get("itemId") != item_id:
                continue
            take = min(int(raw["qty"]), need)
            if take >= int(raw["qty"]):
                self.clear_footprint(i)
            else:
                raw["qty"] = int(raw["qty"]) - take
            need -= take
            removed += take
        return removed

    def count_item(self, item_id: str) -> int:
        total = 0
        for i in range(self.size()):
            raw = self.slots[i]
            if not raw or raw.get("occupiedBy") is not None or raw.get("itemId") != item_id:
                continue
            total += int(raw["qty"])
        return total

    def update_slot(self, index: int, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """就地更新原点堆叠字段（如 mag），并经 _norm_stack 约束。"""
        origin = self.origin_index(index)
        raw = self.slots[origin]
        if not raw or raw.get("occupiedBy") is not None:
            return None
        merged = dict(raw)
        merged.update(patch)
        normalized = _norm_stack(merged, self.id)
        if not normalized:
            return None
        self.slots[origin] = normalized
        return dict(normalized)

    def to_json(self) -> Dict[str, Any]:
        slots: List[Optional[Dict[str, Any]]] = []
        for slot in self.slots:
            if not slot or slot.get("occupiedBy") is not None:
                slots.append(None)
            else:
                out = {"itemId": slot["itemId"], "qty": slot["qty"]}
                if slot.get("mag") is not None:
                    out["mag"] = slot["mag"]
                if slot.get("dur") is not None:
                    out["dur"] = slot["dur"]
                if slot.get("ammo") is not None:
                    out["ammo"] = slot["ammo"]
                if _stack_rot(slot) == 90:
                    out["rot"] = 90
                slots.append(out)
        data: Dict[str, Any] = {
            "id": self.id,
            "cols": self.cols,
            "rows": self.rows,
            "ignoreItemSize": self.ignore_item_size,
            "slots": slots,
        }
        if self.slot_keys:
            data["slotKeys"] = list(self.slot_keys)
        return data

    @classmethod
    def from_json(cls, data: Dict[str, Any], **overrides: Any) -> "Inventory":
        ignore = overrides.get("ignore_item_size", bool(data.get("ignoreItemSize")))
        slot_keys = overrides.get("slot_keys", data.get("slotKeys"))
        inv = cls(
            str(data.get("id") or "inv"),
            int(data.get("cols") or 1),
            int(data.get("rows") or 1),
            ignore_item_size=ignore,
            slot_keys=slot_keys,
        )
        pending = []
        for i, stack in enumerate(data.get("slots") or []):
            normalized = _norm_stack(stack, inv.id)
            if normalized:
                pending.append((i, normalized))
        for index, stack in pending:
            if not inv.place_stack(index, stack):
                inv.add_item(stack["itemId"], stack["qty"])
        return inv


def place_on_slot(inventory: Inventory, index: int, stack: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """放入槽位，返回剩余/换出堆叠。

    数量先按仓储绝对上限保留，再按目标库存 max_stack_in 切 leftover，
    避免大仓储堆放入背包时被 _norm_stack 提前截断丢数量。
    """
    probe = _norm_stack({**stack, "qty": 1}, inventory.id)
    if not probe:
        return stack
    item = ITEMS.get(probe["itemId"])
    if not item:
        return stack
    try:
        raw_qty = max(1, int(stack.get("qty") or 0))
    except (TypeError, ValueError):
        return stack
    transit_cap = STORAGE_MAX_STACK if int(item.get("maxStack") or 1) > 1 else 1
    incoming = dict(probe)
    incoming["qty"] = min(raw_qty, transit_cap)
    if stack.get("mag") is not None and "mag" not in incoming:
        incoming["mag"] = stack["mag"]
    if stack.get("dur") is not None and "dur" not in incoming:
        incoming["dur"] = stack["dur"]
    if stack.get("ammo") is not None and "ammo" not in incoming:
        incoming["ammo"] = stack["ammo"]
    if _stack_rot(stack) == 90:
        incoming["rot"] = 90

    origin = inventory.origin_index(index)
    if not inventory.accepts(incoming["itemId"], origin):
        return stack
    current = inventory.get_slot(origin)
    cap = max_stack_in(inventory.id, item)
    if not current:
        place_qty = min(int(incoming["qty"]), cap)
        leftover_qty = int(incoming["qty"]) - place_qty
        placed = dict(incoming)
        placed["qty"] = place_qty
        if not inventory.place_stack(origin, placed):
            return incoming
        if leftover_qty <= 0:
            return None
        left: Dict[str, Any] = {"itemId": incoming["itemId"], "qty": leftover_qty}
        if incoming.get("mag") is not None:
            left["mag"] = incoming["mag"]
        if incoming.get("dur") is not None:
            left["dur"] = incoming["dur"]
        if incoming.get("ammo") is not None:
            left["ammo"] = incoming["ammo"]
        if _stack_rot(incoming) == 90:
            left["rot"] = 90
        return left
    if current["itemId"] == incoming["itemId"]:
        space = cap - int(current["qty"])
        if space <= 0:
            return incoming
        moved = min(space, incoming["qty"])
        inventory.slots[origin]["qty"] = int(current["qty"]) + moved
        leftover = incoming["qty"] - moved
        if leftover <= 0:
            return None
        left = {"itemId": incoming["itemId"], "qty": leftover}
        if incoming.get("mag") is not None:
            left["mag"] = incoming["mag"]
        if incoming.get("dur") is not None:
            left["dur"] = incoming["dur"]
        if incoming.get("ammo") is not None:
            left["ammo"] = incoming["ammo"]
        if _stack_rot(incoming) == 90:
            left["rot"] = 90
        return left
    removed = inventory.take_slot(origin)
    if int(incoming["qty"]) > cap or not inventory.place_stack(origin, incoming):
        if removed:
            inventory.place_stack(origin, removed)
        return incoming
    return removed


def weapon_accepts_ammo(weapon_item_id: str, ammo_item_id: str) -> bool:
    """武器是否接受该弹药：须有 magazineSize，且 ammoId 与弹药 id 一致。"""
    weapon = ITEMS.get(str(weapon_item_id) or "") or {}
    ammo_id = str(ammo_item_id or "").strip()
    if not weapon or not ammo_id:
        return False
    if weapon.get("type") != "weapon" and not weapon.get("weaponId"):
        return False
    mag_size = weapon.get("magazineSize")
    accepts = weapon.get("ammoId")
    if mag_size is None or not accepts:
        return False
    return str(accepts) == ammo_id


def is_ammo_onto_weapon_intent(
    ammo_stack: Optional[Dict[str, Any]], weapon_stack: Optional[Dict[str, Any]]
) -> bool:
    """弹药堆拖到带弹匣武器上时视为装填意图（兼容与否另判）。"""
    if not ammo_stack or not weapon_stack:
        return False
    ammo_item = ITEMS.get(str(ammo_stack.get("itemId") or "")) or {}
    weapon_item = ITEMS.get(str(weapon_stack.get("itemId") or "")) or {}
    if ammo_item.get("type") != "ammo":
        return False
    if weapon_item.get("magazineSize") is None:
        return False
    return weapon_item.get("type") == "weapon" or bool(weapon_item.get("weaponId"))


def try_load_ammo_onto_weapon(
    weapon_inv: Inventory, weapon_index: int, ammo_stack: Dict[str, Any]
) -> Tuple[bool, int, Optional[Dict[str, Any]]]:
    """用弹药堆装填武器格弹匣。

    返回 (ok, loaded, leftover)：
    - ok=False：不匹配，leftover 为原弹药堆（调用方原位放回）
    - ok=True：已写入 mag；leftover 为剩余弹药（None=用尽）
    """
    incoming = _norm_stack(ammo_stack)
    if not incoming:
        return False, 0, ammo_stack
    origin = weapon_inv.origin_index(weapon_index)
    weapon_stack = weapon_inv.get_slot(origin)
    if not is_ammo_onto_weapon_intent(incoming, weapon_stack):
        return False, 0, incoming
    assert weapon_stack is not None
    if not weapon_accepts_ammo(str(weapon_stack["itemId"]), str(incoming["itemId"])):
        return False, 0, incoming
    weapon_item = ITEMS.get(str(weapon_stack["itemId"])) or {}
    mag_size = int(weapon_item.get("magazineSize") or 0)
    need = mag_size - int(weapon_stack.get("mag") or 0)
    if need <= 0:
        return True, 0, incoming
    take = min(need, int(incoming["qty"]))
    if take <= 0:
        return True, 0, incoming
    weapon_inv.update_slot(origin, {"mag": int(weapon_stack.get("mag") or 0) + take})
    left_qty = int(incoming["qty"]) - take
    if left_qty <= 0:
        return True, take, None
    return True, take, {"itemId": incoming["itemId"], "qty": left_qty}


def quick_transfer(source: Inventory, source_index: int, target: Inventory) -> bool:
    """整堆快速转移到目标栏；手部/装备已满时与可接受槽互换并把被换物放回源格。"""
    origin = source.origin_index(source_index)
    stack = source.get_slot(origin)
    if not stack or not target.accepts(stack["itemId"]):
        return False
    item = ITEMS.get(stack["itemId"]) or {}
    if item.get("type") == "weapon" or stack.get("mag") is not None or _stack_rot(stack) == 90:
        dest = target.find_place_index(stack["itemId"], _stack_rot(stack))
        if dest < 0 and target.id in ("hands", "equip"):
            for i in range(target.size()):
                if target.is_covered(i):
                    continue
                if not target.accepts(stack["itemId"], i):
                    continue
                existing = target.get_slot(i)
                if not existing:
                    dest = i
                    break
                if existing["itemId"] == stack["itemId"]:
                    continue
                displaced = place_on_slot(target, i, dict(stack))
                if not displaced or displaced.get("itemId") == stack["itemId"]:
                    continue
                source.take_slot(origin)
                if source.place_stack(origin, displaced):
                    return True
                bag_dest = source.find_place_index(
                    str(displaced["itemId"]), _stack_rot(displaced)
                )
                if bag_dest >= 0 and source.place_stack(bag_dest, displaced):
                    return True
                undo = place_on_slot(target, i, displaced)
                if undo:
                    source.place_stack(origin, undo)
                else:
                    source.place_stack(origin, stack)
                return False
        if dest < 0:
            return False
        if not target.place_stack(dest, stack):
            return False
        source.take_slot(origin)
        return True
    leftover = target.add_item(stack["itemId"], stack["qty"])
    if leftover >= stack["qty"]:
        return False
    if leftover <= 0:
        source.take_slot(origin)
    else:
        source.slots[origin]["qty"] = leftover
    return True


def _clone_stack_fields(stack: Dict[str, Any]) -> Dict[str, Any]:
    """拷贝堆叠字段（qty / mag / dur / ammo / rot），供整理合并使用。"""
    out: Dict[str, Any] = {"itemId": stack["itemId"], "qty": int(stack["qty"])}
    if stack.get("mag") is not None:
        out["mag"] = stack["mag"]
    if stack.get("dur") is not None:
        out["dur"] = stack["dur"]
    if stack.get("ammo") is not None:
        out["ammo"] = stack["ammo"]
    if _stack_rot(stack) == 90:
        out["rot"] = 90
    return out


def _collect_stacks(inventory: Inventory) -> List[Dict[str, Any]]:
    """收集库存中全部逻辑堆叠（保留弹匣）。"""
    list_out: List[Dict[str, Any]] = []
    for i in range(inventory.size()):
        if inventory.is_covered(i):
            continue
        stack = inventory.get_slot(i)
        if stack:
            list_out.append(stack)
    return list_out


def _merge_stacks_for_sort(stacks: List[Dict[str, Any]], bag_id: str) -> List[Dict[str, Any]]:
    """合并可叠加同类堆叠至该库存叠加上限；带 mag 或 cap≤1 的堆保持独立。"""
    merged: List[Dict[str, Any]] = []
    open_by_item: Dict[str, int] = {}
    for raw in stacks:
        stack = _clone_stack_fields(raw)
        item = ITEMS.get(str(stack["itemId"]))
        if not item:
            continue
        cap = max_stack_in(bag_id, item)
        if cap <= 1 or stack.get("mag") is not None or stack.get("dur") is not None or stack.get("ammo") is not None:
            merged.append(stack)
            continue
        remaining = int(stack["qty"])
        while remaining > 0:
            idx = open_by_item.get(str(stack["itemId"]))
            if idx is None:
                next_stack: Dict[str, Any] = {"itemId": stack["itemId"], "qty": 0}
                if _stack_rot(stack) == 90:
                    next_stack["rot"] = 90
                merged.append(next_stack)
                idx = len(merged) - 1
                open_by_item[str(stack["itemId"])] = idx
            target = merged[idx]
            space = cap - int(target["qty"])
            if space <= 0:
                open_by_item.pop(str(stack["itemId"]), None)
                continue
            take = min(space, remaining)
            target["qty"] = int(target["qty"]) + take
            remaining -= take
            if int(target["qty"]) >= cap:
                open_by_item.pop(str(stack["itemId"]), None)
    return [s for s in merged if int(s["qty"]) > 0]


def _sort_key_for_stack(stack: Dict[str, Any]) -> Tuple[Any, ...]:
    """整理放置排序键：占格面积降序 → type → itemId → mag。"""
    item = ITEMS.get(str(stack["itemId"])) or {}
    w, h = _oriented_size(str(stack["itemId"]), _stack_rot(stack))
    mag = int(stack["mag"]) if stack.get("mag") is not None else -1
    return (-(w * h), str(item.get("type") or ""), str(stack["itemId"]), -mag)


def _pick_sort_placement(
    inventory: Inventory, item_id: str, preferred_rot: int
) -> Optional[Tuple[int, int]]:
    """整理放置：在当前朝向与交替朝向中选更靠左上的合法格（正方形足迹不试交替）。

    返回 (dest, rot)；两者同格时保留 preferred_rot；都放不下返回 None。
    """
    prefer = 90 if int(preferred_rot) == 90 else 0
    dest_prefer = inventory.find_place_index(item_id, prefer)
    base_w, base_h = _oriented_size(item_id, 0)
    if base_w == base_h:
        if dest_prefer < 0:
            return None
        return dest_prefer, prefer
    alt = _toggled_rot(prefer)
    dest_alt = inventory.find_place_index(item_id, alt)
    if dest_prefer < 0 and dest_alt < 0:
        return None
    if dest_prefer < 0:
        return dest_alt, alt
    if dest_alt < 0:
        return dest_prefer, prefer
    if dest_alt < dest_prefer:
        return dest_alt, alt
    return dest_prefer, prefer


def sort_inventory(inventory: Inventory) -> bool:
    """自动整理：合并可叠加堆，再按足迹左上紧凑重排（可旋转 0↔90；仅 player/双仓储）。

    放不下时回滚并返回 False。
    """
    if inventory is None or inventory.ignore_item_size or inventory.slot_keys:
        return False
    if inventory.id not in ("player", STORAGE_BAG_ID, FACILITY_STORAGE_BAG_ID):
        return False
    collected = _collect_stacks(inventory)
    if not collected:
        return True
    merged = _merge_stacks_for_sort(collected, inventory.id)
    merged.sort(key=_sort_key_for_stack)
    snapshot = [dict(s) if s else None for s in inventory.slots]
    inventory.slots = [None] * inventory.size()
    for stack in merged:
        picked = _pick_sort_placement(inventory, str(stack["itemId"]), _stack_rot(stack))
        if picked is None:
            inventory.slots = snapshot
            return False
        dest, rot = picked
        place = stack
        if rot != _stack_rot(stack):
            place = _clone_stack_fields(stack)
            if rot == 90:
                place["rot"] = 90
            else:
                place.pop("rot", None)
        if not inventory.place_stack(dest, place):
            inventory.slots = snapshot
            return False
    return True


def create_default_player() -> Inventory:
    """开局背包：与 lp-inventory-core.js PLAYER_SEED 对齐。

    work_satchel 为 2×2，占 0/1/4/5；其余种子落在 2/3/6。
    turret_ammo 现为 1×2，基础 4×2 装不下，由客户端 PLAYER_OVERFLOW_SEED 丢到脚边。
    """
    inv = Inventory("player", PLAYER_BASE[0], PLAYER_BASE[1])
    seeds = [
        (0, {"itemId": "work_satchel", "qty": 1}),
        (2, {"itemId": "coal", "qty": 16}),
        (3, {"itemId": "scrap", "qty": 4}),
        (6, {"itemId": "small_caliber_ammo", "qty": 54}),
    ]
    for index, stack in seeds:
        if not inv.place_stack(index, stack):
            inv.add_item(stack["itemId"], int(stack["qty"]))
    return inv


def create_default_storage() -> Inventory:
    """开局物资仓库：与客户端 STORAGE_SEED 大致对齐（不含可摆放设施）。"""
    inv = Inventory(STORAGE_BAG_ID, 8, 8)
    for index, stack in STORAGE_SEED:
        if not inv.place_stack(index, dict(stack)):
            inv.add_item(stack["itemId"], int(stack["qty"]))
    return inv


def create_default_facility_storage() -> Inventory:
    """开局设施仓库：仅可摆放 facility_* 种子。"""
    inv = Inventory(FACILITY_STORAGE_BAG_ID, 8, 8)
    for index, stack in FACILITY_STORAGE_SEED:
        if not inv.place_stack(index, dict(stack)):
            inv.add_item(stack["itemId"], int(stack["qty"]))
    return inv


def create_empty_platform_storage() -> Inventory:
    """小型月台地牢仓库房本地空仓（进站按种子填装；不连通车辆仓）。"""
    return Inventory(PLATFORM_STORAGE_BAG_ID, 6, 6)


def _mulberry32(seed: int):
    """与客户端 LpDungeon.mulberry32 对齐的确定性 RNG。"""
    state = [seed & 0xFFFFFFFF]

    def rng() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = Math_imul(t ^ (t >> 15), t | 1) & 0xFFFFFFFF
        t = (t ^ ((t + Math_imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


def Math_imul(a: int, b: int) -> int:
    """模拟 JS Math.imul（32 位有符号乘法结果再按无符号用）。"""
    a = ctypes_c_int32(a)
    b = ctypes_c_int32(b)
    return (a * b) & 0xFFFFFFFF


def ctypes_c_int32(v: int) -> int:
    v = v & 0xFFFFFFFF
    return v - 0x100000000 if v >= 0x80000000 else v


def hash_seed_station(world_seed: int, station_index: int) -> int:
    """与客户端 LpDungeon.hash2 对齐。"""
    h = (int(world_seed) ^ Math_imul(int(station_index) + 1, 0x9E3779B9)) & 0xFFFFFFFF
    h = Math_imul(h ^ (h >> 16), 0x85EBCA6B) & 0xFFFFFFFF
    h = Math_imul(h ^ (h >> 13), 0xC2B2AE35) & 0xFFFFFFFF
    return (h ^ (h >> 16)) & 0xFFFFFFFF


# 月台仓库战利品表（itemId, minQty, maxQty）；与客户端 LpDungeon.PLATFORM_LOOT_TABLE 对齐。
PLATFORM_LOOT_TABLE: List[Tuple[str, int, int]] = [
    ("coal", 8, 32),
    ("lumber", 6, 24),
    ("iron_ingot", 4, 16),
    ("scrap", 4, 20),
    ("small_caliber_ammo", 24, 90),
    ("turret_ammo", 10, 40),
    ("medkit", 1, 1),
    ("first_aid_kit", 1, 2),
]


def fill_platform_storage(
    inv: Inventory, world_seed: int, station_index: int
) -> Inventory:
    """清空并按种子填装月台仓库（确定性）。"""
    if inv is None:
        inv = create_empty_platform_storage()
    for i in range(inv.size()):
        if inv.is_covered(i):
            continue
        if inv.get_slot(i):
            inv.take_slot(i)
    rng = _mulberry32(hash_seed_station(world_seed, station_index) ^ 0xA11CE)
    pile_count = 4 + int(rng() * 5)
    for _ in range(pile_count):
        entry = PLATFORM_LOOT_TABLE[int(rng() * len(PLATFORM_LOOT_TABLE)) % len(PLATFORM_LOOT_TABLE)]
        item_id, lo, hi = entry
        qty = lo + int(rng() * (hi - lo + 1))
        if qty < 1:
            continue
        stack: Dict[str, Any] = {"itemId": item_id, "qty": qty}
        item = ITEMS.get(item_id) or {}
        if item.get("magazineSize") is not None:
            stack["mag"] = int(item["magazineSize"])
        if item.get("maxDurability") is not None:
            stack["dur"] = int(item["maxDurability"])
        if item.get("maxAmmo") is not None:
            stack["ammo"] = int(item["maxAmmo"])
        placed = False
        for i in range(inv.size()):
            if inv.is_covered(i) or inv.get_slot(i):
                continue
            if inv.place_stack(i, dict(stack)):
                placed = True
                break
        if not placed:
            inv.add_item(item_id, qty)
    return inv


def migrate_facilities_to_facility_storage(
    storage: Inventory, facility_storage: Inventory
) -> int:
    """将物资仓中的可摆放设施整堆迁入设施仓；返回迁入件数（堆数）。"""
    if not storage or not facility_storage:
        return 0
    moved = 0
    for i in range(storage.size()):
        if storage.is_covered(i):
            continue
        stack = storage.get_slot(i)
        if not stack or not _is_placeable_facility(str(stack["itemId"])):
            continue
        taken = storage.take_slot(i)
        if not taken:
            continue
        leftover = facility_storage.add_item(str(taken["itemId"]), int(taken["qty"]))
        if leftover > 0:
            # 设施仓满则退回物资仓，避免丢物。
            storage.add_item(str(taken["itemId"]), leftover)
        if leftover < int(taken["qty"]):
            moved += 1
    return moved


def ensure_placeable_facility_seeds(facility_storage: Inventory) -> None:
    """旧档补种：设施仓某 id 数量为 0 时按种子 qty 放入（不刷到 maxStack）。"""
    if not facility_storage:
        return
    for _index, seed in FACILITY_STORAGE_SEED:
        item_id = str(seed["itemId"])
        if not _is_placeable_facility(item_id):
            continue
        if facility_storage.count_item(item_id) > 0:
            continue
        facility_storage.add_item(item_id, int(seed.get("qty") or 1))


def _dump_stack_to_player(player: Inventory, stack: Dict[str, Any]) -> None:
    """把堆叠退回背包（尽量保留弹匣与朝向）。"""
    if not stack:
        return
    rot = _stack_rot(stack)
    for i in range(player.size()):
        if player.is_covered(i):
            continue
        if player.get_slot(i):
            continue
        if player.can_place_at(i, stack["itemId"], -1, rot):
            player.place_stack(i, stack)
            return
    player.add_item(stack["itemId"], int(stack["qty"]))


def sanitize_hands(hands: Inventory, player: Inventory) -> None:
    """手部武器槽清出非武器（可任意手槽物品除外），快捷槽清出枪械；非法物品退回背包。"""
    for index in HANDS_WEAPON_SLOTS:
        stack = hands.get_slot(index)
        if not stack:
            continue
        item = ITEMS.get(str(stack["itemId"])) or {}
        if not _is_weapon(stack["itemId"]) and not item.get("canHoldAnyHandSlot"):
            taken = hands.take_slot(index)
            if taken:
                _dump_stack_to_player(player, taken)
    util = hands.get_slot(HANDS_UTILITY)
    if util:
        item = ITEMS.get(str(util["itemId"])) or {}
        if _is_weapon(util["itemId"]) and not item.get("canHoldAnyHandSlot"):
            taken = hands.take_slot(HANDS_UTILITY)
            if taken:
                _dump_stack_to_player(player, taken)


def create_default_hands() -> Inventory:
    inv = Inventory("hands", 3, 1, ignore_item_size=True)
    inv.place_stack(1, {"itemId": "gur65", "qty": 1, "mag": 27})
    return inv


def create_default_equip() -> Inventory:
    return Inventory("equip", len(EQUIP_SLOT_KEYS), 1, ignore_item_size=True, slot_keys=EQUIP_SLOT_KEYS)


def create_default_crates() -> Dict[str, Inventory]:
    ammo = Inventory("guard-ammo", 4, 2)
    ammo.place_stack(0, {"itemId": "turret_ammo", "qty": 60})
    recycle = Inventory("guard-recycle", 3, 2)
    return {"ammo": ammo, "recycle": recycle}


def resolve_bag_size(equip: Inventory) -> Tuple[int, int]:
    worn = equip.get_slot(5)
    if worn:
        item = ITEMS.get(worn["itemId"]) or {}
        if item.get("bagCols") and item.get("bagRows"):
            return int(item["bagCols"]), int(item["bagRows"])
    return PLAYER_BASE


def sync_player_to_equip(player: Inventory, equip: Inventory) -> List[Dict[str, Any]]:
    cols, rows = resolve_bag_size(equip)
    if player.cols == cols and player.rows == rows:
        return []
    stacks = []
    for i in range(player.size()):
        if player.is_covered(i):
            continue
        stack = player.get_slot(i)
        if stack:
            stacks.append(stack)
    player.cols = cols
    player.rows = rows
    player.slots = [None] * (cols * rows)
    overflow: List[Dict[str, Any]] = []
    for stack in stacks:
        placed = False
        for i in range(player.size()):
            if player.can_place_at(i, stack["itemId"], -1, _stack_rot(stack)):
                player.place_stack(i, stack)
                placed = True
                break
        if not placed:
            leftover = player.add_item(stack["itemId"], stack["qty"])
            if leftover > 0:
                drop = {"itemId": stack["itemId"], "qty": leftover}
                if stack.get("mag") is not None:
                    drop["mag"] = stack["mag"]
                if _stack_rot(stack) == 90:
                    drop["rot"] = 90
                overflow.append(drop)
    return overflow


class PlayerInventories:
    """单名玩家的私有库存。"""

    def __init__(self) -> None:
        self.equip = create_default_equip()
        self.player = create_default_player()
        self.hands = create_default_hands()
        sync_player_to_equip(self.player, self.equip)

    def personal_snapshot(self) -> Dict[str, Any]:
        return {
            "player": self.player.to_json(),
            "hands": self.hands.to_json(),
            "equip": self.equip.to_json(),
        }

    def apply_personal(self, data: Dict[str, Any]) -> None:
        """套用客户端/存档私有库存，并校正手部槽合法性。"""
        if data.get("equip"):
            self.equip = Inventory.from_json(data["equip"], ignore_item_size=True, slot_keys=EQUIP_SLOT_KEYS)
        if data.get("player"):
            self.player = Inventory.from_json(data["player"])
        if data.get("hands"):
            self.hands = Inventory.from_json(data["hands"], ignore_item_size=True)
        sanitize_hands(self.hands, self.player)
        sync_player_to_equip(self.player, self.equip)


class RoomInventories:
    """房间共享：物资仓、设施仓、月台仓、地面、炮塔箱。"""

    def __init__(self) -> None:
        self.storage = create_default_storage()
        self.storage_facility = create_default_facility_storage()
        self.platform_storage = create_empty_platform_storage()
        # 兼容旧默认/热重载：若物资仓仍含设施则迁入设施仓。
        migrate_facilities_to_facility_storage(self.storage, self.storage_facility)
        ensure_placeable_facility_seeds(self.storage_facility)
        self.crates = create_default_crates()
        self.ground: List[Dict[str, Any]] = []
        self._pile_seq = 1

    def room_snapshot(self) -> Dict[str, Any]:
        return {
            "storage": self.storage.to_json(),
            "storage_facility": self.storage_facility.to_json(),
            "platform_storage": self.platform_storage.to_json(),
            "crates": {
                "ammo": self.crates["ammo"].to_json(),
                "recycle": self.crates["recycle"].to_json(),
            },
            "ground": [
                {
                    "id": p["id"],
                    "x": p["x"],
                    "y": p["y"],
                    "inv": p["inv"].to_json(),
                }
                for p in self.ground
                if any(p["inv"].get_slot(i) for i in range(p["inv"].size()))
            ],
        }

    def get_bag(self, name: str, personal: PlayerInventories, pile_id: Optional[str] = None) -> Optional[Inventory]:
        if name == "player":
            return personal.player
        if name == "hands":
            return personal.hands
        if name == "equip":
            return personal.equip
        if name == "storage":
            return self.storage
        if name == FACILITY_STORAGE_BAG_ID or name == "storage_facility":
            return self.storage_facility
        if name == PLATFORM_STORAGE_BAG_ID or name == "platform_storage":
            return self.platform_storage
        if name == "crate_ammo":
            return self.crates["ammo"]
        if name == "crate_recycle":
            return self.crates["recycle"]
        if name == "ground" and pile_id:
            for pile in self.ground:
                if pile["id"] == pile_id:
                    return pile["inv"]
        return None

    def ensure_ground(self, x: float, y: float) -> Dict[str, Any]:
        for pile in self.ground:
            if abs(pile["x"] - x) <= 48:
                return pile
        pile = {
            "id": f"pile-{self._pile_seq}",
            "x": float(x),
            "y": float(y),
            "inv": Inventory(f"ground-{self._pile_seq}", 5, 4),
        }
        self._pile_seq += 1
        self.ground.append(pile)
        return pile

    def drop_stacks(self, x: float, y: float, stacks: List[Dict[str, Any]]) -> None:
        pile = self.ensure_ground(x, y)
        for raw in stacks:
            stack = _norm_stack(raw)
            if not stack:
                continue
            leftover = pile["inv"].add_item(stack["itemId"], stack["qty"])
            if stack.get("mag") is not None and leftover < stack["qty"]:
                for i in range(pile["inv"].size()):
                    slot = pile["inv"].slots[i]
                    if slot and slot.get("itemId") == stack["itemId"] and slot.get("mag") is None:
                        slot["mag"] = stack["mag"]
                        break
            while leftover > 0:
                pile = {
                    "id": f"pile-{self._pile_seq}",
                    "x": float(x) + self._pile_seq * 6,
                    "y": float(y),
                    "inv": Inventory(f"ground-{self._pile_seq}", 5, 4),
                }
                self._pile_seq += 1
                self.ground.append(pile)
                leftover = pile["inv"].add_item(stack["itemId"], leftover)


def held_weapon_id(personal: PlayerInventories) -> Optional[str]:
    """右手优先，再左手（仅武器槽 0/1）。"""
    for index in HANDS_WEAPON_SLOTS[::-1]:
        stack = personal.hands.get_slot(index)
        if not stack:
            continue
        if _is_weapon(stack["itemId"]):
            return stack["itemId"]
    return None


def item_is_consumable(item_id: str) -> bool:
    """燃料与弹药视为消耗品（测试自动补充范围）。"""
    item = ITEMS.get(str(item_id)) or {}
    return item.get("type") in CONSUMABLE_TYPES


def refill_consumable_stacks(inv: Inventory) -> None:
    """把库存中燃料/弹药堆叠补到 maxStack（不补武器弹匣）。"""
    for index in range(inv.size()):
        if inv.is_covered(index):
            continue
        stack = inv.slots[index]
        if not stack or not stack.get("itemId"):
            continue
        item = ITEMS.get(str(stack["itemId"])) or {}
        if item.get("type") in CONSUMABLE_TYPES:
            inv.slots[index]["qty"] = int(item["maxStack"])


def refill_storage_infinite(storage: Inventory) -> None:
    """TEST_ONLY — remove after playtest：物资仓种子补到 maxStack（或种子 qty），取用不尽。"""
    for _index, seed in STORAGE_SEED:
        item_id = str(seed["itemId"])
        item = ITEMS.get(item_id) or {}
        # 可摆放设施不参与无限补货（设施在独立仓且编辑会扣库）。
        if _is_placeable_facility(item_id):
            continue
        want = int(item.get("maxStack") or seed.get("qty") or 1)
        have = storage.count_item(item_id)
        if have >= want:
            continue
        need = want - have
        leftover = storage.add_item(item_id, need)
        # 武器等带弹匣：若刚补进，把缺 mag 的堆设为满匣
        mag_size = item.get("magazineSize")
        max_dur = item.get("maxDurability")
        max_ammo = item.get("maxAmmo")
        if leftover >= need:
            continue
        for i in range(storage.size()):
            if storage.is_covered(i):
                continue
            st = storage.slots[i]
            if not st or st.get("itemId") != item_id:
                continue
            if mag_size is not None and st.get("mag") is None:
                storage.slots[i]["mag"] = int(mag_size)
            if max_dur is not None and st.get("dur") is None:
                storage.slots[i]["dur"] = int(max_dur)
            if max_ammo is not None and st.get("ammo") is None:
                storage.slots[i]["ammo"] = float(max_ammo)


def refill_player_consumables(personal: PlayerInventories) -> None:
    """补满玩家背包/手部/装备里的燃料与弹药堆（不补弹匣）。"""
    refill_consumable_stacks(personal.player)
    refill_consumable_stacks(personal.hands)
    refill_consumable_stacks(personal.equip)


def refill_room_consumables(room_inv: RoomInventories) -> None:
    """TEST_ONLY：无限物资仓 + 炮塔箱/地面消耗品堆补满（不刷设施仓）。"""
    refill_storage_infinite(room_inv.storage)
    for crate in room_inv.crates.values():
        refill_consumable_stacks(crate)
    for pile in room_inv.ground:
        refill_consumable_stacks(pile["inv"])


def consume_from_personal(personal: PlayerInventories, item_id: str, qty: int) -> int:
    """从手部再背包扣除物品。测试模式下消耗品视为扣成功并立即补满。"""
    need = max(0, int(qty))
    if need <= 0:
        return 0
    if TEST_AUTO_REFILL_CONSUMABLES and item_is_consumable(item_id):
        have = personal.hands.count_item(item_id) + personal.player.count_item(item_id)
        if have <= 0:
            item = ITEMS.get(item_id) or {}
            personal.player.add_item(item_id, int(item.get("maxStack") or need))
        refill_player_consumables(personal)
        return need
    removed = personal.hands.remove_item(item_id, need)
    rest = need - removed
    if rest > 0:
        removed += personal.player.remove_item(item_id, rest)
    return removed


def get_held_medkit_slot(
    personal: PlayerInventories, hand_index: Optional[int] = None
) -> Optional[Tuple[int, Dict[str, Any], Dict[str, Any]]]:
    """取手部医疗箱槽（仅 medkit）；优先 hand_index，否则扫 3 号工具槽。"""
    hands = personal.hands
    order: List[int] = []
    if hand_index is not None:
        try:
            hi = int(hand_index)
        except (TypeError, ValueError):
            hi = -1
        if 0 <= hi < hands.size():
            order.append(hi)
    if HANDS_UTILITY not in order:
        order.append(HANDS_UTILITY)
    for index in order:
        if hands.is_covered(index):
            continue
        stack = hands.get_slot(index)
        if not stack or stack.get("itemId") != MEDKIT_ID:
            continue
        item = ITEMS.get(MEDKIT_ID) or {}
        if stack.get("dur") is None and item.get("maxDurability"):
            hands.update_slot(index, {"dur": int(item["maxDurability"])})
            stack = hands.get_slot(index) or stack
        return index, stack, item
    return None


def get_held_first_aid_slot(
    personal: PlayerInventories, hand_index: Optional[int] = None
) -> Optional[Tuple[int, Dict[str, Any], Dict[str, Any]]]:
    """取手部急救箱槽（仅 first_aid_kit）；优先 hand_index，否则扫 3 号工具槽。"""
    hands = personal.hands
    order: List[int] = []
    if hand_index is not None:
        try:
            hi = int(hand_index)
        except (TypeError, ValueError):
            hi = -1
        if 0 <= hi < hands.size():
            order.append(hi)
    if HANDS_UTILITY not in order:
        order.append(HANDS_UTILITY)
    for index in order:
        if hands.is_covered(index):
            continue
        stack = hands.get_slot(index)
        if not stack or stack.get("itemId") != FIRST_AID_KIT_ID:
            continue
        item = ITEMS.get(FIRST_AID_KIT_ID) or {}
        return index, stack, item
    return None


def apply_medkit_tick(
    personal: PlayerInventories,
    *,
    hand_index: Optional[int],
    dt: float,
    ally: bool,
) -> Optional[Dict[str, Any]]:
    """权威结算一帧医疗箱：扣耐久并给出应回复量。耗尽则移除堆叠。

    返回 {amount, durCost, handIndex, emptied}；无效返回 None。
    """
    held = get_held_medkit_slot(personal, hand_index)
    if not held:
        return None
    index, stack, item = held
    dt = max(0.0, min(0.25, float(dt)))
    if dt <= 0:
        return None
    dur = int(stack.get("dur") or 0)
    if dur <= 0:
        personal.hands.take_slot(index)
        return {"amount": 0.0, "durCost": 0, "handIndex": index, "emptied": True}
    rate = float(item.get("allyHealPerSec") if ally else item.get("selfHealPerSec") or 0)
    cost_rate = float(item.get("durCostPerSec") or 0)
    amount = rate * dt
    dur_cost = cost_rate * dt
    if dur_cost <= 0 and amount <= 0:
        return None
    # 按剩余耐久比例截断本帧治疗
    if cost_rate > 0 and dur_cost > dur:
        scale = dur / dur_cost
        amount *= scale
        dur_cost = float(dur)
    next_dur = max(0, int(round(dur - dur_cost)))
    if next_dur <= 0:
        personal.hands.take_slot(index)
        emptied = True
    else:
        personal.hands.update_slot(index, {"dur": next_dur})
        emptied = False
    return {
        "amount": amount,
        "durCost": dur_cost,
        "handIndex": index,
        "emptied": emptied,
        "ally": ally,
    }


def consume_held_medkit(
    personal: PlayerInventories, *, hand_index: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    """兼容旧名：改为消耗急救箱（濒死复活）。"""
    return consume_held_first_aid(personal, hand_index=hand_index)


def consume_held_first_aid(
    personal: PlayerInventories, *, hand_index: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    """权威消耗整箱手部急救箱（濒死复活）；成功返回 {handIndex}，否则 None。"""
    held = get_held_first_aid_slot(personal, hand_index)
    if not held:
        return None
    index, _stack, _item = held
    personal.hands.take_slot(index)
    return {"handIndex": index, "emptied": True}