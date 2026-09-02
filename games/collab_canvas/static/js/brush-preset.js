(function (global) {
  'use strict';

  const STROKE_TOOLS = new Set(['brush', 'eraser', 'glow', 'spray']);

  const PRESET_DEFAULTS = {
    brush: {
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5,
      taperStart: true,
      taperEnd: true,
      opacity: 1,
      flow: 1,
      spacing: 0.25,
      randomJitter: 0,
      driverSource: 'pressure'
    },
    eraser: {
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5,
      taperStart: true,
      taperEnd: true,
      opacity: 1,
      flow: 1,
      spacing: 0.25,
      randomJitter: 0,
      driverSource: 'pressure'
    },
    glow: {
      thinning: 0.2,
      smoothing: 0.8,
      streamline: 0.6,
      taperStart: false,
      taperEnd: false,
      opacity: 0.55,
      flow: 0.5,
      spacing: 0.5,
      randomJitter: 0,
      driverSource: 'pressure'
    },
    spray: {
      thinning: 0.3,
      smoothing: 0.3,
      streamline: 0.3,
      taperStart: false,
      taperEnd: false,
      opacity: 0.75,
      flow: 0.7,
      spacing: 0.25,
      randomJitter: 0.35,
      driverSource: 'random'
    }
  };

  /** 多笔刷预设：集中管理 tool 变体与 perfect-freehand 参数，供联机 segment 渲染复用。 */
  class BrushPreset {
    constructor() {
      this.tool = 'brush';
      this.size = 8;
      this.id = 'round';
      this.name = '圆头笔';
      this.category = '常用';
      this.applyDefaults('brush');
    }

    /** 加载指定 tool 变体的默认参数集。 */
    applyDefaults(tool) {
      const defaults = PRESET_DEFAULTS[tool] || PRESET_DEFAULTS.brush;
      Object.assign(this, defaults);
    }

    /** 从注册表加载一个预设（id → 参数/名称/分组/tool）。 */
    applyPreset(presetId) {
      const registry = global.BrushRegistry;
      if (!registry || typeof registry.getPreset !== 'function') return false;
      const preset = registry.getPreset(presetId);
      if (!preset) return false;
      this.id = preset.id;
      this.name = preset.name;
      this.category = preset.category;
      this.tool = preset.tool;
      Object.assign(this, preset.params || {});
      return true;
    }

    /** 切换当前笔刷变体（brush / eraser / glow / spray）。 */
    setTool(tool) {
      if (!STROKE_TOOLS.has(tool)) return;
      this.tool = tool;
      this.applyDefaults(tool);
    }

    /** 同步 UI 滑块线宽到预设。 */
    setSize(size) {
      this.size = Math.max(1, Math.min(128, Number(size) || 8));
    }

    /**
     * 生成 perfect-freehand 选项；strokePart 控制首尾锥形（start/mid/end/single）。
     * last 恒为 true：每个 segment 都是独立完成的迷你笔画，轮廓必须到达真实端点，
     * 否则 last:false 会截短轮廓（streamline 插值到 57.5%），快速长线段之间出现断触。
     */
    getStrokeOptions(strokeSizePx, strokePart) {
      const part = strokePart || 'mid';
      const taperStart = this.taperStart && (part === 'start' || part === 'single');
      const taperEnd = this.taperEnd && (part === 'end' || part === 'single');
      return {
        size: strokeSizePx,
        thinning: this.thinning,
        smoothing: this.smoothing,
        streamline: this.streamline,
        simulatePressure: true,
        start: { taper: taperStart },
        end: { taper: taperEnd },
        last: true
      };
    }
  }

  global.BrushPreset = BrushPreset;
  global.STROKE_TOOLS = STROKE_TOOLS;
})(window);
