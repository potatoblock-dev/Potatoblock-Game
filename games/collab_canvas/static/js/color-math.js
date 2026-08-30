(function (global) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 将 0–1 归一化坐标贴边到 0/100%，避免差一点无法取满通道。 */
  function snapUnit(t) {
    const n = clamp(t, 0, 1);
    if (n >= 0.998) return 1;
    if (n <= 0.002) return 0;
    return n;
  }

  /** 将 0–1 归一化坐标转为 0–100 百分比并贴边。 */
  function snapPercent(t) {
    return snapUnit(t) * 100;
  }

  function rgbToHex(r, g, b) {
    const ch = n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
    return '#' + ch(r) + ch(g) + ch(b);
  }

  function hexToRgb(hex) {
    const h = String(hex || '#000000').replace('#', '');
    if (h.length !== 6) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }

  /** RGB 0-255 → HSV 0-360, 0-100, 0-100。 */
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    const s = max === 0 ? 0 : (d / max) * 100;
    return { h, s: s * 100, v: max * 100 };
  }

  /** HSV → RGB hex；满饱和满亮度时用整数扇区避免浮点误差。 */
  function hsvToRgb(h, s, v) {
    s /= 100; v /= 100;
    if (s >= 0.999 && v >= 0.999) {
      return hsvToRgbFull(h);
    }
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    let rp = 0; let gp = 0; let bp = 0;
    if (h < 60) { rp = c; gp = x; }
    else if (h < 120) { rp = x; gp = c; }
    else if (h < 180) { gp = c; bp = x; }
    else if (h < 240) { gp = x; bp = c; }
    else if (h < 300) { rp = x; bp = c; }
    else { rp = c; bp = x; }
    return rgbToHex((rp + m) * 255, (gp + m) * 255, (bp + m) * 255);
  }

  /** 满饱和、满亮度下按色相扇区返回精确 RGB。 */
  function hsvToRgbFull(h) {
    const hue = ((h % 360) + 360) % 360;
    const sector = Math.floor(hue / 60);
    const f = (hue % 60) / 60;
    switch (sector) {
      case 0: return rgbToHex(255, Math.round(f * 255), 0);
      case 1: return rgbToHex(Math.round((1 - f) * 255), 255, 0);
      case 2: return rgbToHex(0, 255, Math.round(f * 255));
      case 3: return rgbToHex(0, Math.round((1 - f) * 255), 255);
      case 4: return rgbToHex(Math.round(f * 255), 0, 255);
      default: return rgbToHex(255, 0, Math.round((1 - f) * 255));
    }
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    let h = 0; let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function hslToRgb(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    if (s === 0) {
      const v = l * 255;
      return rgbToHex(v, v, v);
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = t => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return rgbToHex(hue2rgb(h + 1 / 3) * 255, hue2rgb(h) * 255, hue2rgb(h - 1 / 3) * 255);
  }

  global.ColorMath = { clamp, snapUnit, snapPercent, rgbToHex, hexToRgb, rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb };
})(window);
