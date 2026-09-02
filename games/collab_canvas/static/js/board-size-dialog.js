(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-board-size-v1';
  const MIN = 256;
  const MAX = 8192;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 预设：id / 名称 / 宽高（纵向默认），locked 表示锁定比例。 */
  const PRESETS = [
    { id: 'a4', label: 'A4', width: 2480, height: 3508, locked: true },
    { id: 'a5', label: 'A5', width: 1748, height: 2480, locked: true },
    { id: 'r43', label: '4:3', width: 1920, height: 1440, locked: true },
    { id: 'r169', label: '16:9', width: 1920, height: 1080, locked: true }
  ];

  /**
   * 新建画板尺寸配置弹窗：预设 + 自定义像素 + 锁比例 + 高宽对调 + 记忆上次选项。
   * onConfirm({width, height}) 确认；onCancel 关闭。
   */
  class BoardSizeDialog {
    constructor(options) {
      const settings = options || {};
      this.onConfirm = settings.onConfirm || (() => {});
      this.onCancel = settings.onCancel || (() => {});
      this._el = null;
      this._state = this._load();
    }

    get isOpen() { return Boolean(this._el); }

    open() {
      this.close();
      this._el = document.createElement('div');
      this._el.className = 'board-size-backdrop';
      this._el.innerHTML = this._template();
      document.body.appendChild(this._el);
      this._bind();
      this._render();
      this._onDocKey = event => { if (event.key === 'Escape') this.close(); };
      document.addEventListener('keydown', this._onDocKey, true);
    }

    close() {
      if (!this._el) return;
      if (this._onDocKey) document.removeEventListener('keydown', this._onDocKey, true);
      if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
      this._el = null;
      this.onCancel();
    }

    _template() {
      return ''
        + '<div class="board-size-panel">'
        +   '<div class="board-size-header">'
        +     '<span class="board-size-title">新建画板尺寸</span>'
        +     '<button type="button" class="board-size-close" data-bs-close title="关闭">'
        +       '<span class="material-symbols-outlined" aria-hidden="true">close</span>'
        +     '</button>'
        +   '</div>'
        +   '<div class="board-size-body">'
        +     '<div class="board-size-group">'
        +       '<div class="board-size-group-title">预设</div>'
        +       '<div class="board-size-presets" data-bs-presets></div>'
        +     '</div>'
        +     '<div class="board-size-group">'
        +       '<div class="board-size-group-title">自定义(像素)</div>'
        +       '<div class="board-size-dims">'
        +         '<label class="board-size-dim">'
        +           '<span>宽</span>'
        +           '<input type="number" min="' + MIN + '" max="' + MAX + '" step="1" data-bs-width>'
        +         '</label>'
        +         '<button type="button" class="board-size-swap" data-bs-swap title="高宽对调">'
        +           '<span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span>'
        +         '</button>'
        +         '<label class="board-size-dim">'
        +           '<span>高</span>'
        +           '<input type="number" min="' + MIN + '" max="' + MAX + '" step="1" data-bs-height>'
        +         '</label>'
        +       '</div>'
        +       '<label class="board-size-lock">'
        +         '<input type="checkbox" data-bs-lock>'
        +         '<span>锁定比例</span>'
        +       '</label>'
        +       '<p class="board-size-hint">自定义像素范围 ' + MIN + ' ~ ' + MAX + '；开启锁定比例后修改一边会自动缩放另一边。</p>'
        +     '</div>'
        +   '</div>'
        +   '<div class="board-size-footer">'
        +     '<button type="button" class="board-size-cancel" data-bs-cancel>取消</button>'
        +     '<button type="button" class="board-size-create" data-bs-create>创建画板</button>'
        +   '</div>'
        + '</div>';
    }

    _bind() {
      const closeBtn = this._el.querySelector('[data-bs-close]');
      if (closeBtn) closeBtn.addEventListener('click', () => this.close());
      const cancelBtn = this._el.querySelector('[data-bs-cancel]');
      if (cancelBtn) cancelBtn.addEventListener('click', () => this.close());
      const createBtn = this._el.querySelector('[data-bs-create]');
      if (createBtn) createBtn.addEventListener('click', () => this._confirm());
      const swapBtn = this._el.querySelector('[data-bs-swap]');
      if (swapBtn) swapBtn.addEventListener('click', () => {
        const w = this._state.width;
        this._state.width = this._state.height;
        this._state.height = w;
        this._render();
      });
      const width = this._el.querySelector('[data-bs-width]');
      const height = this._el.querySelector('[data-bs-height]');
      if (width) width.addEventListener('input', () => {
        this._state.width = clamp(Number(width.value) || MIN, MIN, MAX);
        if (width.value !== String(this._state.width)) width.value = String(this._state.width);
        if (this._state.locked) this._linkFromWidth();
        this._render(); // 更新比例与高
      });
      if (height) height.addEventListener('input', () => {
        this._state.height = clamp(Number(height.value) || MIN, MIN, MAX);
        if (height.value !== String(this._state.height)) height.value = String(this._state.height);
        if (this._state.locked) this._linkFromHeight();
        this._render();
      });
      const lock = this._el.querySelector('[data-bs-lock]');
      if (lock) lock.addEventListener('change', () => {
        this._state.locked = lock.checked;
        // 开启锁比例时记录当前比例
        this._state.ratio = this._state.width / this._state.height;
      });
      const presets = this._el.querySelector('[data-bs-presets]');
      if (presets) presets.addEventListener('click', event => {
        const btn = event.target.closest('[data-bs-preset]');
        if (!btn) return;
        const preset = PRESETS.find(p => p.id === btn.dataset.bsPreset);
        if (!preset) return;
        this._state.presetId = preset.id;
        this._state.width = preset.width;
        this._state.height = preset.height;
        this._state.locked = preset.locked;
        this._state.ratio = preset.width / preset.height;
        this._render();
      });
    }

    _linkFromWidth() {
      if (!this._state.ratio) this._state.ratio = this._state.width / this._state.height;
      this._state.height = Math.round(this._state.width / this._state.ratio);
      this._state.height = clamp(this._state.height, MIN, MAX);
    }

    _linkFromHeight() {
      if (!this._state.ratio) this._state.ratio = this._state.width / this._state.height;
      this._state.width = Math.round(this._state.height * this._state.ratio);
      this._state.width = clamp(this._state.width, MIN, MAX);
    }

    _confirm() {
      const width = clamp(this._state.width || 1920, MIN, MAX);
      const height = clamp(this._state.height || 1080, MIN, MAX);
      this._save(width, height);
      this.close();
      this.onConfirm({ width, height });
    }

    _render() {
      const presets = this._el.querySelector('[data-bs-presets]');
      if (presets) {
        presets.innerHTML = '';
        PRESETS.forEach(preset => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'board-size-preset' + (preset.id === this._state.presetId ? ' is-active' : '');
          btn.dataset.bsPreset = preset.id;
          const name = document.createElement('span');
          name.textContent = preset.label;
          const dim = document.createElement('span');
          dim.className = 'board-size-preset-dim';
          dim.textContent = preset.width + ' × ' + preset.height;
          btn.appendChild(name);
          btn.appendChild(dim);
          presets.appendChild(btn);
        });
      }
      const width = this._el.querySelector('[data-bs-width]');
      const height = this._el.querySelector('[data-bs-height]');
      if (width) width.value = String(this._state.width);
      if (height) height.value = String(this._state.height);
      const lock = this._el.querySelector('[data-bs-lock]');
      if (lock) lock.checked = Boolean(this._state.locked);
    }

    _load() {
      const state = {
        presetId: 'r169',
        width: 1920,
        height: 1080,
        locked: true,
        ratio: 1920 / 1080
      };
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed) Object.assign(state, parsed);
        }
      } catch (_err) {}
      if (!state.ratio) state.ratio = state.width / state.height;
      return state;
    }

    _save(width, height) {
      const state = {
        presetId: this._state.presetId,
        width,
        height,
        locked: Boolean(this._state.locked),
        ratio: width / height
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (_err) {}
    }
  }

  global.BoardSizeDialog = BoardSizeDialog;
})(window);
