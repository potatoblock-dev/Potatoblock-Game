(function (global) {
  'use strict';

  const MODES = ColorSettings.MODES;

  /** 多模式取色器（HSV / 色轮 / RGB / HSL），含 hex 预览。 */
  class ColorPicker {
    constructor(mount, options) {
      const settings = options || {};
      this.mount = mount;
      this.onChange = settings.onChange || (() => {});
      this.onCommit = settings.onCommit || (() => {});
      this.onModeChange = settings.onModeChange || (() => {});
      this.color = String(settings.initialColor || '#111827').toLowerCase();
      this.mode = ColorSettings.loadMode('hsv');
      this.surface = null;
      this._buildDom();
      this._mountSurface();
      this._syncPreview(false);
    }

    _saveMode() {
      ColorSettings.saveMode(this.mode);
    }

    _buildDom() {
      if (!this.mount) return;
      this.mount.innerHTML = '';
      const root = document.createElement('div');
      root.className = 'color-picker-root';
      root.innerHTML = `
        <div class="color-swatch-preview">
          <div class="color-swatch-box" data-preview></div>
          <input class="color-hex-input" type="text" maxlength="7" data-hex aria-label="颜色 hex">
        </div>
        <div data-mode-body></div>`;
      this.mount.appendChild(root);
      this.preview = root.querySelector('[data-preview]');
      this.hexInput = root.querySelector('[data-hex]');
      this.modeBody = root.querySelector('[data-mode-body]');
      this.hexInput.addEventListener('change', () => this._applyHex(this.hexInput.value));
      this.hexInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') this._applyHex(this.hexInput.value);
      });
    }

    _mountSurface() {
      if (!this.modeBody) return;
      this.surface = new ColorPickerSurface(this.modeBody, {
        mode: this.mode,
        color: this.color,
        compact: false,
        onChange: hex => {
          this.color = hex;
          this._syncPreview(false);
          this.onChange(this.color);
        },
        onCommit: hex => {
          this.onCommit(hex);
        }
      });
    }

    setColor(hex) {
      const next = String(hex || '').toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(next)) return;
      this.color = next;
      if (this.surface) this.surface.setColor(this.color);
      this._syncPreview(false);
    }

    getColor() {
      return this.color;
    }

    getMode() {
      return this.mode;
    }

    /** 切换取色 UI 模式并持久化。 */
    setMode(mode) {
      if (!MODES.includes(mode) || mode === this.mode) return;
      this.mode = mode;
      this._saveMode();
      if (this.surface) this.surface.setMode(mode);
      this.onModeChange(this.mode);
    }

    _applyHex(text) {
      let hex = String(text || '').trim().toLowerCase();
      if (!hex.startsWith('#')) hex = '#' + hex;
      if (!/^#[0-9a-f]{6}$/.test(hex)) {
        this.hexInput.value = this.color;
        return;
      }
      this.setColor(hex);
      this.onChange(this.color);
      this.onCommit(this.color);
    }

    _syncPreview(emit) {
      if (this.preview) this.preview.style.background = this.color;
      if (this.hexInput) this.hexInput.value = this.color;
      if (emit !== false) this.onChange(this.color);
    }
  }

  global.ColorPicker = ColorPicker;
})(window);
