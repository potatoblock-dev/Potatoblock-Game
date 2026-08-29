"""Reusable drawing-board protocol validation and stroke history helpers."""

import math
import re
import uuid
from typing import Dict, List, Optional, Tuple

MAX_STROKES = 1000
MAX_SEGMENTS_PER_STROKE = 5000
MAX_LAYERS_PER_BOARD = 20
DEFAULT_LAYER_ID = "l_default"
VALID_TOOLS = {"brush", "eraser", "fill", "background"}
HEX_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
VECTOR_CANVAS_WIDTH = 960
VECTOR_CANVAS_HEIGHT = 540
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
    return {
        "x1": _unit_float(data["x1"]),
        "y1": _unit_float(data["y1"]),
        "x2": _unit_float(data["x2"]),
        "y2": _unit_float(data["y2"]),
        "color": color,
        "size": max(1, min(64, int(data.get("size", 5)))),
        "tool": tool,
    }


def default_layers() -> List[Dict[str, object]]:
    """返回默认单图层列表。"""
    return [
        {
            "layer_id": DEFAULT_LAYER_ID,
            "name": "图层 1",
            "visible": True,
            "opacity": 255,
            "locked": False,
            "order": 0,
        }
    ]


def migrate_board_layers(board: Dict) -> None:
    """旧画板补全 layers 与 stroke.layer_id。"""
    if "layers" not in board or not board["layers"]:
        board["layers"] = default_layers()
    for stroke in board.get("strokes") or []:
        if "layer_id" not in stroke:
            stroke["layer_id"] = DEFAULT_LAYER_ID


def serialize_layers(layers: List[Dict]) -> List[Dict[str, object]]:
    """返回图层元数据的 wire 格式。"""
    return [
        {
            "layer_id": layer["layer_id"],
            "name": layer["name"],
            "visible": bool(layer.get("visible", True)),
            "opacity": max(0, min(255, int(layer.get("opacity", 255)))),
            "locked": bool(layer.get("locked", False)),
            "order": int(layer.get("order", index)),
        }
        for index, layer in enumerate(layers or [])
    ]


def get_layer(board: Dict, layer_id: str) -> Optional[Dict]:
    """按 id 取图层。"""
    for layer in board.get("layers") or []:
        if layer.get("layer_id") == layer_id:
            return layer
    return None


def layer_has_strokes(board: Dict, layer_id: str) -> bool:
    """图层是否含非背景笔触。"""
    for stroke in board.get("strokes") or []:
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
    if not stack:
        return None
    stroke = stack.pop()
    stroke["active"] = True
    return stroke
