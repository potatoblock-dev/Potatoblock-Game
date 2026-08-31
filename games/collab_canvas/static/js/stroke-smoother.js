(function (global) {
  'use strict';

  const STORAGE_ENABLED = 'collabCanvas.debounceEnabled';
  const STORAGE_LEVEL = 'collabCanvas.debounceLevel';
  const MAX_LEVEL = 5;
  const DEFAULT_LEVEL = 2;
  /** 吸收阈值（归一化坐标）：输出点与上一输出点间距小于该值则吞掉，减少冗余线段。 */
  const ABSORB_DIST = 0.0004;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * 笔画防抖（轨迹平滑）：滑动窗口均值 + 近点吸收。
   * 级数越高窗口越大，笔画越平滑，跟手延迟略增。
   *
   * 动态防抖（预留）：setBoost(true) 时有效级数临时提到 MAX_LEVEL，
   * 不持久化；未来可由「按住某按键」或工具栏开关 UI 触发，
   * 监听 onBoostChange 即可同步 UI 状态。
   */
  class StrokeSmoother {
    constructor(options) {
      const settings = options || {};
      this._enabled = localStorage.getItem(STORAGE_ENABLED) !== '0';
      const storedLevel = Number(localStorage.getItem(STORAGE_LEVEL));
      this._level = localStorage.getItem(STORAGE_LEVEL) != null && Number.isFinite(storedLevel)
        ? clamp(Math.round(storedLevel), 1, MAX_LEVEL)
        : DEFAULT_LEVEL;
      this._boost = false;
      this._window = [];
      this._lastOut = null;
      this.onChange = settings.onChange || (() => {});
      this.onBoostChange = settings.onBoostChange || (() => {});
    }

    get enabled() {
      return this._enabled;
    }

    /** 开关防抖（持久化）。 */
    setEnabled(on) {
      const next = Boolean(on);
      const changed = next !== this._enabled;
      this._enabled = next;
      if (changed) {
        try {
          localStorage.setItem(STORAGE_ENABLED, next ? '1' : '0');
        } catch (_err) {}
        this.onChange(this);
      }
    }

    get level() {
      return this._level;
    }

    /** 设置防抖级数 1..MAX_LEVEL（持久化）。 */
    setLevel(level) {
      const next = clamp(Math.round(Number(level) || 0), 1, MAX_LEVEL);
      const changed = next !== this._level;
      this._level = next;
      if (changed) {
        try {
          localStorage.setItem(STORAGE_LEVEL, String(next));
        } catch (_err) {}
        this.onChange(this);
      }
    }

    /** 动态防抖是否开启（最高级数）。 */
    get boost() {
      return this._boost;
    }

    /** 开启动态防抖（不持久化，配合按键按住 / 开关 UI 使用）。 */
    setBoost(on) {
      const next = Boolean(on);
      if (next === this._boost) return;
      this._boost = next;
      this.onBoostChange(this);
    }

    /** 当前有效级数：0 = 关闭；1..MAX_LEVEL；动态防抖时为 MAX_LEVEL。 */
    effectiveLevel() {
      if (this._boost) return MAX_LEVEL;
      return this._enabled ? this._level : 0;
    }

    /** 供测试画板 / 设置 UI 显示的状态文案。 */
    statusLabel() {
      const level = this.effectiveLevel();
      if (level <= 0) return '关闭';
      return this._boost ? '最高（动态）' : level + ' 级';
    }

    /** 清空平滑窗口，开始/结束一笔时调用。 */
    reset() {
      this._window.length = 0;
      this._lastOut = null;
    }

    /**
     * 输入原始点，返回平滑后的点 {x, y, pressure}；
     * pressure 为窗口内笔压均值（无笔压输入时传 null，输出亦为 null）。
     * 返回 null 表示该点被吸收（未达到输出间距），调用方应跳过。
     */
    push(x, y, pressure) {
      const level = this.effectiveLevel();
      if (level <= 0) return { x, y, pressure: Number.isFinite(pressure) ? pressure : null };

      this._window.push({ x, y, pressure: Number.isFinite(pressure) ? pressure : null });
      const windowSize = 1 + Math.round(level * 1.5);
      while (this._window.length > windowSize) this._window.shift();

      let sumX = 0;
      let sumY = 0;
      let sumPressure = 0;
      let penCount = 0;
      for (let i = 0; i < this._window.length; i += 1) {
        const point = this._window[i];
        sumX += point.x;
        sumY += point.y;
        if (point.pressure != null) {
          sumPressure += point.pressure;
          penCount += 1;
        }
      }
      const count = this._window.length;
      const out = {
        x: sumX / count,
        y: sumY / count,
        pressure: penCount ? sumPressure / penCount : null
      };
      if (this._lastOut) {
        const dx = out.x - this._lastOut.x;
        const dy = out.y - this._lastOut.y;
        if (dx * dx + dy * dy < ABSORB_DIST * ABSORB_DIST) return null;
      }
      this._lastOut = out;
      return out;
    }
  }

  StrokeSmoother.MAX_LEVEL = MAX_LEVEL;
  global.StrokeSmoother = StrokeSmoother;
})(window);
