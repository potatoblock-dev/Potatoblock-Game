(function (global) {
  'use strict';

  const THUMB_W = 96;
  const THUMB_H = 48;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 在离屏 canvas 上画一笔预设的示例笔画（供笔刷库缩略图/参数面板试笔用）。 */
  function renderBrushSample(preset, sizePx, color, outCanvas, options) {
    const opts = options || {};
    const canvas = outCanvas || document.createElement('canvas');
    // 试笔板传入 keepSize 时保留其已在 _fitScratchResolution 设置的高分辨率，避免被重置变小。
    if (!opts.keepSize) {
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
    }
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1c1c1e';
    ctx.fillRect(0, 0, w, h);
    const pf = global.PerfectFreehand;
    if (!pf || typeof pf.getStroke !== 'function') return canvas;
    const tool = preset.tool || 'brush';
    const size = Math.max(2, Number(sizePx) || 8);
    const paintColor = tool === 'eraser' ? '#ffffff' : (color || '#ffffff');

    // 一段横向示例笔画（三次点，模拟真实运笔）
    const points = [
      { x: w * 0.1, y: h * 0.62, pressure: 0.35 },
      { x: w * 0.42, y: h * 0.42, pressure: 0.75 },
      { x: w * 0.9, y: h * 0.58, pressure: 0.5 }
    ];

    if (tool === 'glow') {
      // 光晕：沿笔画画多个径向渐变圆
      points.forEach(pt => {
        const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, size * 2);
        grad.addColorStop(0, paintColor);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = clamp(Number(preset.opacity) || 0.55, 0.05, 1);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, size * 2, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      return canvas;
    }

    if (tool === 'spray') {
      // 喷笔：沿笔画散布点
      const spacing = Math.max(1, (Number(preset.spacing) || 0.25) * size);
      const jitter = clamp(Number(preset.randomJitter) || 0.35, 0, 1);
      const dotR = Math.max(0.8, size * 0.1);
      let seed = 7;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed % 10000) / 10000;
      };
      ctx.globalAlpha = clamp(Number(preset.opacity) || 0.75, 0.05, 1);
      ctx.fillStyle = paintColor;
      for (let i = 0; i <= 28; i += 1) {
        const t = i / 28;
        const baseX = points[0].x + (points[2].x - points[0].x) * t;
        const baseY = points[0].y + (points[2].y - points[0].y) * t
          + Math.sin(t * Math.PI) * h * 0.1;
        const jx = (rand() - 0.5) * size * jitter * 1.6;
        const jy = (rand() - 0.5) * size * jitter * 1.6;
        ctx.beginPath();
        ctx.arc(baseX + jx, baseY + jy, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return canvas;
    }

    // brush / eraser：perfect-freehand 轮廓填充
    const presetParams = preset.params || {};
    const strokePoints = points.map(pt => ({ x: pt.x, y: pt.y, pressure: pt.pressure }));
    const strokeOptions = {
      size,
      thinning: Number(presetParams.thinning != null ? presetParams.thinning : preset.thinning) || 0.5,
      smoothing: Number(presetParams.smoothing != null ? presetParams.smoothing : preset.smoothing) || 0.5,
      streamline: Number(presetParams.streamline != null ? presetParams.streamline : preset.streamline) || 0.5,
      simulatePressure: true,
      start: { taper: true },
      end: { taper: true },
      last: true
    };
    const outline = pf.getStroke(strokePoints, strokeOptions);
    if (outline.length) {
      ctx.save();
      ctx.fillStyle = paintColor;
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
    return canvas;
  }

  /**
   * 双栏笔刷库面板：左分组 + 右笔刷条目（真实笔画缩略图）+ 底部快捷滑块。
   * 由 ToolRail 画笔组小三角展开；面板内选择预设回调 onSelect。
   */
  class BrushLibrary {
    constructor(options) {
      const settings = options || {};
      this.onSelect = settings.onSelect || (() => {});
      this.onEditSettings = settings.onEditSettings || (() => {});
      this.onClose = settings.onClose || (() => {});
      this.getBrushSize = settings.getBrushSize || (() => 8);
      this.getBrushColor = settings.getBrushColor || (() => '#ffffff');
      this.onSizeChange = settings.onSizeChange || (() => {});
      this.onOpacityChange = settings.onOpacityChange || (() => {});
      this.onFlowChange = settings.onFlowChange || (() => {});
      this.getOpacity = settings.getOpacity || (() => 1);
      this.getFlow = settings.getFlow || (() => 1);
      this.getActivePresetId = settings.getActivePresetId || (() => 'round');
      this._el = null;
      this._anchor = null;
      this._search = '';
      this._activeCategory = '常用';
      this._listeners = [];
    }

    get isOpen() { return Boolean(this._el); }

    /** 在指定锚点元素旁打开面板。 */
    open(anchorEl) {
      this.close();
      this._anchor = anchorEl || null;
      this._el = document.createElement('div');
      this._el.className = 'brush-library-panel';
      this._el.setAttribute('role', 'dialog');
      this._el.setAttribute('aria-label', '笔刷库');
      this._el.innerHTML = this._template();
      document.body.appendChild(this._el);
      this._bind();
      this._render();
      this._position();
      this._onDocPointer = event => {
        if (!this._el) return;
        if (this._el.contains(event.target)) return;
        if (this._anchor && this._anchor.contains(event.target)) return;
        // 点击次级设置面板内部保持笔刷库打开（联动）。
        if (event.target.closest && event.target.closest('.brush-settings-panel')) return;
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
        + '<div class="brush-library-header">'
        +   '<span class="brush-library-title">笔刷库</span>'
        +   '<button type="button" class="brush-library-settings-btn" data-brush-edit title="编辑参数">'
        +     '<span class="material-symbols-outlined" aria-hidden="true">tune</span>'
        +   '</button>'
        +   '<button type="button" class="brush-library-close" data-brush-close title="关闭">'
        +     '<span class="material-symbols-outlined" aria-hidden="true">close</span>'
        +   '</button>'
        + '</div>'
        + '<div class="brush-library-search-wrap">'
        +   '<input type="search" class="brush-library-search" data-brush-search placeholder="搜索笔刷…" aria-label="搜索笔刷">'
        + '</div>'
        + '<div class="brush-library-body">'
        +   '<div class="brush-library-cats" data-brush-cats></div>'
        +   '<div class="brush-library-grid" data-brush-grid></div>'
        + '</div>'
        + '<div class="brush-library-foot">'
        +   '<label class="brush-lib-slider">'
        +     '<span class="brush-lib-slider-label">大小</span>'
        +     '<input type="range" min="1" max="128" step="1" data-brush-size>'
        +     '<output data-brush-size-out></output>'
        +   '</label>'
        +   '<label class="brush-lib-slider">'
        +     '<span class="brush-lib-slider-label">不透明度</span>'
        +     '<input type="range" min="5" max="100" step="1" data-brush-opacity>'
        +     '<output data-brush-opacity-out></output>'
        +   '</label>'
        +   '<label class="brush-lib-slider">'
        +     '<span class="brush-lib-slider-label">流量</span>'
        +     '<input type="range" min="5" max="100" step="1" data-brush-flow>'
        +     '<output data-brush-flow-out></output>'
        +   '</label>'
        + '</div>';
    }

    _bind() {
      const closeBtn = this._el.querySelector('[data-brush-close]');
      if (closeBtn) closeBtn.addEventListener('click', () => this.close());
      const editBtn = this._el.querySelector('[data-brush-edit]');
      if (editBtn) editBtn.addEventListener('click', () => this.onEditSettings());
      const search = this._el.querySelector('[data-brush-search]');
      if (search) search.addEventListener('input', () => {
        this._search = search.value.trim().toLowerCase();
        this._renderGrid();
      });
      const sizeInput = this._el.querySelector('[data-brush-size]');
      const sizeOut = this._el.querySelector('[data-brush-size-out]');
      if (sizeInput) sizeInput.addEventListener('input', () => {
        const value = Number(sizeInput.value);
        if (sizeOut) sizeOut.textContent = String(value);
        this.onSizeChange(value);
      });
      const opInput = this._el.querySelector('[data-brush-opacity]');
      const opOut = this._el.querySelector('[data-brush-opacity-out]');
      if (opInput) opInput.addEventListener('input', () => {
        const value = Number(opInput.value);
        if (opOut) opOut.textContent = value + '%';
        this.onOpacityChange(value / 100);
      });
      const flowInput = this._el.querySelector('[data-brush-flow]');
      const flowOut = this._el.querySelector('[data-brush-flow-out]');
      if (flowInput) flowInput.addEventListener('input', () => {
        const value = Number(flowInput.value);
        if (flowOut) flowOut.textContent = value + '%';
        this.onFlowChange(value / 100);
      });
    }

    _render() {
      const grid = this._el.querySelector('[data-brush-grid]');
      if (grid) {
        // 清空后填充（grid 内容由 _renderGrid 管理，这里先清占位）
      }
      this._renderCats();
      this._renderGrid();
      this._syncFoot();
    }

    /** 左栏分组列表。 */
    _renderCats() {
      const mount = this._el.querySelector('[data-brush-cats]');
      if (!mount || !global.BrushRegistry) return;
      mount.innerHTML = '';
      BrushRegistry.getGrouped().forEach(group => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'brush-library-cat' + (group.id === this._activeCategory ? ' is-active' : '');
        btn.textContent = group.label;
        btn.addEventListener('click', () => {
          this._activeCategory = group.id;
          this._renderCats();
          this._renderGrid();
        });
        mount.appendChild(btn);
      });
    }

    /** 右栏笔刷条目网格（当前分组 + 搜索过滤）。 */
    _renderGrid() {
      const mount = this._el.querySelector('[data-brush-grid]');
      if (!mount || !global.BrushRegistry) return;
      mount.innerHTML = '';
      const group = BrushRegistry.getGrouped().find(g => g.id === this._activeCategory);
      const presets = group ? group.presets : [];
      const filtered = this._search
        ? presets.filter(p => p.name.toLowerCase().includes(this._search))
        : presets;
      if (!filtered.length) {
        mount.innerHTML = '<div class="brush-library-empty">没有匹配的笔刷</div>';
        return;
      }
      filtered.forEach(preset => {
        mount.appendChild(this._renderItem(preset));
      });
    }

    _renderItem(preset) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'brush-library-item'
        + (preset.id === this.getActivePresetId() ? ' is-active' : '');
      item.dataset.presetId = preset.id;

      const thumb = document.createElement('canvas');
      thumb.className = 'brush-library-thumb';
      thumb.width = THUMB_W;
      thumb.height = THUMB_H;
      renderBrushSample(preset, this.getBrushSize(), this.getBrushColor(), thumb);

      const name = document.createElement('span');
      name.className = 'brush-library-item-name';
      name.textContent = preset.name;

      item.appendChild(thumb);
      item.appendChild(name);
      item.addEventListener('click', () => {
        this.onSelect(preset.id);
        // 选择后刷新激活态（不关闭，方便连续试笔）
        this._markActive(preset.id);
      });
      return item;
    }

    /** 仅刷新条目的激活态。 */
    _markActive(presetId) {
      if (!this._el) return;
      this._el.querySelectorAll('[data-brush-grid] .brush-library-item').forEach(el => {
        el.classList.toggle('is-active', el.dataset.presetId === presetId);
      });
    }

    /** 底部快捷滑块同步当前值。 */
    _syncFoot() {
      if (!this._el) return;
      const sizeInput = this._el.querySelector('[data-brush-size]');
      const sizeOut = this._el.querySelector('[data-brush-size-out]');
      if (sizeInput) {
        const size = this.getBrushSize();
        sizeInput.value = String(size);
        if (sizeOut) sizeOut.textContent = String(size);
      }
      const opInput = this._el.querySelector('[data-brush-opacity]');
      const opOut = this._el.querySelector('[data-brush-opacity-out]');
      if (opInput) {
        const opacity = Math.round(clamp(this.getOpacity(), 0, 1) * 100);
        opInput.value = String(opacity);
        if (opOut) opOut.textContent = opacity + '%';
      }
      const flowInput = this._el.querySelector('[data-brush-flow]');
      const flowOut = this._el.querySelector('[data-brush-flow-out]');
      if (flowInput) {
        const flow = Math.round(clamp(this.getFlow(), 0, 1) * 100);
        flowInput.value = String(flow);
        if (flowOut) flowOut.textContent = flow + '%';
      }
    }

    /** 停靠到左侧栏右侧成一列全高侧栏；左右栏对调时停靠到另一侧。 */
    _position() {
      if (!this._el) return;
      const ws = document.getElementById('collabWorkspace');
      const rail = document.getElementById('dockLeft');
      const wsRect = ws ? ws.getBoundingClientRect() : null;
      const railRect = rail ? rail.getBoundingClientRect() : null;
      const swapped = ws && ws.classList.contains('is-sides-swapped');
      const top = wsRect ? wsRect.top : 0;
      const height = wsRect ? wsRect.height : window.innerHeight;
      this._el.style.position = 'fixed';
      if (swapped) {
        // 对调时 rail 在右侧，侧栏停靠到其左侧。
        const left = (railRect ? railRect.left : 0) - this._el.offsetWidth;
        this._el.style.left = Math.max(8, Math.round(left)) + 'px';
      } else {
        const left = railRect ? railRect.right : (wsRect ? wsRect.left : 0);
        this._el.style.left = Math.round(left) + 'px';
      }
      this._el.style.top = Math.round(top) + 'px';
      this._el.style.height = Math.round(height) + 'px';
      this._el.style.zIndex = '2100';
    }
  }

  global.BrushLibrary = BrushLibrary;
  global.renderBrushSample = renderBrushSample;
})(window);
