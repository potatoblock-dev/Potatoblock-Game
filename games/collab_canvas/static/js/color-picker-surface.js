(function (global) {
  'use strict';

  const WHEEL_SIZE = { normal: 160, compact: 120 };
  const MODES = ColorSettings.MODES;

  /** 可嵌入的取色 UI（HSV / 色轮 / RGB / HSL），供 dock 与轮盘复用。 */
  class ColorPickerSurface {
    constructor(mount, options) {
      const settings = options || {};
      this.mount = mount;
      this.mode = MODES.includes(settings.mode) ? settings.mode : 'hsv';
      this.compact = Boolean(settings.compact);
      this.showRgbSliders = Boolean(settings.showRgbSliders);
      this.onChange = settings.onChange || (() => {});
      this.onCommit = settings.onCommit || (() => {});
      this.color = String(settings.color || '#111827').toLowerCase();
      this._hsv = ColorMath.rgbToHsv(...Object.values(ColorMath.hexToRgb(this.color)));
      this._renderMode();
      this._syncFromColor(false);
      requestAnimationFrame(() => this._syncFromColor(false));
    }

    getColor() {
      return this.color;
    }

    getMode() {
      return this.mode;
    }

    /** 切换 UI 模式并重建控件。 */
    setMode(mode) {
      if (!MODES.includes(mode) || mode === this.mode) return;
      this.mode = mode;
      this._renderMode();
      this._syncFromColor(false);
    }

    /** 外部设置颜色并刷新控件。 */
    setColor(hex) {
      const next = String(hex || '').toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(next)) return;
      this.color = next;
      this._hsv = ColorMath.rgbToHsv(...Object.values(ColorMath.hexToRgb(this.color)));
      this._syncFromColor(false);
    }

    _emit() {
      this.onChange(this.color);
    }

    _syncFromColor(emit) {
      if (emit !== false) this._emit();
      if (this.mode === 'hsv') {
        this._paintHsv();
        if (this.showRgbSliders) this._syncRgbChannelSliders();
      }
      if (this.mode === 'wheel') this._paintWheel();
      if (this.mode === 'rgb') this._syncRgbSliders();
      if (this.mode === 'hsl') this._syncHslSliders();
    }

    _renderMode() {
      if (!this.mount) return;
      this.mount.innerHTML = '';
      this._rgbChannelSliders = null;
      this._rgbRangeInputs = null;
      this._rgbNumberInputs = null;
      this._channelSliders = null;
      this._sliderInputs = null;
      this._numberInputs = null;
      this.mount.classList.toggle('is-compact', this.compact);
      if (this.mode === 'hsv') {
        this.mount.innerHTML =
          '<div class="color-sv-area" data-sv>' +
          '<span class="color-sv-cursor" data-sv-cursor aria-hidden="true"></span></div>' +
          '<div class="color-hue-bar" data-hue>' +
          '<span class="color-hue-cursor" data-hue-cursor aria-hidden="true"></span></div>';
        this.svArea = this.mount.querySelector('[data-sv]');
        this.hueBar = this.mount.querySelector('[data-hue]');
        this.svCursor = this.mount.querySelector('[data-sv-cursor]');
        this.hueCursor = this.mount.querySelector('[data-hue-cursor]');
        this._bindSv(this.svArea, () => this._hsv, (h, s, v) => {
          this._hsv = { h, s, v };
          this.color = ColorMath.hsvToRgb(h, s, v);
        });
        this._bindHueBar(this.hueBar);
        if (this.showRgbSliders) this._mountRgbChannelSliders();
        return;
      }
      if (this.mode === 'wheel') {
        const wrap = document.createElement('div');
        wrap.className = 'color-wheel-wrap';
        const stage = document.createElement('div');
        stage.className = 'color-wheel-stage';
        const size = this.compact ? WHEEL_SIZE.compact : WHEEL_SIZE.normal;
        this.wheelCanvas = document.createElement('canvas');
        this.wheelCanvas.className = 'color-wheel-canvas';
        this.wheelCanvas.width = size;
        this.wheelCanvas.height = size;
        this.wheelCursor = document.createElement('span');
        this.wheelCursor.className = 'color-wheel-cursor';
        this.wheelCursor.setAttribute('aria-hidden', 'true');
        stage.appendChild(this.wheelCanvas);
        stage.appendChild(this.wheelCursor);
        wrap.appendChild(stage);
        this.mount.appendChild(wrap);
        this._bindWheel(this.wheelCanvas);
        return;
      }
      if (this.mode === 'rgb' || this.mode === 'hsl') {
        this._mountChannelSliders(this.mode === 'rgb' ? ['R', 'G', 'B'] : ['H', 'S', 'L']);
      }
    }

    /** 在 HSV 模式下追加 RGB 滑块 + 数字输入。 */
    _mountRgbChannelSliders() {
      if (this._rgbChannelSliders) return;
      this._mountChannelSliders(['R', 'G', 'B'], true);
    }

    /** 创建通道滑块行（RGB / HSL 或 HSV 下的 RGB 附加区）。 */
    _mountChannelSliders(labels, rgbUnderHsv) {
      const sliders = document.createElement('div');
      sliders.className = 'color-sliders' + (rgbUnderHsv ? ' color-rgb-under-hsv' : '');
      labels.forEach(label => {
        const row = document.createElement('div');
        row.className = 'color-slider-row';
        row.innerHTML = `<label>${label}</label><input type="range" min="0" max="255"><input type="number" min="0" max="255">`;
        sliders.appendChild(row);
      });
      this.mount.appendChild(sliders);
      const rangeInputs = sliders.querySelectorAll('input[type=range]');
      const numberInputs = sliders.querySelectorAll('input[type=number]');
      if (rgbUnderHsv) {
        this._rgbChannelSliders = sliders;
        this._rgbRangeInputs = rangeInputs;
        this._rgbNumberInputs = numberInputs;
      } else {
        this._channelSliders = sliders;
        this._sliderInputs = rangeInputs;
        this._numberInputs = numberInputs;
      }
      if (this.mode === 'hsl') {
        rangeInputs[0].max = '360';
        numberInputs[0].max = '360';
        rangeInputs[1].max = '100';
        numberInputs[1].max = '100';
        rangeInputs[2].max = '100';
        numberInputs[2].max = '100';
      }
      rangeInputs.forEach((input, i) => {
        input.addEventListener('input', () => {
          numberInputs[i].value = input.value;
          if (rgbUnderHsv) this._applyRgbChannelSliders();
          else this._onSliderInput(i);
        });
        input.addEventListener('change', () => this.onCommit(this.color));
      });
      numberInputs.forEach((input, i) => {
        input.addEventListener('change', () => {
          rangeInputs[i].value = input.value;
          if (rgbUnderHsv) this._applyRgbChannelSliders();
          else this._onNumberInput(i);
        });
      });
      if (rgbUnderHsv) this._syncRgbChannelSliders();
    }

    _applyRgbChannelSliders() {
      if (!this._rgbRangeInputs) return;
      const r = Number(this._rgbRangeInputs[0].value);
      const g = Number(this._rgbRangeInputs[1].value);
      const b = Number(this._rgbRangeInputs[2].value);
      this.color = ColorMath.rgbToHex(r, g, b);
      this._hsv = ColorMath.rgbToHsv(...Object.values(ColorMath.hexToRgb(this.color)));
      this._syncFromColor();
    }

    _syncRgbChannelSliders() {
      if (!this._rgbRangeInputs) return;
      const { r, g, b } = ColorMath.hexToRgb(this.color);
      [r, g, b].forEach((v, i) => {
        this._rgbRangeInputs[i].value = String(v);
        this._rgbNumberInputs[i].value = String(v);
      });
    }

    _onSliderInput(i) {
      this._numberInputs[i].value = this._sliderInputs[i].value;
      this._applyChannelSliders();
    }

    _onNumberInput(i) {
      this._sliderInputs[i].value = this._numberInputs[i].value;
      this._applyChannelSliders();
    }

    _applyChannelSliders() {
      if (this.mode === 'rgb') {
        const r = Number(this._sliderInputs[0].value);
        const g = Number(this._sliderInputs[1].value);
        const b = Number(this._sliderInputs[2].value);
        this.color = ColorMath.rgbToHex(r, g, b);
      } else {
        const h = Number(this._sliderInputs[0].value);
        const s = Number(this._sliderInputs[1].value);
        const l = Number(this._sliderInputs[2].value);
        this.color = ColorMath.hslToRgb(h, s, l);
      }
      this._hsv = ColorMath.rgbToHsv(...Object.values(ColorMath.hexToRgb(this.color)));
      this._syncFromColor();
    }

    _syncRgbSliders() {
      if (!this._sliderInputs) return;
      const { r, g, b } = ColorMath.hexToRgb(this.color);
      [r, g, b].forEach((v, i) => {
        this._sliderInputs[i].value = String(v);
        this._numberInputs[i].value = String(v);
      });
    }

    _syncHslSliders() {
      if (!this._sliderInputs) return;
      const { r, g, b } = ColorMath.hexToRgb(this.color);
      const hsl = ColorMath.rgbToHsl(r, g, b);
      [hsl.h, hsl.s, hsl.l].forEach((v, i) => {
        this._sliderInputs[i].value = String(Math.round(v));
        this._numberInputs[i].value = String(Math.round(v));
      });
    }

    _paintHsv() {
      if (!this.svArea || !this.hueBar) return;
      const h = Math.round(this._hsv.h);
      this.hueBar.style.background = 'linear-gradient(to right, ' +
        [0, 60, 120, 180, 240, 300, 360].map(hue =>
          ColorMath.hsvToRgb(hue, 100, 100)
        ).join(', ') + ')';
      this.svArea.style.background =
        'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ' +
        ColorMath.hsvToRgb(h, 100, 100) + ')';
      this._updateHsvCursors();
    }

    /** 更新 HSV 方框与色相条上的取色指示器。 */
    _updateHsvCursors() {
      if (!this.svCursor || !this.hueCursor) return;
      const h = ColorMath.clamp(this._hsv.h, 0, 360);
      const s = ColorMath.clamp(this._hsv.s, 0, 100);
      const v = ColorMath.clamp(this._hsv.v, 0, 100);
      this.hueCursor.style.left = (h / 360 * 100) + '%';
      this.svCursor.style.left = s + '%';
      this.svCursor.style.top = ((1 - v / 100) * 100) + '%';
    }

    _bindHueBar(el) {
      let dirty = false;
      const pick = clientX => {
        const rect = el.getBoundingClientRect();
        const t = ColorMath.snapUnit((clientX - rect.left) / rect.width);
        this._hsv.h = t * 360;
        this.color = ColorMath.hsvToRgb(this._hsv.h, this._hsv.s, this._hsv.v);
        dirty = true;
        this._syncFromColor();
      };
      const commit = () => {
        if (!dirty) return;
        dirty = false;
        this.onCommit(this.color);
      };
      el.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        pick(e.clientX);
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', e => {
        if (el.hasPointerCapture(e.pointerId)) pick(e.clientX);
      });
      el.addEventListener('pointerup', e => {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        commit();
      });
      el.addEventListener('pointercancel', e => {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        commit();
      });
    }

    _bindSv(el, getHsv, setHsv) {
      let dirty = false;
      const pick = (cx, cy) => {
        const rect = el.getBoundingClientRect();
        const s = ColorMath.snapPercent((cx - rect.left) / rect.width);
        const v = ColorMath.snapPercent(1 - (cy - rect.top) / rect.height);
        const hsv = getHsv();
        setHsv(hsv.h, s, v);
        dirty = true;
        this._syncFromColor();
      };
      const commit = () => {
        if (!dirty) return;
        dirty = false;
        this.onCommit(this.color);
      };
      el.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        pick(e.clientX, e.clientY);
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', e => {
        if (el.hasPointerCapture(e.pointerId)) pick(e.clientX, e.clientY);
      });
      el.addEventListener('pointerup', e => {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        commit();
      });
      el.addEventListener('pointercancel', e => {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        commit();
      });
    }

    _paintWheel() {
      if (!this.wheelCanvas) return;
      const ctx = this.wheelCanvas.getContext('2d');
      const w = this.wheelCanvas.width;
      const cx = w / 2;
      const cy = w / 2;
      const r = w / 2 - 2;
      const image = ctx.createImageData(w, w);
      for (let y = 0; y < w; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const dx = x - cx;
          const dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const i = (y * w + x) * 4;
          if (dist > r) { image.data[i + 3] = 0; continue; }
          const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
          const sat = (dist / r) * 100;
          const rgb = ColorMath.hexToRgb(ColorMath.hsvToRgb(hue, sat, this._hsv.v));
          image.data[i] = rgb.r;
          image.data[i + 1] = rgb.g;
          image.data[i + 2] = rgb.b;
          image.data[i + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
      this._updateWheelCursor();
    }

    /** 更新色轮模式下的取色指示圈。 */
    _updateWheelCursor() {
      if (!this.wheelCursor || !this.wheelCanvas) return;
      const w = this.wheelCanvas.width;
      const cx = w / 2;
      const r = w / 2 - 2;
      const h = ColorMath.clamp(this._hsv.h, 0, 360);
      const s = ColorMath.clamp(this._hsv.s, 0, 100);
      const rad = h * Math.PI / 180;
      const dist = (s / 100) * r;
      const x = cx + Math.cos(rad) * dist;
      const y = cx + Math.sin(rad) * dist;
      this.wheelCursor.style.left = (x / w * 100) + '%';
      this.wheelCursor.style.top = (y / w * 100) + '%';
    }

    _bindWheel(canvas) {
      let dirty = false;
      const pick = (cx, cy) => {
        const rect = canvas.getBoundingClientRect();
        const x = cx - rect.left - canvas.width / 2;
        const y = cy - rect.top - canvas.height / 2;
        const dist = Math.min(Math.sqrt(x * x + y * y), canvas.width / 2 - 2);
        const hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        const sat = (dist / (canvas.width / 2 - 2)) * 100;
        this._hsv.h = hue;
        this._hsv.s = sat;
        this.color = ColorMath.hsvToRgb(this._hsv.h, this._hsv.s, this._hsv.v);
        dirty = true;
        this._syncFromColor();
      };
      const commit = () => {
        if (!dirty) return;
        dirty = false;
        this.onCommit(this.color);
      };
      canvas.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        pick(e.clientX, e.clientY);
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', e => {
        if (canvas.hasPointerCapture(e.pointerId)) pick(e.clientX, e.clientY);
      });
      canvas.addEventListener('pointerup', e => {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        commit();
      });
      canvas.addEventListener('pointercancel', e => {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        commit();
      });
      this._paintWheel();
    }
  }

  global.ColorPickerSurface = ColorPickerSurface;
})(window);
