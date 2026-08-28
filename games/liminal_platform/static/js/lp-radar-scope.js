/**
 * 绘轨车厢 · 雷达示波器控制台（战斗机式俯视 PPI）。
 * 搜索雷达：360° 慢速扫描；锁定扇区内另有往返扫描线（单向 ~0.5s，往返 ~1s）。
 * 目标（车厢 / 接触 / 小型集群标）仅在扫描线穿过方位时涂磷光，随后缓慢衰减。
 * 小型集群：绿方块 + 下划线=保龄球(地面) / 上划线=气球(空中)；附速度矢量线（簇均速 × VECTOR_LEAD_S）。
 * 方位约定：画面 12 点 / 0° = 列车前进（航向朝上）；角度顺时针递增。
 * 本列编组沿本线脊线落轨；仅最小量程逐节，更大档位单「编组」图标。
 */
(() => {
  const root = document.getElementById('lpRadarScopeRoot');
  const canvas = document.getElementById('lpRadarScopeCanvas');
  const closeBtn = document.getElementById('lpRadarScopeClose');
  const rangeReadout = document.getElementById('lpRadarRangeReadout');
  const modeReadout = document.getElementById('lpRadarModeReadout');
  const sectorRpmReadout = document.getElementById('lpRadarSectorRpmReadout');
  const rangeTrack = document.getElementById('lpRadarRangeTrack');
  const rangeKnob = document.getElementById('lpRadarRangeKnob');
  const rangeNotches = document.getElementById('lpRadarRangeNotches');
  const aimStick = document.getElementById('lpRadarAimStick');
  const aimKnob = document.getElementById('lpRadarAimKnob');
  if (!root || !canvas) return;

  const ctx = canvas.getContext('2d');

  /** 锁定雷达扇区总张角（度）；可调。 */
  const LOCK_BEAM_WIDTH_DEG = 30;
  const LOCK_HALF_RAD = ((LOCK_BEAM_WIDTH_DEG / 2) * Math.PI) / 180;
  const AIM_DEADZONE = 0.18;

  /** 示波器 PPI 量程下限 / 上限（滚轮不可超过上限）。 */
  const RANGE_WORLD_MIN = 1200;
  const RANGE_WORLD_MAX = 12000;
  /** 量程档位步长（世界单位）；档位为 1200 的整数倍。 */
  const RANGE_GEAR_STEP = 1200;
  /** 量程档位表：1200…12000。 */
  const RANGE_GEARS = (() => {
    const gears = [];
    for (let v = RANGE_WORLD_MIN; v <= RANGE_WORLD_MAX; v += RANGE_GEAR_STEP) {
      gears.push(v);
    }
    return gears;
  })();
  /** 刻度可见数字标签（其余档位仅短刻线，仍可点选）。 */
  const RANGE_GEAR_LABELS = new Set([RANGE_WORLD_MIN, 6000, RANGE_WORLD_MAX]);
  /** 锁定扇区有效世界量程；超出部分不填充，以外弧封闭表示超出锁定量程。 */
  const LOCK_RANGE_WORLD_MAX = 6000;
  /**
   * 小型目标集群：示波器局部坐标邻域链接距离（世界单位）。
   * 仅簇大小 ≥ MOB_CLUSTER_MIN 才绘制，避免单只小球成点。
   */
  const MOB_CLUSTER_LINK = 300;
  const MOB_CLUSTER_MIN = 2;
  /**
   * PPI 屏幕元素比例（相对 ~560–600px 示波器）：
   * 接触点 < 集群方块 < 敌方框 ≈ 月台半宽；轨半宽不超过集群；矢量不压过标。
   */
  const CLUSTER_MARK_PX = 6.5;
  /** 敌方接触方框边长（CSS 像素）。 */
  const HOSTILE_MARK_PX = 8;
  /** 普通接触圆点半径（CSS 像素）。 */
  const CONTACT_DOT_R_PX = 3;
  /** 上/下划线相对方块外缘的间隙与线长余量（CSS 像素）。 */
  const CLUSTER_BAR_GAP_PX = 1.5;
  const CLUSTER_BAR_PAD_PX = 1;
  /** 站心十字半臂 / PPI 圆相对画布内缩（给外侧钟点字留边）。 */
  const STATION_CROSS_HALF_PX = 5;
  const PPI_RADIUS_INSET_PX = 14;
  /** 编组/接触/月台图例字号；TRACK/方位主刻度略大一档。 */
  const SCOPE_LABEL_FONT_PX = 8;
  const SCOPE_LEGEND_FONT_PX = 9;
  /**
   * 速度矢量：世界速度 × 秒数 → 示波器位移（再 × scale 成像素）。
   * 低于 VECTOR_MIN_SPEED 不画；屏幕长度夹在 [VECTOR_MIN_PX, VECTOR_MAX_PX]。
   */
  const VECTOR_LEAD_S = 3.5;
  const VECTOR_MIN_SPEED = 18;
  const VECTOR_MIN_PX = 6;
  const VECTOR_MAX_PX = 28;
  /**
   * 本列俯视车体比例：沿轨长度 / 车宽。
   * 旧 beam=length×0.28（≈3.6:1）过胖；现 ≈8.3:1，更接近窄长车厢。
   */
  const OWN_CAR_BEAM_RATIO = 0.12;
  /**
   * 单节车厢屏幕可读下限（CSS 像素）。
   * 沿轨长度或车宽任一项低于此 → 整列改画一条统一矩形（避免缩成难辨碎块）。
   */
  const OWN_CAR_MIN_LENGTH_PX = 10;
  const OWN_CAR_MIN_BEAM_PX = 3;
  /**
   * 单节车厢屏幕上限（CSS 像素）；近距量程下按比例整体缩小，避免盖过集群/月台标。
   * 不改世界尺寸，仅限制 PPI 观感。
   */
  const OWN_CAR_MAX_LENGTH_PX = 140;
  const OWN_CAR_MAX_BEAM_PX = 20;
  /** 绘轨本车相对其它节的屏幕放大（观感强调，非世界尺寸）。 */
  const OWN_SCOPE_LENGTH_BOOST = 1.04;
  const OWN_SCOPE_BEAM_BOOST = 1.06;
  /**
   * 月台标半宽/半高：BASE + BOOST×scale，再夹 MAX。
   * 旧式 max(5, 10×scale×40) 近距过大。
   */
  const PLATFORM_HALF_W_BASE_PX = 6;
  const PLATFORM_HALF_H_BASE_PX = 3.5;
  const PLATFORM_HALF_W_MAX_PX = 11;
  const PLATFORM_HALF_H_MAX_PX = 6.5;
  const PLATFORM_SCALE_BOOST = 80;
  /**
   * 轨距半宽（CSS 像素）夹制；世界参考半宽 × scale 后再夹。
   * MIN 放宽：远距可变细，避免「缩放无效」的粗绳感；近距靠 MAX。
   */
  const TRACK_WORLD_HALF = 36;
  const TRACK_HALF_MIN_PX = 2.2;
  const TRACK_HALF_MAX_PX = 22;
  /** 单侧铁轨描边（像素）。 */
  const TRACK_RAIL_STROKE_PX = 1.7;
  /** 轨枕：世界间距 × scale；近距随缩放拉开，远距保可读。 */
  const TRACK_SLEEPER_WORLD = 110;
  const TRACK_SLEEPER_SPACING_MIN_PX = 4.5;
  const TRACK_SLEEPER_SPACING_MAX_PX = 36;
  const TRACK_SLEEPER_STROKE_PX = 1.25;
  /** 搜索雷达角速度（rad/s）；满圈约 2π/1.35 ≈ 4.65s。 */
  const SEARCH_SWEEP_RAD_PER_S = 1.35;
  /** 搜索雷达满圈周期（ms）；由角速度推导，扫速变更时自动同步。 */
  const SEARCH_PERIOD_MS = ((Math.PI * 2) / SEARCH_SWEEP_RAD_PER_S) * 1000;
  /** 锁定扇区扫描线单向（边→边）时长（ms）；往返为三角波，全周期 2×。 */
  const LOCK_SECTOR_SWEEP_PERIOD_MS = 500;
  /** 扇区扫描往返全周期（ms）：边→边→边。 */
  const LOCK_SECTOR_SWEEP_CYCLE_MS = LOCK_SECTOR_SWEEP_PERIOD_MS * 2;
  /** 扇区扫描转速（RPM）= 每分钟往返次数 = 60000 / CYCLE_MS。 */
  const LOCK_SECTOR_SWEEP_RPM = 60000 / LOCK_SECTOR_SWEEP_CYCLE_MS;
  /** 扇区扫描频率（Hz）= 每秒往返次数 = 1000 / CYCLE_MS。 */
  const LOCK_SECTOR_SWEEP_HZ = 1000 / LOCK_SECTOR_SWEEP_CYCLE_MS;
  /**
   * 磷光余晖：涂覆后到完全消失的时长（ms）。
   * 略长于搜索满圈周期，保证下次主扫描线再次经过前仍可见。
   */
  const BLIP_FADE_MS = SEARCH_PERIOD_MS * 1.08;
  /** 扫描线命中半宽（弧度）；方位落在此内或本帧扫过即涂磷光。 */
  const SWEEP_HIT_HALF_RAD = 0.04;
  /**
   * 圆形搜索扫描命中目标时的声呐 ping（三段轮播）。
   * 扇区快扫不播；处理说明见 static/audio/radar-sonar.PROCESSING.txt。
   */
  const SONAR_SFX_URLS = [
    '/static/games/liminal-platform/audio/radar-sonar-a.wav?v=1',
    '/static/games/liminal-platform/audio/radar-sonar-b.wav?v=1',
    '/static/games/liminal-platform/audio/radar-sonar-c.wav?v=1',
  ];
  /** 声呐 UI 音量（ambient，不衰减）。 */
  const SONAR_SFX_VOLUME = 0.48;
  /** 多目标同帧/近邻命中时的全局最短间隔（ms），防刷屏。 */
  const SONAR_PING_COOLDOWN_MS = 90;
  /** 量程档位 localStorage 键（关面板 / 刷新后仍保留）。 */
  const RANGE_STORAGE_KEY = 'lp-radar-range-v1';
  /** 未持久化或无效时的默认量程档。 */
  const DEFAULT_RANGE_WORLD = 4800;
  /** 示波器量程（世界单位；始终落在 RANGE_GEARS）。 */
  let rangeWorld = DEFAULT_RANGE_WORLD;
  /** 量程拉杆拖拽中的 pointerId；null 表示未拖。 */
  let rangeGearPointer = null;
  let open = false;
  let raf = 0;
  let sweepAngle = -Math.PI / 2;
  /** 锁定扇区内快速扫描线方位（canvas 弧度）。 */
  let sectorSweepAngle = -Math.PI / 2;
  /** 上一帧搜索/扇区扫描角；用于跨帧扫过判定。 */
  let prevSearchSweep = null;
  let prevSectorSweep = null;
  /**
   * 磷光余晖标绘表：扫描线扫过后写入，按 paintedAt 衰减绘制。
   * @type {Map<string, {
   *   key: string,
   *   kind: 'contact' | 'mob-cluster',
   *   paintedAt: number,
   *   sx: number,
   *   sy: number,
   *   style?: string,
   *   label?: string,
   *   mobKind?: 'ground' | 'air',
   *   vx?: number,
   *   vy?: number,
   * }>}
   */
  let phosphorBlips = new Map();
  /**
   * 当前搜索雷达一圈内已播过声呐的目标 key（每目标每圈最多一次）。
   * @type {Set<string>}
   */
  let sonarPingedThisPass = new Set();
  /** 上次搜索圈序号；变化时清空 sonarPingedThisPass。 */
  let sonarSearchPass = -1;
  /** 声呐三段轮播下标。 */
  let sonarSfxIndex = 0;
  /** 上次成功播放声呐的时间戳（ms）。 */
  let lastSonarPingAt = 0;
  /** 锁定扇区角平分线（canvas 弧度，0 = 右，顺时针为正）。 */
  let lockAimAngle = -Math.PI / 2;
  let mouseAimActive = false;
  let radarAimPointer = null;
  let radarAimReady = false;
  /** @type {Array<{ id: string, kind: string, x: number, y: number, label?: string }>} */
  let externalContacts = [];
  /**
   * 上次有效前进符号（+1 = 世界 +X / 屏幕右，-1 = 反向）。
   * 静止时沿用，避免 12 点乱跳。
   */
  let lastForwardSign = 1;

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /**
   * 读取列车前进符号：有速度用 speed 符号，静止保留上次，缺省 +1（编组右=前进）。
   */
  function resolveForwardSign() {
    const speed = window.LpTrainDrive?.getState?.()?.speed;
    if (typeof speed === 'number' && Math.abs(speed) >= 0.08) {
      lastForwardSign = speed > 0 ? 1 : -1;
    }
    return lastForwardSign;
  }

  /**
   * 前进在 PPI 上的 canvas 弧度：恒为 12 点（上，-π/2）。
   * forwardSign 只影响世界→航向变换，不旋转表盘。
   */
  function forwardCanvasAngle(_forwardSign) {
    return -Math.PI / 2;
  }

  /** 未来：其它列车 / 敌方大型目标等接触点（世界坐标）。 */
  function setContacts(list) {
    externalContacts = Array.isArray(list) ? list.slice() : [];
  }

  /** 追加单个接触（不替换整表）。 */
  function upsertContact(contact) {
    if (!contact?.id) return;
    const i = externalContacts.findIndex((c) => c.id === contact.id);
    if (i >= 0) externalContacts[i] = { ...externalContacts[i], ...contact };
    else externalContacts.push({ ...contact });
  }

  /**
   * 本列车厢世界中心与俯视车体尺寸（沿轨长度 / 车宽，世界单位）。
   * 长度取走道跨度；车宽按 OWN_CAR_BEAM_RATIO，避免旧 0.28 比例过胖。
   */
  function ownTrainCenters() {
    const Spec = window.LiminalCarriageSpec;
    if (!Spec?.CARRIAGES) return [];
    const mid = (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2;
    const length = Math.max(120, Spec.WALK_RIGHT - Spec.WALK_LEFT);
    const beam = Math.max(28, length * OWN_CAR_BEAM_RATIO);
    return Spec.CARRIAGES.map((car) => ({
      id: car.id,
      label: car.map?.shortLabel || car.label || car.id,
      x: car.worldX + mid,
      y: Spec.FLOOR_Y,
      length,
      beam,
      kind: car.id === 'huigui' ? 'own-scope' : 'own',
    }));
  }

  /**
   * 是否逐节绘制本列（仅最小量程 1200）；更大档位整列同一图标。
   */
  function showIndividualOwnCars() {
    return rangeWorld <= RANGE_WORLD_MIN;
  }

  /** 本线轨道脊线（世界坐标折线）。 */
  function getOwnTrackSpine() {
    const routes = window.LpPlatform?.getRadarTrackRoutes?.() || [];
    const own = routes.find((r) => r.kind === 'own' || r.lane === 0);
    if (own?.points?.length >= 2) return own.points;
    const poly = window.LpPlatform?.getRadarTrackPolyline?.() || [];
    return poly.length >= 2 ? poly : [];
  }

  /**
   * 按世界 X 在本线脊线上插值采样（车厢落轨用）。
   * @param {Array<{ x: number, y: number }>} spine
   * @param {number} worldX
   */
  function sampleSpineAtWorldX(spine, worldX) {
    if (!spine?.length) return null;
    if (spine.length === 1) return { x: spine[0].x, y: spine[0].y };
    const x = Number(worldX);
    if (!Number.isFinite(x)) return null;
    if (x <= spine[0].x) return { x: spine[0].x, y: spine[0].y };
    const last = spine[spine.length - 1];
    if (x >= last.x) return { x: last.x, y: last.y };
    for (let i = 0; i < spine.length - 1; i += 1) {
      const a = spine[i];
      const b = spine[i + 1];
      if (x < a.x || x > b.x) continue;
      const t = (x - a.x) / (b.x - a.x || 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    return null;
  }

  /**
   * 轨面世界点 → PPI 屏幕坐标。
   * @param {number} wx
   * @param {number} wy
   */
  function worldOnTrackToScreen(wx, wy, cx, cy, scale, forwardSign) {
    const sc = worldToScope(wx, wy);
    return scopeToPpi(sc.x, sc.y, cx, cy, scale, forwardSign);
  }

  /**
   * 轨向切线角（canvas 弧度）；车体矩形长边沿轨。
   * @param {Array<{ x: number, y: number }>} spine
   * @param {number} worldX
   */
  function trackTangentRotationRad(spine, worldX, cx, cy, scale, forwardSign) {
    const eps = Math.max(40, 80 / Math.max(scale, 1e-6));
    const a = sampleSpineAtWorldX(spine, worldX - eps);
    const b = sampleSpineAtWorldX(spine, worldX + eps);
    if (!a || !b) return 0;
    const sa = worldOnTrackToScreen(a.x, a.y, cx, cy, scale, forwardSign);
    const sb = worldOnTrackToScreen(b.x, b.y, cx, cy, scale, forwardSign);
    const tdx = sb.x - sa.x;
    const tdy = sb.y - sa.y;
    if (Math.hypot(tdx, tdy) < 0.5) return 0;
    return Math.atan2(tdy, tdx) - Math.PI / 2;
  }

  /**
   * @deprecated 改用 showIndividualOwnCars；保留供测试对照。
   */
  function ownCarsReadableOnScreen(scale, sample) {
    const lengthPx = sample.length * scale;
    const beamPx = sample.beam * scale;
    return lengthPx >= OWN_CAR_MIN_LENGTH_PX && beamPx >= OWN_CAR_MIN_BEAM_PX;
  }

  /**
   * 世界车体尺寸 × PPI scale → 屏幕长宽；等比夹到 [MIN, MAX]，近距不盖过集群/月台。
   * @param {number} lengthWorld
   * @param {number} beamWorld
   * @param {number} scale
   * @returns {{ lengthPx: number, beamPx: number }}
   */
  function clampCarScreenSize(lengthWorld, beamWorld, scale) {
    return clampOwnCarScreenSize(lengthWorld * scale, beamWorld * scale);
  }

  /**
   * 已换算到屏幕像素的车体长宽 → 等比夹到 [MIN, MAX]。
   * @param {number} lengthPx
   * @param {number} beamPx
   * @returns {{ lengthPx: number, beamPx: number }}
   */
  function clampOwnCarScreenSize(lengthPx, beamPx) {
    const shrink = Math.min(
      1,
      OWN_CAR_MAX_LENGTH_PX / Math.max(1e-6, lengthPx),
      OWN_CAR_MAX_BEAM_PX / Math.max(1e-6, beamPx),
    );
    return {
      lengthPx: Math.max(OWN_CAR_MIN_LENGTH_PX, lengthPx * shrink),
      beamPx: Math.max(OWN_CAR_MIN_BEAM_PX, beamPx * shrink),
    };
  }

  /**
   * 轨距半宽（像素）：世界参考半宽 × scale 后夹制，避免近粗远糊。
   * @param {number} scale
   */
  function trackHalfPx(scale) {
    return Math.min(
      TRACK_HALF_MAX_PX,
      Math.max(TRACK_HALF_MIN_PX, TRACK_WORLD_HALF * scale),
    );
  }

  /**
   * 轨枕屏幕间距（像素）：世界间距 × scale 后夹制，远近量程都保持可读密度。
   * @param {number} scale
   */
  function trackSleeperSpacingPx(scale) {
    return Math.min(
      TRACK_SLEEPER_SPACING_MAX_PX,
      Math.max(TRACK_SLEEPER_SPACING_MIN_PX, TRACK_SLEEPER_WORLD * scale),
    );
  }

  /**
   * 描画折线路径（调用方已设 strokeStyle / lineWidth）。
   * @param {Array<{ x: number, y: number }>} points
   */
  function strokePolyline(points) {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  /**
   * 沿中心折线生成左右铁轨屏幕点（法向偏移半轨距）。
   * @param {Array<{ x: number, y: number }>} screen
   * @param {number} halfPx
   * @returns {{ left: Array<{ x: number, y: number }>, right: Array<{ x: number, y: number }> }}
   */
  function offsetRailPolylines(screen, halfPx) {
    const left = [];
    const right = [];
    for (let i = 0; i < screen.length; i += 1) {
      let dx;
      let dy;
      if (i === 0) {
        dx = screen[1].x - screen[0].x;
        dy = screen[1].y - screen[0].y;
      } else if (i === screen.length - 1) {
        dx = screen[i].x - screen[i - 1].x;
        dy = screen[i].y - screen[i - 1].y;
      } else {
        dx = screen[i + 1].x - screen[i - 1].x;
        dy = screen[i + 1].y - screen[i - 1].y;
      }
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      left.push({ x: screen[i].x + nx * halfPx, y: screen[i].y + ny * halfPx });
      right.push({ x: screen[i].x - nx * halfPx, y: screen[i].y - ny * halfPx });
    }
    return { left, right };
  }

  /**
   * 沿中心折线弧长铺轨枕短横（夹在双轨之间）；间距随量程夹制。
   * @param {Array<{ x: number, y: number }>} screen
   * @param {number} halfPx
   * @param {number} scale
   */
  function paintTrackSleepers(screen, halfPx, scale) {
    if (screen.length < 2) return;
    const spacing = trackSleeperSpacingPx(scale);
    const tieHalf = halfPx * 0.92;
    ctx.strokeStyle = 'rgba(90, 215, 120, 0.5)';
    ctx.lineWidth = TRACK_SLEEPER_STROKE_PX;
    ctx.lineCap = 'butt';
    let carry = 0;
    let nextAt = spacing * 0.45;
    for (let i = 1; i < screen.length; i += 1) {
      const a = screen[i - 1];
      const b = screen[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 0.5) continue;
      const ux = (b.x - a.x) / segLen;
      const uy = (b.y - a.y) / segLen;
      const nx = -uy;
      const ny = ux;
      while (nextAt <= carry + segLen) {
        const t = nextAt - carry;
        const x = a.x + ux * t;
        const y = a.y + uy * t;
        ctx.beginPath();
        ctx.moveTo(x - nx * tieHalf, y - ny * tieHalf);
        ctx.lineTo(x + nx * tieHalf, y + ny * tieHalf);
        ctx.stroke();
        nextAt += spacing;
      }
      carry += segLen;
    }
  }

  /**
   * 在 PPI 圆内绘制双轨 + 轨枕（磷光绿）；裁切内缩半轨宽，避免粗描边渗出。
   * @param {Array<{ x: number, y: number }>} screen
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @param {number} trackHalf
   * @param {number} scale
   * @param {{ kind?: 'own'|'siding', label?: string }} [style]
   */
  function paintTrackOnScreen(screen, cx, cy, radius, trackHalf, scale, style = {}) {
    if (screen.length < 2) return;
    const kind = style.kind === 'siding' ? 'siding' : 'own';
    const isOwn = kind === 'own';
    /* 裁到 PPI 内缘再内缩半轨宽，避免粗描边/圆角端点渗出绿圈。 */
    const clipR = Math.max(8, radius - Math.max(trackHalf, 3) - 1);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, clipR, 0, Math.PI * 2);
    ctx.clip();

    /* 道碴底带：本线更亮，侧线更淡虚线，方便读多轨地图 */
    ctx.strokeStyle = isOwn ? 'rgba(55, 160, 80, 0.22)' : 'rgba(40, 110, 60, 0.12)';
    ctx.lineWidth = trackHalf * 2 + (isOwn ? 2.2 : 1.2);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (!isOwn) ctx.setLineDash([7, 6]);
    strokePolyline(screen);
    ctx.setLineDash([]);

    if (isOwn) {
      paintTrackSleepers(screen, trackHalf, scale);
    }

    const rails = offsetRailPolylines(screen, trackHalf);
    ctx.strokeStyle = isOwn
      ? 'rgba(145, 255, 170, 0.95)'
      : 'rgba(90, 200, 120, 0.45)';
    ctx.lineWidth = isOwn ? TRACK_RAIL_STROKE_PX + 0.35 : TRACK_RAIL_STROKE_PX * 0.75;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (!isOwn) ctx.setLineDash([5, 5]);
    strokePolyline(rails.left);
    strokePolyline(rails.right);
    ctx.setLineDash([]);

    let labelPt = null;
    let bestY = Infinity;
    for (const p of screen) {
      if (Math.hypot(p.x - cx, p.y - cy) > clipR * 0.92) continue;
      if (p.y < bestY) {
        bestY = p.y;
        labelPt = p;
      }
    }
    if (labelPt) {
      const text = style.label || (isOwn ? 'TRACK' : 'SIDING');
      ctx.fillStyle = isOwn
        ? 'rgba(150, 255, 180, 0.72)'
        : 'rgba(100, 200, 130, 0.42)';
      ctx.font = `${SCOPE_LEGEND_FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, labelPt.x + trackHalf + 5, Math.max(cy - clipR + 10, labelPt.y));
    }
    ctx.restore();
  }

  /**
   * 世界折线 → PPI 屏幕点。
   * @param {Array<{ x: number, y: number }>} points
   * @param {number} cx
   * @param {number} cy
   * @param {number} scale
   * @param {number} forwardSign
   * @returns {Array<{ x: number, y: number }>}
   */
  function worldTrackToScreen(points, cx, cy, scale, forwardSign) {
    const screen = [];
    for (const p of points) {
      const sc = worldToScope(p.x, p.y);
      screen.push(scopeToPpi(sc.x, sc.y, cx, cy, scale, forwardSign));
    }
    return screen;
  }

  /**
   * 绘制可拐弯铁轨折线（世界点 → PPI）：双轨 + 轨枕，圆内裁剪。
   * @param {Array<{ x: number, y: number }>} points
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @param {number} scale
   * @param {number} forwardSign
   * @param {number} trackHalf
   * @param {{ kind?: 'own'|'siding', label?: string }} [style]
   */
  function paintTrackPolyline(points, cx, cy, radius, scale, forwardSign, trackHalf, style) {
    const screen = worldTrackToScreen(points, cx, cy, scale, forwardSign);
    paintTrackOnScreen(screen, cx, cy, radius, trackHalf, scale, style);
  }

  /**
   * 绘制雷达轨道路线网：先侧线、再本线（本线覆盖最上），供后续敌对列车挂 lane。
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @param {number} scale
   * @param {number} forwardSign
   * @param {number} trackHalf
   */
  function paintTrackRouteNetwork(cx, cy, radius, scale, forwardSign, trackHalf) {
    const routes =
      window.LpPlatform?.getRadarTrackRoutes?.() ||
      (() => {
        const poly = window.LpPlatform?.getRadarTrackPolyline?.() || [];
        return poly.length >= 2
          ? [{ id: 'track-own', kind: 'own', lane: 0, label: '本线', points: poly }]
          : [];
      })();
    if (!routes.length) {
      paintStraightTrackAxis(cx, cy, radius, trackHalf, scale);
      return;
    }
    const sidings = routes.filter((r) => r.kind === 'siding');
    const owns = routes.filter((r) => r.kind !== 'siding');
    for (const route of sidings) {
      if (!route.points || route.points.length < 2) continue;
      paintTrackPolyline(
        route.points,
        cx,
        cy,
        radius,
        scale,
        forwardSign,
        trackHalf * 0.82,
        { kind: 'siding', label: route.label || '侧线' },
      );
    }
    for (const route of owns) {
      if (!route.points || route.points.length < 2) continue;
      paintTrackPolyline(
        route.points,
        cx,
        cy,
        radius,
        scale,
        forwardSign,
        trackHalf,
        { kind: 'own', label: route.label || '本线' },
      );
    }
  }

  /**
   * 月台标半宽/半高（像素）：基准 + 轻度随量程放大，再夹上限。
   * @param {number} scale
   * @returns {{ hw: number, hh: number }}
   */
  function platformMarkHalfPx(scale) {
    const hw = Math.min(
      PLATFORM_HALF_W_MAX_PX,
      Math.max(
        PLATFORM_HALF_W_BASE_PX,
        PLATFORM_HALF_W_BASE_PX + PLATFORM_SCALE_BOOST * scale * 0.55,
      ),
    );
    const hh = Math.min(
      PLATFORM_HALF_H_MAX_PX,
      Math.max(
        PLATFORM_HALF_H_BASE_PX,
        PLATFORM_HALF_H_BASE_PX + PLATFORM_SCALE_BOOST * scale * 0.32,
      ),
    );
    return { hw, hh };
  }

  /**
   * 绘制俯视车体矩形（填充 + 描边）；调用前须已 translate 到车心。
   * @param {number} lengthPx
   * @param {number} beamPx
   * @param {string} stroke
   * @param {string} fill
   */
  function strokeTrainBodyRect(lengthPx, beamPx, stroke, fill) {
    ctx.strokeStyle = stroke;
    ctx.fillStyle = fill;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.rect(-beamPx / 2, -lengthPx / 2, beamPx, lengthPx);
    ctx.fill();
    ctx.stroke();
  }

  /**
   * 非最小量程：整列沿本线脊线画成一条统一长矩形（单图标「编组」）。
   * @param {Array<{ x: number, y: number, length: number, beam: number, kind: string }>} cars
   * @param {number} cx
   * @param {number} cy
   * @param {number} scale
   * @param {number} forwardSign
   */
  function paintOwnTrainUnified(cars, cx, cy, scale, forwardSign) {
    const spine = getOwnTrackSpine();
    let xMin = Infinity;
    let xMax = -Infinity;
    let hasScope = false;
    let beamWorld = 0;
    let n = 0;
    for (const car of cars) {
      const trackPt = spine.length
        ? sampleSpineAtWorldX(spine, car.x)
        : { x: car.x, y: car.y };
      if (!trackPt) continue;
      const sc = worldToScope(trackPt.x, trackPt.y);
      if (Math.hypot(sc.x, sc.y) > rangeWorld * 1.05) continue;
      xMin = Math.min(xMin, car.x);
      xMax = Math.max(xMax, car.x);
      beamWorld = Math.max(beamWorld, car.beam);
      if (car.kind === 'own-scope') hasScope = true;
      n += 1;
    }
    if (n < 1 || !(xMax > xMin)) return;

    const xMid = (xMin + xMax) / 2;
    const ptMid = spine.length
      ? sampleSpineAtWorldX(spine, xMid)
      : { x: xMid, y: cars[0].y };
    const ptLo = spine.length
      ? sampleSpineAtWorldX(spine, xMin)
      : { x: xMin, y: cars[0].y };
    const ptHi = spine.length
      ? sampleSpineAtWorldX(spine, xMax)
      : { x: xMax, y: cars[0].y };
    if (!ptMid || !ptLo || !ptHi) return;

    const scrMid = worldOnTrackToScreen(ptMid.x, ptMid.y, cx, cy, scale, forwardSign);
    const scrLo = worldOnTrackToScreen(ptLo.x, ptLo.y, cx, cy, scale, forwardSign);
    const scrHi = worldOnTrackToScreen(ptHi.x, ptHi.y, cx, cy, scale, forwardSign);
    const spanPx = Math.hypot(scrHi.x - scrLo.x, scrHi.y - scrLo.y);
    const carLenPx = clampCarScreenSize(cars[0].length, beamWorld * 1.05, scale).lengthPx;
    const lengthPx = Math.max(OWN_CAR_MIN_LENGTH_PX, spanPx + carLenPx * 0.55);
    const beamPx = clampCarScreenSize(cars[0].length, beamWorld * 1.05, scale).beamPx;
    const rot = spine.length
      ? trackTangentRotationRad(spine, xMid, cx, cy, scale, forwardSign)
      : 0;

    ctx.save();
    ctx.translate(scrMid.x, scrMid.y);
    ctx.rotate(rot);
    strokeTrainBodyRect(
      lengthPx,
      beamPx,
      hasScope ? '#b8ffc8' : '#5dff8a',
      'rgba(80, 255, 120, 0.35)',
    );
    ctx.fillStyle = 'rgba(180, 255, 200, 0.9)';
    ctx.font = `${SCOPE_LABEL_FONT_PX}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('编组', beamPx / 2 + 3, 0);
    ctx.restore();
  }

  /**
   * 无折线时的直线轨带：沿 PPI 前进轴（竖向）画双轨 + 轨枕。
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @param {number} trackHalf
   * @param {number} scale
   */
  function paintStraightTrackAxis(cx, cy, radius, trackHalf, scale) {
    const pad = 4;
    paintTrackOnScreen(
      [
        { x: cx, y: cy - radius - pad },
        { x: cx, y: cy + radius + pad },
      ],
      cx,
      cy,
      radius,
      trackHalf,
      scale,
      { kind: 'own', label: '本线' },
    );
  }

  /**
   * 绘制月台 PPI 标（基准 + 轻度随量程，夹上限；近距不再巨型）。
   * @param {number} cx
   * @param {number} cy
   * @param {number} scale
   * @param {number} forwardSign
   */
  function paintPlatformBlip(cx, cy, scale, forwardSign) {
    const blip = window.LpPlatform?.getRadarPlatformBlip?.();
    if (!blip || !Number.isFinite(blip.x)) return;
    const sc = worldToScope(blip.x, blip.y);
    if (Math.hypot(sc.x, sc.y) > rangeWorld * 1.05) return;
    const scr = scopeToPpi(sc.x, sc.y, cx, cy, scale, forwardSign);
    const docked = Boolean(window.LpPlatform?.isAtPlatform?.());
    ctx.fillStyle = docked ? 'rgba(220, 220, 230, 0.95)' : 'rgba(180, 200, 210, 0.85)';
    ctx.strokeStyle = 'rgba(40, 50, 60, 0.8)';
    ctx.lineWidth = 1;
    const { hw, hh } = platformMarkHalfPx(scale);
    ctx.fillRect(scr.x - hw, scr.y - hh, hw * 2, hh * 2);
    ctx.strokeRect(scr.x - hw, scr.y - hh, hw * 2, hh * 2);
    ctx.fillStyle = 'rgba(200, 220, 230, 0.9)';
    ctx.font = `${SCOPE_LABEL_FONT_PX}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(blip.label || '月台', scr.x + hw + 3, scr.y);
  }

  /** 轨道在示波器上的参考 Y（本车高度附近的「轨面」带）。 */
  function trackY() {
    const o = window.LpPlatform?.getRadarStationOrigin?.();
    if (o && Number.isFinite(o.y)) return o.y;
    return window.LiminalCarriageSpec?.TRACK_Y ?? window.LiminalCarriageSpec?.FLOOR_Y ?? 0;
  }

  /** 示波器原点：与铁轨/月台标同一站心（绘轨车，否则编组中心）。 */
  function radarOriginX() {
    const o = window.LpPlatform?.getRadarStationOrigin?.();
    if (o && Number.isFinite(o.x)) return o.x;
    const Spec = window.LiminalCarriageSpec;
    const scope = Spec?.carriageById?.('huigui');
    if (scope) return scope.worldX + (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2;
    const cars = Spec?.CARRIAGES;
    if (!cars?.length) return 0;
    const first = cars[0];
    const last = cars[cars.length - 1];
    return (first.worldX + last.worldX + Spec.MODULE_W) / 2;
  }

  /** 世界 → 示波器局部（站心为 0；+X = 编组右 / 默认前进，+Y = 轨面侧向）。 */
  function worldToScope(wx, wy) {
    const ox = radarOriginX();
    const oy = trackY();
    return { x: wx - ox, y: wy - oy };
  }

  /** 示波器局部 → 世界（磷光标绘快照坐标；非实时实体位置）。 */
  function scopeToWorld(sx, sy) {
    const ox = radarOriginX();
    const oy = trackY();
    return { x: ox + sx, y: oy + sy };
  }

  /**
   * 示波器局部 → 航向坐标：+u = 前进，+v = 右舷（俯视）。
   * 倒车时翻转，使 12 点始终为当前前进方向。
   */
  function scopeToHeading(sx, sy, forwardSign) {
    if (forwardSign >= 0) return { u: sx, v: sy };
    return { u: -sx, v: -sy };
  }

  /**
   * 航向坐标 → PPI 像素：前进朝上（12 点），右舷朝右（3 点）。
   */
  function headingToScreen(u, v, cx, cy, scale) {
    return {
      x: cx + v * scale,
      y: cy - u * scale,
    };
  }

  /**
   * 示波器局部点 → 俯视 PPI 像素（站心 + 量程比例 + 航向）。
   */
  function scopeToPpi(sx, sy, cx, cy, scale, forwardSign) {
    const h = scopeToHeading(sx, sy, forwardSign);
    return headingToScreen(h.u, h.v, cx, cy, scale);
  }

  /**
   * 示波器局部点在俯视 PPI 上的 canvas 方位角（与扫描线 / 锁定扇区同系）。
   * 前进（+u）→ -π/2（12 点）。
   */
  function scopeBearingCanvas(sx, sy, forwardSign) {
    const h = scopeToHeading(sx, sy, forwardSign);
    return Math.atan2(-h.u, h.v);
  }

  /** 按外壳宽度调整 canvas 像素尺寸，保持 PPI 圆形；量程档 + 边距尽量让圆占主导。 */
  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const shell = root.querySelector('.lp-radar-shell');
    const gear = root.querySelector('.lp-radar-gear');
    const basis = shell?.clientWidth || root.clientWidth;
    const gearW = gear?.offsetWidth || 72;
    const avail = Math.max(180, Math.floor(basis - gearW - 36));
    const css = Math.min(600, Math.max(200, avail));
    canvas.style.width = `${css}px`;
    canvas.style.height = `${css}px`;
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 由指针相对 PPI 画布中心更新锁定扇区瞄准角（可在画布外调用）。
   * 副作用：设置 mouseAimActive，覆盖摇杆瞄准优先权。
   */
  function aimFromCanvasClient(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - (rect.left + rect.width / 2);
    const y = clientY - (rect.top + rect.height / 2);
    if (Math.hypot(x, y) < 6) return;
    lockAimAngle = Math.atan2(y, x);
    mouseAimActive = true;
  }

  /**
   * 将任意量程吸附到最近档位（RANGE_GEARS）；夹在 [MIN, MAX] 内。
   */
  function snapRangeWorld(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return rangeWorld;
    const clamped = Math.max(RANGE_WORLD_MIN, Math.min(RANGE_WORLD_MAX, raw));
    let best = RANGE_GEARS[0];
    let bestDist = Math.abs(clamped - best);
    for (let i = 1; i < RANGE_GEARS.length; i += 1) {
      const d = Math.abs(clamped - RANGE_GEARS[i]);
      if (d < bestDist) {
        best = RANGE_GEARS[i];
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * 从 localStorage 读取上次量程档；缺省或无效则回默认档。
   */
  function loadPersistedRangeWorld() {
    try {
      const raw = localStorage.getItem(RANGE_STORAGE_KEY);
      if (raw == null || raw === '') return DEFAULT_RANGE_WORLD;
      const n = Number(raw);
      if (!Number.isFinite(n)) return DEFAULT_RANGE_WORLD;
      return snapRangeWorld(n);
    } catch {
      return DEFAULT_RANGE_WORLD;
    }
  }

  /**
   * 将当前量程档写入 localStorage（关面板 / 刷新后仍保留）。
   */
  function persistRangeWorld() {
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, String(rangeWorld));
    } catch {
      /* ignore quota / private mode */
    }
  }

  /** 当前量程在 RANGE_GEARS 中的下标（0 = 最近）。 */
  function rangeGearIndex() {
    const i = RANGE_GEARS.indexOf(rangeWorld);
    return i >= 0 ? i : RANGE_GEARS.indexOf(snapRangeWorld(rangeWorld));
  }

  /**
   * 量程档位 → 拉杆垂直比例（上=远/最大量程，下=近/最小量程）。
   */
  function gearIndexToRatio(index) {
    const maxI = RANGE_GEARS.length - 1;
    return (maxI - index) / maxI;
  }

  /**
   * 拉杆垂直比例 → 档位下标（吸附到最近刻度）。
   */
  function ratioToGearIndex(ratio) {
    const maxI = RANGE_GEARS.length - 1;
    const t = Math.max(0, Math.min(1, ratio));
    return Math.round((1 - t) * maxI);
  }

  /**
   * 将量程夹并吸附到档位；打开面板或外部 setRange 时调用。
   * 副作用：同步档位拉杆 UI。
   */
  function clampRangeWorld() {
    rangeWorld = snapRangeWorld(rangeWorld);
    syncRangeGearUi();
  }

  /**
   * 设定量程档位并刷新拉杆/读数；值会吸附到 RANGE_GEARS。
   */
  function setRangeWorld(value) {
    rangeWorld = snapRangeWorld(value);
    syncRangeGearUi();
  }

  /**
   * 按档位步进调量程（+1 更远，-1 更近）；滚轮 / 远近按钮用。
   */
  function stepRangeGear(deltaSteps) {
    const next = Math.max(
      0,
      Math.min(RANGE_GEARS.length - 1, rangeGearIndex() + deltaSteps)
    );
    rangeWorld = RANGE_GEARS[next];
    syncRangeGearUi();
  }

  /**
   * 同步档位拉杆把手位置、刻度高亮与 aria；读数由 drawFrame 写。
   * 副作用：持久化当前量程档到 localStorage。
   */
  function syncRangeGearUi() {
    const index = rangeGearIndex();
    const ratio = gearIndexToRatio(index);
    if (rangeKnob) rangeKnob.style.top = `${ratio * 100}%`;
    if (rangeTrack) {
      rangeTrack.setAttribute('aria-valuenow', String(rangeWorld));
      rangeTrack.setAttribute('aria-valuetext', `量程 ${rangeWorld}`);
    }
    if (rangeNotches) {
      for (const btn of rangeNotches.querySelectorAll('[data-range-gear]')) {
        const active = Number(btn.dataset.rangeGear) === rangeWorld;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }
    persistRangeWorld();
  }

  /**
   * 由指针相对量程拉杆轨道写入档位（拖动中连续吸附）。
   */
  function applyRangeGearPointer(clientY) {
    if (!rangeTrack) return;
    const rect = rangeTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    rangeWorld = RANGE_GEARS[ratioToGearIndex(ratio)];
    syncRangeGearUi();
  }

  /** 构建量程刻度按钮（远在上、近在下；仅 1200/6000/12000 显示数字）。 */
  function buildRangeNotches() {
    if (!rangeNotches) return;
    rangeNotches.replaceChildren();
    for (let i = RANGE_GEARS.length - 1; i >= 0; i -= 1) {
      const gear = RANGE_GEARS[i];
      const labeled = RANGE_GEAR_LABELS.has(gear);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.rangeGear = String(gear);
      btn.setAttribute('role', 'option');
      btn.classList.toggle('is-tick-only', !labeled);
      btn.textContent = labeled ? String(gear) : '';
      btn.setAttribute('aria-label', `量程 ${gear}`);
      btn.addEventListener('click', () => {
        if (!open) return;
        setRangeWorld(gear);
      });
      rangeNotches.appendChild(btn);
    }
  }

  /** 复位雷达专用瞄准摇杆外观（保留已锁定方向）。 */
  function resetRadarAimKnob() {
    radarAimPointer = null;
    if (aimKnob) aimKnob.style.transform = 'translate(0, 0)';
  }

  /** 根据触点更新雷达锁定瞄准摇杆。 */
  function updateRadarAimStick(clientX, clientY) {
    if (!aimStick || !aimKnob) return;
    const rect = aimStick.getBoundingClientRect();
    const radius = rect.width * 0.34;
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      dx = (dx / distance) * radius;
      dy = (dy / distance) * radius;
    }
    aimKnob.style.transform = `translate(${dx}px, ${dy}px)`;

    const nx = dx / radius;
    const ny = dy / radius;
    const mag = Math.hypot(nx, ny);
    if (mag < AIM_DEADZONE) return;
    lockAimAngle = Math.atan2(ny / mag, nx / mag);
    radarAimReady = true;
    mouseAimActive = false;
  }

  /**
   * 刷新锁定瞄准：鼠标优先；否则保留雷达摇杆角；再否则读全局 look 摇杆。
   * 副作用：可能覆盖 lockAimAngle。
   */
  function refreshLockAimFromSticks() {
    if (mouseAimActive) return;
    if (radarAimReady) return;
    const look = window.LpTouchControls?.getLook?.();
    if (!look?.ready) return;
    const mag = Math.hypot(look.x, look.y);
    if (mag > 0.01) lockAimAngle = Math.atan2(look.y, look.x);
  }

  /**
   * 绘制相对列车前进的钟点与角度标注（12/0° = 前进，顺时针递增）。
   * 在 clip 外调用，避免字被 PPI 圆裁切。
   */
  function paintBearingLabels(cx, cy, radius, forwardSign) {
    const zero = forwardCanvasAngle(forwardSign);
    const tickOuter = radius;
    const tickInnerMajor = radius - 8;
    const tickInnerMinor = radius - 5;
    const clockR = radius + 12;
    const degR = radius - 16;

    ctx.strokeStyle = 'rgba(140, 255, 170, 0.55)';
    ctx.fillStyle = 'rgba(170, 255, 190, 0.92)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let deg = 0; deg < 360; deg += 45) {
      const ang = zero + (deg * Math.PI) / 180;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      const major = deg % 90 === 0;
      const inner = major ? tickInnerMajor : tickInnerMinor;
      ctx.lineWidth = major ? 1.35 : 0.9;
      ctx.beginPath();
      ctx.moveTo(cx + cos * inner, cy + sin * inner);
      ctx.lineTo(cx + cos * tickOuter, cy + sin * tickOuter);
      ctx.stroke();

      ctx.font = major
        ? `${SCOPE_LEGEND_FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`
        : `${SCOPE_LABEL_FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const degLabel = deg === 0 ? '0°' : `${deg}°`;
      ctx.fillText(degLabel, cx + cos * degR, cy + sin * degR);
    }

    const clocks = [
      { hour: 12, deg: 0 },
      { hour: 3, deg: 90 },
      { hour: 6, deg: 180 },
      { hour: 9, deg: 270 },
    ];
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(200, 255, 210, 0.95)';
    for (const c of clocks) {
      const ang = zero + (c.deg * Math.PI) / 180;
      ctx.fillText(String(c.hour), cx + Math.cos(ang) * clockR, cy + Math.sin(ang) * clockR);
    }
  }

  /**
   * 读取存活小怪列表（优先 LpMobs；否则战斗层敌方摘要）。
   * @returns {Array<{ id?: string, x: number, y: number, kind?: string, vx?: number, vy?: number }>}
   */
  function readMobHostiles() {
    const fromMobs = window.LpMobs?.listHostiles?.();
    if (Array.isArray(fromMobs) && fromMobs.length) return fromMobs;
    const fromCombat = window.LpCombat?.listHostiles?.();
    return Array.isArray(fromCombat) ? fromCombat : [];
  }

  /**
   * 目标在示波器局部坐标下的速度（世界 px/s）。
   * 编组站心固定时直接用 mob/contact 的 vx/vy（与磷光点位移一致）。
   * @param {{ vx?: number, vy?: number }} h
   */
  function hostileScopeVelocity(h) {
    return {
      vx: Number(h?.vx) || 0,
      vy: Number(h?.vy) || 0,
    };
  }

  /**
   * 按示波器局部距离把点并成簇（并查集）；返回各簇成员下标。
   * @param {Array<{ sx: number, sy: number }>} points
   * @param {number} linkDist 链接半径（与 sx/sy 同单位）
   * @returns {number[][]}
   */
  function clusterIndicesByDist(points, linkDist) {
    const n = points.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    /** 并查集找根（路径压缩）。 */
    function find(i) {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    }
    /** 合并两个点的连通分量。 */
    function unite(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }
    const link2 = linkDist * linkDist;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dx = points[i].sx - points[j].sx;
        const dy = points[i].sy - points[j].sy;
        if (dx * dx + dy * dy <= link2) unite(i, j);
      }
    }
    /** @type {Map<number, number[]>} */
    const groups = new Map();
    for (let i = 0; i < n; i += 1) {
      const r = find(i);
      let g = groups.get(r);
      if (!g) {
        g = [];
        groups.set(r, g);
      }
      g.push(i);
    }
    return [...groups.values()];
  }

  /**
   * 统计射程内小型目标集群数（与雷达集群标同源：按 kind 分桶、链接 MOB_CLUSTER_LINK、簇 ≥ MOB_CLUSTER_MIN）。
   * 调用方应已剔除大型目标；本函数只做邻域聚类计数，不画图。
   * @param {Array<{ x: number, y?: number, kind?: string }>} hostiles
   * @param {{ x: number, y: number }} origin
   * @param {number} range 世界像素半径
   * @returns {number}
   */
  function countSmallTargetClustersInRange(hostiles, origin, range) {
    if (!origin || !(range > 0) || !Array.isArray(hostiles)) return 0;
    const range2 = range * range;
    /** @type {Record<string, Array<{ sx: number, sy: number }>>} */
    const byKind = Object.create(null);
    for (const h of hostiles) {
      if (h?.x == null || !Number.isFinite(h.x)) continue;
      const y = h.y != null && Number.isFinite(h.y) ? h.y : origin.y;
      const dx = h.x - origin.x;
      const dy = y - origin.y;
      if (dx * dx + dy * dy > range2) continue;
      const bucket = h.kind === 'air' ? 'air' : 'ground';
      if (!byKind[bucket]) byKind[bucket] = [];
      byKind[bucket].push({ sx: h.x, sy: y });
    }
    let n = 0;
    for (const pts of Object.values(byKind)) {
      if (pts.length < MOB_CLUSTER_MIN) continue;
      const clusters = clusterIndicesByDist(pts, MOB_CLUSTER_LINK);
      for (const idxs of clusters) {
        if (idxs.length >= MOB_CLUSTER_MIN) n += 1;
      }
    }
    return n;
  }

  /**
   * 最短有向角差，结果落在 (-π, π]。
   * @param {number} from
   * @param {number} to
   */
  function shortestAngleDelta(from, to) {
    let d = to - from;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d <= -Math.PI) d += Math.PI * 2;
    return d;
  }

  /**
   * 判断扫描线从 prev→curr（可双向）是否扫过 bearing，或当前贴在命中半宽内。
   * 用最短角跨度，支持搜索顺扫与锁定扇区往返。
   * @param {number|null} prev
   * @param {number} curr
   * @param {number} bearing
   */
  function sweepIlluminates(prev, curr, bearing) {
    if (Math.abs(shortestAngleDelta(curr, bearing)) <= SWEEP_HIT_HALF_RAD) return true;
    if (prev == null || !Number.isFinite(prev)) return false;
    const span = shortestAngleDelta(prev, curr);
    /* 大跳变（重开 / 瞄准猛甩）不当作扫过，避免整圈误涂 */
    if (Math.abs(span) < 1e-9 || Math.abs(span) > Math.PI * 0.99) return false;
    const fromPrev = shortestAngleDelta(prev, bearing);
    if (span > 0) return fromPrev >= 0 && fromPrev <= span;
    return fromPrev <= 0 && fromPrev >= span;
  }

  /**
   * 锁定扇区扫描相位：三角波 0→1→0（边到边再反向），单向时长 LOCK_SECTOR_SWEEP_PERIOD_MS。
   * @param {number} now
   * @returns {{ t: number, dir: number }} t∈[0,1]；dir +1 朝右缘、-1 朝左缘
   */
  function lockSectorSweepPhase(now) {
    const phase = (now / LOCK_SECTOR_SWEEP_PERIOD_MS) % 2;
    if (phase <= 1) return { t: phase, dir: 1 };
    return { t: 2 - phase, dir: -1 };
  }

  /**
   * 扇区扫描转速读数文案（由 LOCK_SECTOR_SWEEP_* 常量推导，不依赖帧时）。
   */
  function formatSectorSweepRpmReadout() {
    const rpmStr = Number.isInteger(LOCK_SECTOR_SWEEP_RPM)
      ? String(LOCK_SECTOR_SWEEP_RPM)
      : LOCK_SECTOR_SWEEP_RPM.toFixed(1);
    return `扇扫 ${rpmStr} RPM · ${LOCK_SECTOR_SWEEP_HZ.toFixed(1)} Hz`;
  }

  /**
   * 把扇区扫描转速写到页脚读数（副作用：更新 DOM）。
   */
  function syncSectorRpmReadout() {
    if (!sectorRpmReadout) return;
    sectorRpmReadout.textContent = formatSectorSweepRpmReadout();
  }

  /**
   * 示波器局部坐标是否落在指定锁定扇区内。
   * @param {number} sx
   * @param {number} sy
   * @param {number} forwardSign
   * @param {number} aimAngle 扇区角平分线（canvas 弧度）
   */
  function inLockSectorAt(sx, sy, forwardSign, aimAngle) {
    const dist = Math.hypot(sx, sy);
    if (dist > Math.min(LOCK_RANGE_WORLD_MAX, rangeWorld) * 1.02) return false;
    if (dist < 1e-3) return true;
    const bearing = scopeBearingCanvas(sx, sy, forwardSign);
    return Math.abs(shortestAngleDelta(aimAngle, bearing)) <= LOCK_HALF_RAD;
  }

  /** 本地锁定扇区（当前 lockAimAngle）。 */
  function inLockSector(sx, sy, forwardSign) {
    return inLockSectorAt(sx, sy, forwardSign, lockAimAngle);
  }

  /**
   * 写入或刷新一条磷光标绘（副作用：更新 phosphorBlips）。
   * @param {object} blip
   * @param {number} now
   */
  function paintPhosphorBlip(blip, now) {
    phosphorBlips.set(blip.key, { ...blip, paintedAt: now });
  }

  /**
   * 由动画时钟推导搜索雷达当前圈序号（满圈 +1）。
   * @param {number} now
   */
  function searchSweepPassIndex(now) {
    return Math.floor(((now / 1000) * SEARCH_SWEEP_RAD_PER_S) / (Math.PI * 2));
  }

  /**
   * 圆形搜索线首次命中某目标时播一声呐（边沿；每目标每圈一次；全局冷却）。
   * 扇区快扫不调用。副作用：轮播下标、冷却时间、pinged 集合。
   * @param {string} key
   * @param {number} now
   */
  function tryPlaySearchSonarPing(key, now) {
    const pass = searchSweepPassIndex(now);
    if (pass !== sonarSearchPass) {
      sonarSearchPass = pass;
      sonarPingedThisPass = new Set();
    }
    if (sonarPingedThisPass.has(key)) return;
    sonarPingedThisPass.add(key);
    if (now - lastSonarPingAt < SONAR_PING_COOLDOWN_MS) return;
    const url = SONAR_SFX_URLS[sonarSfxIndex % SONAR_SFX_URLS.length];
    sonarSfxIndex = (sonarSfxIndex + 1) % SONAR_SFX_URLS.length;
    lastSonarPingAt = now;
    window.LpSfx?.play?.(url, {
      volume: SONAR_SFX_VOLUME,
      ambient: true,
      rateJitter: 0.02,
    });
  }

  /**
   * 清空磷光表与扫描角历史（关面板时调用，避免残留）。
   */
  function clearPhosphorState() {
    phosphorBlips.clear();
    prevSearchSweep = null;
    prevSectorSweep = null;
    sonarPingedThisPass = new Set();
    sonarSearchPass = -1;
    lastSonarPingAt = 0;
  }

  /**
   * 收集本帧可被扫描线涂覆的目标（外部接触、小型集群标）。
   * 本列编组不走磷光，由 paintOwnTrainTopDown 常显俯视图标。
   * @param {number} forwardSign
   * @returns {Array<object>}
   */
  function collectSweepTargets(forwardSign) {
    /** @type {Array<object>} */
    const out = [];

    for (const c of externalContacts) {
      if (!Number.isFinite(c?.x) || !Number.isFinite(c?.y)) continue;
      const p = worldToScope(c.x, c.y);
      if (Math.hypot(p.x, p.y) > rangeWorld * 1.05) continue;
      const vel = hostileScopeVelocity(c);
      out.push({
        key: `contact:${c.id || `${c.x},${c.y}`}`,
        kind: 'contact',
        sx: p.x,
        sy: p.y,
        bearing: scopeBearingCanvas(p.x, p.y, forwardSign),
        style: c.kind || 'contact',
        label: c.label,
        length: c.length,
        beam: c.beam,
        vx: vel.vx,
        vy: vel.vy,
      });
    }

    const hostiles = readMobHostiles();
    /** @type {{ ground: Array<{ sx: number, sy: number, vx: number, vy: number }>, air: Array<{ sx: number, sy: number, vx: number, vy: number }> }} */
    const byKind = { ground: [], air: [] };
    for (const h of hostiles) {
      if (!Number.isFinite(h?.x) || !Number.isFinite(h?.y)) continue;
      const p = worldToScope(h.x, h.y);
      if (Math.hypot(p.x, p.y) > rangeWorld * 1.05) continue;
      const bucket = h.kind === 'air' ? 'air' : 'ground';
      const vel = hostileScopeVelocity(h);
      byKind[bucket].push({ sx: p.x, sy: p.y, vx: vel.vx, vy: vel.vy });
    }

    for (const mobKind of ['ground', 'air']) {
      const pts = byKind[mobKind];
      if (pts.length < MOB_CLUSTER_MIN) continue;
      const clusters = clusterIndicesByDist(pts, MOB_CLUSTER_LINK);
      let clusterIdx = 0;
      for (const idxs of clusters) {
        if (idxs.length < MOB_CLUSTER_MIN) continue;
        let sumX = 0;
        let sumY = 0;
        let sumVx = 0;
        let sumVy = 0;
        for (const i of idxs) {
          sumX += pts[i].sx;
          sumY += pts[i].sy;
          sumVx += pts[i].vx;
          sumVy += pts[i].vy;
        }
        const n = idxs.length;
        const mx = sumX / n;
        const my = sumY / n;
        out.push({
          key: `mob:${mobKind}:${clusterIdx}`,
          kind: 'mob-cluster',
          sx: mx,
          sy: my,
          bearing: scopeBearingCanvas(mx, my, forwardSign),
          mobKind,
          vx: sumVx / n,
          vy: sumVy / n,
        });
        clusterIdx += 1;
      }
    }

    return out;
  }

  /**
   * 按搜索线与锁定扇区快扫线更新磷光表（扫过才涂；扇区内两条线均可涂）。
   * 圆形搜索首次涂覆时边沿触发声呐；扇区快扫只涂磷光不播。
   * @param {number} now
   * @param {number} forwardSign
   */
  function updatePhosphorFromSweeps(now, forwardSign) {
    const targets = collectSweepTargets(forwardSign);
    for (const t of targets) {
      const bySearch = sweepIlluminates(prevSearchSweep, sweepAngle, t.bearing);
      const inSector = inLockSector(t.sx, t.sy, forwardSign);
      const bySector =
        inSector && sweepIlluminates(prevSectorSweep, sectorSweepAngle, t.bearing);
      if (!bySearch && !bySector) continue;
      if (bySearch) tryPlaySearchSonarPing(t.key, now);
      paintPhosphorBlip(t, now);
    }
    prevSearchSweep = sweepAngle;
    prevSectorSweep = sectorSweepAngle;
  }

  /**
   * 示波器速度 → 俯视 PPI 屏幕像素位移（与 scopeToPpi 同系）。
   * @param {number} vx
   * @param {number} vy
   * @param {number} scale
   * @param {number} forwardSign
   */
  function scopeVelocityToScreenDelta(vx, vy, scale, forwardSign) {
    const h = scopeToHeading(vx, vy, forwardSign);
    return { dx: h.v * scale, dy: -h.u * scale };
  }

  /**
   * 绘制速度矢量线（簇/接触均速 × VECTOR_LEAD_S）；过慢不画。
   * @param {number} vx
   * @param {number} vy
   * @param {number} scale
   * @param {number} forwardSign
   */
  function drawVelocityVector(vx, vy, scale, forwardSign) {
    const speed = Math.hypot(vx, vy);
    if (speed < VECTOR_MIN_SPEED) return;
    const delta = scopeVelocityToScreenDelta(vx * VECTOR_LEAD_S, vy * VECTOR_LEAD_S, scale, forwardSign);
    let len = Math.hypot(delta.dx, delta.dy);
    if (len < 1e-3) return;
    if (len < VECTOR_MIN_PX) {
      const k = VECTOR_MIN_PX / len;
      delta.dx *= k;
      delta.dy *= k;
      len = VECTOR_MIN_PX;
    } else if (len > VECTOR_MAX_PX) {
      const k = VECTOR_MAX_PX / len;
      delta.dx *= k;
      delta.dy *= k;
    }
    ctx.strokeStyle = 'rgba(180, 255, 200, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(delta.dx, delta.dy);
    ctx.stroke();
  }

  /**
   * 绘制一条接触类磷光标（俯视坐标）；alpha 由余晖衰减。
   * @param {object} blip
   * @param {number} cx
   * @param {number} cy
   * @param {number} scale
   * @param {number} alpha
   * @param {number} forwardSign
   */
  function drawContactBlip(blip, cx, cy, scale, alpha, forwardSign) {
    const scr = scopeToPpi(blip.sx, blip.sy, cx, cy, scale, forwardSign);
    const style = blip.style || 'contact';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(scr.x, scr.y);
    if (style === 'hostile') {
      const half = HOSTILE_MARK_PX / 2;
      ctx.strokeStyle = '#ff6b4a';
      ctx.lineWidth = 1.75;
      ctx.strokeRect(-half, -half, HOSTILE_MARK_PX, HOSTILE_MARK_PX);
    } else if (style === 'train') {
      const sized = clampCarScreenSize(blip.length || 900, blip.beam || 250, scale);
      const len = sized.lengthPx;
      const beam = sized.beamPx;
      ctx.fillStyle = '#7ec8ff';
      ctx.fillRect(-beam / 2, -len / 2, beam, len);
    } else {
      ctx.fillStyle = '#9dffb0';
      ctx.beginPath();
      ctx.arc(0, 0, CONTACT_DOT_R_PX, 0, Math.PI * 2);
      ctx.fill();
    }
    if (blip.label && style !== 'train') {
      ctx.fillStyle = 'rgba(180, 255, 200, 0.9)';
      ctx.font = `${SCOPE_LABEL_FONT_PX}px ui-monospace, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(blip.label, HOSTILE_MARK_PX / 2 + 3, 0);
    }
    drawVelocityVector(blip.vx || 0, blip.vy || 0, scale, forwardSign);
    ctx.restore();
  }

  /**
   * 绘制小型集群磷光标：绿方块 + 下划线=地面保龄球 / 上划线=空中气球 + 速度矢量 + 简称。
   * @param {object} blip
   * @param {number} cx
   * @param {number} cy
   * @param {number} scale
   * @param {number} alpha
   * @param {number} forwardSign
   */
  function drawMobClusterBlip(blip, cx, cy, scale, alpha, forwardSign) {
    const scr = scopeToPpi(blip.sx, blip.sy, cx, cy, scale, forwardSign);
    const half = CLUSTER_MARK_PX / 2;
    const air = blip.mobKind === 'air';
    const label = air ? '气球' : '保龄球';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(scr.x, scr.y);
    ctx.fillStyle = 'rgba(90, 255, 140, 0.55)';
    ctx.strokeStyle = '#6dff9a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(-half, -half, CLUSTER_MARK_PX, CLUSTER_MARK_PX);
    ctx.fill();
    ctx.stroke();
    const barY = air
      ? -half - CLUSTER_BAR_GAP_PX
      : half + CLUSTER_BAR_GAP_PX;
    const barHalf = half + CLUSTER_BAR_PAD_PX;
    ctx.strokeStyle = '#b8ffc8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-barHalf, barY);
    ctx.lineTo(barHalf, barY);
    ctx.stroke();
    ctx.fillStyle = 'rgba(180, 255, 200, 0.9)';
    ctx.font = `${SCOPE_LABEL_FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, half + 3, 0);
    drawVelocityVector(blip.vx || 0, blip.vy || 0, scale, forwardSign);
    ctx.restore();
  }

  /**
   * 绘制全部磷光余晖并剔除已过期条目。
   * @param {number} now
   * @param {number} cx
   * @param {number} cy
   * @param {number} scale
   * @param {number} forwardSign
   */
  function paintPhosphorBlips(now, cx, cy, scale, forwardSign) {
    for (const [key, blip] of phosphorBlips) {
      const age = now - blip.paintedAt;
      if (age >= BLIP_FADE_MS) {
        phosphorBlips.delete(key);
        continue;
      }
      const alpha = Math.max(0, 1 - age / BLIP_FADE_MS);
      if (blip.kind === 'mob-cluster' || blip.kind === 'mob-blob') {
        drawMobClusterBlip(blip, cx, cy, scale, alpha, forwardSign);
      } else {
        drawContactBlip(blip, cx, cy, scale, alpha, forwardSign);
      }
    }
  }

  /**
   * 常显本列俯视编组：沿本线脊线落位；仅最小量程逐节，其余档位单图标。
   * @param {number} cx
   * @param {number} cy
   * @param {number} scale
   * @param {number} forwardSign
   */
  function paintOwnTrainTopDown(cx, cy, scale, forwardSign) {
    const cars = ownTrainCenters();
    if (!cars.length) return;
    if (!showIndividualOwnCars()) {
      paintOwnTrainUnified(cars, cx, cy, scale, forwardSign);
      return;
    }
    const spine = getOwnTrackSpine();
    for (const car of cars) {
      const trackPt = spine.length
        ? sampleSpineAtWorldX(spine, car.x)
        : { x: car.x, y: car.y };
      if (!trackPt) continue;
      const sc = worldToScope(trackPt.x, trackPt.y);
      if (Math.hypot(sc.x, sc.y) > rangeWorld * 1.05) continue;
      const scr = scopeToPpi(sc.x, sc.y, cx, cy, scale, forwardSign);
      let lengthWorld = car.length;
      let beamWorld = car.beam;
      if (car.kind === 'own-scope') {
        lengthWorld *= OWN_SCOPE_LENGTH_BOOST;
        beamWorld *= OWN_SCOPE_BEAM_BOOST;
      }
      const sized = clampCarScreenSize(lengthWorld, beamWorld, scale);
      const length = sized.lengthPx;
      const beam = sized.beamPx;
      const rot = spine.length
        ? trackTangentRotationRad(spine, car.x, cx, cy, scale, forwardSign)
        : 0;
      ctx.save();
      ctx.translate(scr.x, scr.y);
      ctx.rotate(rot);
      strokeTrainBodyRect(
        length,
        beam,
        car.kind === 'own-scope' ? '#b8ffc8' : '#5dff8a',
        'rgba(80, 255, 120, 0.35)',
      );
      if (car.label) {
        ctx.fillStyle = 'rgba(180, 255, 200, 0.9)';
        ctx.font = `${SCOPE_LABEL_FONT_PX}px ui-monospace, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(car.label, beam / 2 + 3, 0);
      }
      ctx.restore();
    }
  }

  /**
   * 绘制锁定扇区内快速扫描线（仅亮线，无拖尾楔；满圈 PPI 搜索线仍保留余晖）。
   * @param {number} cx
   * @param {number} cy
   * @param {number} lockR
   */
  function paintSectorSweepLine(cx, cy, lockR) {
    ctx.strokeStyle = 'rgba(220, 255, 230, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + Math.cos(sectorSweepAngle) * lockR,
      cy + Math.sin(sectorSweepAngle) * lockR
    );
    ctx.stroke();
  }

  /**
   * 绘制锁定雷达扇区（填充 + 两侧亮边 + 外弧封闭 + 角平分线）。
   * 扇区半径为 min(LOCK_RANGE_WORLD_MAX, rangeWorld) 映射像素；量程 > 6000 时外弧停在半途表示超出锁定量程。
   */
  function paintLockSector(cx, cy, scale) {
    const a0 = lockAimAngle - LOCK_HALF_RAD;
    const a1 = lockAimAngle + LOCK_HALF_RAD;
    const lockWorldR = Math.min(LOCK_RANGE_WORLD_MAX, rangeWorld);
    const lockR = lockWorldR * scale;

    ctx.fillStyle = 'rgba(50, 200, 110, 0.14)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, lockR, a0, a1, false);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(170, 255, 190, 0.82)';
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a0) * lockR, cy + Math.sin(a0) * lockR);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a1) * lockR, cy + Math.sin(a1) * lockR);
    ctx.stroke();

    /* 外弧：量程 ≤ 6000 贴 PPI 外缘；> 6000 时停在 6000 对应半径，封闭扇形 */
    ctx.strokeStyle = 'rgba(140, 255, 170, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0.5, lockR - 0.5), a0, a1, false);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(210, 255, 220, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + Math.cos(lockAimAngle) * lockR,
      cy + Math.sin(lockAimAngle) * lockR
    );
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** 画一帧 PPI。 */
  function drawFrame(now) {
    const cssW = canvas.clientWidth || 360;
    const cssH = canvas.clientHeight || 360;
    const cx = cssW / 2;
    const cy = cssH / 2;
    const radius = Math.min(cx, cy) - PPI_RADIUS_INSET_PX;
    /* 线性 PPI：像素半径 / 当前量程。远站压缩在 LpPlatform.radarBlipRouteDist（随量程外扩）。 */
    const scale = radius / rangeWorld;

    refreshLockAimFromSticks();
    const forwardSign = resolveForwardSign();

    ctx.clearRect(0, 0, cssW, cssH);

    /* CRT 底 */
    const bg = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
    bg.addColorStop(0, '#06280a');
    bg.addColorStop(0.7, '#031805');
    bg.addColorStop(1, '#010901');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    /* 量程环 + 径向距离标注（随当前量程变化，便于核对缩放） */
    ctx.strokeStyle = 'rgba(80, 255, 120, 0.22)';
    ctx.lineWidth = 0.9;
    ctx.fillStyle = 'rgba(140, 230, 170, 0.55)';
    ctx.font = `${SCOPE_LABEL_FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 1; i <= 4; i += 1) {
      const r = (radius * i) / 4;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      const distLabel = String(Math.round((rangeWorld * i) / 4));
      ctx.fillText(distLabel, cx + r * 0.72, cy - 8);
    }

    /* 方位十字 */
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.strokeStyle = 'rgba(80, 255, 120, 0.18)';
    ctx.stroke();

    /* 铁轨线路网：侧线占位 + 本线双轨（后续敌对列车按 lane 挂载） */
    const trackHalf = trackHalfPx(scale);
    paintTrackRouteNetwork(cx, cy, radius, scale, forwardSign, trackHalf);

    /* 搜索雷达扫描线（满圈 ~4.65s） */
    sweepAngle = ((now / 1000) * SEARCH_SWEEP_RAD_PER_S) % (Math.PI * 2);
    const sweepGrad = ctx.createConicGradient(sweepAngle - Math.PI / 2, cx, cy);
    sweepGrad.addColorStop(0, 'rgba(80, 255, 120, 0.35)');
    sweepGrad.addColorStop(0.08, 'rgba(80, 255, 120, 0)');
    sweepGrad.addColorStop(1, 'rgba(80, 255, 120, 0)');
    ctx.fillStyle = sweepGrad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, sweepAngle - 0.9, sweepAngle, false);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(180, 255, 190, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweepAngle) * radius, cy + Math.sin(sweepAngle) * radius);
    ctx.stroke();

    /* 锁定雷达扇区（在接触点之下；有效半径 capped 于 LOCK_RANGE_WORLD_MAX） */
    paintLockSector(cx, cy, scale);

    /* 扇区内快速扫描线（单向 ~0.5s，到边后反向，往返 ~1s） */
    const lockWorldR = Math.min(LOCK_RANGE_WORLD_MAX, rangeWorld);
    const lockR = lockWorldR * scale;
    const a0 = lockAimAngle - LOCK_HALF_RAD;
    const a1 = lockAimAngle + LOCK_HALF_RAD;
    const sectorPhase = lockSectorSweepPhase(now);
    sectorSweepAngle = a0 + sectorPhase.t * (a1 - a0);
    paintSectorSweepLine(cx, cy, lockR);

    /* 扫描线命中 → 涂磷光；再画余晖衰减标 */
    updatePhosphorFromSweeps(now, forwardSign);
    paintPhosphorBlips(now, cx, cy, scale, forwardSign);

    /* 本列俯视编组（常显，不依赖扫描余晖） */
    paintOwnTrainTopDown(cx, cy, scale, forwardSign);

    /* 月台标（路线前方 / 停靠） */
    paintPlatformBlip(cx, cy, scale, forwardSign);

    /* 站心十字 = 本站（绘轨）；始终可见 */
    ctx.strokeStyle = 'rgba(220, 255, 230, 0.9)';
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.moveTo(cx - STATION_CROSS_HALF_PX, cy);
    ctx.lineTo(cx + STATION_CROSS_HALF_PX, cy);
    ctx.moveTo(cx, cy - STATION_CROSS_HALF_PX);
    ctx.lineTo(cx, cy + STATION_CROSS_HALF_PX);
    ctx.stroke();

    ctx.restore();

    /* 外圈 + 方位/角度标注（12/0° = 列车前进） */
    ctx.strokeStyle = 'rgba(120, 255, 160, 0.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    paintBearingLabels(cx, cy, radius, resolveForwardSign());

    if (rangeReadout) {
      rangeReadout.textContent = `量程 ${Math.round(rangeWorld)}`;
    }
    if (modeReadout) {
      modeReadout.textContent = `接触 ${externalContacts.length} · PPI`;
    }
    syncSectorRpmReadout();
  }

  /** 动画循环。 */
  function tick(now) {
    if (!open) return;
    drawFrame(now);
    raf = requestAnimationFrame(tick);
  }

  /** 打开示波器；量程吸附到 RANGE_GEARS 档位；预热声呐缓冲。 */
  function openPanel() {
    if (open) return;
    open = true;
    clearPhosphorState();
    clampRangeWorld();
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-radar-panel-open');
    window.LpSfx?.preload?.(SONAR_SFX_URLS);
    resizeCanvas();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  /** 关闭示波器。 */
  function closePanel() {
    if (!open) return;
    open = false;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-radar-panel-open');
    cancelAnimationFrame(raf);
    raf = 0;
    clearPhosphorState();
    resetRadarAimKnob();
  }

  closeBtn?.addEventListener('click', () => closePanel());
  root.querySelector('.lp-radar-backdrop')?.addEventListener('click', () => closePanel());
  window.addEventListener('resize', () => {
    if (open) resizeCanvas();
  });

  /*
   * 桌面：全页 mousemove 驱动锁定扇区（相对 PPI 中心取角）；
   * 搜索 360° 扫描线不跟随鼠标。移动端用下方瞄准摇杆。
   */
  window.addEventListener('mousemove', (event) => {
    if (!open || radarAimPointer !== null) return;
    aimFromCanvasClient(event.clientX, event.clientY);
  });

  /* 滚轮调量程：每格一档，吸附 RANGE_GEARS */
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!open) return;
      event.preventDefault();
      stepRangeGear(event.deltaY > 0 ? -1 : 1);
    },
    { passive: false }
  );

  /* 移动端：双指捏合调量程；松手与移动均吸附最近档 */
  let pinchStartDist = 0;
  let pinchStartRange = rangeWorld;
  canvas.addEventListener(
    'touchstart',
    (event) => {
      if (!open || event.touches.length !== 2) return;
      const a = event.touches[0];
      const b = event.touches[1];
      pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinchStartRange = rangeWorld;
    },
    { passive: true }
  );
  canvas.addEventListener(
    'touchmove',
    (event) => {
      if (!open || event.touches.length !== 2 || pinchStartDist < 8) return;
      event.preventDefault();
      const a = event.touches[0];
      const b = event.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const next = pinchStartRange * (pinchStartDist / Math.max(8, dist));
      setRangeWorld(next);
    },
    { passive: false }
  );
  canvas.addEventListener(
    'touchend',
    () => {
      if (pinchStartDist > 0) {
        clampRangeWorld();
        pinchStartDist = 0;
      }
    },
    { passive: true }
  );

  document.getElementById('lpRadarRangeFar')?.addEventListener('click', () => {
    if (open) stepRangeGear(1);
  });
  document.getElementById('lpRadarRangeNear')?.addEventListener('click', () => {
    if (open) stepRangeGear(-1);
  });

  /* 量程档位拉杆：拖拽 / 键盘上下；启动时恢复上次量程 */
  rangeWorld = loadPersistedRangeWorld();
  buildRangeNotches();
  if (rangeTrack) {
    rangeTrack.addEventListener('pointerdown', (event) => {
      if (!open || rangeGearPointer !== null) return;
      event.preventDefault();
      rangeGearPointer = event.pointerId;
      rangeTrack.setPointerCapture(event.pointerId);
      applyRangeGearPointer(event.clientY);
    });
    rangeTrack.addEventListener('pointermove', (event) => {
      if (event.pointerId !== rangeGearPointer) return;
      applyRangeGearPointer(event.clientY);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      rangeTrack.addEventListener(eventName, (event) => {
        if (event.pointerId === rangeGearPointer) {
          rangeGearPointer = null;
          clampRangeWorld();
        }
      });
    }
    rangeTrack.addEventListener('keydown', (event) => {
      if (!open) return;
      if (event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault();
        stepRangeGear(1);
      } else if (event.key === 'ArrowDown' || event.key === 'PageDown') {
        event.preventDefault();
        stepRangeGear(-1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setRangeWorld(RANGE_WORLD_MAX);
      } else if (event.key === 'End') {
        event.preventDefault();
        setRangeWorld(RANGE_WORLD_MIN);
      }
    });
  }
  syncRangeGearUi();

  /* 移动端：雷达面板内锁定瞄准摇杆（复用 look 摇杆交互模式） */
  if (aimStick && aimKnob) {
    aimStick.addEventListener('pointerdown', (event) => {
      if (!open || radarAimPointer !== null) return;
      event.preventDefault();
      radarAimPointer = event.pointerId;
      updateRadarAimStick(event.clientX, event.clientY);
      aimStick.setPointerCapture(event.pointerId);
    });
    aimStick.addEventListener('pointermove', (event) => {
      if (event.pointerId === radarAimPointer) {
        updateRadarAimStick(event.clientX, event.clientY);
      }
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      aimStick.addEventListener(eventName, (event) => {
        if (event.pointerId === radarAimPointer) resetRadarAimKnob();
      });
    }
  }

  /**
   * 射程内可跟踪目标（外部接触 + 单只小怪），含示波器与世界坐标。
   * @param {number} forwardSign
   * @returns {Array<{ id: string, kind: string, x: number, y: number, sx: number, sy: number, label: string }>}
   */
  function collectTrackableContacts(forwardSign) {
    /** @type {Array<{ id: string, kind: string, x: number, y: number, sx: number, sy: number, label: string }>} */
    const out = [];
    for (const c of externalContacts) {
      if (!Number.isFinite(c?.x) || !Number.isFinite(c?.y)) continue;
      const p = worldToScope(c.x, c.y);
      if (Math.hypot(p.x, p.y) > rangeWorld * 1.05) continue;
      out.push({
        id: String(c.id || `contact:${c.x},${c.y}`),
        kind: c.kind || 'contact',
        x: c.x,
        y: c.y,
        sx: p.x,
        sy: p.y,
        label: c.label || c.kind || '接触',
      });
    }
    for (const h of readMobHostiles()) {
      if (!Number.isFinite(h?.x) || !Number.isFinite(h?.y)) continue;
      const p = worldToScope(h.x, h.y);
      if (Math.hypot(p.x, p.y) > rangeWorld * 1.05) continue;
      out.push({
        id: String(h.id || `mob:${h.x},${h.y}`),
        kind: h.kind || 'mob',
        x: h.x,
        y: h.y,
        sx: p.x,
        sy: p.y,
        label: h.label || h.species || h.kind || '目标',
      });
    }
    return out;
  }

  /**
   * 当前被持续照射的目标 id（本地或任一远端绘轨雷达锁定扇区）。
   * @returns {Set<string>}
   */
  function getIlluminatedContactIds() {
    const forwardSign = resolveForwardSign();
    /** @type {Set<string>} */
    const ids = new Set();
    const targets = collectTrackableContacts(forwardSign);
    if (open) {
      for (const t of targets) {
        if (inLockSectorAt(t.sx, t.sy, forwardSign, lockAimAngle)) ids.add(t.id);
      }
    }
    const remotes = window.LiminalSession?.remotes?.();
    if (remotes && typeof remotes.values === 'function') {
      for (const remote of remotes.values()) {
        if (!remote || remote._lpDisconnected) continue;
        if (!remote._lpRadarOpen) continue;
        const aim = Number(remote._lpRadarLockAim);
        if (!Number.isFinite(aim)) continue;
        for (const t of targets) {
          if (inLockSectorAt(t.sx, t.sy, forwardSign, aim)) ids.add(t.id);
        }
      }
    }
    return ids;
  }

  /**
   * 落在锁定扇区内的接触（持续照射；含远端雷达操作员）。
   * @returns {Array<{ id: string, kind: string, x: number, y: number, label?: string }>}
   */
  function getIlluminatedContacts() {
    const forwardSign = resolveForwardSign();
    const ids = getIlluminatedContactIds();
    if (!ids.size) return [];
    return collectTrackableContacts(forwardSign)
      .filter((t) => ids.has(t.id))
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        x: t.x,
        y: t.y,
        label: t.label,
      }));
  }

  /**
   * 磷光标绘快照（搜索/扇扫曾涂覆的近期接触），示波器局部坐标。
   * @returns {Array<object>}
   */
  function getPhosphorContacts() {
    const now = performance.now();
    const out = [];
    for (const blip of phosphorBlips.values()) {
      if (!blip) continue;
      const age = now - (blip.paintedAt || 0);
      if (age > BLIP_FADE_MS) continue;
      const w = scopeToWorld(blip.sx, blip.sy);
      out.push({ ...blip, ageMs: age, x: w.x, y: w.y });
    }
    return out;
  }

  /**
   * 火控索敌：磷光为滞后快照（live=false），持续照射为实时坐标（live=true）。
   * @returns {Array<{ id: string, kind: string, label: string, x: number, y: number, live: boolean, ageMs: number }>}
   */
  function getTargetingContacts() {
    const forwardSign = resolveForwardSign();
    const illuminatedIds = getIlluminatedContactIds();
    /** @type {Map<string, { id: string, kind: string, label: string, x: number, y: number, live: boolean, ageMs: number }>} */
    const byId = new Map();
    const now = performance.now();
    for (const blip of phosphorBlips.values()) {
      if (!blip) continue;
      const age = now - (blip.paintedAt || 0);
      if (age > BLIP_FADE_MS) continue;
      const id = String(blip.key || '');
      if (!id) continue;
      const w = scopeToWorld(blip.sx, blip.sy);
      byId.set(id, {
        id,
        kind: blip.kind || 'contact',
        label: blip.label || blip.kind || id,
        x: w.x,
        y: w.y,
        live: false,
        ageMs: age,
      });
    }
    for (const t of collectTrackableContacts(forwardSign)) {
      if (!illuminatedIds.has(t.id)) continue;
      byId.set(t.id, {
        id: t.id,
        kind: t.kind,
        label: t.label,
        x: t.x,
        y: t.y,
        live: true,
        ageMs: 0,
      });
    }
    return [...byId.values()];
  }

  window.LpRadarScope = {
    isOpen,
    open: openPanel,
    close: closePanel,
    setContacts,
    upsertContact,
    /** 外部接触点副本（供自动化传感器等读取）。 */
    getContacts: () => externalContacts.map((c) => ({ ...c })),
    getIlluminatedContacts,
    getPhosphorContacts,
    getTargetingContacts,
    getBlipFadeMs: () => BLIP_FADE_MS,
    getRange: () => rangeWorld,
    setRange: (v) => {
      setRangeWorld(Number(v) || rangeWorld);
    },
    /** 量程档位表副本（1200 步进至 PPI 上限）。 */
    getRangeGears: () => RANGE_GEARS.slice(),
    /** 锁定扇区有效半径上限（世界像素）。 */
    getLockRangeMax: () => LOCK_RANGE_WORLD_MAX,
    /** 锁定扇区总张角（度）。 */
    getLockBeamWidthDeg: () => LOCK_BEAM_WIDTH_DEG,
    /** 当前锁定角平分线弧度。 */
    getLockAimAngle: () => lockAimAngle,
    /** 小型目标邻域链接距离（世界单位；与集群标一致）。 */
    getMobClusterLinkDist: () => MOB_CLUSTER_LINK,
    /** 计入「集群」的最小成员数（与集群标一致；单只不计）。 */
    getMobClusterMinSize: () => MOB_CLUSTER_MIN,
    /** 射程内小型目标集群数（供自动化传感器；与集群标同规则）。 */
    countSmallTargetClustersInRange,
  };
})();
