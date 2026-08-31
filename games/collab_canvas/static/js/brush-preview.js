(function (global) {
  'use strict';

  const BRUSH_TOOLS = new Set(['brush', 'eraser', 'glow', 'spray']);

  /** 本地笔刷空心圆预览（大小与笔刷一致）。 */
  class BrushPreview {
    constructor(container, options) {
      const settings = options || {};
      this.container = container;
      this.getStage = settings.getStage || (() => null);
      this.getViewportScale = settings.getViewportScale || (() => 1);
      this.getCanvas = settings.getCanvas || (() => null);
      this.getLogicalWidth = settings.getLogicalWidth || (() => 1920);
      this.getBrushSize = settings.getBrushSize || (() => 8);
      this.getTool = settings.getTool || (() => 'brush');
      this.isVisible = settings.isVisible || (() => true);
      this._sliderPinned = false;
      this.el = document.createElement('div');
      this.el.className = 'brush-preview-ring hidden';
      this.el.setAttribute('aria-hidden', 'true');
      const mount = this.getStage() || this.container;
      if (mount) mount.appendChild(this.el);
    }

    /** 笔刷在画布布局坐标中的直径（未乘 viewport 缩放）。 */
    static layoutDiameter(canvas, logicalWidth, brushSize) {
      if (!canvas) return Math.max(4, Number(brushSize) || 8);
      const layoutW = canvas.clientWidth;
      if (!layoutW) return Math.max(4, Number(brushSize) || 8);
      const lw = Number(logicalWidth) || 1920;
      const size = Number(brushSize) || 8;
      const lineWidth = size * (lw / 640);
      return Math.max(2, lineWidth * (layoutW / lw));
    }

    /** 将视口 client 坐标转为 cursorLayer 本地坐标（legacy）。 */
    static localPoint(canvas, clientX, clientY) {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const layoutW = canvas.clientWidth;
      const layoutH = canvas.clientHeight;
      if (!layoutW || !layoutH) return null;
      const nx = (clientX - rect.left) / rect.width;
      const ny = (clientY - rect.top) / rect.height;
      return {
        x: nx * layoutW,
        y: ny * layoutH
      };
    }

    /** 是否使用 stage 屏幕坐标（不受 viewport transform 裁切影响）。 */
    _usesStageSpace() {
      return Boolean(this.getStage && this.getStage());
    }

    /** 笔刷在屏幕上的直径（px）。 */
    screenDiameter() {
      const layout = BrushPreview.layoutDiameter(
        this.getCanvas(),
        this.getLogicalWidth(),
        this.getBrushSize()
      );
      if (!this._usesStageSpace()) return layout;
      const scale = Number(this.getViewportScale()) || 1;
      return Math.max(2, layout * scale);
    }

    /** client 坐标转为 stage 本地坐标。 */
    _stagePoint(clientX, clientY) {
      const stage = this.getStage();
      if (!stage) return null;
      const rect = stage.getBoundingClientRect();
      return {
        x: clientX - rect.left,
        y: clientY - rect.top
      };
    }

    /** 刷新环的位置、大小与样式。 */
    _applyRing(x, y, diameter) {
      this.el.classList.remove('hidden');
      this.el.classList.toggle('is-eraser', this.getTool() === 'eraser');
      this.el.style.width = diameter + 'px';
      this.el.style.height = diameter + 'px';
      this.el.style.transform = 'translate(' + (x - diameter / 2) + 'px,' + (y - diameter / 2) + 'px)';
    }

    /** 在画布中心显示笔刷空心圆（拖动粗细滑块时使用）。 */
    showAtCenter(options) {
      const settings = options || {};
      if (!this.el) return;
      if (!this.isVisible() || !BRUSH_TOOLS.has(this.getTool())) {
        this.hide();
        return;
      }
      const canvas = this.getCanvas();
      if (!canvas) {
        this.hide();
        return;
      }
      const canvasRect = canvas.getBoundingClientRect();
      if (!canvasRect.width || !canvasRect.height) {
        this.hide();
        return;
      }
      this._sliderPinned = Boolean(settings.pinned);
      const diameter = this.screenDiameter();
      if (this._usesStageSpace()) {
        const stagePt = this._stagePoint(
          canvasRect.left + canvasRect.width / 2,
          canvasRect.top + canvasRect.height / 2
        );
        if (!stagePt) {
          this.hide();
          return;
        }
        this._applyRing(stagePt.x, stagePt.y, diameter);
        return;
      }
      const layoutW = canvas.clientWidth;
      const layoutH = canvas.clientHeight;
      if (!layoutW || !layoutH) {
        this.hide();
        return;
      }
      this._applyRing(layoutW / 2, layoutH / 2, diameter);
    }

    update(clientX, clientY) {
      if (this._sliderPinned) return;
      if (!this.el) return;
      if (!this.isVisible() || !BRUSH_TOOLS.has(this.getTool())) {
        this.hide();
        return;
      }
      const canvas = this.getCanvas();
      if (!canvas) {
        this.hide();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      if (
        clientX < rect.left || clientX > rect.right
        || clientY < rect.top || clientY > rect.bottom
      ) {
        this.hide();
        return;
      }
      const diameter = this.screenDiameter();
      if (this._usesStageSpace()) {
        const stagePt = this._stagePoint(clientX, clientY);
        if (!stagePt) {
          this.hide();
          return;
        }
        this._applyRing(stagePt.x, stagePt.y, diameter);
        return;
      }
      const local = BrushPreview.localPoint(canvas, clientX, clientY);
      if (!local) {
        this.hide();
        return;
      }
      this._applyRing(local.x, local.y, diameter);
    }

    hide() {
      this._sliderPinned = false;
      if (this.el) this.el.classList.add('hidden');
    }
  }

  /** 右栏粗细滑块旁的笔迹空心圆预览（白底条内）。 */
  class BrushSizeDockPreview {
    constructor(root, options) {
      const settings = options || {};
      this.root = root;
      this.ring = root && root.querySelector('.brush-size-preview-ring');
      this.getBrushSize = settings.getBrushSize || (() => 8);
      this.getTool = settings.getTool || (() => 'brush');
      this.maxDiameter = settings.maxDiameter || 36;
    }

    /** 将笔刷逻辑大小映射为预览区内的像素直径。 */
    static dockDiameter(brushSize, maxPx) {
      const size = Math.max(1, Number(brushSize) || 8);
      const maxD = maxPx || 36;
      const minD = 4;
      return minD + ((size - 1) / 63) * (maxD - minD);
    }

    /** 刷新侧栏预览圆环大小与样式。 */
    update() {
      if (!this.root || !this.ring) return;
      const tool = this.getTool();
      if (!BRUSH_TOOLS.has(tool)) {
        this.root.classList.add('hidden');
        return;
      }
      this.root.classList.remove('hidden');
      const diameter = BrushSizeDockPreview.dockDiameter(this.getBrushSize(), this.maxDiameter);
      this.ring.style.width = diameter + 'px';
      this.ring.style.height = diameter + 'px';
      this.ring.classList.toggle('is-eraser', tool === 'eraser');
    }
  }

  global.BrushPreview = BrushPreview;
  global.BrushSizeDockPreview = BrushSizeDockPreview;
})(window);
