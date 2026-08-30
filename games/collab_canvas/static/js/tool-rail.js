(function (global) {
  'use strict';

  /** 左侧竖向工具栏；同类变体通过底部小三角展开（Aseprite 式横条）。 */
  class ToolRail {
    constructor(mount, options) {
      const settings = options || {};
      this.mount = mount;
      this.onChange = settings.onChange || (() => {});
      this.variantStore = settings.variantStore || new ToolVariantStore();
      this.currentTool = ToolRegistry.resolveTool(settings.initialTool || 'brush', this.variantStore);
      this._openGroupId = null;
      this._openFlyoutWrap = null;
      this._openFlyoutEl = null;
      this._flyoutReposition = null;
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
      this._closeFlyout();
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
      btn.appendChild(MaterialIcons.createToolIcon(meta, 'tool-rail-icon'));
      btn.addEventListener('click', () => this.setTool(toolId));
      return btn;
    }

    _createGroupBtn(group, activeId, isActive) {
      const meta = ToolRail.getToolMeta(activeId);
      const wrap = document.createElement('div');
      wrap.className = 'tool-rail-group';
      wrap.dataset.group = group.id;

      const cell = document.createElement('div');
      cell.className = 'tool-rail-group-cell';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-rail-btn tool-rail-group-main' + (isActive ? ' is-active' : '');
      btn.dataset.tool = activeId;
      btn.dataset.group = group.id;
      btn.setAttribute('data-tooltip', meta.label);
      btn.setAttribute('aria-label', meta.label);
      btn.appendChild(MaterialIcons.createToolIcon(meta, 'tool-rail-icon'));
      btn.addEventListener('click', () => this.setTool(activeId));

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tool-rail-flyout-toggle';
      toggle.setAttribute('aria-label', '展开同类工具');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('data-tooltip', '展开同类工具');
      const caret = document.createElement('span');
      caret.className = 'tool-rail-flyout-caret material-symbols-outlined';
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = 'arrow_drop_down';
      toggle.appendChild(caret);
      toggle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleGroupFlyout(group, wrap);
      });

      cell.appendChild(btn);
      cell.appendChild(toggle);
      wrap.appendChild(cell);
      return wrap;
    }

    /** 点击小三角：展开/收起横向变体条。 */
    _toggleGroupFlyout(group, wrap) {
      if (this._openGroupId === group.id && this._openFlyoutWrap === wrap) {
        this._closeFlyout();
        return;
      }
      this._openGroupFlyout(group, wrap);
    }

    _openGroupFlyout(group, wrap) {
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
        item.setAttribute('data-tooltip', meta.label);
        item.appendChild(MaterialIcons.createToolIcon(meta, 'tool-rail-flyout-icon'));
        item.addEventListener('click', event => {
          event.stopPropagation();
          this.setTool(variantId);
        });
        flyout.appendChild(item);
      });
      document.body.appendChild(flyout);
      this._positionFlyout(flyout, wrap);
      wrap.classList.add('is-flyout-open');
      const toggle = wrap.querySelector('.tool-rail-flyout-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
      this._openGroupId = group.id;
      this._openFlyoutWrap = wrap;
      this._openFlyoutEl = flyout;
      this._flyoutReposition = () => this._positionFlyout(flyout, wrap);
      window.addEventListener('resize', this._flyoutReposition);
      window.addEventListener('scroll', this._flyoutReposition, true);
    }

    /** 自工具栏向外侧固定定位 flyout（避免 overflow 裁切）。 */
    _positionFlyout(flyout, wrap) {
      if (!flyout || !wrap) return;
      const rect = wrap.getBoundingClientRect();
      flyout.style.position = 'fixed';
      const swapped = document.getElementById('collabWorkspace')?.classList.contains('is-sides-swapped');
      if (swapped) {
        flyout.style.left = Math.round(rect.left - flyout.offsetWidth - 2) + 'px';
      } else {
        flyout.style.left = Math.round(rect.right + 2) + 'px';
      }
      flyout.style.top = Math.round(rect.top + (rect.height - flyout.offsetHeight) / 2) + 'px';
      flyout.style.zIndex = '2000';
    }

    /** 左右栏对调后重算已打开 flyout 的位置。 */
    repositionOpenFlyout() {
      if (this._openFlyoutEl && this._openFlyoutWrap) {
        this._positionFlyout(this._openFlyoutEl, this._openFlyoutWrap);
      }
    }

    _closeFlyout() {
      if (this._flyoutReposition) {
        window.removeEventListener('resize', this._flyoutReposition);
        window.removeEventListener('scroll', this._flyoutReposition, true);
        this._flyoutReposition = null;
      }
      if (this._openFlyoutWrap) {
        this._openFlyoutWrap.classList.remove('is-flyout-open');
        const toggle = this._openFlyoutWrap.querySelector('.tool-rail-flyout-toggle');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      }
      if (this._openFlyoutEl && this._openFlyoutEl.parentNode) {
        this._openFlyoutEl.parentNode.removeChild(this._openFlyoutEl);
      }
      this._openGroupId = null;
      this._openFlyoutWrap = null;
      this._openFlyoutEl = null;
    }

    _onDocPointer(event) {
      if (!this._openFlyoutEl) return;
      if (event.target.closest('.tool-rail-flyout')) return;
      if (this._openFlyoutWrap && this._openFlyoutWrap.contains(event.target)) return;
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
