(function (global) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 本地选区：创建 mask、移动/删除/填充，变更通过新 stroke 同步。 */
  class SelectionManager {
    constructor(board, overlay) {
      this.board = board;
      this.overlay = overlay;
      this.mode = 'selectRect';
      this.state = 'idle';
      this.mask = null;
      this.maskW = 0;
      this.maskH = 0;
      this.bbox = null;
      this._start = null;
      this._points = [];
      this._moveOffset = null;
      this._dragStart = null;
    }

    setMode(toolId) {
      this.mode = toolId;
      this.clear();
    }

    clear() {
      this.state = 'idle';
      this.mask = null;
      this.bbox = null;
      this._start = null;
      this._points = [];
      this._moveOffset = null;
      this._dragStart = null;
      if (this.overlay) {
        this.overlay.setSelectionPath(null);
        this.overlay.clear();
      }
      this._onSelectionChanged();
    }

    /** 整幅画布为选区。 */
    selectAll() {
      const db = this.board.drawingBoard;
      const w = db.logicalWidth;
      const h = db.logicalHeight;
      this.mask = new Uint8Array(w * h);
      this.mask.fill(1);
      this.maskW = w;
      this.maskH = h;
      this.bbox = { x: 0, y: 0, w, h };
      this.state = 'selected';
      this._refreshSelectionOverlay();
      this._onSelectionChanged();
    }

    /** 当前 bbox 内 mask 取反。 */
    invertSelection() {
      if (!this.isActive()) return;
      for (let i = 0; i < this.mask.length; i += 1) {
        this.mask[i] = this.mask[i] ? 0 : 1;
      }
      this._refreshSelectionOverlay();
      this._onSelectionChanged();
    }

    /** 复制选区像素到新图层（原层保留）；异步等待 layer_added。 */
    copyToNewLayer() {
      if (!this.isActive()) return;
      if (this.board._activeLayerLocked() || !this.board.canDraw) return;
      if (!global.LayerMove) return;
      const db = this.board.drawingBoard;
      const w = db.logicalWidth;
      const h = db.logicalHeight;
      const bbox = this.bbox;
      const layerId = this.board.activeLayerId;
      const scratch = document.createElement('canvas');
      scratch.width = w;
      scratch.height = h;
      const ctx = scratch.getContext('2d');
      LayerMove._renderLayer(db, layerId, this.board.strokes, ctx);
      const src = ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
      const patch = db.context.createImageData(bbox.w, bbox.h);
      for (let i = 0; i < this.mask.length; i += 1) {
        if (!this.mask[i]) continue;
        const pi = i * 4;
        patch.data[pi] = src.data[pi];
        patch.data[pi + 1] = src.data[pi + 1];
        patch.data[pi + 2] = src.data[pi + 2];
        patch.data[pi + 3] = src.data[pi + 3];
      }
      this.board._pendingSelectionCopy = {
        bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
        pixels: Array.from(patch.data)
      };
      this.board.createLayer();
    }

    /** 通知浮动栏刷新位置/可见性。 */
    _onSelectionChanged() {
      if (this.board && this.board.selectionActionsBar) {
        this.board.selectionActionsBar.sync();
      }
    }

    /** 按当前 bbox 重绘蚂蚁线 overlay。 */
    _refreshSelectionOverlay() {
      if (!this.overlay || !this.bbox) return;
      const w = this.board.drawingBoard.logicalWidth;
      const h = this.board.drawingBoard.logicalHeight;
      const bx = this.bbox.x;
      const by = this.bbox.y;
      const bw = this.bbox.w;
      const bh = this.bbox.h;
      this.overlay.setPreview(null);
      this.overlay.setSelectionPath([
        { x: bx / w, y: by / h },
        { x: (bx + bw) / w, y: by / h },
        { x: (bx + bw) / w, y: (by + bh) / h },
        { x: bx / w, y: (by + bh) / h }
      ], true);
    }

    isActive() {
      return this.state === 'selected' && this.mask;
    }

    onPointerDown(ctx) {
      const { board, event } = ctx;
      if (board._activeLayerLocked()) return false;
      const pt = board.normalizedPoint(event);
      if (this.state === 'selected' && this._hitInside(pt)) {
        this.state = 'moving';
        this._dragStart = pt;
        return true;
      }
      if (this.state === 'selected' && this.board.currentTool !== 'move') {
        this.clear();
      }
      if (this.state === 'selected' && this.board.currentTool === 'move') {
        return false;
      }
      this._start = pt;
      this._points = [pt];
      if (this.mode === 'selectPolygon') {
        if (event.detail >= 2 && this._points.length >= 3) {
          this._finalizeSelection();
          return true;
        }
        this.state = 'selecting';
        this._updateOverlay();
        return true;
      }
      this.state = 'selecting';
      return true;
    }

    onPointerMove(ctx) {
      const { board, event } = ctx;
      const pt = board.normalizedPoint(event);
      if (this.state === 'moving' && this._dragStart) {
        const dx = pt.x - this._dragStart.x;
        const dy = pt.y - this._dragStart.y;
        this._moveOffset = { dx, dy };
        this._updateMoveOverlay();
        return true;
      }
      if (this.state !== 'selecting') return false;
      if (this.mode === 'selectLasso') {
        this._points.push(pt);
        this._updateOverlay();
        return true;
      }
      if (this.mode === 'selectPolygon') return true;
      this._points = [this._start, pt];
      this._updateOverlay();
      return true;
    }

    onPointerUp(ctx) {
      const { board, event } = ctx;
      if (this.state === 'moving') {
        const pt = board.normalizedPoint(event);
        const dx = pt.x - (this._dragStart ? this._dragStart.x : pt.x);
        const dy = pt.y - (this._dragStart ? this._dragStart.y : pt.y);
        this._commitMove(dx, dy);
        this.state = 'selected';
        this._dragStart = null;
        this._moveOffset = null;
        return true;
      }
      if (this.state !== 'selecting') return false;
      if (this.mode === 'selectPolygon') return true;
      if (this.mode === 'magicWand') {
        this._buildMagicWand(board.normalizedPoint(event));
      } else {
        this._finalizeSelection();
      }
      return true;
    }

    /** Delete 键清除选区内像素并同步 stroke。 */
    deleteSelection() {
      if (!this.isActive()) return;
      this._applyToMask(pixels => {
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 0) pixels[i + 3] = 0;
        }
      });
      this._commitMaskAsStroke(true);
      this.clear();
    }

    /** 用当前前景色填充选区。 */
    fillSelection(color) {
      if (!this.isActive()) return;
      const rgb = this._hexToRgb(color || '#111827');
      this._applyToMask(pixels => {
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 0) {
            pixels[i] = rgb.r;
            pixels[i + 1] = rgb.g;
            pixels[i + 2] = rgb.b;
            pixels[i + 3] = 255;
          }
        }
      });
      this._commitMaskAsStroke();
      this.clear();
    }

    _hitInside(pt) {
      if (!this.bbox || !this.mask) return false;
      const w = this.board.drawingBoard.logicalWidth;
      const h = this.board.drawingBoard.logicalHeight;
      const x = clamp(Math.floor(pt.x * w), 0, w - 1);
      const y = clamp(Math.floor(pt.y * h), 0, h - 1);
      const bx = this.bbox.x;
      const by = this.bbox.y;
      const bw = this.bbox.w;
      const bh = this.bbox.h;
      if (x < bx || y < by || x >= bx + bw || y >= by + bh) return false;
      return this.mask[(y - by) * bw + (x - bx)] > 0;
    }

    _updateOverlay() {
      if (!this.overlay) return;
      if (this.mode === 'selectLasso' || this.mode === 'selectPolygon') {
        this.overlay.setSelectionPath(this._points, this.mode === 'selectPolygon' && this._points.length >= 3);
        return;
      }
      if (this._points.length >= 2) {
        const kind = this.mode === 'selectEllipse' ? 'ellipse' : 'rect';
        this.overlay.setPreview({
          kind,
          x1: this._points[0].x,
          y1: this._points[0].y,
          x2: this._points[1].x,
          y2: this._points[1].y,
          color: '#6366f1',
          size: 1,
          filled: false
        });
      }
    }

    _updateMoveOverlay() {
      if (!this.overlay || !this.bbox || !this._moveOffset) return;
      const w = this.board.drawingBoard.logicalWidth;
      const h = this.board.drawingBoard.logicalHeight;
      const x1 = (this.bbox.x + this._moveOffset.dx * w) / w;
      const y1 = (this.bbox.y + this._moveOffset.dy * h) / h;
      const x2 = (this.bbox.x + this.bbox.w + this._moveOffset.dx * w) / w;
      const y2 = (this.bbox.y + this.bbox.h + this._moveOffset.dy * h) / h;
      this.overlay.setPreview({
        kind: this.mode === 'selectEllipse' ? 'ellipse' : 'rect',
        x1, y1, x2, y2,
        color: '#6366f1',
        size: 1,
        filled: false
      });
    }

    _finalizeSelection() {
      const db = this.board.drawingBoard;
      const w = db.logicalWidth;
      const h = db.logicalHeight;
      if (this.mode === 'selectLasso' && this._points.length < 3) {
        this.clear();
        return;
      }
      if ((this.mode === 'selectRect' || this.mode === 'selectEllipse') && this._points.length < 2) {
        this.clear();
        return;
      }
      let bx;
      let by;
      let bw;
      let bh;
      if (this.mode === 'selectLasso' || this.mode === 'selectPolygon') {
        let minX = 1;
        let minY = 1;
        let maxX = 0;
        let maxY = 0;
        this._points.forEach(p => {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        });
        bx = clamp(Math.floor(minX * w), 0, w - 1);
        by = clamp(Math.floor(minY * h), 0, h - 1);
        const ex = clamp(Math.ceil(maxX * w), bx + 1, w);
        const ey = clamp(Math.ceil(maxY * h), by + 1, h);
        bw = ex - bx;
        bh = ey - by;
      } else {
        const x1 = clamp(Math.floor(Math.min(this._points[0].x, this._points[1].x) * w), 0, w - 1);
        const y1 = clamp(Math.floor(Math.min(this._points[0].y, this._points[1].y) * h), 0, h - 1);
        const x2 = clamp(Math.ceil(Math.max(this._points[0].x, this._points[1].x) * w), x1 + 1, w);
        const y2 = clamp(Math.ceil(Math.max(this._points[0].y, this._points[1].y) * h), y1 + 1, h);
        bx = x1;
        by = y1;
        bw = x2 - x1;
        bh = y2 - y1;
      }
      const mask = new Uint8Array(bw * bh);
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.canvas.width = bw;
      ctx.canvas.height = bh;
      ctx.fillStyle = '#fff';
      if (this.mode === 'selectEllipse') {
        ctx.beginPath();
        ctx.ellipse(bw / 2, bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (this.mode === 'selectLasso' || this.mode === 'selectPolygon') {
        ctx.beginPath();
        this._points.forEach((p, i) => {
          const px = p.x * w - bx;
          const py = p.y * h - by;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(0, 0, bw, bh);
      }
      const img = ctx.getImageData(0, 0, bw, bh);
      for (let row = 0; row < bh; row += 1) {
        for (let col = 0; col < bw; col += 1) {
          const alpha = img.data[(row * bw + col) * 4 + 3];
          mask[row * bw + col] = alpha > 0 ? 1 : 0;
        }
      }
      this.mask = mask;
      this.maskW = bw;
      this.maskH = bh;
      this.bbox = { x: bx, y: by, w: bw, h: bh };
      this.state = 'selected';
      if (this.overlay) {
        this.overlay.setPreview(null);
        this.overlay.setSelectionPath([
          { x: bx / w, y: by / h },
          { x: (bx + bw) / w, y: by / h },
          { x: (bx + bw) / w, y: (by + bh) / h },
          { x: bx / w, y: (by + bh) / h }
        ], true);
      }
      this._onSelectionChanged();
    }

    _buildMagicWand(pt) {
      const db = this.board.drawingBoard;
      const w = db.logicalWidth;
      const h = db.logicalHeight;
      const seedX = clamp(Math.floor(pt.x * (w - 1)), 0, w - 1);
      const seedY = clamp(Math.floor(pt.y * (h - 1)), 0, h - 1);
      const image = db.context.getImageData(0, 0, w, h);
      const pixels = image.data;
      const bg = this._hexToRgb(db.backgroundColor);
      const target = db.compositedPixel(pixels, (seedY * w + seedX) * 4, bg);
      const tolerance = this.board.wandTolerance != null ? this.board.wandTolerance : db.fillTolerance;
      const visited = new Uint8Array(w * h);
      const maskFull = new Uint8Array(w * h);
      const stack = [[seedX, seedY]];
      const matches = (x, y) => {
        const color = db.compositedPixel(pixels, (y * w + x) * 4, bg);
        return Math.abs(color[0] - target[0]) <= tolerance
          && Math.abs(color[1] - target[1]) <= tolerance
          && Math.abs(color[2] - target[2]) <= tolerance;
      };
      while (stack.length) {
        const [x, y] = stack.pop();
        const idx = y * w + x;
        if (visited[idx]) continue;
        visited[idx] = 1;
        if (!matches(x, y)) continue;
        maskFull[idx] = 1;
        if (x > 0) stack.push([x - 1, y]);
        if (x < w - 1) stack.push([x + 1, y]);
        if (y > 0) stack.push([x, y - 1]);
        if (y < h - 1) stack.push([x, y + 1]);
      }
      let minX = w;
      let minY = h;
      let maxX = 0;
      let maxY = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (!maskFull[y * w + x]) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (maxX < minX) {
        this.clear();
        return;
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const mask = new Uint8Array(bw * bh);
      for (let row = 0; row < bh; row += 1) {
        for (let col = 0; col < bw; col += 1) {
          if (maskFull[(minY + row) * w + (minX + col)]) mask[row * bw + col] = 1;
        }
      }
      this.mask = mask;
      this.maskW = bw;
      this.maskH = bh;
      this.bbox = { x: minX, y: minY, w: bw, h: bh };
      this.state = 'selected';
      this._updateOverlay();
      this._onSelectionChanged();
    }

    _commitMove(dx, dy) {
      if (!this.mask || !this.bbox || !global.LayerMove) return;
      const oldBbox = { x: this.bbox.x, y: this.bbox.y, w: this.bbox.w, h: this.bbox.h };
      const dest = LayerMove.commitRasterMove(this.board, oldBbox, this.mask, dx, dy);
      if (!dest) return;
      this.bbox = dest;
      if (this.overlay) {
        this.overlay.setPreview(null);
        const w = this.board.drawingBoard.logicalWidth;
        const h = this.board.drawingBoard.logicalHeight;
        this.overlay.setSelectionPath([
          { x: dest.x / w, y: dest.y / h },
          { x: (dest.x + dest.w) / w, y: dest.y / h },
          { x: (dest.x + dest.w) / w, y: (dest.y + dest.h) / h },
          { x: dest.x / w, y: (dest.y + dest.h) / h }
        ], true);
      }
      this._onSelectionChanged();
    }

    _applyToMask(mutate) {
      const db = this.board.drawingBoard;
      const img = db.context.getImageData(this.bbox.x, this.bbox.y, this.bbox.w, this.bbox.h);
      const patch = db.context.createImageData(this.bbox.w, this.bbox.h);
      for (let i = 0; i < this.mask.length; i += 1) {
        if (!this.mask[i]) continue;
        const pi = i * 4;
        patch.data[pi] = img.data[pi];
        patch.data[pi + 1] = img.data[pi + 1];
        patch.data[pi + 2] = img.data[pi + 2];
        patch.data[pi + 3] = img.data[pi + 3];
      }
      mutate(patch.data);
      db.context.putImageData(patch, this.bbox.x, this.bbox.y);
    }

    /** 选区像素变更写入 localRaster stroke，仅本地 redraw 时重放。 */
    _commitMaskAsStroke(punch) {
      const db = this.board.drawingBoard;
      const img = db.context.getImageData(this.bbox.x, this.bbox.y, this.bbox.w, this.bbox.h);
      const segment = {
        tool: 'localRaster',
        x: this.bbox.x / db.logicalWidth,
        y: this.bbox.y / db.logicalHeight,
        w: this.bbox.w / db.logicalWidth,
        h: this.bbox.h / db.logicalHeight,
        pixels: Array.from(img.data),
        punch: !!punch
      };
      const strokeId = crypto.randomUUID();
      db.appendSegment(this.board.strokes, this.board.selfId, strokeId, segment, this.board.activeLayerId);
      this.board._redraw();
    }

    _appendLocalRaster(bbox, punch) {
      const db = this.board.drawingBoard;
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
      db.appendSegment(this.board.strokes, this.board.selfId, strokeId, segment, this.board.activeLayerId);
      this.board._redraw();
    }

    _hexToRgb(hex) {
      const color = String(hex || '#111827');
      return {
        r: parseInt(color.slice(1, 3), 16),
        g: parseInt(color.slice(3, 5), 16),
        b: parseInt(color.slice(5, 7), 16)
      };
    }
  }

  global.SelectionManager = SelectionManager;
})(window);
