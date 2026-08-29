(function (global) {
  'use strict';

  /** 画布上方预览层（直线/形状/选区蚂蚁线），pointer-events:none。 */
  class CanvasOverlay {
    constructor(canvas, drawingBoard) {
      this.canvas = canvas;
      this.drawingBoard = drawingBoard;
      this._preview = null;
      this._selectionPath = null;
      this._ensureCanvas();
    }

    _ensureCanvas() {
      if (this.canvas) return;
      const surface = document.getElementById('canvasStageSurface');
      if (!surface) return;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'canvas-overlay';
      this.canvas.setAttribute('aria-hidden', 'true');
      surface.appendChild(this.canvas);
      this._resize();
    }

    attachToSurface(surface) {
      if (!surface || this.canvas) return;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'canvas-overlay';
      this.canvas.setAttribute('aria-hidden', 'true');
      surface.appendChild(this.canvas);
      this._resize();
    }

    _resize() {
      if (!this.canvas || !this.drawingBoard) return;
      this.canvas.width = this.drawingBoard.logicalWidth;
      this.canvas.height = this.drawingBoard.logicalHeight;
    }

    clear() {
      if (!this.canvas) return;
      const ctx = this.canvas.getContext('2d');
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._preview = null;
      this._selectionPath = null;
    }

    /** 设置几何预览：{ kind, x1,y1,x2,y2, color, size, filled? }。 */
    setPreview(spec) {
      this._preview = spec ? Object.assign({}, spec) : null;
      this._redraw();
    }

    /** 设置选区路径点列（归一化坐标）。 */
    setSelectionPath(points, closed) {
      this._selectionPath = points && points.length ? { points: points.slice(), closed: !!closed } : null;
      this._redraw();
    }

    _redraw() {
      if (!this.canvas) return;
      this._resize();
      const ctx = this.canvas.getContext('2d');
      const w = this.canvas.width;
      const h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);
      if (this._preview) this._drawPreview(ctx, w, h, this._preview);
      if (this._selectionPath) this._drawSelection(ctx, w, h, this._selectionPath);
    }

    _norm(ctx, x, y, w, h) {
      return { x: x * w, y: y * h };
    }

    _drawPreview(ctx, w, h, spec) {
      const p1 = this._norm(ctx, spec.x1, spec.y1, w, h);
      const p2 = this._norm(ctx, spec.x2, spec.y2, w, h);
      const color = spec.color || '#111827';
      const lineWidth = Math.max(1, (Number(spec.size) || 5) * (w / 640));
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.85;
      if (spec.kind === 'line') {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      } else if (spec.kind === 'rect') {
        const left = Math.min(p1.x, p2.x);
        const top = Math.min(p1.y, p2.y);
        const rw = Math.abs(p2.x - p1.x);
        const rh = Math.abs(p2.y - p1.y);
        if (spec.filled) ctx.fillRect(left, top, rw, rh);
        else ctx.strokeRect(left, top, rw, rh);
      } else if (spec.kind === 'ellipse') {
        const cx = (p1.x + p2.x) / 2;
        const cy = (p1.y + p2.y) / 2;
        const rx = Math.abs(p2.x - p1.x) / 2;
        const ry = Math.abs(p2.y - p1.y) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
        if (spec.filled) ctx.fill();
        else ctx.stroke();
      } else if (spec.kind === 'gradient') {
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = '#6366f1';
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = spec.color2 || '#ffffff';
        ctx.beginPath();
        ctx.arc(p2.x, p2.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    _drawSelection(ctx, w, h, spec) {
      const pts = spec.points;
      if (!pts.length) return;
      ctx.save();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      pts.forEach((pt, i) => {
        const px = pt.x * w;
        const py = pt.y * h;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (spec.closed) ctx.closePath();
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = 4;
      ctx.stroke();
      ctx.restore();
    }
  }

  global.CanvasOverlay = CanvasOverlay;
})(window);
