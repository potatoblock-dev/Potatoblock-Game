(function (global) {
  'use strict';

  /** 无保存权限时在画布上显示半透明水印。 */
  class CanvasWatermark {
    constructor(surface, options) {
      const settings = options || {};
      this.surface = surface;
      this.getText = settings.getText || (() => '预览 · 禁止保存');
      this.el = document.createElement('div');
      this.el.className = 'canvas-save-watermark hidden';
      this.el.setAttribute('aria-hidden', 'true');
      if (this.surface) this.surface.appendChild(this.el);
    }

    /** 按 canSave 显示或隐藏水印。 */
    setActive(active) {
      if (!this.el) return;
      if (active) {
        this.el.classList.add('hidden');
        return;
      }
      this.el.textContent = this.getText();
      this.el.classList.remove('hidden');
    }
  }

  global.CanvasWatermark = CanvasWatermark;
})(window);
