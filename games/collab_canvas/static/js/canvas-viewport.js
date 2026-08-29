(function (global) {
  'use strict';

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 8;
  const WHEEL_FACTOR = 0.0012;
  const ZOOM_STEP = 1.25;
  const BADGE_HIDE_MS = 1400;

  /** 画布视口缩放/平移；滚轮、中键拖移与缩放工具仅作用于此区域。 */
  class CanvasViewport {
    constructor(options) {
      const settings = options || {};
      this.stage = settings.stage;
      this.surface = settings.surface;
      this.badge = settings.badge;
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
      this._badgeTimer = null;
      this._panning = false;
      this._panPointerId = null;
      this._panLastX = 0;
      this._panLastY = 0;
      this._bindWheel();
      this._bindMiddlePan();
      this._applyTransform();
      this._flashBadge();
    }

    /** 以舞台坐标为焦点缩放；factor>1 放大。 */
    zoomAt(stageX, stageY, factor) {
      const next = this._clampScale(this.scale * factor);
      if (next === this.scale) return;
      const ratio = next / this.scale;
      this.panX = stageX - (stageX - this.panX) * ratio;
      this.panY = stageY - (stageY - this.panY) * ratio;
      this.scale = next;
      this._applyTransform();
      this._flashBadge();
    }

    /** 缩放工具：在指针位置步进放大或缩小。 */
    zoomStepAt(clientX, clientY, zoomIn) {
      const pt = this._stagePoint(clientX, clientY);
      if (!pt) return;
      this.zoomAt(pt.x, pt.y, zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP);
    }

    /** 按像素增量平移视口（镜头位置）。 */
    panBy(dx, dy) {
      if (!dx && !dy) return;
      this.panX += dx;
      this.panY += dy;
      this._applyTransform();
    }

    /** 当前是否正在中键拖移。 */
    isPanning() {
      return this._panning;
    }

    /** 重置为 100% 并居中。 */
    resetView() {
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
      this._applyTransform();
      this._flashBadge();
    }

    _clampScale(value) {
      return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
    }

    _stagePoint(clientX, clientY) {
      if (!this.stage) return null;
      const rect = this.stage.getBoundingClientRect();
      return {
        x: clientX - rect.left,
        y: clientY - rect.top
      };
    }

    _applyTransform() {
      if (!this.surface) return;
      this.surface.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
      this.surface.style.transformOrigin = '0 0';
    }

    _flashBadge() {
      if (!this.badge) return;
      const pct = Math.round(this.scale * 100);
      this.badge.textContent = pct + '%';
      this.badge.classList.remove('hidden');
      if (this._badgeTimer != null) clearTimeout(this._badgeTimer);
      this._badgeTimer = setTimeout(() => {
        this.badge.classList.add('hidden');
        this._badgeTimer = null;
      }, BADGE_HIDE_MS);
    }

    _setPanningCursor(active) {
      if (!this.stage) return;
      this.stage.classList.toggle('is-panning', active);
    }

    /** 鼠标中键拖移调整镜头位置（灰色视口与画布均可）。 */
    _bindMiddlePan() {
      if (!this.stage) return;

      this.stage.addEventListener('pointerdown', event => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        this._panning = true;
        this._panPointerId = event.pointerId;
        this._panLastX = event.clientX;
        this._panLastY = event.clientY;
        this._setPanningCursor(true);
        try {
          this.stage.setPointerCapture(event.pointerId);
        } catch (_err) {}
      });

      this.stage.addEventListener('pointermove', event => {
        if (!this._panning || event.pointerId !== this._panPointerId) return;
        event.preventDefault();
        const dx = event.clientX - this._panLastX;
        const dy = event.clientY - this._panLastY;
        this._panLastX = event.clientX;
        this._panLastY = event.clientY;
        this.panBy(dx, dy);
      });

      const endPan = event => {
        if (!this._panning || event.pointerId !== this._panPointerId) return;
        event.preventDefault();
        this._panning = false;
        this._panPointerId = null;
        this._setPanningCursor(false);
        try {
          if (this.stage.hasPointerCapture(event.pointerId)) {
            this.stage.releasePointerCapture(event.pointerId);
          }
        } catch (_err) {}
      };

      this.stage.addEventListener('pointerup', endPan);
      this.stage.addEventListener('pointercancel', endPan);

      // 阻止中键默认的自动滚动 / 新标签行为
      this.stage.addEventListener('auxclick', event => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      this.stage.addEventListener('mousedown', event => {
        if (event.button === 1) event.preventDefault();
      });
    }

    _bindWheel() {
      if (!this.stage) return;
      this.stage.addEventListener('wheel', event => {
        event.preventDefault();
        event.stopPropagation();
        const pt = this._stagePoint(event.clientX, event.clientY);
        if (!pt) return;
        const factor = Math.exp(-event.deltaY * WHEEL_FACTOR);
        this.zoomAt(pt.x, pt.y, factor);
      }, { passive: false });
    }
  }

  /** 画板页禁用浏览器双击放大、捏合缩放与 Ctrl+滚轮页面缩放。 */
  function disableBrowserZoom(roomRoot) {
    const root = roomRoot || document.getElementById('roomScreen');
    if (!root) return;

    root.addEventListener('gesturestart', event => event.preventDefault());
    root.addEventListener('gesturechange', event => event.preventDefault());
    root.addEventListener('gestureend', event => event.preventDefault());

    let lastTouchEnd = 0;
    root.addEventListener('touchend', event => {
      const now = Date.now();
      if (now - lastTouchEnd < 320) event.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });

    root.addEventListener('touchmove', event => {
      if (event.scale !== undefined && event.scale !== 1) event.preventDefault();
    }, { passive: false });

    document.addEventListener('wheel', event => {
      if (!root.contains(event.target)) return;
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    }, { passive: false, capture: true });
  }

  global.CanvasViewport = CanvasViewport;
  global.disableCollabBrowserZoom = disableBrowserZoom;
})(window);
