"""Reusable drawing-board protocol validation and stroke history helpers."""

import copy
import math
import re
import uuid
from typing import Dict, List, Optional, Tuple

MAX_STROKES = 1000
MAX_SEGMENTS_PER_STROKE = 5000
MAX_LAYERS_PER_BOARD = 20
DEFAULT_LAYER_ID = "l_default"
DEFAULT_BG_LAYER_ID = "l_background"
DEFAULT_BG_STROKE_ID = "s_bg_white"
SYSTEM_STROKE_OWNER = "__system__"
LAYER_KIND_PAINT = "paint"
LAYER_KIND_GROUP = "group"
VALID_LAYER_KINDS = {LAYER_KIND_PAINT, LAYER_KIND_GROUP}
VALID_TOOLS = {"brush", "eraser", "glow", "spray", "fill", "background", "line", "rect", "ellipse", "gradient"}
HEX_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
VECTOR_CANVAS_WIDTH = 1920
VECTOR_CANVAS_HEIGHT = 1080
PIXEL_CANVAS_MIN = 2
PIXEL_CANVAS_MAX = 128
DEFAULT_PIXEL_SIZE = 32


def default_vector_canvas() -> Dict[str, object]:
    """Return the default 16:9 vector canvas used by both lobby and game boards."""
    return {
        "mode": "vector",
        "width": VECTOR_CANVAS_WIDTH,
        "height": VECTOR_CANVAS_HEIGHT,
    }


def serialize_canvas(canvas: Dict) -> Dict[str, object]:
    """Return the stable wire representation for a canvas mode payload."""
    mode = "pixel" if canvas.get("mode") == "pixel" else "vector"
    return {
        "mode": mode,
        "width": int(canvas.get("width") or VECTOR_CANVAS_WIDTH),
        "height": int(canvas.get("height") or VECTOR_CANVAS_HEIGHT),
    }


def canvases_equal(left: Dict, right: Dict) -> bool:
    """Return True when two canvas specs describe the same grid."""
    return (
        str(left.get("mode") or "vector") == str(right.get("mode") or "vector")
        and int(left.get("width") or 0) == int(right.get("width") or 0)
        and int(left.get("height") or 0) == int(right.get("height") or 0)
    )


def reset_room_game_canvas(room: Dict) -> None:
    """换画师时重置游戏画布规格，避免下一位继承上一位的设置。"""
    room["game_canvas"] = default_vector_canvas()


def normalize_canvas_mode(data: object) -> Dict[str, object]:
    """Validate vector/pixel canvas settings for room state and WebSocket payloads."""
    payload = data if isinstance(data, dict) else {}
    mode = str(payload.get("mode") or "vector")
    if mode not in {"vector", "pixel"}:
        raise ValueError("画布模式无效")
    if mode == "vector":
        return default_vector_canvas()
    try:
        width = int(payload.get("width", DEFAULT_PIXEL_SIZE))
        height = int(payload.get("height", DEFAULT_PIXEL_SIZE))
    except (TypeError, ValueError) as exc:
        raise ValueError("像素画板尺寸无效") from exc
    if not (
        PIXEL_CANVAS_MIN <= width <= PIXEL_CANVAS_MAX
        and PIXEL_CANVAS_MIN <= height <= PIXEL_CANVAS_MAX
    ):
        raise ValueError("像素画板宽高必须在 2 到 128 之间")
    return {"mode": "pixel", "width": width, "height": height}


def _unit_float(value: object) -> float:
    """Convert a coordinate to a finite value in the inclusive unit interval."""
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("绘图坐标无效")
    return max(0.0, min(1.0, number))


def _hex_color(value: object) -> str:
    """Accept only canonical six-digit hexadecimal canvas colors."""
    color = str(value or "#111827")
    if not HEX_COLOR_PATTERN.fullmatch(color):
        raise ValueError("绘图颜色无效")
    return color.lower()


def _stroke_size(value: object, default: float = 5.0) -> float:
    """笔刷/线宽：1–128，最多两位小数。"""
    try:
        size = round(float(value), 2)
    except (TypeError, ValueError):
        size = default
    return max(1.0, min(128.0, size))


