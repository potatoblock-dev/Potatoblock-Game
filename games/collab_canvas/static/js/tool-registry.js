(function (global) {
  'use strict';

  /** 全部工具变体元数据。 */
  const TOOL_META = {
    brush: { icon: 'brush', label: '画笔' },
    eraser: { icon: 'ink_eraser', label: '橡皮' },
    fillBucket: { icon: 'format_color_fill', label: '油漆桶' },
    fillGradient: { icon: 'gradient', label: '线性渐变' },
    line: { icon: 'timeline', label: '直线' },
    eyedropper: { icon: 'colorize', label: '吸管' },
    rectOutline: { icon: 'crop_square', label: '空心矩形' },
    rectFill: { icon: 'square', label: '实心矩形' },
    ellipseOutline: { icon: 'circle', label: '空心圆形' },
    ellipseFill: { icon: 'radio_button_unchecked', label: '实心圆形' },
    selectRect: { icon: 'crop_free', label: '矩形选区' },
    selectEllipse: { icon: 'lens_blur', label: '圆形选区' },
    selectLasso: { icon: 'gesture', label: '套索选区' },
    selectPolygon: { icon: 'pentagon', label: '多边形选区' },
    magicWand: { icon: 'auto_fix', label: '魔棒' },
    hand: { icon: 'pan_tool', label: '抓手' },
    zoom: { icon: 'zoom_in', label: '缩放' }
  };

  /** 左侧工具栏分组（flyout 组含 variants）。 */
  const TOOL_GROUPS = [
    { id: 'brush', type: 'single', toolId: 'brush' },
    { id: 'eraser', type: 'single', toolId: 'eraser' },
    { id: 'fill', type: 'flyout', defaultVariant: 'fillBucket', variants: ['fillBucket', 'fillGradient'] },
    { id: 'line', type: 'single', toolId: 'line' },
    { id: 'eyedropper', type: 'single', toolId: 'eyedropper' },
    {
      id: 'shape',
      type: 'flyout',
      defaultVariant: 'rectOutline',
      variants: ['rectOutline', 'rectFill', 'ellipseOutline', 'ellipseFill']
    },
    {
      id: 'select',
      type: 'flyout',
      defaultVariant: 'selectRect',
      variants: ['selectRect', 'selectEllipse', 'selectLasso', 'selectPolygon', 'magicWand']
    },
    { id: 'hand', type: 'single', toolId: 'hand' },
    { id: 'zoom', type: 'single', toolId: 'zoom' }
  ];

  /** 快捷键 action → 工具变体 id。 */
  const SHORTCUT_TOOL_MAP = {
    toolBrush: 'brush',
    toolEraser: 'eraser',
    toolFill: 'fillBucket',
    toolLine: 'line',
    toolEyedropper: 'eyedropper',
    toolHand: 'hand',
    toolZoom: 'zoom'
  };

  const ToolRegistry = {
    TOOL_META,
    TOOL_GROUPS,
    SHORTCUT_TOOL_MAP,

    getMeta(toolId) {
      return TOOL_META[toolId] || { icon: 'help', label: toolId };
    },

    /** 返回组定义列表。 */
    getGroups() {
      return TOOL_GROUPS.slice();
    },

    /** 轮盘外环：每组当前激活变体。 */
    getRingTools(variantStore) {
      const store = variantStore || { get: () => '' };
      return TOOL_GROUPS.map(group => {
        if (group.type === 'single') return group.toolId;
        const saved = store.get(group.id);
        if (saved && group.variants.includes(saved)) return saved;
        return group.defaultVariant;
      });
    },

    findGroupForTool(toolId) {
      return TOOL_GROUPS.find(group => {
        if (group.type === 'single') return group.toolId === toolId;
        return group.variants.includes(toolId);
      }) || null;
    },

    resolveTool(toolId, variantStore) {
      const store = variantStore || { get: () => '' };
      const group = ToolRegistry.findGroupForTool(toolId);
      if (!group) return toolId;
      if (group.type === 'single') return group.toolId;
      if (group.variants.includes(toolId)) return toolId;
      const saved = store.get(group.id);
      if (saved && group.variants.includes(saved)) return saved;
      return group.defaultVariant;
    }
  };

  global.ToolRegistry = ToolRegistry;
  global.ToolRailMeta = TOOL_META;
})(window);
