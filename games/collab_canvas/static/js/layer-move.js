(function (global) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 移动工具：整层笔迹或配合 SelectionManager 移动选区。 */
  const LayerMove = {
    /** 将指定图层绘制到临时 context（含 localRaster）。 */
    _renderLayer(db, layerId, strokes, ctx) {
      const prev = db.context;
      db.context = ctx;
      try {
        (strokes || []).forEach(stroke => {
          if (stroke.active === false) return;
          if (String(stroke.layer_id || 'l_default') !== String(layerId)) return;
          (stroke.segments || []).forEach(segment => {
            if ((segment.tool || 'brush') === 'background') return;
            db.drawSegment(segment);
          });
        });
      } finally {
        db.context = prev;
      }
    },

    /** 计算当前图层非透明像素包围盒；无内容时返回 null。 */
    measureLayerBounds(board) {
      const db = board.drawingBoard;
      const w = db.logicalWidth;
      const h = db.logicalHeight;
      const layerId = board.activeLayerId;
      const scratch = document.createElement('canvas');
      scratch.width = w;
      scratch.height = h;
      const ctx = scratch.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      LayerMove._renderLayer(db, layerId, board.strokes, ctx);
      const img = ctx.getImageData(0, 0, w, h);
      const pixels = img.data;
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (pixels[(y * w + x) * 4 + 3] <= 0) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (maxX < minX) return null;
      return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    },

    /** 拖拽预览：整层包围盒平移。 */
    showPreview(overlay, board, bbox, dx, dy) {
      if (!overlay || !bbox) return;
      const w = board.drawingBoard.logicalWidth;
      const h = board.drawingBoard.logicalHeight;
      overlay.setPreview({
        kind: 'rect',
        x1: (bbox.x + dx * w) / w,
        y1: (bbox.y + dy * h) / h,
        x2: (bbox.x + bbox.w + dx * w) / w,
        y2: (bbox.y + bbox.h + dy * h) / h,
        color: '#6366f1',
        size: 1,
        filled: false
      });
    },

    /** 按 mask 将 bbox 区域平移 dx/dy（归一化），写入 localRaster 并刷新。 */
    commitRasterMove(board, bbox, mask, dx, dy) {
      if (!bbox || !mask) return;
      const db = board.drawingBoard;
      const w = db.logicalWidth;
      const h = db.logicalHeight;
      const shiftX = Math.round(dx * w);
      const shiftY = Math.round(dy * h);
      if (!shiftX && !shiftY) return;

      const scratch = document.createElement('canvas');
      scratch.width = w;
      scratch.height = h;
      const sctx = scratch.getContext('2d');
      LayerMove._renderLayer(db, board.activeLayerId, board.strokes, sctx);
      const src = sctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);

      const erase = db.context.createImageData(bbox.w, bbox.h);
      for (let i = 0; i < mask.length; i += 1) {
        if (mask[i]) erase.data[i * 4 + 3] = 255;
      }
      db.context.save();
      db.context.globalCompositeOperation = 'destination-out';
      db.context.putImageData(erase, bbox.x, bbox.y);
      db.context.restore();
      LayerMove._appendLocalRaster(board, bbox, true);

      const destX = clamp(bbox.x + shiftX, 0, w - bbox.w);
      const destY = clamp(bbox.y + shiftY, 0, h - bbox.h);
      const patch = db.context.createImageData(bbox.w, bbox.h);
      for (let row = 0; row < bbox.h; row += 1) {
        for (let col = 0; col < bbox.w; col += 1) {
          const mi = row * bbox.w + col;
          if (!mask[mi]) continue;
          const si = mi * 4;
          patch.data[si] = src.data[si];
          patch.data[si + 1] = src.data[si + 1];
          patch.data[si + 2] = src.data[si + 2];
          patch.data[si + 3] = src.data[si + 3];
        }
      }
      db.context.putImageData(patch, destX, destY);
      const destBbox = { x: destX, y: destY, w: bbox.w, h: bbox.h };
      LayerMove._appendLocalRaster(board, destBbox, false);
      board._redraw();
      return destBbox;
    },

    /** 移动当前图层全部笔迹。 */
    commitLayerMove(board, dx, dy) {
      const bbox = LayerMove.measureLayerBounds(board);
      if (!bbox) return null;
      const mask = new Uint8Array(bbox.w * bbox.h);
      const scratch = document.createElement('canvas');
      scratch.width = bbox.w;
      scratch.height = bbox.h;
      const db = board.drawingBoard;
      const full = document.createElement('canvas');
      full.width = db.logicalWidth;
      full.height = db.logicalHeight;
      LayerMove._renderLayer(db, board.activeLayerId, board.strokes, full.getContext('2d'));
      const img = full.getContext('2d').getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
      for (let i = 0; i < mask.length; i += 1) {
        if (img.data[i * 4 + 3] > 0) mask[i] = 1;
      }
      return LayerMove.commitRasterMove(board, bbox, mask, dx, dy);
    },

    _appendLocalRaster(board, bbox, punch) {
      const db = board.drawingBoard;
      const img = db.context.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
      const segment = {
        tool: 'localRaster',
        x: bbox.x / db.logicalWidth,
        y: bbox.y / db.logicalHeight,
        w: bbox.w / db.logicalWidth,
        h: bbox.h / db.logicalHeight,
        pixels: Array.from(img.data),
        punch: !!punch
      };
      const strokeId = crypto.randomUUID();
      db.appendSegment(board.strokes, board.selfId, strokeId, segment, board.activeLayerId);
    }
  };

  global.LayerMove = LayerMove;
})(window);