def normalize_segment(data: Dict) -> Dict[str, object]:
    """Validate and normalize a brush, eraser, fill, or background command."""
    tool = str(data.get("tool", "brush"))
    if tool not in VALID_TOOLS:
        raise ValueError("绘图工具无效")
    color = _hex_color(data.get("color", "#111827"))
    if tool == "background":
        return {"color": color, "tool": tool}
    if tool == "fill":
        return {
            "x": _unit_float(data["x"]),
            "y": _unit_float(data["y"]),
            "color": color,
            "tool": tool,
        }
    if tool == "gradient":
        color2 = _hex_color(data.get("color2", "#ffffff"))
        return {
            "x1": _unit_float(data["x1"]),
            "y1": _unit_float(data["y1"]),
            "x2": _unit_float(data["x2"]),
            "y2": _unit_float(data["y2"]),
            "color": color,
            "color2": color2,
            "tool": tool,
        }
    if tool in {"line", "rect", "ellipse"}:
        segment: Dict[str, object] = {
            "x1": _unit_float(data["x1"]),
            "y1": _unit_float(data["y1"]),
            "x2": _unit_float(data["x2"]),
            "y2": _unit_float(data["y2"]),
            "color": color,
            "size": _stroke_size(data.get("size", 5)),
            "tool": tool,
        }
        if tool in {"rect", "ellipse"}:
            segment["filled"] = bool(data.get("filled", False))
        return segment
    return {
        "x1": _unit_float(data["x1"]),
        "y1": _unit_float(data["y1"]),
        "x2": _unit_float(data["x2"]),
        "y2": _unit_float(data["y2"]),
        "color": color,
        "size": _stroke_size(data.get("size", 5)),
        "tool": tool,
    }


def default_layers() -> List[Dict[str, object]]:
    """返回默认双层：底白底、顶绘画层（Krita 式）。"""
    return [
        {
            "layer_id": DEFAULT_BG_LAYER_ID,
            "name": "背景",
            "kind": LAYER_KIND_PAINT,
            "parent_id": None,
            "visible": True,
            "opacity": 255,
            "locked": False,
            "order": 0,
        },
        {
            "layer_id": DEFAULT_LAYER_ID,
            "name": "图层 1",
            "kind": LAYER_KIND_PAINT,
            "parent_id": None,
            "visible": True,
            "opacity": 255,
            "locked": False,
            "order": 1,
        },
    ]


def default_background_strokes() -> List[Dict[str, object]]:
    """新画板白底：在背景层铺全画布白色填充。"""
    return [
        {
            "stroke_id": DEFAULT_BG_STROKE_ID,
            "owner_id": SYSTEM_STROKE_OWNER,
            "layer_id": DEFAULT_BG_LAYER_ID,
            "active": True,
            "segments": [
                {
                    "tool": "rect",
                    "x1": 0.0,
                    "y1": 0.0,
                    "x2": 1.0,
                    "y2": 1.0,
                    "color": "#ffffff",
                    "size": 1,
                    "filled": True,
                }
            ],
        }
    ]


def normalize_layer_kind(value: object) -> str:
    """规范化图层类型为 paint 或 group。"""
    kind = str(value or LAYER_KIND_PAINT)
    return kind if kind in VALID_LAYER_KINDS else LAYER_KIND_PAINT


def is_group_layer(layer: Optional[Dict]) -> bool:
    """是否为图层组（不含笔迹容器）。"""
    return bool(layer) and normalize_layer_kind(layer.get("kind")) == LAYER_KIND_GROUP


def is_paint_layer(layer: Optional[Dict]) -> bool:
    """是否为可绘制的绘画图层。"""
    return bool(layer) and not is_group_layer(layer)


def layer_parent_id(layer: Optional[Dict]) -> Optional[str]:
    """读取图层 parent_id；空串视为无父组。"""
    if not layer:
        return None
    raw = layer.get("parent_id")
    if raw is None or raw == "":
        return None
    return str(raw)


def repair_orphan_layers(board: Dict) -> None:
    """将 parent_id 指向不存在图层的层提升到根。"""
    layers = board.get("layers") or []
    ids = {str(layer["layer_id"]) for layer in layers}
    for layer in layers:
        parent = layer_parent_id(layer)
        if parent and parent not in ids:
            layer["parent_id"] = None


