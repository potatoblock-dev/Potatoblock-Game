(function (global) {
  'use strict';

  const LERP_MS = 100;
  const HIDE_MS = 3000;

  /** 远程玩家光标 overlay（DOM 层，不写进 stroke buffer）。 */
  class CursorOverlay {
    constructor(container, options) {
      const settings = options || {};
      this.container = container;
      this.selfId = settings.selfId || '';
      this.colorFor = settings.colorFor || (() => '#60a5fa');
      this.cursors = new Map();
      this._raf = null;
      this._lastFrame = 0;
      this._tick = this._tick.bind(this);
    }

    setSelfId(id) {
      this.selfId = String(id || '');
    }

    _ensureEntry(playerId, nickname) {
      let entry = this.cursors.get(playerId);
      if (entry) {
        entry.nickname = nickname || entry.nickname;
        return entry;
      }
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.innerHTML = '<span class="remote-cursor-dot"></span><span class="remote-cursor-label"></span>';
      el.style.setProperty('--cursor-color', this.colorFor(playerId));
      this.container.appendChild(el);
      entry = {
        el,
        dot: el.querySelector('.remote-cursor-dot'),
        label: el.querySelector('.remote-cursor-label'),
        nickname: nickname || '玩家',
        fromX: 0,
        fromY: 0,
        toX: 0,
        toY: 0,
        t0: 0,
        lastSeen: performance.now(),
        drawing: false
      };
      entry.label.textContent = entry.nickname;
      this.cursors.set(playerId, entry);
      return entry;
    }

    update(playerId, payload) {
      if (playerId === this.selfId) return;
      const entry = this._ensureEntry(playerId, payload.nickname);
      const rect = this.container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = Number(payload.x) * rect.width;
      const y = Number(payload.y) * rect.height;
      entry.fromX = entry.toX;
      entry.fromY = entry.toY;
      entry.toX = x;
      entry.toY = y;
      entry.t0 = performance.now();
      entry.lastSeen = entry.t0;
      entry.drawing = Boolean(payload.drawing);
      entry.el.classList.toggle('is-drawing', entry.drawing);
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
    }

    _startLoop() {
      if (this._raf != null) return;
      this._lastFrame = performance.now();
      this._raf = requestAnimationFrame(this._tick);
    }

    _tick(now) {
      let anyVisible = false;
      this.cursors.forEach((entry, playerId) => {
        if (now - entry.lastSeen > HIDE_MS) {
          entry.el.style.opacity = '0';
          return;
        }
        anyVisible = true;
        const t = clamp01((now - entry.t0) / LERP_MS);
        const x = entry.fromX + (entry.toX - entry.fromX) * t;
        const y = entry.fromY + (entry.toY - entry.fromY) * t;
        entry.el.style.transform = `translate(${x}px, ${y}px)`;
        entry.el.style.opacity = '1';
      });
      if (anyVisible) {
        this._raf = requestAnimationFrame(this._tick);
      } else {
        this._raf = null;
      }
    }
  }

  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  global.CursorOverlay = CursorOverlay;
})(window);
