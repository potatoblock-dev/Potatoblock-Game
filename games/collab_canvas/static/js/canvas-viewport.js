(function (global) {
  'use strict';

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 8;
  const WHEEL_FACTOR = 0.0012;
  const ZOOM_STEP = 1.25;
  const BADGE_HIDE_MS = 1400;

  /** 画布视口缩放/平移/旋转；滚轮、中键拖移、缩放工具与多指手势仅作用于此区域。 */
  class CanvasViewport {
    constructor(options) {
      const settings = options || {};
      this.stage = settings.stage;
      this.surface = settings.surface;
      this.badge = settings.badge;
      this.onTransformChange = settings.onTransformChange || (() => {});
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
      this.rotation = 0;
      this.gesturesEnabled = settings.gesturesEnabled !== false;
      this._badgeTimer = null;
      this._panning = false;
      this._panPointerId = null;
      this._panLastX = 0;
      this._panLastY = 0;
      this._touchPoints = new Map();
      this._gesture = null;
      this._bindWheel();
      this._bindMiddlePan();
      this._bindTouchGestures();
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

    /** 当前是否正在多指手势（≥2 触点在画板）。 */
    isTouchGestureActive() {
      return this.gesturesEnabled && this._touchPoints.size >= 2;
    }

    /** 设置是否启用多指画布手势（平移/缩放/旋转）。 */
    setGesturesEnabled(enabled) {
      this.gesturesEnabled = Boolean(enabled);
      if (!this.gesturesEnabled) {
        this._touchPoints.clear();
        this._gesture = null;
      }
    }

    /** 是否启用多指手势。 */
    isGesturesEnabled() {
      return this.gesturesEnabled;
    }

    /** 重置为 100%、不旋转并居中。 */
    resetView() {
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
      this.rotation = 0;
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
      if (this.rotation) {
        this.surface.style.transform = `translate(${this.panX}px, ${this.panY}px) rotate(${this.rotation}deg) scale(${this.scale})`;
      } else {
        this.surface.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
      }
      this.surface.style.transformOrigin = '0 0';
      this.onTransformChange();
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

    /** 两指/多指手势：平移 + 捏合缩放 + 双指旋转。 */
    _bindTouchGestures() {
      if (!this.stage) return;

      const pointOf = event => ({ x: event.clientX, y: event.clientY });

      this.stage.addEventListener('pointerdown', event => {
        if (!this.gesturesEnabled || event.pointerType !== 'touch') return;
        this._touchPoints.set(event.pointerId, pointOf(event));
        if (this._touchPoints.size >= 2) {
          this._gesture = this._initGesture();
        }
      });

      this.stage.addEventListener('pointermove', event => {
        if (!this.gesturesEnabled || event.pointerType !== 'touch') return;
        if (!this._touchPoints.has(event.pointerId)) return;
        this._touchPoints.set(event.pointerId, pointOf(event));
        if (this._touchPoints.size >= 2 && this._gesture) {
          this._applyGesture();
        }
      });

      const end = event => {
        if (event.pointerType !== 'touch') return;
        this._touchPoints.delete(event.pointerId);
        if (this._touchPoints.size < 2) {
          this._gesture = null;
        }
      };
      this.stage.addEventListener('pointerup', end);
      this.stage.addEventListener('pointercancel', end);
    }

    /** 计算两指基线的中心、距离与角度。 */
    _touchBaseline() {
      const pts = Array.from(this._touchPoints.values());
      if (pts.length < 2) return null;
      const [a, b] = pts;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      return {
        cx,
        cy,
        dist: Math.max(20, Math.hypot(b.x - a.x, b.y - a.y)),
        angle: Math.atan2(b.y - a.y, b.x - a.x)
      };
    }

    /** 在一指按下时记录手势起始状态。 */
    _initGesture() {
      const base = this._touchBaseline();
      if (!base) return null;
      return {
        base,
        panX: this.panX,
        panY: this.panY,
        scale: this.scale,
        rotation: this.rotation
      };
    }

    /** 依据当前双指基线增量更新 pan/scale/rotate。 */
    _applyGesture() {
      const g = this._gesture;
      const cur = this._touchBaseline();
      if (!g || !cur) return;
      const cx = g.base.cx;
      const cy = g.base.cy;
      const focal = this._stagePoint(cx, cy);
      const factor = cur.dist / g.base.dist;
      const nextScale = this._clampScale(g.scale * factor);
      const ratio = nextScale / g.scale;
      // 以手指中心为焦点缩放+平移
      this.panX = focal.x - (focal.x - g.panX) * ratio + (cur.cx - cx);
      this.panY = focal.y - (focal.y - g.panY) * ratio + (cur.cy - cy);
      this.scale = nextScale;
      // 双指旋转（弧度 → 角度)
      const angle = (cur.angle - g.base.angle) * 180 / Math.PI;
      this.rotation = g.rotation + angle;
      this._applyTransform();
      this._flashBadge();
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
      if (!root.contains(event.target) && !isRoomActive(root)) return;
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    }, { passive: false, capture: true });
  }

  function isRoomActive(roomRoot) {
    const root = roomRoot || document.getElementById('roomScreen');
    return Boolean(root && !root.classList.contains('hidden'));
  }

  /** 查找可滚动的祖先（保留面板内滚动）。 */
  function findScrollableAncestor(node, stopAt) {
    let el = node instanceof Element ? node : null;
    const stop = stopAt || document.body;
    while (el && el !== stop && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 1) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /** 该元素是否还能沿 deltaY 继续滚动。 */
  function canScrollElement(el, deltaY) {
    if (!el || !deltaY) return false;
    if (deltaY < 0) return el.scrollTop > 0;
    return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  /** 触摸滑动是否应放行（表单控件、弹窗、标记忽略区）。 */
  function shouldAllowTouchMove(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest('[data-scroll-lock-ignore]')) return true;
    if (target.closest('#settingsModal, .room-panel-modal')) return true;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return true;
    return false;
  }

  /** 画板房间页锁定 document 滚动；可滚动面板内仍允许滚轮/触摸滚动。 */
  function lockCollabPageScroll(roomRoot) {
    const root = roomRoot || document.getElementById('roomScreen');
    if (!root) return;

    document.addEventListener('wheel', event => {
      if (!isRoomActive(root)) return;
      if (event.target.closest && event.target.closest('#canvasStage, .canvas-stage')) return;
      const scrollable = findScrollableAncestor(event.target, document.body);
      if (scrollable && canScrollElement(scrollable, event.deltaY)) return;
      event.preventDefault();
    }, { passive: false, capture: true });

    document.addEventListener('touchmove', event => {
      if (!isRoomActive(root)) return;
      if (shouldAllowTouchMove(event.target)) return;
      const scrollable = findScrollableAncestor(event.target, document.body);
      if (scrollable) return;
      event.preventDefault();
    }, { passive: false, capture: true });
  }

  /** 切换 html/body 溢出锁定（进入/离开画板房间）。 */
  function setCollabRoomScrollLock(active) {
    document.documentElement.classList.toggle('collab-scroll-lock', Boolean(active));
    document.body.classList.toggle('collab-scroll-lock', Boolean(active));
  }

  global.CanvasViewport = CanvasViewport;
  global.disableCollabBrowserZoom = disableBrowserZoom;
  global.lockCollabPageScroll = lockCollabPageScroll;
  global.setCollabRoomScrollLock = setCollabRoomScrollLock;
})(window);
