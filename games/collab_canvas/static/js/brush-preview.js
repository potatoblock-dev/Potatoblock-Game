(function (global) {
  'use strict';

  const BRUSH_TOOLS = new Set(['brush', 'eraser']);

  /** 本地笔刷空心圆预览（大小与笔刷一致）。 */
  class BrushPreview {
    constructor(container, options) {
      const settings = options || {};
      this.container = container;
      this.getCanvas = settings.getCanvas || (() => null);
      this.getLogicalWidth = settings.getLogicalWidth || (() => 960);
      this.getBrushSize = settings.getBrushSize || (() => 8);
      this.getTool = settings.getTool || (() => 'brush');
      this.isVisible = settings.isVisible || (() => true);
      this._sliderPinned = false;
      this.el = document.createElement('div');
      this.el.className = 'brush-preview-ring hidden';
      this.el.setAttribute('aria-hidden', 'true');
      if (this.container) this.container.appendChild(this.el);
    }

    /** 笔刷在屏幕上的直径（px），与画布预览一致。 */
    static displayDiameter(canvas, logicalWidth, brushSize) {
      if (!canvas) return Math.max(4, Number(brushSize) || 8);
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return Math.max(4, Number(brushSize) || 8);
      const lw = Number(logicalWidth) || 960;
      const size = Number(brushSize) || 8;
      const lineWidth = size * (lw / 640);
      return Math.max(2, lineWidth * (rect.width / lw));
    }

    /** 笔刷在屏幕上的直径（px）。 */
    displayDiameter() {
      return BrushPreview.displayDiameter(
        this.getCanvas(),
        this.getLogicalWidth(),
        this.getBrushSize()
      );
    }

    /** 在画布中心显示笔刷空心圆（拖动粗细滑块时使用）。 */
    showAtCenter(options) {
      const settings = options || {};
      if (!this.container || !this.el) return;
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
      if (!rect.width || !rect.height) {
        this.hide();
        return;
      }
      this._sliderPinned = Boolean(settings.pinned);
      const diameter = this.displayDiameter();
      const x = rect.width / 2;
      const y = rect.height / 2;
      this.el.classList.remove('hidden');
      this.el.classList.toggle('is-eraser', this.getTool() === 'eraser');
      this.el.style.width = diameter + 'px';
      this.el.style.height = diameter + 'px';
      this.el.style.transform = 'translate(' + (x - diameter / 2) + 'px,' + (y - diameter / 2) + 'px)';
    }

    update(clientX, clientY) {
      if (this._sliderPinned) return;
      if (!this.container || !this.el) return;
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
      const diameter = this.displayDiameter();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      this.el.classList.remove('hidden');
      this.el.classList.toggle('is-eraser', this.getTool() === 'eraser');
      this.el.style.width = diameter + 'px';
      this.el.style.height = diameter + 'px';
      this.el.style.transform = 'translate(' + (x - diameter / 2) + 'px,' + (y - diameter / 2) + 'px)';
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
