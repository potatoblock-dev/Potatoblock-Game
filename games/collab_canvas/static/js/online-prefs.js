(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-online-label-color-v1';
  const DISPLAY_NAME_KEY = 'collab-online-display-name-v1';
  const USE_PASSPORT_KEY = 'collab-online-use-passport-name-v1';
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const MAX_DISPLAY_NAME_LEN = 24;

  /** 根据相对亮度返回黑或白文字色。 */
  function contrastText(color) {
    const raw = String(color || '');
    if (HEX_RE.test(raw)) {
      const r = parseInt(raw.slice(1, 3), 16);
      const g = parseInt(raw.slice(3, 5), 16);
      const b = parseInt(raw.slice(5, 7), 16);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return lum > 0.55 ? '#111827' : '#ffffff';
    }
    const hslMatch = raw.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/i);
    if (hslMatch) {
      const lightness = Number(hslMatch[3]) / 100;
      return lightness > 0.55 ? '#111827' : '#ffffff';
    }
    return '#ffffff';
  }

  /** 无自定义色时按玩家 id 生成稳定色相。 */
  function defaultLabelColor(playerId) {
    let hash = 0;
    const text = String(playerId || '');
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return 'hsl(' + (hash % 360) + ' 75% 55%)';
  }

  /** 联机展示偏好：用户名、标签底色（仅合作画板，localStorage 持久化）。 */
  class OnlinePrefs {
    constructor() {
      this._labelColor = '';
      this._customDisplayName = '';
      this._usePassportName = true;
      this._load();
    }

    getCustomDisplayName() {
      return this._customDisplayName;
    }

    /** 是否优先显示通行证用户名（否则用自定义名）。 */
    getUsePassportName() {
      return this._usePassportName;
    }

    setCustomDisplayName(name) {
      const next = String(name || '').trim().slice(0, MAX_DISPLAY_NAME_LEN);
      if (next === this._customDisplayName) return;
      this._customDisplayName = next;
      this._saveDisplayName();
      this._notify();
    }

    setUsePassportName(usePassport) {
      const next = Boolean(usePassport);
      if (next === this._usePassportName) return;
      this._usePassportName = next;
      this._saveUsePassport();
      this._notify();
    }

    /** 解析当前应上送/展示的用户名。 */
    resolveDisplayName(passportNickname) {
      const passport = String(passportNickname || '').trim().slice(0, MAX_DISPLAY_NAME_LEN);
      if (this._usePassportName) {
        return passport || this._customDisplayName || '玩家';
      }
      return this._customDisplayName || passport || '玩家';
    }

    getLabelColor() {
      return this._labelColor;
    }

    /** 返回要上送的 hex 标签色；未设置则空字符串。 */
    getWireLabelColor() {
      return HEX_RE.test(this._labelColor) ? this._labelColor.toLowerCase() : '';
    }

    setLabelColor(color) {
      const next = HEX_RE.test(color || '') ? color.toLowerCase() : '';
      this._labelColor = next;
      this._saveLabelColor();
      this._notify();
    }

    resetLabelColor() {
      this.setLabelColor('');
    }

    _notify() {
      if (typeof this.onChange === 'function') this.onChange();
    }

    /** 解析远端或本地的标签底色。 */
    resolveLabelColor(playerId, wireColor) {
      if (HEX_RE.test(wireColor || '')) return wireColor.toLowerCase();
      return defaultLabelColor(playerId);
    }

    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw && HEX_RE.test(raw)) this._labelColor = raw.toLowerCase();
      } catch (_err) {}
      try {
        const nameRaw = localStorage.getItem(DISPLAY_NAME_KEY);
        if (nameRaw) this._customDisplayName = String(nameRaw).trim().slice(0, MAX_DISPLAY_NAME_LEN);
      } catch (_err) {}
      try {
        const flag = localStorage.getItem(USE_PASSPORT_KEY);
        if (flag === '0') this._usePassportName = false;
        else if (flag === '1') this._usePassportName = true;
      } catch (_err) {}
    }

    _saveLabelColor() {
      try {
        if (this._labelColor) localStorage.setItem(STORAGE_KEY, this._labelColor);
        else localStorage.removeItem(STORAGE_KEY);
      } catch (_err) {}
    }

    _saveDisplayName() {
      try {
        if (this._customDisplayName) localStorage.setItem(DISPLAY_NAME_KEY, this._customDisplayName);
        else localStorage.removeItem(DISPLAY_NAME_KEY);
      } catch (_err) {}
    }

    _saveUsePassport() {
      try {
        localStorage.setItem(USE_PASSPORT_KEY, this._usePassportName ? '1' : '0');
      } catch (_err) {}
    }
  }

  global.OnlinePrefs = OnlinePrefs;
  global.contrastText = contrastText;
  global.defaultLabelColor = defaultLabelColor;
})(window);
