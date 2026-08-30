(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-workspace-layout-v2';
  const LEFT_W_MIN = 52;
  const LEFT_W_MAX = 160;
  const RIGHT_W_MIN = 200;
  const RIGHT_W_MAX = 520;
  const DEFAULT_LEFT_W = 52;
  const DEFAULT_RIGHT_W = 280;
  const SPLITTER_PX = 6;
  const DEFAULT_SPLIT_RATIO = 0.45;

  /** 持久化 dock 尺寸与分割比例。 */
  class LayoutStore {
    static load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (_err) {
        return {};
      }
    }

    static save(data) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (_err) {}
    }
  }

  /** 注册可挂载 panel，供后续 UI 自定义布局扩展。 */
  class PanelRegistry {
    constructor() {
      this._panels = new Map();
    }

    register(spec) {
      if (!spec || !spec.id) return;
      this._panels.set(spec.id, spec);
    }

    get(id) {
      return this._panels.get(id) || null;
    }

    list() {
      return Array.from(this._panels.values());
    }
  }

  /** 初始化工作区：左右栏宽度、上下分割条、bottom tab。 */
  class WorkspaceLayout {
    constructor(options) {
      const settings = options || {};
      this.root = settings.root;
      this.rightDock = settings.rightDock;
      this.splitter = settings.splitter;
      this.gutterLeft = settings.gutterLeft;
      this.gutterRight = settings.gutterRight;
      this.rightTop = settings.rightTop;
      this.rightBottom = settings.rightBottom;
      this.registry = new PanelRegistry();
      this._saved = LayoutStore.load();
      this._applySideWidths();
      this._applySplitRatio();
      this._bindSplitter();
      this._bindWidthGutters();
      this._bindBottomTabs();
    }

    /** 是否处于左右栏视觉对调。 */
    _isSidesSwapped() {
      return Boolean(this.root && this.root.classList.contains('is-sides-swapped'));
    }

    /** 读取 CSS 变量像素值。 */
    _readVarPx(varName, fallback) {
      if (!this.root) return fallback;
      const raw = getComputedStyle(this.root).getPropertyValue(varName).trim();
      const value = parseFloat(raw);
      return Number.isFinite(value) ? value : fallback;
    }

    /** 写入 CSS 变量像素值。 */
    _setVarPx(varName, px) {
      if (!this.root) return;
      this.root.style.setProperty(varName, Math.round(px) + 'px');
    }

    _limitsForVar(varName) {
      if (varName === '--ws-left-w') return [LEFT_W_MIN, LEFT_W_MAX];
      return [RIGHT_W_MIN, RIGHT_W_MAX];
    }

    _storageKeyForVar(varName) {
      return varName === '--ws-left-w' ? 'leftWidth' : 'rightWidth';
    }

    /** 恢复并应用左右栏宽度。 */
    _applySideWidths() {
      if (!this.root) return;
      if (this._saved.leftWidth) {
        this._setVarPx('--ws-left-w', clamp(this._saved.leftWidth, LEFT_W_MIN, LEFT_W_MAX));
      }
      if (this._saved.rightWidth) {
        this._setVarPx('--ws-right-w', clamp(this._saved.rightWidth, RIGHT_W_MIN, RIGHT_W_MAX));
      }
    }

    /** 生成右侧上下分栏 grid-template-rows。 */
    _splitGridTemplate(ratio) {
      const top = clamp(ratio, 0.2, 0.8);
      const bottom = 1 - top;
      return `minmax(0, ${top}fr) ${SPLITTER_PX}px minmax(0, ${bottom}fr)`;
    }

    _applySplitRatio() {
      if (!this.rightDock) return;
      const ratio = clamp(
        this._saved.splitRatio != null ? this._saved.splitRatio : DEFAULT_SPLIT_RATIO,
        0.2,
        0.8
      );
      this.rightDock.style.gridTemplateRows = this._splitGridTemplate(ratio);
    }

    /** 首列与画布之间的分隔条：调整 leading 侧栏宽。 */
    _varForLeadingGutter() {
      return this._isSidesSwapped() ? '--ws-right-w' : '--ws-left-w';
    }

    /** 画布与末列之间的分隔条：调整 trailing 侧栏宽。 */
    _varForTrailingGutter() {
      return this._isSidesSwapped() ? '--ws-left-w' : '--ws-right-w';
    }

    /** 绑定左右栏水平拖拽分隔条。 */
    _bindWidthGutters() {
      if (this.gutterLeft) {
        this._bindWidthGutter(this.gutterLeft, 'leading');
      }
      if (this.gutterRight) {
        this._bindWidthGutter(this.gutterRight, 'trailing');
      }
    }

    _bindWidthGutter(gutter, edge) {
      let dragging = false;
      let startX = 0;
      let startWidth = 0;
      let activeVar = '';
      let activeKey = '';

      const onMove = event => {
        if (!dragging) return;
        const delta = edge === 'leading'
          ? event.clientX - startX
          : startX - event.clientX;
        const limits = this._limitsForVar(activeVar);
        const next = clamp(startWidth + delta, limits[0], limits[1]);
        this._setVarPx(activeVar, next);
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        gutter.classList.remove('is-dragging');
        document.body.classList.remove('is-dock-width-dragging');
        const limits = this._limitsForVar(activeVar);
        const current = this._readVarPx(
          activeVar,
          activeVar === '--ws-left-w' ? DEFAULT_LEFT_W : DEFAULT_RIGHT_W
        );
        this._saved[activeKey] = clamp(current, limits[0], limits[1]);
        LayoutStore.save(this._saved);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        window.dispatchEvent(new Event('resize'));
      };

      gutter.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        dragging = true;
        startX = event.clientX;
        activeVar = edge === 'leading'
          ? this._varForLeadingGutter()
          : this._varForTrailingGutter();
        activeKey = this._storageKeyForVar(activeVar);
        startWidth = this._readVarPx(
          activeVar,
          activeVar === '--ws-left-w' ? DEFAULT_LEFT_W : DEFAULT_RIGHT_W
        );
        gutter.classList.add('is-dragging');
        document.body.classList.add('is-dock-width-dragging');
        gutter.setPointerCapture(event.pointerId);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        event.preventDefault();
      });
    }

    _bindSplitter() {
      if (!this.splitter || !this.rightDock) return;
      let dragging = false;

      const onMove = event => {
        if (!dragging) return;
        const rect = this.rightDock.getBoundingClientRect();
        if (rect.height <= SPLITTER_PX) return;
        const y = (event.clientY - rect.top) / rect.height;
        const ratio = clamp(y, 0.2, 0.8);
        this.rightDock.style.gridTemplateRows = this._splitGridTemplate(ratio);
        this._saved.splitRatio = ratio;
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        this.splitter.classList.remove('is-dragging');
        document.body.classList.remove('is-dock-split-dragging');
        LayoutStore.save(this._saved);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        window.dispatchEvent(new Event('resize'));
      };

      this.splitter.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        dragging = true;
        this.splitter.classList.add('is-dragging');
        document.body.classList.add('is-dock-split-dragging');
        this.splitter.setPointerCapture(event.pointerId);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        event.preventDefault();
        event.stopPropagation();
      });
    }

    _bindBottomTabs() {
      const tabs = document.querySelectorAll('[data-bottom-tab]');
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const name = tab.dataset.bottomTab;
          tabs.forEach(t => t.classList.toggle('is-active', t.dataset.bottomTab === name));
          document.querySelectorAll('[data-bottom-pane]').forEach(pane => {
            pane.classList.toggle('is-active', pane.dataset.bottomPane === name);
          });
        });
      });
    }
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  global.LayoutStore = LayoutStore;
  global.PanelRegistry = PanelRegistry;
  global.WorkspaceLayout = WorkspaceLayout;
})(window);