def ensure_background_stroke(board: Dict) -> None:
    """确保背景层存在系统白底笔迹（旧画板迁移）。"""
    strokes = board.setdefault("strokes", [])
    layer_ids = {str(layer.get("layer_id") or "") for layer in board.get("layers") or []}
    if DEFAULT_BG_LAYER_ID not in layer_ids:
        layers = board.setdefault("layers", [])
        layers.insert(0, default_layers()[0])
        for index, layer in enumerate(layers):
            layer["order"] = index
    has_bg = any(
        str(stroke.get("stroke_id") or "") == DEFAULT_BG_STROKE_ID
        for stroke in strokes
    )
    if not has_bg:
        board["strokes"] = list(default_background_strokes()) + list(strokes)


def ensure_drawable_paint_layer(board: Dict) -> Optional[Dict]:
    """无用户可绘制图层时追加空白「图层 1」；返回新建图层或 None。"""
    layers = board.get("layers") or []
    if not layers:
        board["layers"] = default_layers()
        for layer in board["layers"]:
            if str(layer.get("layer_id") or "") != DEFAULT_BG_LAYER_ID:
                return layer
        return None
    user_paints = [
        layer
        for layer in layers
        if is_paint_layer(layer) and str(layer.get("layer_id") or "") != DEFAULT_BG_LAYER_ID
    ]
    if user_paints:
        return None
    ids = {str(layer["layer_id"]) for layer in layers}
    layer_id = DEFAULT_LAYER_ID if DEFAULT_LAYER_ID not in ids else ("l_" + uuid.uuid4().hex[:10])
    max_order = max(int(layer.get("order", 0)) for layer in layers)
    layer = {
        "layer_id": layer_id,
        "name": "图层 1",
        "kind": LAYER_KIND_PAINT,
        "parent_id": None,
        "visible": True,
        "opacity": 255,
        "locked": False,
        "order": max_order + 1,
    }
    layers.append(layer)
    board["layers"] = layers
    return layer


def migrate_board_layers(board: Dict) -> None:
    """旧画板补全 layers 与 stroke.layer_id。"""
    if "layers" not in board or not board["layers"]:
        board["layers"] = default_layers()
    for layer in board["layers"]:
        layer["kind"] = normalize_layer_kind(layer.get("kind"))
        if "parent_id" not in layer:
            layer["parent_id"] = None
        elif layer["parent_id"] == "":
            layer["parent_id"] = None
    repair_orphan_layers(board)
    for stroke in board.get("strokes") or []:
        if "layer_id" not in stroke:
            stroke["layer_id"] = DEFAULT_LAYER_ID
    ensure_background_stroke(board)
    ensure_drawable_paint_layer(board)


def serialize_layers(layers: List[Dict]) -> List[Dict[str, object]]:
    """返回图层元数据的 wire 格式。"""
    result: List[Dict[str, object]] = []
    for index, layer in enumerate(layers or []):
        parent_id = layer_parent_id(layer)
        result.append(
            {
                "layer_id": layer["layer_id"],
                "name": layer["name"],
                "kind": normalize_layer_kind(layer.get("kind")),
                "parent_id": parent_id or "",
                "visible": bool(layer.get("visible", True)),
                "opacity": max(0, min(255, int(layer.get("opacity", 255)))),
                "locked": bool(layer.get("locked", False)),
                "order": int(layer.get("order", index)),
            }
        )
    return result


def next_layer_name(board: Dict, kind: str) -> str:
    """按类型生成默认图层/组名称。"""
    migrate_board_layers(board)
    if normalize_layer_kind(kind) == LAYER_KIND_GROUP:
        count = sum(1 for layer in board["layers"] if is_group_layer(layer))
        return f"组 {count + 1}"
    count = sum(1 for layer in board["layers"] if is_paint_layer(layer))
    return f"图层 {count + 1}"


def validate_layer_parent(board: Dict, parent_id: Optional[str]) -> Optional[str]:
    """校验 parent_id 必须指向存在的图层组。"""
    if not parent_id:
        return None
    parent = get_layer(board, str(parent_id))
    if not parent or not is_group_layer(parent):
        raise ValueError("父图层组不存在")
    return str(parent_id)


