(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-ui-prefs-v1';

  /** 本机 UI 偏好（不影响联机；localStorage 持久化）。 */
  class UiPrefs {
    constructor() {
      this._swapSidebars = false;
      this._gesturesEnabled = true;
      this._listeners = [];
      this._load();
    }

    /** 从 localStorage 恢复偏好。 */
    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        this._swapSidebars = Boolean(data.swapSidebars);
        this._gesturesEnabled = data.gesturesEnabled !== false;
      } catch (_err) {}
    }

    /** 写入 localStorage。 */
    _save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          swapSidebars: this._swapSidebars,
          gesturesEnabled: this._gesturesEnabled
        }));
      } catch (_err) {}
    }

    getSwapSidebars() {
      return this._swapSidebars;
    }

    /** 切换左右栏视觉位置；DOM 挂载不变，仅加工作区 class。 */
    setSwapSidebars(on) {
      const next = Boolean(on);
      const changed = next !== this._swapSidebars;
      this._swapSidebars = next;
      if (changed) this._save();
      this.applyToWorkspace();
      if (changed) this._notify();
    }

    /** 是否启用多指画布手势。 */
    getGesturesEnabled() {
      return this._gesturesEnabled;
    }

    /** 开关多指画布手势并持久化。 */
    setGesturesEnabled(on) {
      const next = Boolean(on);
      const changed = next !== this._gesturesEnabled;
      this._gesturesEnabled = next;
      if (changed) this._save();
      if (changed) this._notify();
    }

    onChange(fn) {
      if (typeof fn === 'function') this._listeners.push(fn);
    }

    _notify() {
      this._listeners.forEach(fn => {
        try { fn(this); } catch (_err) {}
      });
    }

    /** 将偏好应用到工作区根节点。 */
    applyToWorkspace(root) {
      const el = root || document.getElementById('collabWorkspace');
      if (!el) return;
      el.classList.toggle('is-sides-swapped', this._swapSidebars);
    }

    /** 当前工作区是否处于左右栏对调状态。 */
    isWorkspaceSwapped() {
      const el = document.getElementById('collabWorkspace');
      return Boolean(el && el.classList.contains('is-sides-swapped'));
    }
  }

  global.UiPrefs = UiPrefs;
})(window);
