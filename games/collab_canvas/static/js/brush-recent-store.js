(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-brush-recents-v1';
  const STORAGE_ACTIVE_KEY = 'collab-brush-active-v1';
  const MAX_RECENT = 8;

  /** 记录最近使用的笔刷预设 id（localStorage 持久化，供笔刷库「最近使用」分组）。 */
  class BrushRecentStore {
    constructor() {
      this._ids = [];
      this._activeId = '';
      this._load();
      BrushRecentStore.instance = this;
    }

    /** 返回最近使用预设 id 数组（新→旧）。 */
    getRecent() {
      return this._ids.slice();
    }

    /** 记录一次使用；重复使用会置顶，超上限裁掉最旧。 */
    push(presetId) {
      const id = String(presetId || '');
      if (!id) return;
      const next = this._ids.filter(existing => existing !== id);
      next.unshift(id);
      this._ids = next.slice(0, MAX_RECENT);
      this._activeId = id;
      this._save();
    }

    /** 上次激活的预设 id（刷新后恢复用）。 */
    getActive() {
      return this._activeId;
    }

    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this._ids = parsed.slice(0, MAX_RECENT);
      } catch (_err) {}
      try {
        this._activeId = localStorage.getItem(STORAGE_ACTIVE_KEY) || '';
      } catch (_err) {}
    }

    _save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this._ids));
        localStorage.setItem(STORAGE_ACTIVE_KEY, this._activeId || '');
      } catch (_err) {}
    }
  }

  BrushRecentStore.MAX_RECENT = MAX_RECENT;
  global.BrushRecentStore = BrushRecentStore;
})(window);
