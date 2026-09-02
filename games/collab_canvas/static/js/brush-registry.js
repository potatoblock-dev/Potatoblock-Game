(function (global) {
  'use strict';

  /**
   * 笔刷预设注册表：集中定义可选的笔刷预设（名称/分组/工具/参数）。
   * 每个预设是一条「完整笔刷」，tool 决定 segment 协议，params 决定渲染质感。
   */
  const BRUSH_PRESETS = [
    {
      id: 'round',
      name: '圆头笔',
      category: '常用',
      tool: 'brush',
      icon: 'circle',
      params: {
        thinning: 0.5, smoothing: 0.5, streamline: 0.5,
        taperStart: true, taperEnd: true,
        opacity: 1, flow: 1, spacing: 0.25, randomJitter: 0,
        driverSource: 'pressure'
      }
    },
    {
      id: 'soft',
      name: '软头笔',
      category: '常用',
      tool: 'brush',
      icon: 'blur_on',
      params: {
        thinning: 0.35, smoothing: 0.85, streamline: 0.6,
        taperStart: true, taperEnd: true,
        opacity: 0.9, flow: 0.85, spacing: 0.3, randomJitter: 0,
        driverSource: 'pressure'
      }
    },
    {
      id: 'ink',
      name: '墨水笔',
      category: '常用',
      tool: 'brush',
      icon: 'ink_pen',
      params: {
        thinning: 0.65, smoothing: 0.5, streamline: 0.8,
        taperStart: true, taperEnd: true,
        opacity: 1, flow: 1, spacing: 0.15, randomJitter: 0,
        driverSource: 'pressure'
      }
    },
    {
      id: 'pencil',
      name: '铅笔',
      category: '常用',
      tool: 'brush',
      icon: 'edit',
      params: {
        thinning: 0.45, smoothing: 0.3, streamline: 0.4,
        taperStart: true, taperEnd: true,
        opacity: 0.85, flow: 0.8, spacing: 0.2, randomJitter: 0.15,
        driverSource: 'pressure'
      }
    },
    {
      id: 'glow',
      name: '光晕笔',
      category: '光效',
      tool: 'glow',
      icon: 'flare',
      params: {
        thinning: 0.2, smoothing: 0.8, streamline: 0.6,
        taperStart: false, taperEnd: false,
        opacity: 0.55, flow: 0.5, spacing: 0.5, randomJitter: 0,
        driverSource: 'pressure'
      }
    },
    {
      id: 'glow-marker',
      name: '发光马克笔',
      category: '光效',
      tool: 'glow',
      icon: 'lightbulb',
      params: {
        thinning: 0.15, smoothing: 0.9, streamline: 0.7,
        taperStart: false, taperEnd: false,
        opacity: 0.7, flow: 0.85, spacing: 0.4, randomJitter: 0,
        driverSource: 'pressure'
      }
    },
    {
      id: 'spray',
      name: '喷笔',
      category: '喷绘',
      tool: 'spray',
      icon: 'blur_on',
      params: {
        thinning: 0.3, smoothing: 0.3, streamline: 0.3,
        taperStart: false, taperEnd: false,
        opacity: 0.75, flow: 0.7, spacing: 0.25, randomJitter: 0.35,
        driverSource: 'random'
      }
    },
    {
      id: 'spray-grain',
      name: '颗粒喷笔',
      category: '喷绘',
      tool: 'spray',
      icon: 'grain',
      params: {
        thinning: 0.25, smoothing: 0.25, streamline: 0.25,
        taperStart: false, taperEnd: false,
        opacity: 0.7, flow: 0.6, spacing: 0.2, randomJitter: 0.6,
        driverSource: 'random'
      }
    },
    {
      id: 'eraser',
      name: '标准橡皮',
      category: '橡皮',
      tool: 'eraser',
      icon: 'ink_eraser',
      params: {
        thinning: 0.5, smoothing: 0.5, streamline: 0.5,
        taperStart: true, taperEnd: true,
        opacity: 1, flow: 1, spacing: 0.25, randomJitter: 0,
        driverSource: 'pressure'
      }
    }
  ];

  /** 分组顺序与标签。 */
  const BRUSH_CATEGORIES = [
    { id: '最近使用', label: '最近使用' },
    { id: '常用', label: '常用' },
    { id: '光效', label: '光效' },
    { id: '喷绘', label: '喷绘' },
    { id: '橡皮', label: '橡皮' }
  ];

  const BrushRegistry = {
    BRUSH_PRESETS,
    BRUSH_CATEGORIES,

    /** 按 id 查找预设。 */
    getPreset(id) {
      return BRUSH_PRESETS.find(p => p.id === id) || null;
    },

    /** 返回某分组下的预设列表。 */
    getByCategory(categoryId) {
      return BRUSH_PRESETS.filter(p => p.category === categoryId);
    },

    /** 全部预设按分组顺序排好（用于渲染），「最近使用」取 recent store 的 id 映射为预设对象。 */
    getGrouped() {
      const recents = (global.BrushRecentStore && global.BrushRecentStore.instance)
        ? global.BrushRecentStore.instance.getRecent()
        : [];
      const map = {
        '最近使用': recents
          .map(id => this.getPreset(id))
          .filter(p => Boolean(p))
      };
      BRUSH_PRESETS.forEach(p => {
        if (!map[p.category]) map[p.category] = [];
        map[p.category].push(p);
      });
      return BRUSH_CATEGORIES.map(cat => ({
        id: cat.id,
        label: cat.label,
        presets: map[cat.id] || []
      })).filter(group => group.presets.length);
    }
  };

  global.BrushRegistry = BrushRegistry;
})(window);
