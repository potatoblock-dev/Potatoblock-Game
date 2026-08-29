(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-workspace-layout-v2';

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

  /** 初始化工作区：右栏宽度、上下分割条、bottom tab。 */
  class WorkspaceLayout {
    constructor(options) {
      const settings = options || {};
      this.root = settings.root;
      this.rightDock = settings.rightDock;
      this.splitter = settings.splitter;
      this.rightTop = settings.rightTop;
      this.rightBottom = settings.rightBottom;
      this.registry = new PanelRegistry();
      this._saved = LayoutStore.load();
      this._applyRightWidth();
      this._applySplitRatio();
      this._bindSplitter();
      this._bindBottomTabs();
    }

    _applyRightWidth() {
      if (!this.root || !this._saved.rightWidth) return;
      this.root.style.setProperty('--ws-right-w', this._saved.rightWidth + 'px');
    }

    _applySplitRatio() {
      if (!this.rightDock || !this._saved.splitRatio) return;
      const ratio = clamp(this._saved.splitRatio, 0.2, 0.8);
      this.rightDock.style.gridTemplateRows = `${ratio}fr 4px ${1 - ratio}fr`;
    }

    _bindSplitter() {
      if (!this.splitter || !this.rightDock) return;
      let dragging = false;
      let startY = 0;
      let startRatio = 0.5;

      const onMove = event => {
        if (!dragging) return;
        const rect = this.rightDock.getBoundingClientRect();
        const y = (event.clientY - rect.top) / rect.height;
        const ratio = clamp(y, 0.2, 0.8);
        this.rightDock.style.gridTemplateRows = `${ratio}fr 4px ${1 - ratio}fr`;
        this._saved.splitRatio = ratio;
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        this.splitter.classList.remove('is-dragging');
        LayoutStore.save(this._saved);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };

      this.splitter.addEventListener('pointerdown', event => {
        dragging = true;
        startY = event.clientY;
        const parts = this.rightDock.style.gridTemplateRows.split(' ');
        startRatio = parts[0] ? parseFloat(parts[0]) : 0.5;
        if (!Number.isFinite(startRatio)) startRatio = 0.5;
        this.splitter.classList.add('is-dragging');
        this.splitter.setPointerCapture(event.pointerId);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
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
