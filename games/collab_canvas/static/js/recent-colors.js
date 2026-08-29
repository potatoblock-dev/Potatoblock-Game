(function (global) {
  'use strict';

  const COLORS_KEY = 'collab-recent-colors-v1';
  const ORDER_KEY = 'collab-recent-colors-order-v1';
  const LIMIT_KEY = 'collab-recent-colors-limit-v1';
  const DEFAULT_LIMIT = 12;
  const MIN_LIMIT = 2;
  const MAX_LIMIT = 24;
  const HEX = /^#[0-9a-f]{6}$/;
  const clampLimit = n => Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(Number(n) || DEFAULT_LIMIT)));

  /** 最近使用颜色 FIFO、排序与缓存上限（Krita 风轮盘等分）。 */
  class RecentColors {
    constructor(options) {
      const settings = options || {};
      this.onChange = settings.onChange || (() => {});
      this._colors = [];
      this._order = 'recency';
      this._maxLimit = DEFAULT_LIMIT;
      this._load();
    }

    getOrder() {
      return this._order;
    }

    /** 最近色缓存上限（2–24，默认 12）。 */
    getMaxLimit() {
      return this._maxLimit;
    }

    /** 设置外环展示排序：recency | hsv。 */
    setOrder(order) {
      const next = order === 'hsv' ? 'hsv' : 'recency';
      if (next === this._order) return;
      this._order = next;
      try {
        localStorage.setItem(ORDER_KEY, next);
      } catch (_err) {}
      this.onChange(this.getDisplayColors());
    }

    /** 调整缓存上限并截断超出项。 */
    setMaxLimit(limit) {
      const next = clampLimit(limit);
      if (next === this._maxLimit) return;
      this._maxLimit = next;
      try {
        localStorage.setItem(LIMIT_KEY, String(next));
      } catch (_err) {}
      if (this._colors.length > next) {
        this._colors = this._colors.slice(0, next);
        this._save();
      }
      this.onChange(this.getDisplayColors());
    }

    /** 记录一次取色（去重后插到最前）。 */
    push(hex) {
      const next = String(hex || '').toLowerCase();
      if (!HEX.test(next)) return;
      this._colors = this._colors.filter(c => c !== next);
      this._colors.unshift(next);
      if (this._colors.length > this._maxLimit) {
        this._colors = this._colors.slice(0, this._maxLimit);
      }
      this._save();
      this.onChange(this.getDisplayColors());
    }

    /** 返回轮盘等分用的颜色列表（仅已有项，无空槽）。 */
    getDisplayColors() {
      const list = this._uniqueColors().slice(0, this._maxLimit);
      if (this._order === 'hsv') {
        list.sort((a, b) => {
          const ha = ColorMath.rgbToHsv(...Object.values(ColorMath.hexToRgb(a)));
          const hb = ColorMath.rgbToHsv(...Object.values(ColorMath.hexToRgb(b)));
          if (ha.h !== hb.h) return ha.h - hb.h;
          if (ha.s !== hb.s) return ha.s - hb.s;
          return ha.v - hb.v;
        });
      }
      return list;
    }

    /** 去重并保持写入顺序。 */
    _uniqueColors() {
      const seen = new Set();
      const out = [];
      this._colors.forEach(c => {
        if (!c || seen.has(c)) return;
        seen.add(c);
        out.push(c);
      });
      return out;
    }

    _load() {
      try {
        const order = localStorage.getItem(ORDER_KEY);
        if (order === 'hsv' || order === 'recency') this._order = order;
        const limitRaw = localStorage.getItem(LIMIT_KEY);
        if (limitRaw != null) this._maxLimit = clampLimit(limitRaw);
        const raw = localStorage.getItem(COLORS_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!Array.isArray(saved)) return;
        this._colors = saved.filter(c => HEX.test(String(c || '').toLowerCase()));
        this._colors = this._uniqueColors().slice(0, this._maxLimit);
      } catch (_err) {}
    }

    _save() {
      try {
        localStorage.setItem(COLORS_KEY, JSON.stringify(this._colors));
      } catch (_err) {}
    }
  }

  global.RecentColors = RecentColors;
  global.RecentColorsStorage = { COLORS_KEY, ORDER_KEY, LIMIT_KEY };
  global.RecentColorsLimits = { DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT };
})(window);