def create_board_layer(
    board: Dict,
    *,
    name: Optional[str] = None,
    kind: str = LAYER_KIND_PAINT,
    parent_id: Optional[str] = None,
) -> Dict:
    """新建绘画图层或图层组并追加到 board.layers。"""
    migrate_board_layers(board)
    layer_kind = normalize_layer_kind(kind)
    parent = validate_layer_parent(board, parent_id)
    new_id = "l_" + uuid.uuid4().hex[:10]
    max_order = max(int(layer.get("order", 0)) for layer in board["layers"])
    layer_name = str(name or next_layer_name(board, layer_kind)).strip()[:40] or next_layer_name(board, layer_kind)
    layer = {
        "layer_id": new_id,
        "name": layer_name,
        "kind": layer_kind,
        "parent_id": parent,
        "visible": True,
        "opacity": 255,
        "locked": False,
        "order": max_order + 1,
    }
    board["layers"].append(layer)
    return layer


def group_has_children(board: Dict, group_id: str) -> bool:
    """图层组是否仍有子图层。"""
    for layer in board.get("layers") or []:
        if layer_parent_id(layer) == group_id:
            return True
    return False


def reparent_group_children(board: Dict, group_id: str, new_parent_id: Optional[str]) -> None:
    """删除组前将其子图层移到新父级（或根）。"""
    for layer in board.get("layers") or []:
        if layer_parent_id(layer) == group_id:
            layer["parent_id"] = new_parent_id


def top_paint_layer_id(board: Dict) -> str:
    """返回 order 最高的可绘制图层 id。"""
    migrate_board_layers(board)
    paint_layers = [layer for layer in board.get("layers") or [] if is_paint_layer(layer)]
    if not paint_layers:
        return DEFAULT_LAYER_ID
    paint_layers.sort(key=lambda item: int(item.get("order", 0)))
    return str(paint_layers[-1]["layer_id"])


def get_layer(board: Dict, layer_id: str) -> Optional[Dict]:
    """按 id 取图层。"""
    for layer in board.get("layers") or []:
        if layer.get("layer_id") == layer_id:
            return layer
    return None


def is_layer_locked(board: Dict, layer_id: str) -> bool:
    """图层或其任意父组是否锁定。"""
    migrate_board_layers(board)
    current_id: Optional[str] = str(layer_id or DEFAULT_LAYER_ID)
    while current_id:
        layer = get_layer(board, current_id)
        if not layer:
            return False
        if bool(layer.get("locked")):
            return True
        current_id = layer_parent_id(layer)
    return False


def layer_has_strokes(board: Dict, layer_id: str) -> bool:
    """图层是否含用户笔触（不含系统白底）。"""
    for stroke in board.get("strokes") or []:
        if stroke.get("owner_id") == SYSTEM_STROKE_OWNER:
            continue
        if stroke.get("stroke_id") == DEFAULT_BG_STROKE_ID:
            continue
        if stroke.get("layer_id", DEFAULT_LAYER_ID) != layer_id:
            continue
        for segment in stroke.get("segments") or []:
            if segment.get("tool") != "background":
                return True
    return False


def clear_layer_strokes(board: Dict, layer_id: str) -> None:
    """清空指定图层上的所有笔触。"""
    kept: List[Dict] = []
    for stroke in board.get("strokes") or []:
        if stroke.get("layer_id", DEFAULT_LAYER_ID) != layer_id:
            kept.append(stroke)
    board["strokes"] = kept


def duplicate_board_layer(board: Dict, source_layer_id: str) -> Tuple[Optional[Dict], List[Dict]]:
    """复制绘画图层元数据与该层全部 active strokes 到新图层。"""
    migrate_board_layers(board)
    src = get_layer(board, source_layer_id)
    if not src or not is_paint_layer(src):
        return None, []
    new_id = "l_" + uuid.uuid4().hex[:10]
    max_order = max(int(layer.get("order", 0)) for layer in board["layers"])
    base_name = str(src.get("name") or "图层").strip()[:36]
    name = f"{base_name} 副本"[:40]
    layer = {
        "layer_id": new_id,
        "name": name,
        "kind": LAYER_KIND_PAINT,
        "parent_id": layer_parent_id(src),
        "visible": bool(src.get("visible", True)),
        "opacity": max(0, min(255, int(src.get("opacity", 255)))),
        "locked": bool(src.get("locked", False)),
        "order": max_order + 1,
    }
    board["layers"].append(layer)
    cloned: List[Dict] = []
    strokes = board.setdefault("strokes", [])
    for stroke in strokes:
        if stroke.get("layer_id", DEFAULT_LAYER_ID) != source_layer_id:
            continue
        if not stroke.get("active", True):
            continue
        new_stroke = {
            "stroke_id": str(uuid.uuid4())[:100],
            "owner_id": stroke["owner_id"],
            "layer_id": new_id,
            "segments": [copy.deepcopy(segment) for segment in stroke.get("segments") or []],
            "active": True,
        }
        while len(strokes) >= MAX_STROKES:
            strokes.pop(0)
        strokes.append(new_stroke)
        cloned.append(new_stroke)
    return layer, cloned


