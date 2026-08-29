(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-tool-variants-v1';

  /** 持久化各 flyout 工具组上次选用的变体。 */
  class ToolVariantStore {
    constructor() {
      this._data = {};
      this._load();
    }

    get(groupId) {
      return this._data[String(groupId || '')] || '';
    }

    set(groupId, toolId) {
      const gid = String(groupId || '');
      const tid = String(toolId || '');
      if (!gid || !tid) return;
      this._data[gid] = tid;
      this._save();
    }

    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') this._data = parsed;
      } catch (_err) {}
    }

    _save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
      } catch (_err) {}
    }
  }

  global.ToolVariantStore = ToolVariantStore;
})(window);
