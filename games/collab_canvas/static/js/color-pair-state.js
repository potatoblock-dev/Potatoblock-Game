(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-fg-bg-colors-v1';
  const HEX = /^#[0-9a-f]{6}$/;

  /** 主色 / 背景色双槽，持久化到 localStorage。 */
  class ColorPairState {
    constructor(options) {
      const settings = options || {};
      this.onChange = settings.onChange || (() => {});
      this.foreground = '#111827';
      this.background = '#ffffff';
      this.activeSlot = 'fg';
      this._load();
    }

    /** 返回当前编辑槽位的颜色。 */
    getActiveColor() {
      return this.activeSlot === 'bg' ? this.background : this.foreground;
    }

    /** 切换当前编辑主色或背景色。 */
    setActive(slot) {
      this.activeSlot = slot === 'bg' ? 'bg' : 'fg';
      this.onChange(this.getSnapshot());
    }

    /** 写入指定槽位颜色并持久化。 */
    setColor(slot, hex) {
      const next = String(hex || '').toLowerCase();
      if (!HEX.test(next)) return;
      if (slot === 'bg') this.background = next;
      else this.foreground = next;
      this._save();
      this.onChange(this.getSnapshot());
    }

    /** 写入当前编辑槽位颜色。 */
    setActiveColor(hex) {
      this.setColor(this.activeSlot === 'bg' ? 'bg' : 'fg', hex);
    }

    /** 交换主色与背景色。 */
    swap() {
      const tmp = this.foreground;
      this.foreground = this.background;
      this.background = tmp;
      this._save();
      this.onChange(this.getSnapshot());
    }

    getSnapshot() {
      return {
        foreground: this.foreground,
        background: this.background,
        activeSlot: this.activeSlot,
        activeColor: this.getActiveColor()
      };
    }

    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (HEX.test(String(data.foreground || '').toLowerCase())) {
          this.foreground = String(data.foreground).toLowerCase();
        }
        if (HEX.test(String(data.background || '').toLowerCase())) {
          this.background = String(data.background).toLowerCase();
        }
      } catch (_err) {}
    }

    _save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          foreground: this.foreground,
          background: this.background
        }));
      } catch (_err) {}
    }
  }

  global.ColorPairState = ColorPairState;
})(window);
