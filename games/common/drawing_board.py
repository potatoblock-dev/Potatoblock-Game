"""Reusable drawing-board protocol validation and stroke history helpers."""

import math
import re
import uuid
from typing import Dict, List, Optional, Tuple

MAX_STROKES = 1000
MAX_SEGMENTS_PER_STROKE = 5000
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


def serialize_strokes(strokes: List[Dict]) -> List[Dict]:
    """Return the stable wire representation for a stroke collection."""
    return [
        {
            "stroke_id": stroke["stroke_id"],
            "owner_id": stroke["owner_id"],
            "segments": stroke["segments"],
            "active": stroke["active"],
        }
        for stroke in strokes
    ]


def append_stroke_segment(
    strokes: List[Dict], redo_stacks: Dict[str, List[Dict]], player_id: str, data: Dict
) -> Dict:
    """Append one validated segment and clear only that player's redo stack."""
    segment = normalize_segment(data)
    stroke_id = str(data.get("stroke_id") or uuid.uuid4())[:100]
    stroke: Optional[Dict] = None
    for candidate in reversed(strokes):
        if (
            candidate["owner_id"] == player_id
            and candidate["stroke_id"] == stroke_id
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
        stroke = append_stroke_segment(strokes, redo_stacks, player_id, packet)
        applied.append(stroke["segments"][-1])
    assert stroke is not None
    return stroke, applied


def undo_player_stroke(
    strokes: List[Dict], redo_stacks: Dict[str, List[Dict]], player_id: str
) -> Optional[Dict]:
    """Hide the player's latest active stroke and add it to their redo stack."""
    for stroke in reversed(strokes):
        if stroke["owner_id"] == player_id and stroke["active"]:
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
