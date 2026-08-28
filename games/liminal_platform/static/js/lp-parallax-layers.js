/**
 * 列车前景 / 中景视差层：随 LpTrack 卷动，制造速度感。
 * 中景在背景与轨道之间（~0.35–0.55× 轨速）；前景在玩法层之上（~1.15–1.35×），
 * 线性随 scrollX 向左退，与列车右行方向相反。
 * 另绘可遮挡视野的地形遮挡物（默认林地树干）；进出月台柱列仍由 LpStationTransit 负责。
 * 后续路线/地形：registerTerrain / setTerrain 换包即可加工业柱、峡谷壁等。
 */
(() => {
  /** 与背景区分的子流盐。 */
  const LAYER_STREAM = 0xc3a11e;
  /** 遮挡物子流盐。 */
  const OCCLUDER_STREAM = 0x7ee011;
  /** FOV 外延（世界像素）。 */
  const FOV_MARGIN = 160;
  /** 水平平铺周期相对视口宽度倍数。 */
  const PERIOD_MUL = 2.15;
  /** 遮挡物平铺周期倍数（略疏，避免糊成墙）。 */
  const OCCLUDER_PERIOD_MUL = 2.8;
  /** 中景数量上下限。 */
  const MG_MIN = 5;
  const MG_MAX = 11;
  /** 前景柔形数量上下限（更少、更大）。 */
  const FG_MIN = 2;
  const FG_MAX = 5;
  const SHAPES = ['ellipse', 'blob', 'petal', 'squircle', 'diamond', 'ring'];

  /**
   * 地形包：决定路上遮挡物种类与配色。未来新路线在此追加或 registerTerrain。
   * @type {Record<string, TerrainPack>}
   */
  const TERRAIN_PACKS = {
    woodland: {
      id: 'woodland',
      label: '林地',
      kinds: ['trunk', 'lean_trunk'],
      bark: [
        [22, 16, 12],
        [34, 26, 18],
        [48, 36, 24],
        [18, 22, 16],
      ],
      fgCount: [3, 7],
      mgCount: [2, 5],
      fgScroll: [1.22, 1.48],
      mgScroll: [0.38, 0.55],
      coreAlpha: [0.58, 0.86],
    },
  };

  /** @type {string} */
  let terrainId = 'woodland';
  /** @type {string|null} */
  let appliedTerrainId = null;
  /** @type {number|null} */
  let appliedSeed = null;
  /** @type {number} */
  let appliedQuality = 1;
  /** @type {LayerTheme|null} */
  let theme = null;
  /** @type {ShapeSpec[]} */
  let midShapes = [];
  /** @type {ShapeSpec[]} */
  let foreShapes = [];
  /** @type {OccluderSpec[]} */
  let midOccluders = [];
  /** @type {OccluderSpec[]} */
  let foreOccluders = [];
  /** @type {MediaQueryList|null} */
  let coarseMq = null;
  let timeSec = 0;

  /**
   * @typedef {{
   *   seed: number,
   *   palette: number[][],
   *   opacity: number,
   *   drift: number,
   * }} LayerTheme
   */

  /**
   * @typedef {{
   *   shape: string,
   *   u: number,
   *   v: number,
   *   sizeN: number,
   *   aspect: number,
   *   rot: number,
   *   lobe: number,
   *   wobble: number,
   *   phase: number,
   *   speedN: number,
   *   colorI: number,
   *   scrollFactor: number,
   *   peakMul: number,
   * }} ShapeSpec
   */

  /**
   * @typedef {{
   *   id: string,
   *   label: string,
   *   kinds: string[],
   *   bark: number[][],
   *   fgCount: [number, number],
   *   mgCount: [number, number],
   *   fgScroll: [number, number],
   *   mgScroll: [number, number],
   *   coreAlpha: [number, number],
   * }} TerrainPack
   */

  /**
   * @typedef {{
   *   kind: string,
   *   u: number,
   *   widthN: number,
   *   heightN: number,
   *   lean: number,
   *   phase: number,
   *   scrollFactor: number,
   *   barkI: number,
   *   coreAlpha: number,
   *   canopy: boolean,
   * }} OccluderSpec
   */

  /** 触控 / 低 DPR 降密度。 */
  function qualityFactor() {
    if (!coarseMq) coarseMq = window.matchMedia('(pointer: coarse)');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (coarseMq.matches && dpr < 1.5) return 0.45;
    if (coarseMq.matches) return 0.55;
    if (dpr < 1.25) return 0.75;
    return 1;
  }

  /** mulberry32：优先复用 LpDungeon。 */
  function mulberry32(seed) {
    const D = window.LpDungeon;
    if (D?.mulberry32) return D.mulberry32(seed);
    let a = seed >>> 0;
    return function rng() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** hash2：优先复用 LpDungeon。 */
  function hash2(worldSeed, salt) {
    const D = window.LpDungeon;
    if (D?.hash2) return D.hash2(worldSeed, salt);
    let h = (worldSeed >>> 0) ^ Math.imul((salt | 0) + 1, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  /**
   * HSL → RGB（0–255）。
   * @param {number} hDeg
   * @param {number} s
   * @param {number} l
   * @returns {number[]}
   */
  function hslToRgb(hDeg, s, l) {
    const h = ((hDeg % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) {
      r = c;
      g = x;
    } else if (h < 120) {
      r = x;
      g = c;
    } else if (h < 180) {
      g = c;
      b = x;
    } else if (h < 240) {
      g = x;
      b = c;
    } else if (h < 300) {
      r = x;
      b = c;
    } else {
      r = c;
      b = x;
    }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ];
  }

  /**
   * 解析世界种子（与背景同源）。
   * @returns {number}
   */
  function resolveWorldSeed() {
    if (window.LpPlatform?.getWorldSeed) {
      const live = window.LpPlatform.getWorldSeed();
      if (Number.isFinite(live)) return live >>> 0;
    }
    if (appliedSeed != null) return appliedSeed;
    return (Math.random() * 0x1fffffffffffff) >>> 0;
  }

  /**
   * 列车场景才启用（月台/地牢不画，避免杂乱）。
   * @returns {boolean}
   */
  function isTrainScene() {
    return window.LpPlatform?.getScene?.() !== 'platform';
  }

  /**
   * 当前地形包；未知 id 回退林地。
   * @returns {TerrainPack}
   */
  function getTerrainPack() {
    return TERRAIN_PACKS[terrainId] || TERRAIN_PACKS.woodland;
  }

  /**
   * 由地形包与种子生成一层遮挡物规格。
   * @param {() => number} rng
   * @param {TerrainPack} pack
   * @param {number} count
   * @param {[number, number]} scrollRange
   * @param {boolean} foreground
   * @returns {OccluderSpec[]}
   */
  function buildOccluders(rng, pack, count, scrollRange, foreground) {
    /** @type {OccluderSpec[]} */
    const list = [];
    const kinds = pack.kinds.length ? pack.kinds : ['trunk'];
    for (let i = 0; i < count; i += 1) {
      const kind = kinds[Math.floor(rng() * kinds.length)];
      const leanBase = kind === 'lean_trunk' ? 0.08 + rng() * 0.14 : rng() * 0.05;
      list.push({
        kind,
        u: (i + 0.12 + rng() * 0.76) / Math.max(1, count),
        widthN: foreground
          ? 0.045 + rng() * 0.07
          : 0.022 + rng() * 0.035,
        heightN: foreground
          ? 0.78 + rng() * 0.28
          : 0.55 + rng() * 0.35,
        lean: (rng() < 0.5 ? -1 : 1) * leanBase,
        phase: rng() * Math.PI * 2,
        scrollFactor:
          scrollRange[0] + rng() * (scrollRange[1] - scrollRange[0]),
        barkI: Math.floor(rng() * pack.bark.length),
        coreAlpha:
          pack.coreAlpha[0] +
          rng() * (pack.coreAlpha[1] - pack.coreAlpha[0]) *
            (foreground ? 1 : 0.55),
        canopy: foreground ? rng() > 0.35 : rng() > 0.7,
      });
    }
    return list;
  }

  /**
   * 由世界种子重建中景/前景规格表与地形遮挡物。
   * @param {number} worldSeed
   */
  function rebuildFromSeed(worldSeed) {
    const seed = worldSeed >>> 0;
    const rng = mulberry32(hash2(seed, LAYER_STREAM));
    const q = qualityFactor();
    appliedQuality = q;

    const hue = rng() * 360;
    const saturation = 0.28 + rng() * 0.42;
    const brightness = 0.36 + rng() * 0.26;
    const density = 0.4 + rng() * 0.55;
    const opacity = 0.7 + rng() * 0.45;
    const drift = 0.5 + rng() * 0.7;

    /** @type {number[][]} */
    const palette = [];
    const n = 4 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i += 1) {
      const h = hue + (i - (n - 1) / 2) * (16 + rng() * 24) + (rng() - 0.5) * 12;
      const s = Math.max(0.16, Math.min(0.72, saturation * (0.7 + rng() * 0.4)));
      const l = Math.max(0.26, Math.min(0.58, brightness * (0.85 + rng() * 0.35)));
      palette.push(hslToRgb(h, s, l));
    }

    const mgCount = Math.max(
      3,
      Math.round((MG_MIN + density * (MG_MAX - MG_MIN)) * q)
    );
    const fgCount = Math.max(
      1,
      Math.round((FG_MIN + density * (FG_MAX - FG_MIN)) * Math.max(0.5, q))
    );

    /** @type {ShapeSpec[]} */
    const nextMg = [];
    for (let i = 0; i < mgCount; i += 1) {
      nextMg.push({
        shape: SHAPES[Math.floor(rng() * SHAPES.length)],
        u: rng(),
        v: 0.08 + rng() * 0.55,
        sizeN: 0.07 + rng() * 0.11,
        aspect: 0.55 + rng() * 0.7,
        rot: (rng() - 0.5) * 0.85,
        lobe: 2 + Math.floor(rng() * 3),
        wobble: 0.1 + rng() * 0.22,
        phase: rng() * Math.PI * 2,
        speedN: 0.5 + rng() * 0.6,
        colorI: Math.floor(rng() * palette.length),
        scrollFactor: 0.32 + rng() * 0.26,
        peakMul: 0.55 + rng() * 0.35,
      });
    }

    /** @type {ShapeSpec[]} */
    const nextFg = [];
    for (let i = 0; i < fgCount; i += 1) {
      /* 柔形前景偏上下缘，少挡车厢中带；硬遮挡由树干承担 */
      const edgePick = rng();
      const v =
        edgePick < 0.48
          ? 0.02 + rng() * 0.18
          : edgePick < 0.92
            ? 0.72 + rng() * 0.24
            : 0.35 + rng() * 0.25;
      nextFg.push({
        shape: SHAPES[Math.floor(rng() * (SHAPES.length - 1))],
        u: rng(),
        v,
        sizeN: 0.12 + rng() * 0.16,
        aspect: 0.5 + rng() * 0.75,
        rot: (rng() - 0.5) * 1.1,
        lobe: 2 + Math.floor(rng() * 3),
        wobble: 0.12 + rng() * 0.25,
        phase: rng() * Math.PI * 2,
        speedN: 0.6 + rng() * 0.7,
        colorI: Math.floor(rng() * palette.length),
        scrollFactor: 1.12 + rng() * 0.26,
        peakMul: 0.28 + rng() * 0.22,
      });
    }

    const pack = getTerrainPack();
    const ocRng = mulberry32(hash2(seed, OCCLUDER_STREAM ^ (terrainId.length * 0x9e37)));
    const fgOcc = Math.max(
      2,
      Math.round((pack.fgCount[0] + density * (pack.fgCount[1] - pack.fgCount[0])) * q)
    );
    const mgOcc = Math.max(
      1,
      Math.round((pack.mgCount[0] + density * (pack.mgCount[1] - pack.mgCount[0])) * q)
    );

    theme = { seed, palette, opacity, drift };
    midShapes = nextMg;
    foreShapes = nextFg;
    midOccluders = buildOccluders(ocRng, pack, mgOcc, pack.mgScroll, false);
    foreOccluders = buildOccluders(ocRng, pack, fgOcc, pack.fgScroll, true);
    appliedSeed = seed;
    appliedTerrainId = terrainId;
  }

  /** 种子、画质或地形变化时重建。 */
  function ensureTheme() {
    const seed = resolveWorldSeed();
    const q = qualityFactor();
    if (
      theme &&
      appliedSeed === seed &&
      appliedTerrainId === terrainId &&
      Math.abs(appliedQuality - q) < 0.08
    ) {
      return;
    }
    rebuildFromSeed(seed);
  }

  /**
   * 外部写入种子（与 LpPlatform.setWorldSeed 同步）。
   * @param {number} seed
   */
  function setSeed(seed) {
    if (seed == null || !Number.isFinite(Number(seed))) return;
    rebuildFromSeed(Number(seed) >>> 0);
  }

  /**
   * 推进轻量漂移动画时钟。
   * @param {number} [dt]
   */
  function tick(dt) {
    if (Number.isFinite(dt) && dt > 0) {
      timeSec += Math.min(0.05, dt);
    } else {
      timeSec = performance.now() * 0.001;
    }
  }

  /**
   * 从世界变换求可见矩形。
   * @param {CanvasRenderingContext2D} ctx
   * @returns {{ left: number, right: number, top: number, bot: number, w: number, h: number } | null}
   */
  function viewRectFromTransform(ctx) {
    const m = ctx.getTransform();
    const sx = m.a;
    const sy = m.d;
    if (!(sx > 0) || !(sy > 0) || !ctx.canvas) return null;
    const left = (0 - m.e) / sx - FOV_MARGIN;
    const right = (ctx.canvas.width - m.e) / sx + FOV_MARGIN;
    const top = (0 - m.f) / sy - FOV_MARGIN;
    const bot = (ctx.canvas.height - m.f) / sy + FOV_MARGIN;
    return { left, right, top, bot, w: right - left, h: bot - top };
  }

  /**
   * 局部点经旋转平移到世界坐标。
   * @returns {{ x: number, y: number }}
   */
  function mapLocal(cx, cy, rot, lx, ly) {
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return {
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    };
  }

  /**
   * 构建封闭造型 path（柔边流体/几何；无硬 AABB）。
   * @returns {Function|{ cx: number, cy: number, rx: number, ry: number }}
   */
  function makeShapePath(shape, cx, cy, rx, ry, rot, spec) {
    if (shape === 'ellipse' || shape === 'ring') {
      if (Math.abs(rot) < 0.02) return { cx, cy, rx, ry };
      /** @param {CanvasRenderingContext2D} c */
      const pathFn = (c) => {
        c.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
      };
      return pathFn;
    }

    if (shape === 'squircle') {
      const k = 0.55;
      /** @param {CanvasRenderingContext2D} c */
      const pathFn = (c) => {
        const p0 = mapLocal(cx, cy, rot, rx, 0);
        c.moveTo(p0.x, p0.y);
        let a = mapLocal(cx, cy, rot, rx, ry * k);
        let b = mapLocal(cx, cy, rot, rx * k, ry);
        let p = mapLocal(cx, cy, rot, 0, ry);
        c.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
        a = mapLocal(cx, cy, rot, -rx * k, ry);
        b = mapLocal(cx, cy, rot, -rx, ry * k);
        p = mapLocal(cx, cy, rot, -rx, 0);
        c.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
        a = mapLocal(cx, cy, rot, -rx, -ry * k);
        b = mapLocal(cx, cy, rot, -rx * k, -ry);
        p = mapLocal(cx, cy, rot, 0, -ry);
        c.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
        a = mapLocal(cx, cy, rot, rx * k, -ry);
        b = mapLocal(cx, cy, rot, rx, -ry * k);
        p = mapLocal(cx, cy, rot, rx, 0);
        c.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
        c.closePath();
      };
      return pathFn;
    }

    if (shape === 'diamond') {
      const soft = 0.35;
      /** @param {CanvasRenderingContext2D} c */
      const pathFn = (c) => {
        const p0 = mapLocal(cx, cy, rot, 0, -ry);
        c.moveTo(p0.x, p0.y);
        let ctrl = mapLocal(cx, cy, rot, rx * soft, -ry * soft);
        let p = mapLocal(cx, cy, rot, rx, 0);
        c.quadraticCurveTo(ctrl.x, ctrl.y, p.x, p.y);
        ctrl = mapLocal(cx, cy, rot, rx * soft, ry * soft);
        p = mapLocal(cx, cy, rot, 0, ry);
        c.quadraticCurveTo(ctrl.x, ctrl.y, p.x, p.y);
        ctrl = mapLocal(cx, cy, rot, -rx * soft, ry * soft);
        p = mapLocal(cx, cy, rot, -rx, 0);
        c.quadraticCurveTo(ctrl.x, ctrl.y, p.x, p.y);
        ctrl = mapLocal(cx, cy, rot, -rx * soft, -ry * soft);
        p = mapLocal(cx, cy, rot, 0, -ry);
        c.quadraticCurveTo(ctrl.x, ctrl.y, p.x, p.y);
        c.closePath();
      };
      return pathFn;
    }

    if (shape === 'petal') {
      const lobes = Math.max(2, Math.min(4, spec.lobe | 0));
      /** @param {CanvasRenderingContext2D} c */
      const pathFn = (c) => {
        const steps = 26;
        for (let s = 0; s <= steps; s += 1) {
          const a = (s / steps) * Math.PI * 2;
          const petal =
            0.72 +
            0.28 * Math.cos(a * lobes + spec.phase) * (1 - 0.35 * Math.sin(a * 0.5));
          const p = mapLocal(
            cx,
            cy,
            rot,
            Math.cos(a) * rx * petal,
            Math.sin(a) * ry * petal
          );
          if (s === 0) c.moveTo(p.x, p.y);
          else c.lineTo(p.x, p.y);
        }
        c.closePath();
      };
      return pathFn;
    }

    /* blob */
    /** @param {CanvasRenderingContext2D} c */
    const pathFn = (c) => {
      const steps = 24;
      const lobes = Math.max(2, Math.min(5, spec.lobe | 0));
      for (let s = 0; s <= steps; s += 1) {
        const a = (s / steps) * Math.PI * 2;
        const wob =
          1 +
          spec.wobble * Math.sin(a * lobes + spec.phase) +
          spec.wobble * 0.45 * Math.sin(a * (lobes + 1) - spec.phase * 0.7);
        const p = mapLocal(
          cx,
          cy,
          rot,
          Math.cos(a) * rx * wob,
          Math.sin(a) * ry * wob
        );
        if (s === 0) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
      }
      c.closePath();
    };
    return pathFn;
  }

  /**
   * 径向柔边填充（边缘 alpha→0）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx
   * @param {number} cy
   * @param {number} rx
   * @param {number} ry
   * @param {number[]} rgb
   * @param {number} peakAlpha
   */
  function fillSoftGlow(ctx, cx, cy, rx, ry, rgb, peakAlpha) {
    const rMax = Math.max(rx, ry) * 1.08;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rMax);
    const a0 = Math.max(0, Math.min(0.22, peakAlpha));
    g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a0})`);
    g.addColorStop(0.4, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a0 * 0.4})`);
    g.addColorStop(0.72, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a0 * 0.1})`);
    g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    ctx.fillStyle = g;
    ctx.fill();
  }

  /**
   * 将规格点映射到视口内世界 X（按轨卷动 × scrollFactor 平铺）。
   * linear：线性 slot−offset（与轨枕同向，不经过易反向的 floor 周期）。
   * @param {ShapeSpec} spec
   * @param {number} scrollX
   * @param {number} viewLeft
   * @param {number} period
   * @param {{ linear?: boolean, scrollSign?: number }} [opts]
   * @returns {number}
   */
  function scrolledWorldX(spec, scrollX, viewLeft, period, opts = {}) {
    const scrollSign = opts.scrollSign ?? 1;
    const offset = scrollSign * scrollX * spec.scrollFactor;
    const slot = spec.u * period;
    if (opts.linear) {
      let x = slot - offset;
      while (x < viewLeft - period * 0.35) x += period;
      while (x > viewLeft + period * 1.35) x -= period;
      return x;
    }
    const phase = ((offset % period) + period) % period;
    const raw = ((slot - phase) % period + period) % period;
    return viewLeft + raw;
  }

  /**
   * 绘制一层视差造型（中景或前景共用）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof viewRectFromTransform>} rect
   * @param {ShapeSpec[]} specs
   * @param {LayerTheme} th
   * @param {number} t
   * @param {number} scrollX
   * @param {{ strokeMul: number, maxPeak: number, scrollSign?: number, linearScroll?: boolean }} style
   */
  function paintLayer(ctx, rect, specs, th, t, scrollX, style) {
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return;
    const scrollOpts = {
      scrollSign: style.scrollSign ?? 1,
      linear: Boolean(style.linearScroll),
    };
    const { left, right, top, bot, w, h } = rect;
    const period = Math.max(800, w * PERIOD_MUL);
    const op = th.opacity;

    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i];
      const baseX = scrolledWorldX(spec, scrollX, left, period, scrollOpts);
      const driftX =
        Math.sin(t * (0.04 + spec.speedN * 0.03) * th.drift + spec.phase) *
        w *
        0.01 *
        th.drift;
      const driftY =
        Math.cos(t * (0.035 + spec.speedN * 0.025) * th.drift + spec.phase * 1.2) *
        h *
        0.008 *
        th.drift;
      const cx = baseX + driftX;
      const cy = top + h * spec.v + driftY;
      const rx = Math.max(18, h * spec.sizeN);
      const ry = Math.max(14, rx * spec.aspect);

      /* 在周期内再铺一次副本，避免大视口断档 */
      const instances = [0, period, -period];
      for (let k = 0; k < instances.length; k += 1) {
        const ix = cx + instances[k];
        if (ix + rx < left || ix - rx > right || cy + ry < top || cy - ry > bot) {
          continue;
        }

        const pathOrBounds = makeShapePath(
          spec.shape,
          ix,
          cy,
          rx,
          ry,
          spec.rot + Math.sin(t * 0.08 + spec.phase) * 0.04,
          spec
        );
        const rgb = th.palette[spec.colorI % th.palette.length];
        const isRing = spec.shape === 'ring';
        const peakAlpha = Math.min(
          style.maxPeak,
          (isRing ? 0.05 : 0.095) * op * spec.peakMul
        );
        const strokeAlpha = peakAlpha * 0.45 * style.strokeMul;

        ctx.beginPath();
        if (typeof pathOrBounds === 'function') {
          pathOrBounds(ctx);
        } else {
          ctx.ellipse(ix, cy, rx, ry, 0, 0, Math.PI * 2);
        }

        if (isRing) {
          ctx.ellipse(ix, cy, rx * 0.52, ry * 0.52, spec.rot, 0, Math.PI * 2);
          const g = ctx.createRadialGradient(
            ix,
            cy,
            Math.min(rx, ry) * 0.35,
            ix,
            cy,
            Math.max(rx, ry) * 1.05
          );
          g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
          g.addColorStop(
            0.45,
            `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${peakAlpha})`
          );
          g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
          ctx.fillStyle = g;
          ctx.fill('evenodd');
        } else {
          fillSoftGlow(ctx, ix, cy, rx, ry, rgb, peakAlpha);
        }

        ctx.beginPath();
        if (typeof pathOrBounds === 'function') {
          pathOrBounds(ctx);
        } else {
          ctx.ellipse(ix, cy, rx, ry, 0, 0, Math.PI * 2);
        }
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${strokeAlpha})`;
        ctx.lineWidth = Math.max(1, rx * (isRing ? 0.04 : 0.02));
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }
  }

  /**
   * 列车前进方向下的视差符号：正速 = 屏幕右行，层元素应向左退（与轨枕同向）。
   * @returns {number}
   */
  function trainScrollSign() {
    const speed = Number(window.LpTrainDrive?.getState?.()?.speed) || 0;
    if (Math.abs(speed) < 0.02) return 1;
    return speed > 0 ? 1 : -1;
  }

  /**
   * 进站主题混合：越高则路上树干越淡（交给月台柱列 FX）。
   * @returns {number}
   */
  function stationFade() {
    const mix = Number(window.LpWorldBackground?.getStationMix?.());
    if (!Number.isFinite(mix)) return 0;
    return Math.max(0, Math.min(1, mix));
  }

  /**
   * 绘制单根树干遮挡（竖向软边剪影，可带轻冠）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {OccluderSpec} spec
   * @param {number} cx
   * @param {number} top
   * @param {number} bot
   * @param {number} h
   * @param {number[][]} bark
   * @param {number} alphaMul
   */
  function paintTrunk(ctx, spec, cx, top, bot, h, bark, alphaMul) {
    const rgb = bark[spec.barkI % bark.length];
    const halfW = Math.max(10, h * spec.widthN * 0.5);
    const trunkH = h * spec.heightN;
    const y0 = bot - trunkH * 0.92;
    const y1 = bot + h * 0.02;
    const leanPx = spec.lean * trunkH;
    const coreA = Math.max(0, Math.min(0.92, spec.coreAlpha * alphaMul));
    if (coreA < 0.04) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - halfW * 1.05, y1);
    ctx.lineTo(cx - halfW * 0.72 + leanPx * 0.15, y0 + trunkH * 0.18);
    ctx.quadraticCurveTo(
      cx - halfW * 0.55 + leanPx * 0.55,
      y0,
      cx + leanPx,
      y0 - halfW * 0.15
    );
    ctx.quadraticCurveTo(
      cx + halfW * 0.55 + leanPx * 0.55,
      y0,
      cx + halfW * 0.72 + leanPx * 0.15,
      y0 + trunkH * 0.18
    );
    ctx.lineTo(cx + halfW * 1.05, y1);
    ctx.closePath();

    const g = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
    g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    g.addColorStop(0.18, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${coreA * 0.55})`);
    g.addColorStop(0.5, `rgba(${Math.min(255, rgb[0] + 12)},${Math.min(255, rgb[1] + 8)},${rgb[2]},${coreA})`);
    g.addColorStop(0.82, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${coreA * 0.55})`);
    g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    ctx.fillStyle = g;
    ctx.fill();

    /* 树皮暗槽 */
    ctx.strokeStyle = `rgba(8,6,4,${coreA * 0.35})`;
    ctx.lineWidth = Math.max(1.2, halfW * 0.12);
    ctx.beginPath();
    ctx.moveTo(cx - halfW * 0.15 + leanPx * 0.4, y0 + trunkH * 0.12);
    ctx.lineTo(cx - halfW * 0.05, y1 - h * 0.04);
    ctx.stroke();

    if (spec.canopy) {
      const cy = y0 + halfW * 0.2;
      const cr = halfW * (2.2 + (spec.phase % 1) * 1.4);
      const leaf = [
        Math.max(0, rgb[0] - 8),
        Math.min(255, rgb[1] + 18),
        Math.max(0, rgb[2] - 4),
      ];
      const cg = ctx.createRadialGradient(cx + leanPx * 0.6, cy, 0, cx + leanPx * 0.6, cy, cr);
      cg.addColorStop(0, `rgba(${leaf[0]},${leaf[1]},${leaf[2]},${coreA * 0.42})`);
      cg.addColorStop(0.55, `rgba(${leaf[0]},${leaf[1]},${leaf[2]},${coreA * 0.18})`);
      cg.addColorStop(1, `rgba(${leaf[0]},${leaf[1]},${leaf[2]},0)`);
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.ellipse(cx + leanPx * 0.6, cy, cr, cr * 0.72, spec.lean * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 绘制地形遮挡层（树干等），随轨线性卷动并短暂挡住视野。
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof viewRectFromTransform>} rect
   * @param {OccluderSpec[]} specs
   * @param {number} scrollX
   * @param {number} scrollSign
   * @param {number} alphaMul
   */
  function paintOccluders(ctx, rect, specs, scrollX, scrollSign, alphaMul) {
    if (!rect || !specs?.length || alphaMul < 0.04) return;
    const pack = getTerrainPack();
    const { left, right, top, bot, w, h } = rect;
    const period = Math.max(1000, w * OCCLUDER_PERIOD_MUL);
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i];
      const baseX = scrolledWorldX(spec, scrollX, left, period, {
        scrollSign,
        linear: true,
      });
      const instances = [0, period, -period];
      for (let k = 0; k < instances.length; k += 1) {
        const ix = baseX + instances[k];
        const halfW = Math.max(10, h * spec.widthN * 0.5);
        if (ix + halfW * 2 < left || ix - halfW * 2 > right) continue;
        if (spec.kind === 'trunk' || spec.kind === 'lean_trunk') {
          paintTrunk(ctx, spec, ix, top, bot, h, pack.bark, alphaMul);
        }
      }
    }
  }

  /**
   * 绘中景（背景之后、轨道之前）；列车静止时仍可见轻漂，卷动时拉开纵深。
   * @param {CanvasRenderingContext2D} ctx
   */
  function drawMidground(ctx) {
    if (!ctx || !isTrainScene()) return;
    ensureTheme();
    if (!theme) return;
    const rect = viewRectFromTransform(ctx);
    if (!rect) return;
    if (!(timeSec > 0)) timeSec = performance.now() * 0.001;
    const scrollX = Number(window.LpTrack?.getScrollX?.()) || 0;
    const sign = trainScrollSign();
    const fade = 1 - stationFade() * 0.92;
    ctx.save();
    paintLayer(ctx, rect, midShapes, theme, timeSec, scrollX, {
      strokeMul: 0.7,
      maxPeak: 0.14,
      scrollSign: sign,
    });
    paintOccluders(ctx, rect, midOccluders, scrollX, sign, fade * 0.72);
    ctx.restore();
  }

  /**
   * 绘前景（玩法层之上、屏幕滤镜之前）：柔形 + 树干遮挡，右行时向左掠过。
   * @param {CanvasRenderingContext2D} ctx
   */
  function drawForeground(ctx) {
    if (!ctx || !isTrainScene()) return;
    ensureTheme();
    if (!theme) return;
    const rect = viewRectFromTransform(ctx);
    if (!rect) return;
    if (!(timeSec > 0)) timeSec = performance.now() * 0.001;
    const scrollX = Number(window.LpTrack?.getScrollX?.()) || 0;
    const sign = trainScrollSign();
    const fade = 1 - stationFade() * 0.95;
    ctx.save();
    paintLayer(ctx, rect, foreShapes, theme, timeSec, scrollX, {
      strokeMul: 0.45,
      maxPeak: 0.1,
      scrollSign: sign,
      linearScroll: true,
    });
    paintOccluders(ctx, rect, foreOccluders, scrollX, sign, fade);
    ctx.restore();
  }

  /**
   * 切换当前路线地形包（重建遮挡物）；未知 id 忽略。
   * @param {string} id
   * @returns {boolean}
   */
  function setTerrain(id) {
    const next = String(id || '').trim();
    if (!next || !TERRAIN_PACKS[next]) return false;
    if (terrainId === next) return true;
    terrainId = next;
    rebuildFromSeed(resolveWorldSeed());
    return true;
  }

  /**
   * 注册或覆盖地形包（供未来路线扩展）。
   * @param {TerrainPack} pack
   * @returns {boolean}
   */
  function registerTerrain(pack) {
    const id = String(pack?.id || '').trim();
    if (!id || !Array.isArray(pack.kinds) || !Array.isArray(pack.bark)) return false;
    TERRAIN_PACKS[id] = {
      id,
      label: pack.label || id,
      kinds: pack.kinds.slice(),
      bark: pack.bark.map((c) => c.slice(0, 3)),
      fgCount: pack.fgCount || [3, 6],
      mgCount: pack.mgCount || [2, 4],
      fgScroll: pack.fgScroll || [1.2, 1.45],
      mgScroll: pack.mgScroll || [0.35, 0.55],
      coreAlpha: pack.coreAlpha || [0.55, 0.85],
    };
    if (terrainId === id) rebuildFromSeed(resolveWorldSeed());
    return true;
  }

  window.LpParallaxLayers = {
    tick,
    drawMidground,
    drawForeground,
    setSeed,
    getSeed: () => appliedSeed,
    setTerrain,
    getTerrain: () => terrainId,
    registerTerrain,
    listTerrains: () => Object.keys(TERRAIN_PACKS),
  };
})();
