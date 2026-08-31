(function (global) {
  'use strict';

  const STORAGE_PEN = 'collabCanvas.penPressure';
  const STORAGE_SENS = 'collabCanvas.penPressureSensitivity';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 数位板/触控笔压感、掌拒与笔侧橡皮。 */
  class PenInput {
    constructor(options) {
      const settings = options || {};
      this.getBaseSize = settings.getBaseSize || (() => 5);
      this.onActivity = settings.onActivity || (() => {});
      this.activePenPointers = new Set();
      this.penGuardUntil = 0;
      this.lastPenSample = null;
      this.enabled = localStorage.getItem(STORAGE_PEN) !== '0';
      const sens = Number(localStorage.getItem(STORAGE_SENS));
      this.sensitivity = Number.isFinite(sens) ? clamp(sens / 100, 0.25, 2) : 1;
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

    /** 按压力值换算线宽；isStylus 为 false 时忽略压力返回基础线宽。 */
    sizeForPressure(pressure, isStylus) {
      const base = this.getBaseSize();
      if (!this.enabled || !isStylus) return base;
      let value = Number(pressure);
      if (!Number.isFinite(value) || value <= 0) value = 0.28;
      value = clamp(value, 0.08, 1);
      const curved = Math.pow(value, 1 / clamp(this.sensitivity, 0.25, 2));
      return clamp(Math.round(base * (0.15 + 0.85 * curved)), 1, 128);
    }

    strokeSize(event) {
      return this.sizeForPressure(Number(event && event.pressure), this.isStylus(event));
    }

    setEnabled(on) {
      this.enabled = Boolean(on);
      localStorage.setItem(STORAGE_PEN, on ? '1' : '0');
    }

    setSensitivity(percent) {
      this.sensitivity = clamp(Number(percent) / 100, 0.25, 2);
      localStorage.setItem(STORAGE_SENS, String(Math.round(this.sensitivity * 100)));
    }
  }

  global.PenInput = PenInput;
})(window);
