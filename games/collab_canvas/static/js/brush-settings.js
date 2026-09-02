(function (global) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const SAMPLE_W = 260;
  const SAMPLE_H = 110;

  /**
   * 笔刷参数编辑面板：高频滑块（大小/不透明度/流量）+ 折叠高级区（间距/抖动/平滑/锥形/流线）
   * + 内嵌试笔板。参数变更即时写回 BrushPreset 并回调 onParamsChange。
   */
  class BrushSettings {
    constructor(options) {
      const settings = options || {};
      this.getPreset = settings.getPreset || (() => null);
      this.getBrushColor = settings.getBrushColor || (() => '#ffffff');
      this.onSizeChange = settings.onSizeChange || (() => {});
      this.onParamsChange = settings.onParamsChange || (() => {});
      this.onClose = settings.onClose || (() => {});
      this._el = null;
      this._anchor = null;
      this._advancedOpen = false;
    }

    get isOpen() { return Boolean(this._el); }

    /** 弹窗打开时重新同步当前预设值（换预设后调用）。 */
    refresh() {
      if (!this._el) return;
      this._sync();
      this._position();
    }

    open(anchorEl) {
      this.close();
      this._anchor = anchorEl || null;
      this._el = document.createElement('div');
      this._el.className = 'brush-settings-panel';
      this._el.setAttribute('role', 'dialog');
      this._el.setAttribute('aria-label', '笔刷参数');
      this._el.innerHTML = this._template();
      document.body.appendChild(this._el);
      this._bind();
      this._sync();
      this._position();
      // 布局完成后按显示尺寸×dpr 提升试笔板分辨率，避免拉伸模糊。
      requestAnimationFrame(() => {
        if (this._el) this._fitScratchResolution();
      });
      this._onDocPointer = event => {
        if (!this._el) return;
        if (this._el.contains(event.target)) return;
        if (this._anchor && this._anchor.contains(event.target)) return;
        // 点击笔刷库面板内部保持设置面板打开（次级侧栏联动）。
        if (event.target.closest && event.target.closest('.brush-library-panel')) return;
        this.close();
      };
      document.addEventListener('pointerdown', this._onDocPointer, true);
      this._onDocKey = event => { if (event.key === 'Escape') this.close(); };
      document.addEventListener('keydown', this._onDocKey, true);
      this._onResize = () => this._position();
      window.addEventListener('resize', this._onResize);
    }

    close() {
      if (!this._el) return;
      if (this._onDocPointer) document.removeEventListener('pointerdown', this._onDocPointer, true);
      if (this._onDocKey) document.removeEventListener('keydown', this._onDocKey, true);
      if (this._onResize) window.removeEventListener('resize', this._onResize);
      if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
      this._el = null;
      this._anchor = null;
      this.onClose();
    }

    _template() {
      return ''
        + '<div class="brush-settings-header">'
        +   '<span class="brush-settings-title" data-brush-settings-name>笔刷参数</span>'
        +   '<button type="button" class="brush-settings-close" data-brush-settings-close title="关闭">'
        +     '<span class="material-symbols-outlined" aria-hidden="true">close</span>'
        +   '</button>'
        + '</div>'
        + '<div class="brush-settings-body">'
        +   '<div class="brush-settings-group">'
        +     '<div class="brush-settings-group-title">基本</div>'
        +     '<label class="brush-settings-row">'
        +       '<span class="brush-settings-row-label">驱动源</span>'
        +       '<select class="brush-settings-select" data-bs-driver>'
        +         '<option value="pressure">压感</option>'
        +         '<option value="speed">速度</option>'
        +         '<option value="fixed">固定</option>'
        +         '<option value="random">随机</option>'
        +       '</select>'
        +     '</label>'
        +     '<label class="brush-settings-row">'
        +       '<span class="brush-settings-row-label">大小</span>'
        +       '<input type="range" min="1" max="128" step="1" data-bs-size>'
        +       '<output data-bs-size-out></output>'
        +     '</label>'
        +     '<label class="brush-settings-row">'
        +       '<span class="brush-settings-row-label">不透明度</span>'
        +       '<input type="range" min="5" max="100" step="1" data-bs-opacity>'
        +       '<output data-bs-opacity-out></output>'
        +     '</label>'
        +     '<label class="brush-settings-row">'
        +       '<span class="brush-settings-row-label">流量</span>'
        +       '<input type="range" min="5" max="100" step="1" data-bs-flow>'
        +       '<output data-bs-flow-out></output>'
        +     '</label>'
        +   '</div>'
        +   '<div class="brush-settings-group">'
        +     '<button type="button" class="brush-settings-group-title is-toggle" data-bs-advanced-toggle>'
        +       '<span>高级</span><span class="material-symbols-outlined" aria-hidden="true">expand_more</span>'
        +     '</button>'
        +     '<div class="brush-settings-advanced" data-bs-advanced hidden>'
        +       '<label class="brush-settings-row">'
        +         '<span class="brush-settings-row-label">间距</span>'
        +         '<input type="range" min="0" max="100" step="1" data-bs-spacing>'
        +         '<output data-bs-spacing-out></output>'
        +       '</label>'
        +       '<label class="brush-settings-row">'
        +         '<span class="brush-settings-row-label">抖动</span>'
        +         '<input type="range" min="0" max="100" step="1" data-bs-jitter>'
        +         '<output data-bs-jitter-out></output>'
        +       '</label>'
        +       '<label class="brush-settings-row">'
        +         '<span class="brush-settings-row-label">平滑</span>'
        +         '<input type="range" min="0" max="100" step="1" data-bs-smoothing>'
        +         '<output data-bs-smoothing-out></output>'
        +       '</label>'
        +       '<label class="brush-settings-row">'
        +         '<span class="brush-settings-row-label">流线</span>'
        +         '<input type="range" min="0" max="100" step="1" data-bs-streamline>'
        +         '<output data-bs-streamline-out></output>'
        +       '</label>'
        +       '<label class="brush-settings-row">'
        +         '<span class="brush-settings-row-label">压感变宽</span>'
        +         '<input type="range" min="0" max="100" step="1" data-bs-thinning>'
        +         '<output data-bs-thinning-out></output>'
        +       '</label>'
        +       '<label class="brush-settings-row brush-settings-row-check">'
        +         '<input type="checkbox" data-bs-taper>'
        +         '<span>锥形收尾</span>'
        +       '</label>'
        +     '</div>'
        +   '</div>'
        +   '<div class="brush-settings-scratch">'
        +     '<div class="brush-settings-scratch-head">'
        +       '<span>试笔板</span>'
        +       '<button type="button" class="brush-settings-scratch-clear" data-bs-clear>清空</button>'
        +     '</div>'
        +     '<canvas class="brush-settings-scratch-canvas" data-bs-scratch width="' + SAMPLE_W + '" height="' + SAMPLE_H + '"></canvas>'
        +   '</div>'
        + '</div>';
    }

    _bind() {
      const closeBtn = this._el.querySelector('[data-brush-settings-close]');
      if (closeBtn) closeBtn.addEventListener('click', () => this.close());
      const advToggle = this._el.querySelector('[data-bs-advanced-toggle]');
      if (advToggle) advToggle.addEventListener('click', () => {
        this._advancedOpen = !this._advancedOpen;
        const adv = this._el.querySelector('[data-bs-advanced]');
        if (adv) adv.classList.toggle('hidden', !this._advancedOpen);
      });
      const clearBtn = this._el.querySelector('[data-bs-clear]');
      if (clearBtn) clearBtn.addEventListener('click', () => this._clearScratch());

      const driver = this._el.querySelector('[data-bs-driver]');
      if (driver) driver.addEventListener('change', () => {
        this._patch({ driverSource: driver.value });
      });

      this._bindSlider('[data-bs-size]', '[data-bs-size-out]', v => {
        this.onSizeChange(Math.round(v));
        this._refreshSample();
      }, true);
      this._bindSlider('[data-bs-opacity]', '[data-bs-opacity-out]', v => {
        this._patch({ opacity: v / 100 });
      }, true);
      this._bindSlider('[data-bs-flow]', '[data-bs-flow-out]', v => {
        this._patch({ flow: v / 100 });
      }, true);
      this._bindSlider('[data-bs-spacing]', '[data-bs-spacing-out]', v => {
        this._patch({ spacing: v / 100 });
      });
      this._bindSlider('[data-bs-jitter]', '[data-bs-jitter-out]', v => {
        this._patch({ randomJitter: v / 100 });
      });
      this._bindSlider('[data-bs-smoothing]', '[data-bs-smoothing-out]', v => {
        this._patch({ smoothing: v / 100 });
      });
      this._bindSlider('[data-bs-streamline]', '[data-bs-streamline-out]', v => {
        this._patch({ streamline: v / 100 });
      });
      this._bindSlider('[data-bs-thinning]', '[data-bs-thinning-out]', v => {
        this._patch({ thinning: v / 100 });
      });

      const taper = this._el.querySelector('[data-bs-taper]');
      if (taper) taper.addEventListener('change', () => {
        this._patch({ taperStart: taper.checked, taperEnd: taper.checked });
      });

      const scratch = this._el.querySelector('[data-bs-scratch]');
      if (scratch) {
        this._bindScratch(scratch);
      }
    }

    /** 让试笔板 canvas 内部分辨率匹配其显示尺寸 × devicePixelRatio，避免 CSS 拉伸导致像素化/模糊。 */
    _fitScratchResolution() {
      const canvas = this._el && this._el.querySelector('[data-bs-scratch]');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const bw = Math.max(1, Math.round(rect.width * dpr));
      const bh = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      this._clearScratch();
      this._refreshSample();
    }

    _bindSlider(inputSel, outSel, onInput, showPx) {
      const input = this._el.querySelector(inputSel);
      const out = this._el.querySelector(outSel);
      if (!input) return;
      input.addEventListener('input', () => {
        const value = Number(input.value);
        if (out) out.textContent = showPx ? String(value) : value + '%';
        onInput(value);
      });
    }

    /** 修改当前预设参数并通知外部刷新。 */
    _patch(patch) {
      const preset = this.getPreset();
      if (!preset) return;
      Object.assign(preset, patch);
      this.onParamsChange();
      this._refreshSample();
    }

    _sync() {
      const preset = this.getPreset();
      if (!preset) return;
      const nameEl = this._el.querySelector('[data-brush-settings-name]');
      if (nameEl) nameEl.textContent = '笔刷参数 · ' + (preset.name || preset.tool || '笔刷');

      const driver = this._el.querySelector('[data-bs-driver]');
      if (driver) driver.value = preset.driverSource || 'pressure';

      const setVal = (sel, outSel, value, suffix) => {
        const input = this._el.querySelector(sel);
        const out = this._el.querySelector(outSel);
        if (input) input.value = String(Math.round(value));
        if (out) out.textContent = (suffix === 'px' ? String(Math.round(value)) : Math.round(value) + '%');
      };
      const opacity = Math.round(clamp(preset.opacity != null ? preset.opacity : 1, 0, 1) * 100);
      const flow = Math.round(clamp(preset.flow != null ? preset.flow : 1, 0, 1) * 100);
      setVal('[data-bs-size]', '[data-bs-size-out]', this._currentSize(), 'px');
      setVal('[data-bs-opacity]', '[data-bs-opacity-out]', opacity);
      setVal('[data-bs-flow]', '[data-bs-flow-out]', flow);
      setVal('[data-bs-spacing]', '[data-bs-spacing-out]', (preset.spacing != null ? preset.spacing : 0.25) * 100);
      setVal('[data-bs-jitter]', '[data-bs-jitter-out]', (preset.randomJitter != null ? preset.randomJitter : 0) * 100);
      setVal('[data-bs-smoothing]', '[data-bs-smoothing-out]', (preset.smoothing != null ? preset.smoothing : 0.5) * 100);
      setVal('[data-bs-streamline]', '[data-bs-streamline-out]', (preset.streamline != null ? preset.streamline : 0.5) * 100);
      setVal('[data-bs-thinning]', '[data-bs-thinning-out]', (preset.thinning != null ? preset.thinning : 0.5) * 100);
      const taper = this._el.querySelector('[data-bs-taper]');
      if (taper) taper.checked = preset.taperStart !== false;
      this._refreshSample();
    }

    /** 当前笔刷大小（优先走回调，取不到用预设 size）。 */
    _currentSize() {
      const preset = this.getPreset();
      if (preset && preset.size != null) return clamp(preset.size, 1, 128);
      return 8;
    }

    _refreshSample() {
      const preset = this.getPreset();
      const canvas = this._el && this._el.querySelector('[data-bs-scratch]');
      if (!preset || !canvas || !global.renderBrushSample) return;
      // keepSize：保留 _fitScratchResolution 设置的高分辨率，避免被重置为缩略图尺寸。
      global.renderBrushSample(preset, this._currentSize(), this.getBrushColor(), canvas, { keepSize: true });
    }

    _clearScratch() {
      const canvas = this._el && this._el.querySelector('[data-bs-scratch]');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1c1c1e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _bindScratch(canvas) {
      const down = event => {
        if (event.button !== 0) return;
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        canvas._drawing = true;
        canvas._last = this._scratchPoint(event, canvas);
      };
      const move = event => {
        if (!canvas._drawing) return;
        event.preventDefault();
        const pt = this._scratchPoint(event, canvas);
        if (!canvas._last) { canvas._last = pt; return; }
        this._drawScratchSegment(canvas, canvas._last, pt);
        canvas._last = pt;
      };
      const up = event => {
        if (!canvas._drawing) return;
        canvas._drawing = false;
        canvas._last = null;
      };
      canvas.addEventListener('pointerdown', down);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
      canvas.addEventListener('contextmenu', event => event.preventDefault());
      this._refreshSample();
    }

    _scratchPoint(event, canvas) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
        y: clamp((event.clientY - rect.top) / rect.height, 0, 1)
      };
    }

    _drawScratchSegment(canvas, from, to) {
      const preset = this.getPreset();
      if (!preset) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const size = Math.max(2, this._currentSize() * (w / 640));
      const tool = preset.tool || 'brush';
      const color = tool === 'eraser' ? '#ffffff' : this.getBrushColor();
      if (tool === 'glow') {
        const radius = size * 2;
        const grad = ctx.createRadialGradient(to.x * w, to.y * h, 0, to.x * w, to.y * h, radius);
        grad.addColorStop(0, color);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = clamp(preset.opacity != null ? preset.opacity : 0.55, 0.05, 1);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(to.x * w, to.y * h, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }
      if (tool === 'spray') {
        const jitter = clamp(preset.randomJitter != null ? preset.randomJitter : 0.35, 0, 1);
        const spacing = Math.max(1, (preset.spacing != null ? preset.spacing : 0.25) * size);
        const dist = Math.hypot((to.x - from.x) * w, (to.y - from.y) * h);
        const steps = Math.max(1, Math.floor(dist / spacing));
        ctx.fillStyle = color;
        ctx.globalAlpha = clamp(preset.opacity != null ? preset.opacity : 0.75, 0.05, 1);
        for (let i = 0; i <= steps; i += 1) {
          const t = i / steps;
          const px = (from.x + (to.x - from.x) * t) * w;
          const py = (from.y + (to.y - from.y) * t) * h;
          const jx = (Math.random() - 0.5) * size * jitter * 1.6;
          const jy = (Math.random() - 0.5) * size * jitter * 1.6;
          ctx.beginPath();
          ctx.arc(px + jx, py + jy, Math.max(0.8, size * 0.1), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        return;
      }
      const pf = global.PerfectFreehand;
      if (pf && typeof pf.getStroke === 'function') {
        const segPoints = [
          { x: from.x * w, y: from.y * h, pressure: 0.5 },
          { x: to.x * w, y: to.y * h, pressure: 0.5 }
        ];
        const options = {
          size,
          thinning: Number(preset.thinning) || 0.5,
          smoothing: Number(preset.smoothing) || 0.5,
          streamline: Number(preset.streamline) || 0.5,
          simulatePressure: true,
          start: { taper: true },
          end: { taper: true },
          last: true
        };
        const outline = pf.getStroke(segPoints, options);
        if (outline.length) {
          ctx.save();
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(outline[0][0], outline[0][1]);
          for (let i = 1; i < outline.length; i += 1) {
            ctx.quadraticCurveTo(outline[i - 1][0], outline[i - 1][1],
              (outline[i - 1][0] + outline[i][0]) / 2, (outline[i - 1][1] + outline[i][1]) / 2);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        return;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(from.x * w, from.y * h);
      ctx.lineTo(to.x * w, to.y * h);
      ctx.stroke();
    }

    _position() {
      if (!this._el) return;
      this._el.style.position = 'fixed';
      // 次级侧栏：停靠在笔刷库面板右侧；无笔刷库时停靠到左侧栏右侧。
      const libraryEl = document.querySelector('.brush-library-panel');
      const anchor = libraryEl || this._anchor;
      const rail = document.getElementById('dockLeft');
      const ws = document.getElementById('collabWorkspace');
      const wsRect = ws ? ws.getBoundingClientRect() : null;
      const swapped = ws && ws.classList.contains('is-sides-swapped');
      const top = wsRect ? wsRect.top : 0;
      const height = wsRect ? wsRect.height : window.innerHeight;

      if (swapped) {
        // 对调时 rail 在右侧，次级面板停靠到 anchor 左侧。
        const left = (anchor && libraryEl ? anchor.getBoundingClientRect().left : (rail ? rail.getBoundingClientRect().left : 0))
          - this._el.offsetWidth;
        this._el.style.left = Math.max(8, Math.round(left)) + 'px';
      } else {
        const anchorRight = anchor
          ? anchor.getBoundingClientRect().right
          : (rail ? rail.getBoundingClientRect().right : (wsRect ? wsRect.left : 0));
        // 防止窄视口下被推到屏幕外：夹到可见范围内。
        const clamped = Math.min(window.innerWidth - this._el.offsetWidth - 8, anchorRight);
        this._el.style.left = Math.max(8, Math.round(clamped)) + 'px';
      }
      this._el.style.top = Math.round(top) + 'px';
      this._el.style.height = Math.round(height) + 'px';
      this._el.style.zIndex = '2200';
    }
  }

  global.BrushSettings = BrushSettings;
})(window);
