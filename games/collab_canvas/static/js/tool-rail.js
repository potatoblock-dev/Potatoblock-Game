(function (global) {
  'use strict';

  const TOOL_META = {
    brush: { icon: 'brush', label: '画笔' },
    eraser: { icon: 'ink_eraser', label: '橡皮' },
    zoom: { icon: 'zoom_in', label: '缩放' }
  };

  /** 左侧竖向工具栏。 */
  class ToolRail {
    constructor(mount, options) {
      const settings = options || {};
      this.mount = mount;
      this.onChange = settings.onChange || (() => {});
      this._tools = settings.tools || ['brush', 'eraser', 'zoom'];
      this.currentTool = settings.initialTool || 'brush';
      this._render(this._tools);
    }

    /** 返回当前工具 id 列表。 */
    getTools() {
      return this._tools.slice();
    }

    /** 返回工具元数据。 */
    static getToolMeta(toolId) {
      return TOOL_META[toolId] || { icon: 'help', label: toolId };
    }

    _render(tools) {
      if (!this.mount) return;
      this.mount.innerHTML = '';
      tools.forEach(toolId => {
        const meta = ToolRail.getToolMeta(toolId);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tool-rail-btn' + (toolId === this.currentTool ? ' is-active' : '');
        btn.dataset.tool = toolId;
        btn.setAttribute('data-tooltip', meta.label);
        btn.setAttribute('aria-label', meta.label);
        btn.appendChild(MaterialIcons.createIcon(meta.icon, 'tool-rail-icon'));
        btn.addEventListener('click', () => this.setTool(toolId));
        this.mount.appendChild(btn);
      });
    }

    setTool(toolId) {
      this.currentTool = toolId;
      this.mount.querySelectorAll('[data-tool]').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.tool === toolId);
      });
      this.onChange(toolId);
    }

    getTool() {
      return this.currentTool;
    }
  }

  global.ToolRail = ToolRail;
  global.ToolRailMeta = TOOL_META;
})(window);
