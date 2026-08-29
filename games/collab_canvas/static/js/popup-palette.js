(function (global) {
  'use strict';

  const POPUP_SIZE = 360;
  const CENTER = POPUP_SIZE / 2;
  /** 工具按钮环（最外） */
  const TOOL_RADIUS = 150;
  const TOOL_BTN = 40;
  /** 最近色分段环：紧贴中心调色盘外围 */
  const RECENT_INNER = 104;
  const RECENT_OUTER = 126;
  const RECENT_GAP = 0.04;

  /** Krita 风右键轮盘：取色 + 工具 + 最近色 + 主/背景色。 */
  class PopupPalette {
    constructor(options) {
      const settings = options || {};
      this.colorPicker = settings.colorPicker;
      this.toolRail = settings.toolRail;
      this.colorPair = settings.colorPair;
      this.recentColors = settings.recentColors;
      this.isDrawing = settings.isDrawing || (() => false);
      this.isPanning = settings.isPanning || (() => false);
      this.isModalOpen = settings.isModalOpen || (() => false);
      this.onColorApplied = settings.onColorApplied || (() => {});

      this._open = false;
      this._surface = null;
      this._root = null;
      this._backdrop = null;
      this._panel = null;
      this._wheel = null;
      this._toolNodes = [];
      this._recentNodes = [];
      this._buildDom();
      this._bindGlobal();
    }

    isOpen() {
      return this._open;
    }

    /** 在视口坐标打开轮盘。 */
    open(clientX, clientY) {
      if (this.isModalOpen()) return;
      if (this.isDrawing()) return;
      if (this.isPanning()) return;
      if (!this.colorPicker || !this.colorPair) return;

      this._syncFromState();
      this._position(clientX, clientY);
      this._root.classList.remove('hidden');
      this._open = true;
    }

    close() {
      if (!this._open) return;
      this._root.classList.add('hidden');
      this._open = false;
      this._surface = null;
      if (this._pickerMount) this._pickerMount.innerHTML = '';
    }

    /** 颜色或模式变化时刷新轮盘 UI。 */
    refresh() {
      if (!this._open) return;
      this._syncFromState();
      this._renderTools();
      this._renderRecent();
      this._renderFgBg();
    }

    _buildDom() {
      this._root = document.createElement('div');
      this._root.id = 'popupPalette';
      this._root.className = 'popup-palette hidden';
      this._root.innerHTML = `
        <div class="popup-palette-backdrop" data-palette-backdrop></div>
        <div class="popup-palette-panel" data-palette-panel>
          <div class="popup-palette-wheel" data-palette-wheel>
            <div class="popup-palette-recent" data-palette-recent></div>
            <div class="popup-palette-tools" data-palette-tools></div>
            <div class="popup-palette-picker" data-palette-picker></div>
          </div>
          <div class="popup-palette-fg-bg" data-palette-fg-bg></div>
        </div>`;
      document.body.appendChild(this._root);
      this._backdrop = this._root.querySelector('[data-palette-backdrop]');
      this._panel = this._root.querySelector('[data-palette-panel]');
      this._wheel = this._root.querySelector('[data-palette-wheel]');
      this._fgBgMount = this._root.querySelector('[data-palette-fg-bg]');
      this._recentMount = this._root.querySelector('[data-palette-recent]');
      this._toolsMount = this._root.querySelector('[data-palette-tools]');
      this._pickerMount = this._root.querySelector('[data-palette-picker]');

      this._backdrop.addEventListener('click', () => this.close());
      if (this._panel) {
        this._panel.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          if (this._open) this.close();
        });
      }
    }

    /** 轮盘打开时任意位置右键：关闭轮盘并阻止浏览器菜单。 */
    _onDocumentContextMenu(event) {
      if (!this._open) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }

    _bindGlobal() {
      document.addEventListener('keydown', event => {
        if (!this._open) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.close();
        }
      }, true);

      document.addEventListener('contextmenu', event => this._onDocumentContextMenu(event), true);

      const stage = document.getElementById('canvasStage');
      if (stage) {
        stage.addEventListener('contextmenu', event => this._onCanvasContextMenu(event), true);
      }
    }

    /** 画布区右键（轮盘未开）：打开轮盘。 */
    _onCanvasContextMenu(event) {
      const stage = document.getElementById('canvasStage');
      if (!stage || !stage.contains(event.target)) return;
      if (this._open) return;

      event.preventDefault();
      event.stopPropagation();

      if (this.isModalOpen()) return;
      if (this.isPanning()) return;
      if (!this.colorPicker || !this.colorPair) return;

      this.open(event.clientX, event.clientY);
    }

    _position(clientX, clientY) {
      const margin = 12;
      const half = POPUP_SIZE / 2;
      let left = clientX - half;
      let top = clientY - half;
      left = Math.max(margin, Math.min(window.innerWidth - POPUP_SIZE - margin, left));
      top = Math.max(margin, Math.min(window.innerHeight - POPUP_SIZE - margin, top));
      if (this._panel) {
        this._panel.style.left = left + 'px';
        this._panel.style.top = top + 'px';
      }
    }

    /** 按取色模式切换轮盘中心形状：HSV/RGB/HSL 方形，色轮圆形。 */
    _applyPickerShape(mode) {
      if (!this._pickerMount) return;
      const round = mode === 'wheel';
      this._pickerMount.classList.toggle('is-picker-round', round);
      this._pickerMount.classList.toggle('is-picker-square', !round);
    }

    _syncFromState() {
      const snap = this.colorPair.getSnapshot();
      const mode = this.colorPicker.getMode();
      const color = snap.activeColor;

      if (!this._surface) {
        this._surface = new ColorPickerSurface(this._pickerMount, {
          mode,
          color,
          compact: true,
          onChange: hex => this._onPickerChange(hex),
          onCommit: hex => this._onPickerCommit(hex)
        });
      } else {
        this._surface.setMode(mode);
        this._surface.setColor(color);
      }

      this._applyPickerShape(mode);
      this._renderTools();
      this._renderRecent();
      this._renderFgBg();
    }

    _onPickerChange(hex) {
      this.colorPair.setActiveColor(hex);
      this.colorPicker.setColor(this.colorPair.foreground);
      this.onColorApplied(this.colorPair.getSnapshot());
      this._renderFgBg();
    }

    /** 取色松手后写入最近色环。 */
    _onPickerCommit(hex) {
      this.recentColors.push(hex);
      this._renderRecent();
    }

    _renderFgBg() {
      const snap = this.colorPair.getSnapshot();
      this._fgBgMount.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'popup-palette-fg-bg-inner';

      const bgBtn = document.createElement('button');
      bgBtn.type = 'button';
      bgBtn.className = 'popup-palette-color-swatch popup-palette-bg-swatch'
        + (snap.activeSlot === 'bg' ? ' is-active' : '');
      bgBtn.style.background = snap.background;
      bgBtn.title = '背景色';
      bgBtn.addEventListener('click', event => {
        event.stopPropagation();
        this.colorPair.setActive('bg');
        this._surface.setColor(this.colorPair.background);
        this._renderFgBg();
      });

      const fgBtn = document.createElement('button');
      fgBtn.type = 'button';
      fgBtn.className = 'popup-palette-color-swatch popup-palette-fg-swatch'
        + (snap.activeSlot === 'fg' ? ' is-active' : '');
      fgBtn.style.background = snap.foreground;
      fgBtn.title = '主色';
      fgBtn.addEventListener('click', event => {
        event.stopPropagation();
        this.colorPair.setActive('fg');
        this._surface.setColor(this.colorPair.foreground);
        this._renderFgBg();
      });

      wrap.appendChild(bgBtn);
      wrap.appendChild(fgBtn);
      this._fgBgMount.appendChild(wrap);
    }

    _renderTools() {
      const tools = this.toolRail.getTools();
      const active = this.toolRail.getTool();
      this._toolsMount.innerHTML = '';
      const count = tools.length;
      tools.forEach((toolId, index) => {
        const meta = ToolRail.getToolMeta(toolId);
        const angle = (-Math.PI / 2) + (index / count) * Math.PI * 2;
        const x = CENTER + Math.cos(angle) * TOOL_RADIUS - TOOL_BTN / 2;
        const y = CENTER + Math.sin(angle) * TOOL_RADIUS - TOOL_BTN / 2;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'popup-palette-tool-btn' + (toolId === active ? ' is-active' : '');
        btn.style.left = x + 'px';
        btn.style.top = y + 'px';
        btn.title = meta.label;
        btn.appendChild(MaterialIcons.createIcon(meta.icon, 'popup-palette-tool-icon'));
        btn.addEventListener('click', event => {
          event.stopPropagation();
          this.toolRail.setTool(toolId);
          this._renderTools();
        });
        this._toolsMount.appendChild(btn);
      });
    }

    _renderRecent() {
      const colors = this.recentColors.getDisplayColors();
      const count = colors.length;
      this._recentMount.innerHTML = '';
      if (!count) return;

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'popup-palette-recent-ring');
      svg.setAttribute('viewBox', '0 0 ' + POPUP_SIZE + ' ' + POPUP_SIZE);
      svg.setAttribute('width', String(POPUP_SIZE));
      svg.setAttribute('height', String(POPUP_SIZE));
      svg.setAttribute('aria-hidden', 'true');

      const slice = (Math.PI * 2) / count;
      const gap = count <= 1 ? 0 : RECENT_GAP;

      colors.forEach((hex, index) => {
        const start = (-Math.PI / 2) + index * slice + gap / 2;
        const end = (-Math.PI / 2) + (index + 1) * slice - gap / 2;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', this._ringSegmentPath(CENTER, CENTER, RECENT_INNER, RECENT_OUTER, start, end));
        path.setAttribute('class', 'popup-palette-recent-seg');
        path.setAttribute('fill', hex);
        path.setAttribute('title', hex);
        path.addEventListener('click', event => {
          event.stopPropagation();
          this.colorPair.setActiveColor(hex);
          this._surface.setColor(hex);
          this.colorPicker.setColor(this.colorPair.foreground);
          this.recentColors.push(hex);
          this.onColorApplied(this.colorPair.getSnapshot());
          this._renderFgBg();
          this._renderRecent();
        });
        svg.appendChild(path);
      });

      this._recentMount.appendChild(svg);
    }

    /** 生成 SVG 圆环扇形路径（最近色一段）。 */
    _ringSegmentPath(cx, cy, innerR, outerR, startAngle, endAngle) {
      const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
      const x1 = cx + outerR * Math.cos(startAngle);
      const y1 = cy + outerR * Math.sin(startAngle);
      const x2 = cx + outerR * Math.cos(endAngle);
      const y2 = cy + outerR * Math.sin(endAngle);
      const x3 = cx + innerR * Math.cos(endAngle);
      const y3 = cy + innerR * Math.sin(endAngle);
      const x4 = cx + innerR * Math.cos(startAngle);
      const y4 = cy + innerR * Math.sin(startAngle);
      return [
        'M', x1, y1,
        'A', outerR, outerR, 0, largeArc, 1, x2, y2,
        'L', x3, y3,
        'A', innerR, innerR, 0, largeArc, 0, x4, y4,
        'Z'
      ].join(' ');
    }
  }

  global.PopupPalette = PopupPalette;
})(window);
