(function (global) {
  'use strict';

  const LONG_PRESS_MS = 400;

  /** 左侧竖向工具栏，支持 flyout 工具组。 */
  class ToolRail {
    constructor(mount, options) {
      const settings = options || {};
      this.mount = mount;
      this.onChange = settings.onChange || (() => {});
      this.variantStore = settings.variantStore || new ToolVariantStore();
      this.currentTool = ToolRegistry.resolveTool(settings.initialTool || 'brush', this.variantStore);
      this._openFlyout = null;
      this._longPressTimer = null;
      this._touchFine = window.matchMedia('(pointer: fine)').matches;
      this._onDocPointer = this._onDocPointer.bind(this);
      this._onDocKey = this._onDocKey.bind(this);
      document.addEventListener('pointerdown', this._onDocPointer, true);
      document.addEventListener('keydown', this._onDocKey, true);
      this._render();
    }

    /** 返回轮盘外环工具（每组当前变体）。 */
    getTools() {
      return ToolRegistry.getRingTools(this.variantStore);
    }

    /** 返回工具元数据。 */
    static getToolMeta(toolId) {
      return ToolRegistry.getMeta(toolId);
    }

    /** 当前激活的具体变体 id。 */
    getTool() {
      return this.currentTool;
    }

    getActiveTool() {
      return this.currentTool;
    }

    _groupActiveTool(group) {
      if (group.type === 'single') return group.toolId;
      const saved = this.variantStore.get(group.id);
      if (saved && group.variants.includes(saved)) return saved;
      return group.defaultVariant;
    }

    _render() {
      if (!this.mount) return;
      this.mount.innerHTML = '';
      ToolRegistry.getGroups().forEach(group => {
        const activeId = this._groupActiveTool(group);
        const isActive = group.type === 'single'
          ? activeId === this.currentTool
          : group.variants.includes(this.currentTool);
        if (group.type === 'single') {
          this.mount.appendChild(this._createSingleBtn(group.toolId, isActive));
          return;
        }
        this.mount.appendChild(this._createGroupBtn(group, activeId, isActive));
      });
    }

    _createSingleBtn(toolId, isActive) {
      const meta = ToolRail.getToolMeta(toolId);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-rail-btn' + (isActive ? ' is-active' : '');
      btn.dataset.tool = toolId;
      btn.setAttribute('data-tooltip', meta.label);
      btn.setAttribute('aria-label', meta.label);
      btn.appendChild(MaterialIcons.createIcon(meta.icon, 'tool-rail-icon'));
      btn.addEventListener('click', () => this.setTool(toolId));
      return btn;
    }

    _createGroupBtn(group, activeId, isActive) {
      const meta = ToolRail.getToolMeta(activeId);
      const wrap = document.createElement('div');
      wrap.className = 'tool-rail-group';
      wrap.dataset.group = group.id;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-rail-btn tool-rail-group-main' + (isActive ? ' is-active' : '');
      btn.dataset.tool = activeId;
      btn.dataset.group = group.id;
      btn.setAttribute('data-tooltip', meta.label);
      btn.setAttribute('aria-label', meta.label);
      btn.appendChild(MaterialIcons.createIcon(meta.icon, 'tool-rail-icon'));
      const caret = document.createElement('span');
      caret.className = 'tool-rail-flyout-caret material-symbols-outlined';
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = 'arrow_drop_down';
      btn.appendChild(caret);

      btn.addEventListener('click', () => this.setTool(activeId));
      if (this._touchFine) {
        btn.addEventListener('mouseenter', () => this._openGroupFlyout(group, wrap));
        btn.addEventListener('mouseleave', () => this._scheduleCloseFlyout());
        wrap.addEventListener('mouseenter', () => this._cancelCloseFlyout());
        wrap.addEventListener('mouseleave', () => this._scheduleCloseFlyout());
      }
      btn.addEventListener('pointerdown', event => {
        if (this._touchFine || event.pointerType === 'mouse') return;
        this._longPressTimer = window.setTimeout(() => {
          this._longPressTimer = null;
          this._openGroupFlyout(group, wrap);
        }, LONG_PRESS_MS);
      });
      btn.addEventListener('pointerup', () => this._clearLongPress());
      btn.addEventListener('pointercancel', () => this._clearLongPress());

      wrap.appendChild(btn);
      return wrap;
    }

    _clearLongPress() {
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = null;
      }
    }

    _scheduleCloseFlyout() {
      this._closeTimer = window.setTimeout(() => this._closeFlyout(), 120);
    }

    _cancelCloseFlyout() {
      if (this._closeTimer) {
        clearTimeout(this._closeTimer);
        this._closeTimer = null;
      }
    }

    _openGroupFlyout(group, wrap) {
      this._cancelCloseFlyout();
      this._closeFlyout();
      const flyout = document.createElement('div');
      flyout.className = 'tool-rail-flyout';
      flyout.setAttribute('role', 'menu');
      group.variants.forEach(variantId => {
        const meta = ToolRail.getToolMeta(variantId);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'tool-rail-flyout-item' + (variantId === this.currentTool ? ' is-active' : '');
        item.dataset.tool = variantId;
        item.setAttribute('role', 'menuitem');
        item.setAttribute('aria-label', meta.label);
        item.appendChild(MaterialIcons.createIcon(meta.icon, 'tool-rail-flyout-icon'));
        const label = document.createElement('span');
        label.className = 'tool-rail-flyout-label';
        label.textContent = meta.label;
        item.appendChild(label);
        item.addEventListener('click', event => {
          event.stopPropagation();
          this.setTool(variantId);
          this._closeFlyout();
        });
        flyout.appendChild(item);
      });
      wrap.appendChild(flyout);
      this._openFlyout = flyout;
    }

    _closeFlyout() {
      if (this._openFlyout && this._openFlyout.parentNode) {
        this._openFlyout.parentNode.removeChild(this._openFlyout);
      }
      this._openFlyout = null;
    }

    _onDocPointer(event) {
      if (!this._openFlyout) return;
      const group = event.target.closest('.tool-rail-group');
      if (group && group.contains(this._openFlyout)) return;
      this._closeFlyout();
    }

    _onDocKey(event) {
      if (event.key === 'Escape') this._closeFlyout();
    }

    /** 切换工具；silent 为 true 时不触发 onChange（由 board 同步调用）。 */
    setTool(toolId, options) {
      const settings = options || {};
      const resolved = ToolRegistry.resolveTool(toolId, this.variantStore);
      const group = ToolRegistry.findGroupForTool(resolved);
      if (group && group.type === 'flyout') {
        this.variantStore.set(group.id, resolved);
      }
      const changed = resolved !== this.currentTool;
      this.currentTool = resolved;
      this._closeFlyout();
      if (changed || settings.forceRender) {
        this._render();
      } else {
        this._syncActiveUi();
      }
      if (changed && !settings.silent) {
        this.onChange(resolved);
      }
    }

    /** 仅刷新激活态，避免重复 innerHTML 清空重建。 */
    _syncActiveUi() {
      if (!this.mount) return;
      ToolRegistry.getGroups().forEach(group => {
        if (group.type === 'single') {
          const btn = this.mount.querySelector('.tool-rail-btn[data-tool="' + group.toolId + '"]');
          if (btn) btn.classList.toggle('is-active', group.toolId === this.currentTool);
          return;
        }
        const wrap = this.mount.querySelector('.tool-rail-group[data-group="' + group.id + '"]');
        if (!wrap) return;
        const main = wrap.querySelector('.tool-rail-group-main');
        if (main) main.classList.toggle('is-active', group.variants.includes(this.currentTool));
      });
    }
  }

  global.ToolRail = ToolRail;
})(window);
