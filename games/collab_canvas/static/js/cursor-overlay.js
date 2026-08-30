(function (global) {
  'use strict';

  const LERP_MS = 100;
  const HIDE_MS = 3000;
  const clamp01 = v => Math.min(1, Math.max(0, v));

  /** 远程玩家光标、笔刷环与用户名标签（DOM overlay）。 */
  class CursorOverlay {
    constructor(container, options) {
      const settings = options || {};
      this.container = container;
      this.selfId = settings.selfId || '';
      this.resolveLabelColor = settings.resolveLabelColor || ((id, wire) => defaultLabelColor(id));
      this.getLogicalWidth = settings.getLogicalWidth || (() => 960);
      this.getCanvas = settings.getCanvas || (() => null);
      this.cursors = new Map();
      this._raf = null;
      this._tick = this._tick.bind(this);
    }

    setSelfId(id) {
      this.selfId = String(id || '');
    }

    /** 批量写入玩家标签色与显示名（room_state / player_style）。 */
    setPlayerStyle(playerId, payload) {
      if (playerId === this.selfId) return;
      const style = payload || {};
      const labelColor = this.resolveLabelColor(playerId, style.label_color);
      const entry = this.cursors.get(playerId);
      if (entry) {
        this._applyLabelStyle(entry, labelColor);
        const nextName = style.name || style.nickname;
        if (nextName) {
          entry.nickname = nextName;
          entry.label.textContent = nextName;
        }
      } else {
        this._styleCache = this._styleCache || new Map();
        this._styleCache.set(playerId, { labelColor, name: style.name || style.nickname || '' });
      }
    }

    _ensureEntry(playerId, nickname) {
      let entry = this.cursors.get(playerId);
      if (entry) {
        if (nickname) entry.nickname = nickname;
        entry.label.textContent = entry.nickname;
        return entry;
      }
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.innerHTML = [
        '<span class="remote-cursor-ring"></span>',
        '<span class="remote-cursor-dot"></span>',
        '<span class="remote-cursor-label"></span>'
      ].join('');
      this.container.appendChild(el);
      entry = {
        el,
        ring: el.querySelector('.remote-cursor-ring'),
        dot: el.querySelector('.remote-cursor-dot'),
        label: el.querySelector('.remote-cursor-label'),
        nickname: nickname || '玩家',
        labelColor: defaultLabelColor(playerId),
        brushSize: 8,
        fromX: 0,
        fromY: 0,
        toX: 0,
        toY: 0,
        t0: 0,
        lastSeen: performance.now(),
        drawing: false
      };
      entry.label.textContent = entry.nickname;
      const cached = this._styleCache && this._styleCache.get(playerId);
      if (cached) {
        if (cached.labelColor) this._applyLabelStyle(entry, cached.labelColor);
        if (cached.name) {
          entry.nickname = cached.name;
          entry.label.textContent = cached.name;
        }
      }
      this.cursors.set(playerId, entry);
      return entry;
    }

    _applyLabelStyle(entry, labelColor) {
      entry.labelColor = labelColor;
      entry.el.style.setProperty('--cursor-color', labelColor);
      entry.label.style.background = labelColor;
      entry.label.style.color = contrastText(labelColor);
      entry.ring.style.borderColor = labelColor;
    }

    _ringDiameter(entry) {
      const canvas = this.getCanvas();
      if (!canvas) return 0;
      const layoutW = canvas.clientWidth;
      if (!layoutW) return 0;
      const logicalWidth = this.getLogicalWidth();
      const lineWidth = (Number(entry.brushSize) || 8) * (logicalWidth / 640);
      return Math.max(2, lineWidth * (layoutW / logicalWidth));
    }

    update(playerId, payload) {
      if (playerId === this.selfId) return;
      const entry = this._ensureEntry(playerId, payload.nickname);
      const layoutW = this.container.clientWidth;
      const layoutH = this.container.clientHeight;
      if (!layoutW || !layoutH) return;
      const x = Number(payload.x) * layoutW;
      const y = Number(payload.y) * layoutH;
      entry.fromX = entry.toX;
      entry.fromY = entry.toY;
      entry.toX = x;
      entry.toY = y;
      entry.t0 = performance.now();
      entry.lastSeen = entry.t0;
      entry.drawing = Boolean(payload.drawing);
      if (payload.size != null) entry.brushSize = Number(payload.size) || entry.brushSize;
      if (payload.label_color !== undefined) {
        this._applyLabelStyle(entry, this.resolveLabelColor(playerId, payload.label_color));
      }
      entry.el.classList.toggle('is-drawing', entry.drawing);
      const diameter = this._ringDiameter(entry);
      entry.ring.style.width = diameter + 'px';
      entry.ring.style.height = diameter + 'px';
      entry.ring.style.marginLeft = (-diameter / 2) + 'px';
      entry.ring.style.marginTop = (-diameter / 2) + 'px';
      entry.el.classList.toggle('has-ring', diameter > 0 && (entry.drawing || payload.size != null));
      this._startLoop();
    }

    remove(playerId) {
      const entry = this.cursors.get(playerId);
      if (!entry) return;
      entry.el.remove();
      this.cursors.delete(playerId);
    }

    clear() {
      this.cursors.forEach(entry => entry.el.remove());
      this.cursors.clear();
      if (this._styleCache) this._styleCache.clear();
    }

    _startLoop() {
      if (this._raf != null) return;
      this._raf = requestAnimationFrame(this._tick);
    }

    _tick(now) {
      let anyVisible = false;
      this.cursors.forEach(entry => {
        if (now - entry.lastSeen > HIDE_MS) {
          entry.el.style.opacity = '0';
          return;
        }
        anyVisible = true;
        const t = clamp01((now - entry.t0) / LERP_MS);
        const x = entry.fromX + (entry.toX - entry.fromX) * t;
        const y = entry.fromY + (entry.toY - entry.fromY) * t;
        entry.el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
        entry.el.style.opacity = '1';
      });
      if (anyVisible) {
        this._raf = requestAnimationFrame(this._tick);
      } else {
        this._raf = null;
      }
    }
  }

  global.CursorOverlay = CursorOverlay;
})(window);
