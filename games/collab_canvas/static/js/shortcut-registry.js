(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-canvas-shortcuts-v1';

  const CATEGORY_LABELS = {
    history: '历史',
    tools: '工具',
    brush: '笔刷',
    view: '视图',
    layer: '图层',
    board: '画板',
    room: '房间',
    export: '导出',
    color: '颜色'
  };

  /** 全部可绑定动作及默认双键位。 */
  const ACTION_DEFS = {
    undo: { label: '撤销', category: 'history', bindings: ['Mod+KeyZ', ''] },
    redo: { label: '重做', category: 'history', bindings: ['Mod+Shift+KeyZ', 'Mod+KeyY'] },
    clearLayer: { label: '清空当前图层', category: 'history', bindings: ['', ''] },
    toolBrush: { label: '画笔工具', category: 'tools', bindings: ['KeyB', ''] },
    toolEraser: { label: '橡皮工具', category: 'tools', bindings: ['KeyE', ''] },
    toolZoom: { label: '缩放工具', category: 'tools', bindings: ['KeyZ', ''] },
    toolFill: { label: '油漆桶', category: 'tools', bindings: ['KeyF', ''] },
    toolLine: { label: '直线工具', category: 'tools', bindings: ['KeyL', ''] },
    toolEyedropper: { label: '吸管工具', category: 'tools', bindings: ['KeyI', 'Mod+KeyI'] },
    toolHand: { label: '抓手工具', category: 'tools', bindings: ['KeyH', ''] },
    toolMove: { label: '移动工具', category: 'tools', bindings: ['KeyV', ''] },
    selectionDelete: { label: '删除选区', category: 'tools', bindings: ['Delete', ''] },
    selectionFill: { label: '填充选区', category: 'tools', bindings: ['Mod+Delete', ''] },
    brushSizeUp: { label: '增大笔刷', category: 'brush', bindings: ['BracketRight', ''] },
    brushSizeDown: { label: '减小笔刷', category: 'brush', bindings: ['BracketLeft', ''] },
    debounceBoost: { label: '切换最高防抖', category: 'brush', bindings: ['', ''] },
    zoomIn: { label: '放大视图', category: 'view', bindings: ['Mod+Equal', ''] },
    zoomOut: { label: '缩小视图', category: 'view', bindings: ['Mod+Minus', ''] },
    resetView: { label: '重置视图', category: 'view', bindings: ['Digit0', ''] },
    layerNew: { label: '新建图层', category: 'layer', bindings: ['', ''] },
    layerDelete: { label: '删除图层', category: 'layer', bindings: ['', ''] },
    layerUp: { label: '图层上移', category: 'layer', bindings: ['', ''] },
    layerDown: { label: '图层下移', category: 'layer', bindings: ['', ''] },
    layerToggleVisible: { label: '切换图层可见', category: 'layer', bindings: ['', ''] },
    layerToggleLock: { label: '切换图层锁定', category: 'layer', bindings: ['', ''] },
    layerRename: { label: '重命名图层', category: 'layer', bindings: ['F2', ''] },
    boardNew: { label: '新建画板', category: 'board', bindings: ['', ''] },
    boardPrev: { label: '上一个画板', category: 'board', bindings: ['', ''] },
    boardNext: { label: '下一个画板', category: 'board', bindings: ['', ''] },
    copyLink: { label: '复制房间链接', category: 'room', bindings: ['', ''] },
    leaveRoom: { label: '离开房间', category: 'room', bindings: ['', ''] },
    openSettings: { label: '打开设置', category: 'room', bindings: ['Comma', 'Mod+Comma'] },
    swapColors: { label: '交换主色/背景色', category: 'color', bindings: ['KeyX', ''] },
    exportPng: { label: '导出 PNG', category: 'export', bindings: ['', ''] },
    exportJpeg: { label: '导出 JPEG', category: 'export', bindings: ['', ''] },
    exportKra: { label: '导出 KRA', category: 'export', bindings: ['', ''] },
    exportSkt: { label: '导出 Sketchbook', category: 'export', bindings: ['', ''] },
    exportHsj: { label: '导出画世界 Pro', category: 'export', bindings: ['', ''] },
    exportProcreate: { label: '导出 Procreate', category: 'export', bindings: ['', ''] },
    exportPsd: { label: '导出 Photoshop', category: 'export', bindings: ['', ''] },
    exportPbcc: { label: '导出 PBCC', category: 'export', bindings: ['', ''] }
  };

  /** 深拷贝默认绑定表。 */
  function defaultBindings() {
    const out = {};
    Object.keys(ACTION_DEFS).forEach(id => {
      out[id] = ACTION_DEFS[id].bindings.slice();
    });
    return out;
  }

  /** 从 localStorage 读取绑定，缺失项用默认。 */
  function loadBindings() {
    const merged = defaultBindings();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return merged;
      const saved = JSON.parse(raw);
      Object.keys(ACTION_DEFS).forEach(id => {
        if (!Array.isArray(saved[id])) return;
        merged[id] = [
          String(saved[id][0] || ''),
          String(saved[id][1] || '')
        ];
      });
    } catch (_err) {}
    return merged;
  }

  /** 持久化绑定表。 */
  function saveBindings(bindings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    } catch (_err) {}
  }

  global.ShortcutRegistry = {
    STORAGE_KEY,
    ACTION_DEFS,
    CATEGORY_LABELS,
    defaultBindings,
    loadBindings,
    saveBindings
  };
})(window);
