(function (global) {
  'use strict';

  const SELECT_TOOLS = new Set(['selectRect', 'selectEllipse', 'selectLasso', 'selectPolygon', 'magicWand']);
  const STROKE_DRAW_TOOLS = new Set(['brush', 'eraser', 'glow', 'spray']);
  const SHAPE_TOOLS = {
    rectOutline: { tool: 'rect', filled: false },
    rectFill: { tool: 'rect', filled: true },
    ellipseOutline: { tool: 'ellipse', filled: false },
    ellipseFill: { tool: 'ellipse', filled: true }
  };

  /** 注册全部工具 handler 到 ToolController。 */
  function registerCollabTools(controller, board) {
    const overlay = board.canvasOverlay;
    const selection = board.selectionManager;

    controller.register('brush', {
      onPointerDown(ctx) { return brushDown(board, ctx); },
      onPointerMove(ctx) { return brushMove(board, ctx); },
      onPointerUp(ctx) { return brushUp(board, ctx); }
    });
    controller.register('eraser', {
      onPointerDown(ctx) { return brushDown(board, ctx); },
      onPointerMove(ctx) { return brushMove(board, ctx); },
      onPointerUp(ctx) { return brushUp(board, ctx); }
    });
    controller.register('glow', {
      onPointerDown(ctx) { return brushDown(board, ctx); },
      onPointerMove(ctx) { return brushMove(board, ctx); },
      onPointerUp(ctx) { return brushUp(board, ctx); }
    });
    controller.register('spray', {
      onPointerDown(ctx) { return brushDown(board, ctx); },
      onPointerMove(ctx) { return brushMove(board, ctx); },
      onPointerUp(ctx) { return brushUp(board, ctx); }
    });

    controller.register('zoom', {
      onPointerDown(ctx) {
        const { event } = ctx;
        event.preventDefault();
        const zoomIn = !(event.altKey || event.shiftKey);
        if (board.viewport) board.viewport.zoomStepAt(event.clientX, event.clientY, zoomIn);
        return true;
      }
    });

    controller.register('hand', {
      onPointerDown(ctx) {
        const { event } = ctx;
        if (event.button !== 0) return false;
        board._handPanning = true;
        board._handLast = { x: event.clientX, y: event.clientY };
        if (board.stage) board.stage.classList.add('is-panning');
        if (board.canvas) board.canvas.setPointerCapture(event.pointerId);
        return true;
      },
      onPointerMove(ctx) {
        if (!board._handPanning || !board._handLast) return false;
        const { event } = ctx;
        const dx = event.clientX - board._handLast.x;
        const dy = event.clientY - board._handLast.y;
        board._handLast = { x: event.clientX, y: event.clientY };
        if (board.viewport) board.viewport.panBy(dx, dy);
        return true;
      },
      onPointerUp(ctx) {
        board._handPanning = false;
        board._handLast = null;
        if (board.stage) board.stage.classList.remove('is-panning');
        return true;
      }
    });

    controller.register('eyedropper', {
      onPointerDown(ctx) {
        const { event } = ctx;
        if (board._activeLayerLocked()) return false;
        event.preventDefault();
        const pt = board.normalizedPoint(event);
        const color = board.drawingBoard.sampleColor(pt.x, pt.y);
        board.currentColor = color;
        if (board.colorPair) board.colorPair.setColor('fg', color);
        if (board.colorPicker) board.colorPicker.setColor(color);
        if (board.popupPalette && board.popupPalette.isOpen()) board.popupPalette.refresh();
        return true;
      }
    });

    controller.register('fillBucket', {
      onPointerDown(ctx) {
        const { event } = ctx;
        if (!board.canDraw) return false;
        if (board._activeLayerLocked()) return false;
        event.preventDefault();
        const pt = board.normalizedPoint(event);
        const segment = { tool: 'fill', x: pt.x, y: pt.y, color: board.currentColor };
        const strokeId = crypto.randomUUID();
        board._appendLocalSegment(strokeId, segment);
        board.adapter.flushSegments();
        board._redraw();
        return true;
      }
    });

    controller.register('fillGradient', {
      onPointerDown(ctx) {
        if (!board.canDraw) return false;
        if (board._activeLayerLocked()) return false;
        board._gradientStart = board.normalizedPoint(ctx.event);
        board._gradientDragging = true;
        ctx.event.preventDefault();
        if (board.canvas) board.canvas.setPointerCapture(ctx.event.pointerId);
        return true;
      },
      onPointerMove(ctx) {
        if (!board._gradientDragging || !board._gradientStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        if (overlay) {
          overlay.setPreview({
            kind: 'gradient',
            x1: board._gradientStart.x,
            y1: board._gradientStart.y,
            x2: pt.x,
            y2: pt.y,
            color: board.currentColor,
            color2: board.colorPair ? board.colorPair.background : '#ffffff'
          });
        }
        return true;
      },
      onPointerUp(ctx) {
        if (!board._gradientDragging || !board._gradientStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        const segment = {
          tool: 'gradient',
          x1: board._gradientStart.x,
          y1: board._gradientStart.y,
          x2: pt.x,
          y2: pt.y,
          color: board.currentColor,
          color2: board.colorPair ? board.colorPair.background : '#ffffff'
        };
        const strokeId = crypto.randomUUID();
        board._appendLocalSegment(strokeId, segment);
        board.adapter.flushSegments();
        board._redraw();
        board._gradientDragging = false;
        board._gradientStart = null;
        if (overlay) overlay.clear();
        return true;
      }
    });

    controller.register('line', makeGeometryHandler(board, overlay, 'line'));

    Object.keys(SHAPE_TOOLS).forEach(variantId => {
      controller.register(variantId, makeGeometryHandler(board, overlay, SHAPE_TOOLS[variantId]));
    });

    SELECT_TOOLS.forEach(toolId => {
      controller.register(toolId, {
        onPointerDown(ctx) {
          if (selection) {
            selection.setMode(toolId);
            return selection.onPointerDown(ctx);
          }
          return false;
        },
        onPointerMove(ctx) {
          return selection ? selection.onPointerMove(ctx) : false;
        },
        onPointerUp(ctx) {
          return selection ? selection.onPointerUp(ctx) : false;
        }
      });
    });

    controller.register('move', {
      onPointerDown(ctx) {
        const { event } = ctx;
        if (!board.canDraw) return false;
        if (board._activeLayerLocked()) return false;
        event.preventDefault();
        const pt = board.normalizedPoint(event);
        if (selection && selection.isActive()) {
          if (selection.onPointerDown(ctx)) {
            if (board.canvas) board.canvas.setPointerCapture(event.pointerId);
            return true;
          }
          return false;
        }
        board._moveDragging = true;
        board._moveStart = pt;
        board._moveLayerBbox = LayerMove.measureLayerBounds(board);
        if (!board._moveLayerBbox) {
          board._moveDragging = false;
          board._moveStart = null;
          return false;
        }
        if (board.canvas) board.canvas.setPointerCapture(event.pointerId);
        return true;
      },
      onPointerMove(ctx) {
        if (selection && selection.state === 'moving') {
          return selection.onPointerMove(ctx);
        }
        if (!board._moveDragging || !board._moveStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        const dx = pt.x - board._moveStart.x;
        const dy = pt.y - board._moveStart.y;
        if (overlay) LayerMove.showPreview(overlay, board, board._moveLayerBbox, dx, dy);
        return true;
      },
      onPointerUp(ctx) {
        if (selection && selection.state === 'moving') {
          const handled = selection.onPointerUp(ctx);
          if (overlay) overlay.setPreview(null);
          return handled;
        }
        if (!board._moveDragging || !board._moveStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        const dx = pt.x - board._moveStart.x;
        const dy = pt.y - board._moveStart.y;
        LayerMove.commitLayerMove(board, dx, dy);
        board._moveDragging = false;
        board._moveStart = null;
        board._moveLayerBbox = null;
        if (overlay) overlay.clear();
        return true;
      }
    });
  }

  function makeGeometryHandler(board, overlay, spec) {
    const isLine = spec === 'line';
    return {
      onPointerDown(ctx) {
        if (!board.canDraw) return false;
        if (board._activeLayerLocked()) return false;
        if (board.penInput.isStylus(ctx.event)) board.penInput.markPenActivity(ctx.event, true);
        board._geoStart = board.normalizedPoint(ctx.event);
        board._geoStrokeSize = board.penInput.strokeSize(ctx.event);
        board._geoDragging = true;
        ctx.event.preventDefault();
        if (board.canvas) board.canvas.setPointerCapture(ctx.event.pointerId);
        return true;
      },
      onPointerMove(ctx) {
        if (!board._geoDragging || !board._geoStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        const size = board._geoStrokeSize != null ? board._geoStrokeSize : board.currentSize;
        if (!overlay) return true;
        if (isLine) {
          overlay.setPreview({
            kind: 'line',
            x1: board._geoStart.x,
            y1: board._geoStart.y,
            x2: pt.x,
            y2: pt.y,
            color: board.currentColor,
            size
          });
        } else {
          overlay.setPreview({
            kind: spec.tool,
            x1: board._geoStart.x,
            y1: board._geoStart.y,
            x2: pt.x,
            y2: pt.y,
            color: board.currentColor,
            size,
            filled: spec.filled
          });
        }
        return true;
      },
      onPointerUp(ctx) {
        if (!board._geoDragging || !board._geoStart) return false;
        const size = board._geoStrokeSize != null ? board._geoStrokeSize : board.currentSize;
        const pt = board.normalizedPoint(ctx.event);
        let x2 = pt.x;
        let y2 = pt.y;
        if (ctx.event.shiftKey) {
          if (isLine) {
            const snapped = snapLine45(board._geoStart.x, board._geoStart.y, x2, y2);
            x2 = snapped.x;
            y2 = snapped.y;
          } else if (spec.tool === 'rect') {
            const side = Math.max(Math.abs(x2 - board._geoStart.x), Math.abs(y2 - board._geoStart.y));
            x2 = board._geoStart.x + (x2 >= board._geoStart.x ? side : -side);
            y2 = board._geoStart.y + (y2 >= board._geoStart.y ? side : -side);
          } else if (spec.tool === 'ellipse') {
            const side = Math.max(Math.abs(x2 - board._geoStart.x), Math.abs(y2 - board._geoStart.y));
            x2 = board._geoStart.x + (x2 >= board._geoStart.x ? side : -side);
            y2 = board._geoStart.y + (y2 >= board._geoStart.y ? side : -side);
          }
        }
        const segment = isLine ? {
          tool: 'line',
          x1: board._geoStart.x,
          y1: board._geoStart.y,
          x2,
          y2,
          color: board.currentColor,
          size
        } : {
          tool: spec.tool,
          x1: board._geoStart.x,
          y1: board._geoStart.y,
          x2,
          y2,
          color: board.currentColor,
          size,
          filled: spec.filled
        };
        const strokeId = crypto.randomUUID();
        board._appendLocalSegment(strokeId, segment);
        board.adapter.flushSegments();
        board._redraw();
        board._geoDragging = false;
        board._geoStart = null;
        board._geoStrokeSize = null;
        if (board.penInput.isStylus(ctx.event)) board.penInput.clearPenPointer(ctx.event);
        if (overlay) overlay.clear();
        return true;
      }
    };
  }

  function snapLine45(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const angle = Math.atan2(dy, dx);
    const step = Math.PI / 4;
    const snapped = Math.round(angle / step) * step;
    const len = Math.sqrt(dx * dx + dy * dy);
    return { x: x1 + Math.cos(snapped) * len, y: y1 + Math.sin(snapped) * len };
  }

function presetSegmentFields(board) {
  const preset = board.brushPreset;
  if (!preset) return {};
  return {
    thinning: preset.thinning,
    smoothing: preset.smoothing,
    streamline: preset.streamline,
    opacity: preset.opacity,
    spacing: preset.spacing,
    randomJitter: preset.randomJitter
  };
}

function resolveStrokeTool(board, event) {
  if (board.penInput.isPenEraser(event)) return 'eraser';
  const tool = board.currentTool;
  return STROKE_DRAW_TOOLS.has(tool) ? tool : 'brush';
}

function brushDown(board, ctx) {
  const { event } = ctx;
  if (!board.canDraw) return false;
  if (board._activeLayerLocked()) return false;
  if (board.penInput.isStylus(event)) board.penInput.markPenActivity(event, true);
  event.preventDefault();
  board.canvas.setPointerCapture(event.pointerId);
  board.activeDrawPointerId = event.pointerId;
  board.isDrawing = true;
  board.activeStrokeId = crypto.randomUUID();
  board.activeStrokeTool = resolveStrokeTool(board, event);
  board._strokeSegmentIndex = 0;
  board.lastPoint = board.normalizedPoint(event);
  if (board.strokeSmoother) {
    board.strokeSmoother.reset();
    const pressure = board.penInput.isStylus(event) ? Number(event.pressure) : null;
    const out = board.strokeSmoother.push(board.lastPoint.x, board.lastPoint.y, pressure);
    if (out) board.lastPoint = out;
  }
  if (board.recentColors) board.recentColors.push(board.currentColor);
  board.stage.classList.add('stylus-ready');
  return true;
}

function brushMove(board, ctx) {
  const { event } = ctx;
  const pt = board.normalizedPoint(event);
  board._sendCursor(board.activeBoardId, pt.x, pt.y, board.isDrawing);
  if (!board.isDrawing || event.pointerId !== board.activeDrawPointerId) return false;
  if (board.penInput.shouldIgnorePointer(event, board.activeDrawPointerId)) return false;
  if (board.penInput.isStylus(event)) board.penInput.markPenActivity(event, true);
  event.preventDefault();
  if (!board.lastPoint) {
    board.lastPoint = pt;
    return true;
  }
  let drawPt = pt;
  if (board.strokeSmoother) {
    const pressure = board.penInput.isStylus(event) ? Number(event.pressure) : null;
    const out = board.strokeSmoother.push(pt.x, pt.y, pressure);
    if (!out) return true;
    drawPt = out;
  }
  const dx = drawPt.x - board.lastPoint.x;
  const dy = drawPt.y - board.lastPoint.y;
  const minDist = 0.5 / Math.max(board.drawingBoard.logicalWidth, 1);
  if (dx * dx + dy * dy < minDist * minDist) return true;
  const isStylus = drawPt.pressure != null;
  const sizeStart = board.penInput.sizeForPressure(
    board.lastPoint.pressure != null ? board.lastPoint.pressure : 0.5,
    isStylus,
    event
  );
  const sizeEnd = board.penInput.sizeForPressure(
    drawPt.pressure != null ? drawPt.pressure : 0.5,
    isStylus,
    event
  );
  const strokePart = board._strokeSegmentIndex === 0 ? 'start' : 'mid';
  board._strokeSegmentIndex += 1;
  const p1 = board.penInput.pressureFromSize(sizeStart, isStylus);
  const p2 = board.penInput.pressureFromSize(sizeEnd, isStylus);
  const segment = Object.assign({
    x1: board.lastPoint.x,
    y1: board.lastPoint.y,
    x2: drawPt.x,
    y2: drawPt.y,
    color: board.currentColor,
    size: sizeEnd,
    tool: board.activeStrokeTool,
    strokePart,
    points: [
      { x: board.lastPoint.x, y: board.lastPoint.y, pressure: p1 },
      { x: drawPt.x, y: drawPt.y, pressure: p2 }
    ]
  }, presetSegmentFields(board));
  board._appendLocalSegment(board.activeStrokeId, segment);
  board.lastPoint = drawPt;
  return true;
}

function brushUp(board, ctx) {
  const { event } = ctx;
  if (event.pointerId !== board.activeDrawPointerId) return false;
  if (board.penInput.isStylus(event)) board.penInput.clearPenPointer(event);
  board._finalizeActiveStroke();
  board.isDrawing = false;
  board.activeDrawPointerId = null;
  board.activeStrokeId = '';
  board.lastPoint = null;
  board._strokeSegmentIndex = 0;
  if (board.strokeSmoother) board.strokeSmoother.reset();
  board.stage.classList.remove('stylus-ready');
  board.adapter.flushSegments();
  board._redraw();
  const pt = board.normalizedPoint(event);
  board._sendCursor(board.activeBoardId, pt.x, pt.y, false);
  return true;
}

  global.registerCollabTools = registerCollabTools;
})(window);