def serialize_strokes(strokes: List[Dict]) -> List[Dict]:
    """Return the stable wire representation for a stroke collection."""
    return [
        {
            "stroke_id": stroke["stroke_id"],
            "owner_id": stroke["owner_id"],
            "layer_id": stroke.get("layer_id", DEFAULT_LAYER_ID),
            "segments": stroke["segments"],
            "active": stroke["active"],
        }
        for stroke in strokes
    ]


def append_stroke_segment(
    strokes: List[Dict],
    redo_stacks: Dict[str, List[Dict]],
    player_id: str,
    data: Dict,
    layer_id: Optional[str] = None,
) -> Dict:
    """Append one validated segment and clear only that player's redo stack."""
    segment = normalize_segment(data)
    stroke_id = str(data.get("stroke_id") or uuid.uuid4())[:100]
    lid = str(layer_id or data.get("layer_id") or DEFAULT_LAYER_ID)
    stroke: Optional[Dict] = None
    for candidate in reversed(strokes):
        if (
            candidate["owner_id"] == player_id
            and candidate["stroke_id"] == stroke_id
            and candidate.get("layer_id", DEFAULT_LAYER_ID) == lid
            and candidate["active"]
        ):
            stroke = candidate
            break
    if stroke is None:
        if len(strokes) >= MAX_STROKES:
            strokes.pop(0)
        stroke = {
            "stroke_id": stroke_id,
            "owner_id": player_id,
            "layer_id": lid,
            "segments": [],
            "active": True,
        }
        strokes.append(stroke)
    if len(stroke["segments"]) >= MAX_SEGMENTS_PER_STROKE:
        raise ValueError("单笔包含的线段过多")
    stroke["segments"].append(segment)
    redo_stacks.setdefault(player_id, []).clear()
    return stroke


def append_stroke_segments(
    strokes: List[Dict],
    redo_stacks: Dict[str, List[Dict]],
    player_id: str,
    stroke_id: str,
    segment_payloads: List[Dict],
    layer_id: Optional[str] = None,
) -> Tuple[Dict, List[Dict]]:
    """Append many validated segments to one stroke; return stroke and normalized segments."""
    if not segment_payloads:
        raise ValueError("批量笔画不能为空")
    if len(segment_payloads) > 64:
        raise ValueError("单次批量笔画过多")
    applied: List[Dict] = []
    stroke: Optional[Dict] = None
    for payload in segment_payloads:
        packet = dict(payload)
        packet["stroke_id"] = stroke_id
        if layer_id:
            packet["layer_id"] = layer_id
        stroke = append_stroke_segment(strokes, redo_stacks, player_id, packet, layer_id)
        applied.append(stroke["segments"][-1])
    assert stroke is not None
    return stroke, applied


def undo_player_stroke(
    strokes: List[Dict],
    redo_stacks: Dict[str, List[Dict]],
    player_id: str,
    layer_id: Optional[str] = None,
) -> Optional[Dict]:
    """Hide the player's latest active stroke on a layer and add it to their redo stack."""
    lid = str(layer_id or DEFAULT_LAYER_ID)
    for stroke in reversed(strokes):
        if (
            stroke["owner_id"] == player_id
            and stroke.get("layer_id", DEFAULT_LAYER_ID) == lid
            and stroke["active"]
        ):
            stroke["active"] = False
            redo_stacks.setdefault(player_id, []).append(stroke)
            return stroke
    return None


def redo_player_stroke(
    redo_stacks: Dict[str, List[Dict]], player_id: str
) -> Optional[Dict]:
    """Restore the player's most recently undone stroke."""
    stack = redo_stacks.setdefault(player_id, [])
    while stack:
        stroke = stack.pop()
        if stroke.get("owner_id") != player_id:
            continue
        stroke["active"] = True
        return stroke
    return None
