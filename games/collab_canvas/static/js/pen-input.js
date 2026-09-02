(function (global) {
  'use strict';

  const STORAGE_PEN = 'collabCanvas.penPressure';
  const STORAGE_SENS = 'collabCanvas.penPressureSensitivity';
  const STORAGE_CURVE = 'collabCanvas.penPressureCurve';
  const STORAGE_SPEED = 'collabCanvas.penSpeedCurve';
  const STORAGE_SPEED_FACTOR = 'collabCanvas.penSpeedFactor';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 压感曲线：把 0–1 压力映射为线宽系数。 */
  const PRESSURE_CURVES = {
    linear: t => t,
    easeOutSine: t => Math.sin(t * Math.PI / 2),
    easeInQuad: t => t * t,
    easeOutQuad: t => t * (2 - t),
    easeInOutQuad: t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t)
  };

  /** 数位板/触控笔压感、掌拒与笔侧橡皮；支持可配置压感/速度传感器曲线。 */
  class PenInput {
    constructor(options) {
      const settings = options || {};
      this.getBaseSize = settings.getBaseSize || (() => 5);
      this.onActivity = settings.onActivity || (() => {});
      this.activePenPointers = new Set();
      this.penGuardUntil = 0;
      this.lastPenSample = null;
      this._lastMotionSample = null;
      this.enabled = localStorage.getItem(STORAGE_PEN) !== '0';
      const sens = Number(localStorage.getItem(STORAGE_SENS));
      this.sensitivity = Number.isFinite(sens) ? clamp(sens / 100, 0.25, 2) : 1;
      const curve = localStorage.getItem(STORAGE_CURVE);
      this.pressureCurve = curve && PRESSURE_CURVES[curve] ? curve : 'easeOutSine';
      this.sizeRange = [0.15, 1.0];
      this.useSpeedCurve = localStorage.getItem(STORAGE_SPEED) === '1';
      const speedFactor = Number(localStorage.getItem(STORAGE_SPEED_FACTOR));
      this.speedFactor = Number.isFinite(speedFactor) ? clamp(speedFactor / 100, 0.25, 2) : 1;
    }

    isStylus(event) {
      return Boolean(event && event.pointerType === 'pen');
    }

    isPenEraser(event) {
      if (!event) return false;
      return event.button === 5 || (event.buttons & 32) !== 0;
    }

    markPenActivity(event, extendGuard) {
      if (!this.isStylus(event)) return;
      this.activePenPointers.add(event.pointerId);
      if (extendGuard) this.penGuardUntil = performance.now() + 400;
      this.onActivity(true);
    }

    clearPenPointer(event) {
      if (!event) return;
      this.activePenPointers.delete(event.pointerId);
      if (this.activePenPointers.size === 0) {
        this.penGuardUntil = performance.now() + 300;
        this.onActivity(false);
      }
    }

    shouldIgnorePointer(event, activeDrawPointerId) {
      if (!event || event.isPrimary === false) return true;
      if (this.isStylus(event)) return false;
      const stylusBusy = this.activePenPointers.size > 0 || performance.now() < this.penGuardUntil;
      if (event.pointerType === 'touch' && stylusBusy) return true;
      if (event.pointerType === 'mouse' && stylusBusy) return true;
      if (activeDrawPointerId !== null && event.pointerId !== activeDrawPointerId) return true;
      return false;
    }

    /** 把原始压力经幂函数与曲线映射为 0–1 系数。 */
    _mapPressure(value) {
      let pressure = Number(value);
      if (!Number.isFinite(pressure) || pressure <= 0) pressure = 0.28;
      pressure = clamp(pressure, 0.08, 1);
      const powered = Math.pow(pressure, 1 / clamp(this.sensitivity, 0.25, 2));
      const curveFn = PRESSURE_CURVES[this.pressureCurve] || PRESSURE_CURVES.easeOutSine;
      return curveFn(powered);
    }

    /** 根据指针速度返回线宽倍率（快移变细）。 */
    speedModifier(event) {
      if (!this.useSpeedCurve || !event) return 1;
      const now = performance.now();
      const sample = this._lastMotionSample;
      this._lastMotionSample = { t: now, x: event.clientX, y: event.clientY };
      if (!sample) return 1;
      const dt = Math.max(1, now - sample.t);
      const dist = Math.hypot(event.clientX - sample.x, event.clientY - sample.y);
      const speed = dist / dt;
      return clamp(1 - speed * 0.015 * this.speedFactor, 0.25, 1);
    }

    /** 按压力值换算线宽；isStylus 为 false 时忽略压力返回基础线宽。 */
    sizeForPressure(pressure, isStylus, event) {
      const base = this.getBaseSize();
      const speedMod = this.speedModifier(event);
      if (!this.enabled || !isStylus) {
        return clamp(Math.round(base * speedMod), 1, 128);
      }
      const curved = this._mapPressure(pressure);
      const minF = this.sizeRange[0];
      const maxF = this.sizeRange[1];
      return clamp(Math.round(base * (minF + (maxF - minF) * curved) * speedMod), 1, 128);
    }

    strokeSize(event) {
      return this.sizeForPressure(Number(event && event.pressure), this.isStylus(event), event);
    }

    /** 从已渲染线宽反推 perfect-freehand 压力（用于 segment 回放）。 */
    pressureFromSize(size, isStylus) {
      const base = this.getBaseSize();
      if (!base || !isStylus) return 0.5;
      const minF = this.sizeRange[0];
      const maxF = this.sizeRange[1];
      const ratio = clamp((Number(size) / base - minF) / (maxF - minF), 0, 1);
      return ratio;
    }

    setEnabled(on) {
      this.enabled = Boolean(on);
      localStorage.setItem(STORAGE_PEN, on ? '1' : '0');
    }

    setSensitivity(percent) {
      this.sensitivity = clamp(Number(percent) / 100, 0.25, 2);
      localStorage.setItem(STORAGE_SENS, String(Math.round(this.sensitivity * 100)));
    }

    /** 切换压感曲线名（localStorage 持久化）。 */
    setPressureCurve(name) {
      if (!PRESSURE_CURVES[name]) return;
      this.pressureCurve = name;
      localStorage.setItem(STORAGE_CURVE, name);
    }

    /** 开关速度曲线并持久化。 */
    setUseSpeedCurve(on) {
      this.useSpeedCurve = Boolean(on);
      localStorage.setItem(STORAGE_SPEED, on ? '1' : '0');
    }

    /** 设置速度曲线强度（25–200 映射到内部 0.25–2）。 */
    setSpeedFactor(percent) {
      this.speedFactor = clamp(Number(percent) / 100, 0.25, 2);
      localStorage.setItem(STORAGE_SPEED_FACTOR, String(Math.round(this.speedFactor * 100)));
    }
  }

  global.PenInput = PenInput;
  global.PenPressureCurves = Object.keys(PRESSURE_CURVES);
})(window);
