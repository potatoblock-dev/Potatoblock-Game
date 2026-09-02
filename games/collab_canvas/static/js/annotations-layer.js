(function (global) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const HOVER_TOOLTIP_MS = 500;
  const ANNOTATION_RADIUS = 14; // 圆圈像素半径（逻辑坐标下）

  /**
   * 画布批注层：圆圈 + 展开框 + 顶部工具栏，锚在画布逻辑坐标上。
   * 容器挂在 .canvas-stage-surface 内（与 drawCanvas 平级），随 viewport 缩放/平移/旋转。
   */
  class AnnotationLayer {
    constructor(surface, options) {
      const settings = options || {};
      this.surface = surface;
      this.getBoard = settings.getBoard || (() => null);
      this.getDrawingBoard = settings.getDrawingBoard || (() => null);
      this.getViewport = settings.getViewport || (() => null);
      this.resolveLabelColor = settings.resolveLabelColor || ((pid, wire) => defaultColor(pid));
      this.getPlayersSnapshot = settings.getPlayersSnapshot || (() => []);
      this._container = null;
      this._annotations = [];
      this._els = new Map();
      this.ensureContainer();
    }

    /** 创建批注容器（一次），并在画布重设尺寸时同步 canvas 尺寸。 */
    ensureContainer() {
      if (!this.surface) return null;
      if (this._container) return this._container;
      this._container = document.createElement('div');
      this._container.className = 'annotations-layer';
      this._container.setAttribute('aria-hidden', 'true');
      this.surface.appendChild(this._container);
      this._resizeCanvas();
      return this._container;
    }

    /** 批注层 canvas 尺寸 = 画布逻辑尺寸（surface 内坐标即逻辑像素）。 */
    _resizeCanvas() {
      const db = this.getDrawingBoard();
      if (!this._container || !db) return;
      this._container.style.width = db.logicalWidth + 'px';
      this._container.style.height = db.logicalHeight + 'px';
    }

    /** 外部注入批注数据并重绘。 */
    setAnnotations(annotations, players) {
      this._annotations = (annotations || []).slice();
      this._resizeCanvas();
      this._render();
    }

    /** 玩家 style 更新时刷新颜色/昵称（无需重绘结构）。 */
    refreshColors() {
      this._render();
    }

    /** 重建全部批注 DOM。 */
    _render() {
      const board = this.getBoard();
      if (!this._container || !board) return;
      this._container.innerHTML = '';
      this._els.clear();
      this._annotations.forEach(ann => {
        const el = this._buildNode(ann);
        this._container.appendChild(el);
        this._els.set(String(ann.id), el);
      });
    }

    /** 按创建者 id 解析标签色。 */
    _colorFor(ann) {
      const players = this.getPlayersSnapshot() || [];
      const author = players.find(p => String(p.uid) === String(ann.created_by));
      const wire = author && author.label_color;
      return this.resolveLabelColor(String(ann.created_by), wire);
    }

    /** 按创建者 id 解析昵称。 */
    _nameFor(ann) {
      const players = this.getPlayersSnapshot() || [];
      const author = players.find(p => String(p.uid) === String(ann.created_by));
      return (author && author.name) || '匿名';
    }

    _buildNode(ann) {
      const el = document.createElement('div');
      el.className = 'annotation is-direction-' + (ann.direction || 'br');
      el.dataset.annotationId = String(ann.id);
      el.style.left = (clamp(Number(ann.x) || 0, 0, 1) * 100) + '%';
      el.style.top = (clamp(Number(ann.y) || 0, 0, 1) * 100) + '%';

      const color = this._colorFor(ann);

      // 圆圈
      const circle = document.createElement('div');
      circle.className = 'annotation-circle';
      circle.style.setProperty('--annotation-color', color);
      circle.appendChild(this._buildToolbar(ann, color));

      // 展开框（文本）
      const box = document.createElement('div');
      box.className = 'annotation-box';
      const textArea = document.createElement('textarea');
      textArea.className = 'annotation-text';
      textArea.placeholder = '输入批注…';
      textArea.value = ann.text || '';
      textArea.rows = 2;
      textArea.addEventListener('input', () => {
        const value = textArea.value;
        const board = this.getBoard();
        if (board && board.updateAnnotation) board.updateAnnotation(ann.id, { text: value });
      });
      box.appendChild(textArea);

      // 创建者昵称 tooltip（悬浮/长按出现）
      const tooltip = document.createElement('div');
      tooltip.className = 'annotation-author';
      tooltip.textContent = this._nameFor(ann);

      el.appendChild(circle);
      el.appendChild(box);
      el.appendChild(tooltip);

      // 模式：pinned 恒展开；hover 默认收起
      if (ann.mode === 'pinned') {
        el.classList.add('is-open');
      }

      this._bindInteractions(el, ann, circle, box);

      return el;
    }

    /** 顶部工具栏：圆圈、钉子、方向、删除。 */
    _buildToolbar(ann, color) {
      const bar = document.createElement('div');
      bar.className = 'annotation-toolbar';

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'annotation-tool is-dot';
      dot.title = '圆圈';
      dot.appendChild(svgPath('M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z'));
      bar.appendChild(dot);

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'annotation-tool is-pin' + (ann.mode === 'pinned' ? ' is-on' : '');
      pin.title = ann.mode === 'pinned' ? '切换为点击打开' : '切换为常亮';
      pin.appendChild(svgPath(ann.mode === 'pinned'
        ? 'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3Z'
        : 'M16 12c0-.55.45-1 1-1s1 .45 1 1v7c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2v-7c0-.55.45-1 1-1s1 .45 1 1v7h8v-7Z'));
      pin.addEventListener('click', event => {
        event.stopPropagation();
        const board = this.getBoard();
        const next = ann.mode === 'pinned' ? 'hover' : 'pinned';
        if (board && board.updateAnnotation) board.updateAnnotation(ann.id, { mode: next });
      });
      bar.appendChild(pin);

      const dir = document.createElement('button');
      dir.type = 'button';
      dir.className = 'annotation-tool is-direction';
      dir.title = '展开方向';
      dir.appendChild(svgPath('M4 12h16v2H4zM4 6h16v2H4zM4 16h16v2H4z'));
      dir.addEventListener('click', event => {
        event.stopPropagation();
        this._cycleDirection(ann);
      });
      bar.appendChild(dir);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'annotation-tool is-delete';
      del.title = '删除批注';
      del.appendChild(svgPath('M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z'));
      del.addEventListener('click', event => {
        event.stopPropagation();
        const board = this.getBoard();
        if (board && board.deleteAnnotation) board.deleteAnnotation(ann.id);
      });
      bar.appendChild(del);

      return bar;
    }

    /** 循环切换展开方向。 */
    _cycleDirection(ann) {
      const order = ['br', 'bl', 'tl', 'tr'];
      const idx = order.indexOf(ann.direction || 'br');
      const next = order[(idx + 1) % order.length];
      const board = this.getBoard();
      if (board && board.updateAnnotation) board.updateAnnotation(ann.id, { direction: next });
    }

    /** 圆圈：拖动改位置；点击切换 hover 展开收起。tooltip 悬浮/长按。 */
    _bindInteractions(el, ann, circle, box) {
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let baseX = 0;
      let baseY = 0;

      circle.addEventListener('pointerdown', event => {
        event.preventDefault();
        dragging = true;
        const board = this.getBoard();
        const surfaceRect = el.parentElement.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        baseX = clamp(Number(ann.x) || 0, 0, 1);
        baseY = clamp(Number(ann.y) || 0, 0, 1);
        circle.setPointerCapture(event.pointerId);
      });

      circle.addEventListener('pointermove', event => {
        if (!dragging) return;
        const surfaceRect = el.parentElement.getBoundingClientRect();
        const nx = baseX + (event.clientX - startX) / Math.max(surfaceRect.width || 1, 1);
        const ny = baseY + (event.clientY - startY) / Math.max(surfaceRect.height || 1, 1);
        el.style.left = (clamp(nx, 0, 1) * 100) + '%';
        el.style.top = (clamp(ny, 0, 1) * 100) + '%';
      });

      circle.addEventListener('pointerup', event => {
        if (!dragging) return;
        dragging = false;
        const surfaceRect = el.parentElement.getBoundingClientRect();
        const nx = baseX + (event.clientX - startX) / Math.max(surfaceRect.width || 1, 1);
        const ny = baseY + (event.clientY - startY) / Math.max(surfaceRect.height || 1, 1);
        const board = this.getBoard();
        if (board && board.updateAnnotation) {
          board.updateAnnotation(ann.id, { x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) });
        }
      });

      // 点击圆圈：hover 模式切换展开
      circle.addEventListener('click', event => {
        event.stopPropagation();
        if (ann.mode === 'hover') {
          const open = !el.classList.contains('is-open');
          el.classList.toggle('is-open', open);
        }
      });

      // 桌面悬浮一段时间 / 移动端长按显示昵称
      let hoverTimer = null;
      circle.addEventListener('mouseenter', () => {
        hoverTimer = setTimeout(() => el.classList.add('show-author'), HOVER_TOOLTIP_MS);
      });
      circle.addEventListener('mouseleave', () => {
        if (hoverTimer) clearTimeout(hoverTimer);
        el.classList.remove('show-author');
      });
      circle.addEventListener('contextmenu', event => {
        event.preventDefault();
        el.classList.add('show-author');
      });
    }
  }

  /** 内联 SVG 图标（不依赖 Material Symbols 字体，避免乱码）。 */
  function svgPath(d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  /** 兜底颜色。 */
  function defaultColor(playerId) {
    let hash = 0;
    const text = String(playerId || '');
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return 'hsl(' + (hash % 360) + ' 70% 55%)';
  }

  global.AnnotationLayer = AnnotationLayer;
})(window);
