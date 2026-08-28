/**
 * 塔莎火箭弹车厢：伸缩装填动画、弹药箱、真空管火控 UI、磷光/照射分级索敌与火箭弹道。
 */
(() => {
  const CAR_ID = 'tasha';
  const AMMO_ID = 'rocket_ammo';
  const STORAGE_KEY = 'lp-tasha-crates-v1';
  const IMG_BASE = '/static/games/liminal-platform/img/cars/tasha-rocket';
  const LAYER_URLS = {
    telescopic: `${IMG_BASE}/tasha-telescopic.png?v=1`,
    launcher: `${IMG_BASE}/tasha-launcher.png?v=1`,
    rocket: `${IMG_BASE}/tasha-rocket.png?v=1`,
  };
  /** 单发火箭离架（Freesound 569563 / smokey9977）。 */
  const LAUNCH_SFX =
    '/static/games/liminal-platform/audio/weapons/tasha-rocket-launch.mp3?v=1';

  /** 装填：下降 / 驻留 / 上升（秒）。 */
  const STOW_DOWN_S = 1.6;
  const STOW_DWELL_S = 1.0;
  const STOW_UP_S = 2.0;
  const RELOAD_TOTAL_S = STOW_DOWN_S + STOW_DWELL_S + STOW_UP_S;
  /**
   * 进站前开始沉架的路线距离（约 2s 巡航；大于 PLATFORM_AHEAD 800，
   * 使发射架在停靠前基本沉入）。
   */
  const PLATFORM_STOW_DIST = 2200;
  /**
   * 下降最大贴图像素偏移：只需沉到舱顶以下，避免落到走道胸高。
   * 舱顶≈620、火箭顶≈502 → 约 180 + 抬高余量。
   */
  const STOW_DROP_ART = 190;
  /** 待发时相对贴图再抬高（源图像素）；默认几乎贴舱顶，抬高后更像车顶架。 */
  const LAUNCHER_RAISE_ART = 48;
  /** 伸缩杆圆头顶（贴图像素；随发射架高度缩放）。 */
  const TELESCOPIC_HEAD_ART_Y = 561;
  /** 发射架俯仰枢轴（贴图像素；伸缩铰链附近）。 */
  const PIVOT_ART_X = 1020;
  const PIVOT_ART_Y = 655;
  /** 炮口（贴图像素；待发姿态）。 */
  const MUZZLE_ART_X = 1125;
  const MUZZLE_ART_Y = 545;
  /** 近距高仰角 / 远距低仰角（Canvas 弧度；负=抬高炮口）。 */
  const ELEV_NEAR_RAD = -0.68;
  const ELEV_FAR_RAD = -0.06;
  const ELEV_DIST_NEAR = 350;
  const ELEV_DIST_FAR = 5200;
  /** 仰角跟踪角速度（弧度/秒）。 */
  const ELEV_SLEW_RAD_S = 2.2;

  const ROCKET_SPEED = 920;
  const ROCKET_AOE = 96;
  const ROCKET_DAMAGE = 48;
  const SAFETY_OPEN_MIN = 0.9;
  /** 磷光目标瞄准散布（世界像素）：随磷光年龄增大。 */
  const STALE_AIM_SPREAD_MIN = 140;
  const STALE_AIM_SPREAD_MAX = 480;

  const Core = window.LpInventoryCore;

  const layers = {
    telescopic: { img: null, ready: false },
    launcher: { img: null, ready: false },
    rocket: { img: null, ready: false },
  };

  const state = {
    /** 'ready' | 'reloading' */
    phase: 'ready',
    /** 0=升起待发，1=完全沉入舱内。 */
    stowT: 0,
    /** 当前仰角（弧度；0=贴图缺省）。 */
    elevRad: 0,
    /** 索敌目标对应的目标仰角。 */
    elevTargetRad: 0,
    reloadElapsed: 0,
    /** 火控面板是否打开（入座）。 */
    fcOpen: false,
    /** @type {string | null} */
    selectedTargetId: null,
    safetyOpen: 0,
    safetyDragging: false,
    safetyPointerId: null,
    safetyStartX: 0,
    safetyStartOpen: 0,
    /** @type {Array<{ x: number, y: number, tx: number, ty: number, targetId: string, liveTrack: boolean }>} */
    rockets: [],
    ammoInv: null,
  };

  let fcRoot = null;
  let fcLampReady = null;
  let fcLampLoad = null;
  let fcSeekList = null;
  let fcFireBtn = null;
  let fcSafety = null;
  let fcSafetyTrack = null;
  let fcAmmoReadout = null;
  let fcStatus = null;
  let fcIrstCanvas = null;
  let fcIrstCtx = null;
  let fcIrstTrack = null;
  let fcIrstMode = null;
  let fcIrstRange = null;
  let seekTimer = 0;
  /** @type {Array<{ id: string, label: string, live: boolean, x: number, y: number, ageMs?: number, sx: number, sy: number, screenX: number, screenY: number, trackNo: number }>} */
  let irstPlotCache = [];
  let irstKeyBound = false;

  /** 读取车厢规格。 */
  function getSpec() {
    return window.LiminalCarriageSpec || null;
  }

  /** 贴图像素 → 世界。 */
  function scaleArt(value) {
    const Spec = getSpec();
    if (typeof Spec?.scaleArt === 'function') return Spec.scaleArt(value);
    return value * (Spec?.WORLD_SCALE || 0.88);
  }

  /** 编组中是否仍有塔莎车。 */
  function hasCarriage() {
    return Boolean(getSpec()?.carriageById?.(CAR_ID));
  }

  /**
   * 火控 IRST 原点（与绘轨雷达同源：绘轨车走道中心 / 编组中点）。
   * @returns {{ x: number, y: number }}
   */
  function irstOrigin() {
    const Spec = getSpec();
    const oy = Spec?.TRACK_Y ?? Spec?.FLOOR_Y ?? 0;
    const scope = Spec?.carriageById?.('huigui');
    if (scope) {
      return {
        x: scope.worldX + (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2,
        y: oy,
      };
    }
    const cars = Spec?.CARRIAGES;
    if (cars?.length) {
      const first = cars[0];
      const last = cars[cars.length - 1];
      return {
        x: (first.worldX + last.worldX + Spec.MODULE_W) / 2,
        y: oy,
      };
    }
    return { x: 0, y: oy };
  }

  /** 列车前进符号（+1 = 世界 +X）。 */
  function irstForwardSign() {
    const speed = window.LpTrainDrive?.getState?.()?.speed;
    if (typeof speed === 'number' && Math.abs(speed) >= 0.08) {
      return speed > 0 ? 1 : -1;
    }
    return 1;
  }

  /**
   * 世界坐标 → IRST 示波器局部（+sx 前进侧，+sy 侧向）。
   * @param {number} wx
   * @param {number} wy
   */
  function worldToIrst(wx, wy) {
    const o = irstOrigin();
    const sign = irstForwardSign();
    const dx = wx - o.x;
    const dy = wy - o.y;
    return { sx: sign * dx, sy: sign * dy };
  }

  /**
   * 示波器局部 → 画布像素（前进朝上）。
   * @param {number} sx
   * @param {number} sy
   * @param {number} cx
   * @param {number} cy
   * @param {number} scale
   */
  function irstToScreen(sx, sy, cx, cy, scale) {
    return { x: cx + sy * scale, y: cy - sx * scale };
  }

  /** 当前 IRST 量程（优先雷达量程，上限锁定扇区半径）。 */
  function irstRangeWorld() {
    const radarR = Number(window.LpRadarScope?.getRange?.());
    const lockMax = Number(window.LpRadarScope?.getLockRangeMax?.()) || 6000;
    if (Number.isFinite(radarR) && radarR > 0) return Math.min(radarR, lockMax);
    return Math.min(4800, lockMax);
  }

  /**
   * 按方位排序构建带轨号的接触表，并写入屏幕坐标缓存。
   * @param {number} cssW
   * @param {number} cssH
   */
  function buildIrstPlots(cssW, cssH) {
    const contacts = window.LpRadarScope?.getTargetingContacts?.() || [];
    const range = irstRangeWorld();
    const cx = cssW / 2;
    const cy = cssH / 2;
    const scale = (Math.min(cssW, cssH) * 0.46) / Math.max(1, range);
    const withScope = contacts.map((c) => {
      const p = worldToIrst(c.x, c.y);
      return { ...c, sx: p.sx, sy: p.sy };
    });
    withScope.sort((a, b) => {
      const ba = Math.atan2(a.sy, a.sx);
      const bb = Math.atan2(b.sy, b.sx);
      if (ba !== bb) return ba - bb;
      return Math.hypot(a.sx, a.sy) - Math.hypot(b.sx, b.sy);
    });
    irstPlotCache = withScope.map((c, i) => {
      const scr = irstToScreen(c.sx, c.sy, cx, cy, scale);
      return {
        id: String(c.id),
        label: c.label || c.kind || String(c.id),
        live: !!c.live,
        x: c.x,
        y: c.y,
        ageMs: c.ageMs || 0,
        sx: c.sx,
        sy: c.sy,
        screenX: scr.x,
        screenY: scr.y,
        trackNo: i + 1,
      };
    });
    return { range, cx, cy, scale };
  }

  /**
   * 绘制 IRST 示波器：量程环、本舰、接触点与选中框。
   */
  function paintIrstScope() {
    if (!fcIrstCanvas || !fcIrstCtx || !state.fcOpen) return;
    const canvas = fcIrstCanvas;
    const ctx = fcIrstCtx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(160, canvas.clientWidth || 280);
    const cssH = Math.max(160, canvas.clientHeight || cssW);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const { range, cx, cy } = buildIrstPlots(cssW, cssH);
    const rMax = Math.min(cssW, cssH) * 0.46;

    ctx.fillStyle = '#020805';
    ctx.beginPath();
    ctx.arc(cx, cy, rMax + 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(80, 180, 100, 0.28)';
    ctx.lineWidth = 1;
    for (const frac of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, rMax * frac, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let i = 0; i < 8; i += 1) {
      const a = (i * Math.PI) / 4 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * rMax, cy + Math.sin(a) * rMax);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(160, 255, 180, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 7, cy);
    ctx.lineTo(cx + 7, cy);
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(180, 255, 200, 0.75)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('OWN', cx, cy + rMax + 12);

    for (const p of irstPlotCache) {
      const dist = Math.hypot(p.sx, p.sy);
      if (dist > range * 1.05) continue;
      const alpha = p.live
        ? 1
        : Math.max(0.28, 1 - (p.ageMs || 0) / (window.LpRadarScope?.getBlipFadeMs?.() || 8000));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.screenX, p.screenY);
      if (p.live) {
        ctx.fillStyle = '#6dff8a';
        ctx.strokeStyle = '#b8ffc8';
        ctx.fillRect(-3.5, -3.5, 7, 7);
        ctx.strokeRect(-3.5, -3.5, 7, 7);
      } else {
        ctx.strokeStyle = '#5a9a68';
        ctx.strokeRect(-4, -4, 8, 8);
      }
      ctx.fillStyle = p.live ? '#c8ffd4' : '#6fa87c';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.trackNo).padStart(2, '0'), 7, 0);
      ctx.restore();

      if (String(state.selectedTargetId) === p.id) {
        drawIrstSelectBox(ctx, p.screenX, p.screenY, p.live);
      }
    }

    updateIrstMeta(range);
  }

  /**
   * 绘制 IRST 选中框（角括号）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {boolean} live
   */
  function drawIrstSelectBox(ctx, x, y, live) {
    const s = 12;
    const g = 4;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = live ? '#ffe08a' : '#9ef0b0';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-s, -s + g);
    ctx.lineTo(-s, -s);
    ctx.lineTo(-s + g, -s);
    ctx.moveTo(s - g, -s);
    ctx.lineTo(s, -s);
    ctx.lineTo(s, -s + g);
    ctx.moveTo(s, s - g);
    ctx.lineTo(s, s);
    ctx.lineTo(s - g, s);
    ctx.moveTo(-s + g, s);
    ctx.lineTo(-s, s);
    ctx.lineTo(-s, s - g);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 刷新 IRST 读数条。
   * @param {number} range
   */
  function updateIrstMeta(range) {
    const sel = irstPlotCache.find((p) => String(p.id) === String(state.selectedTargetId));
    if (fcIrstTrack) {
      fcIrstTrack.textContent = sel
        ? `TGT ${String(sel.trackNo).padStart(2, '0')} · ${sel.label}`
        : `TGT ··· · ${irstPlotCache.length} 接触`;
    }
    if (fcIrstMode) {
      fcIrstMode.textContent = sel
        ? sel.live
          ? '照射锁定'
          : '磷光跟踪'
        : irstPlotCache.length
          ? '待选'
          : '无接触';
    }
    if (fcIrstRange) {
      if (sel) {
        const dist = Math.round(Math.hypot(sel.sx, sel.sy));
        fcIrstRange.textContent = `RNG ${dist}`;
      } else {
        fcIrstRange.textContent = `FOV ${Math.round(range)}`;
      }
    }
  }

  /**
   * 在示波器上点选最近接触。
   * @param {number} clientX
   * @param {number} clientY
   */
  function pickIrstAtClient(clientX, clientY) {
    if (!fcIrstCanvas) return;
    const rect = fcIrstCanvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / Math.max(1, rect.width)) * (fcIrstCanvas.clientWidth || rect.width);
    const y = ((clientY - rect.top) / Math.max(1, rect.height)) * (fcIrstCanvas.clientHeight || rect.height);
    let best = null;
    let bestD = 22;
    for (const p of irstPlotCache) {
      const d = Math.hypot(p.screenX - x, p.screenY - y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return;
    state.selectedTargetId = best.id;
    syncFcUi();
  }

  /**
   * 循环切换目标（delta = ±1）。
   * @param {number} delta
   */
  function cycleIrstTarget(delta) {
    const list = irstPlotCache.length
      ? irstPlotCache
      : (window.LpRadarScope?.getTargetingContacts?.() || []).map((c, i) => ({
          id: String(c.id),
          trackNo: i + 1,
        }));
    if (!list.length) return;
    let idx = list.findIndex((p) => String(p.id) === String(state.selectedTargetId));
    if (idx < 0) idx = delta > 0 ? -1 : 0;
    idx = (idx + delta + list.length) % list.length;
    state.selectedTargetId = list[idx].id;
    syncFcUi();
  }

  /** 绑定 IRST 快捷键（火控打开时 ←/→ / [ / ]）。 */
  function bindIrstKeys() {
    if (irstKeyBound) return;
    irstKeyBound = true;
    window.addEventListener('keydown', (event) => {
      if (!state.fcOpen) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === '[') {
        event.preventDefault();
        cycleIrstTarget(-1);
      } else if (event.key === 'ArrowRight' || event.key === ']') {
        event.preventDefault();
        cycleIrstTarget(1);
      }
    });
  }

  /** 预加载一层贴图。 */
  function loadLayer(key) {
    const slot = layers[key];
    if (!slot || slot.ready) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      slot.img = img;
      slot.ready = img.naturalWidth > 0;
    };
    img.onerror = () => {
      slot.img = null;
      slot.ready = false;
    };
    img.src = LAYER_URLS[key];
  }

  /** 预加载伸缩机 / 发射架 / 火箭弹层。 */
  function preloadLayers() {
    loadLayer('telescopic');
    loadLayer('launcher');
    loadLayer('rocket');
    window.LpSfx?.preload?.([LAUNCH_SFX]);
  }

  /**
   * 在炮口世界坐标播放火箭离架音（同车厢满音量，跨车距离衰减）。
   * @param {number} x
   * @param {number} y
   */
  function playLaunchSfx(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    window.LpSfx?.play?.(LAUNCH_SFX, {
      volume: 0.62,
      rateJitter: 0.04,
      playbackRate: 1,
      x,
      y,
      heavy: false,
    });
  }

  /** 读取或新建火箭弹药箱库存。 */
  function ensureInventory() {
    if (state.ammoInv) return state.ammoInv;
    if (!Core) return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        state.ammoInv = Core.Inventory.fromJSON(parsed.ammo);
        return state.ammoInv;
      } catch (_) {
        /* fall through */
      }
    }
    state.ammoInv = new Core.Inventory('tasha-ammo', 4, 2, [
      { index: 0, stack: { itemId: AMMO_ID, qty: 6 } },
    ]);
    saveCrates();
    return state.ammoInv;
  }

  /** 持久化弹药箱（本机；联机权威后续接入）。 */
  function saveCrates() {
    if (window.LpInventoryNet?.isActive?.()) return;
    ensureInventory();
    if (!state.ammoInv) return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ammo: state.ammoInv.toJSON() })
    );
  }

  /** 弹药箱剩余火箭弹数量。 */
  function ammoCount() {
    ensureInventory();
    return state.ammoInv?.countItem?.(AMMO_ID) ?? 0;
  }

  /** 弹药箱权威库存。 */
  function getAmmoInventory() {
    return ensureInventory();
  }

  /** 从弹药箱消耗火箭弹。 */
  function consumeAmmo(qty = 1) {
    ensureInventory();
    if (!state.ammoInv) return 0;
    if (window.LpItemCatalog?.TEST_AUTO_REFILL_CONSUMABLES) {
      if (ammoCount() < qty) {
        const max = window.LpItemCatalog?.getItem?.(AMMO_ID)?.maxStack || 20;
        state.ammoInv.addItem(AMMO_ID, max);
      }
    }
    const spent = state.ammoInv.removeItem(AMMO_ID, qty);
    if (spent > 0) saveCrates();
    return spent;
  }

  /** 存入火箭弹（背包 → 箱）。 */
  function depositItem(qty) {
    const want = Math.max(0, Math.floor(qty));
    if (want <= 0) return 0;
    ensureInventory();
    const playerInv = window.LpInventory?.getPlayerInventory?.();
    const handsInv = window.LpInventory?.getHandsInventory?.();
    let need = want;
    let moved = 0;
    for (const inv of [playerInv, handsInv]) {
      if (!inv || need <= 0) continue;
      const took = inv.removeItem(AMMO_ID, need);
      if (took <= 0) continue;
      const leftover = state.ammoInv.addItem(AMMO_ID, took);
      const accepted = took - (leftover || 0);
      if (leftover > 0) inv.addItem(AMMO_ID, leftover);
      moved += accepted;
      need -= accepted;
    }
    if (moved > 0) saveCrates();
    return moved;
  }

  /** 取出火箭弹（箱 → 背包）。 */
  function withdrawItem(qty) {
    const want = Math.max(0, Math.floor(qty));
    if (want <= 0) return 0;
    ensureInventory();
    const removed = state.ammoInv.removeItem(AMMO_ID, want);
    if (removed <= 0) return 0;
    const leftover =
      window.LpInventory?.getPlayerInventory?.()?.addItem?.(AMMO_ID, removed) ??
      removed;
    if (leftover > 0) state.ammoInv.addItem(AMMO_ID, leftover);
    saveCrates();
    return removed - (leftover || 0);
  }

  /** 停靠/月台时抑制列车武器。 */
  function isWeaponSuppressed() {
    return Boolean(window.LpGuardTurret?.isTrainWeaponSuppressed?.());
  }

  /**
   * 是否应沉入发射架：已停靠、在月台场景、或路线上即将进站。
   * @returns {boolean}
   */
  function wantsPlatformStow() {
    if (isWeaponSuppressed()) return true;
    const s = window.LpAutoSensors?.getPlatformSensor?.();
    if (!s) return false;
    if (s.atPlatform) return true;
    const d = s.distanceAhead;
    if (d == null || !Number.isFinite(Number(d))) return false;
    return Number(d) >= 0 && Number(d) <= PLATFORM_STOW_DIST;
  }

  /** 是否处于待发（可开火）状态。 */
  function isReady() {
    return state.phase === 'ready' && state.stowT < 0.02;
  }

  /** 火控是否打开。 */
  function isFireControlOpen() {
    return state.fcOpen;
  }

  /** 是否入座火控（同 isFireControlOpen）。 */
  function isManned() {
    return state.fcOpen;
  }

  /** 开始装填循环（发射后）。 */
  function beginReload() {
    state.phase = 'reloading';
    state.reloadElapsed = 0;
    state.stowT = 0;
  }

  /**
   * 按装填时间推进 stowT：先沉入再升起；近站时装填结束后保持沉入。
   * @param {number} dt
   */
  function tickReload(dt) {
    if (state.phase !== 'reloading') return;
    state.reloadElapsed += Math.max(0, dt);
    const t = state.reloadElapsed;
    if (t <= STOW_DOWN_S) {
      state.stowT = t / STOW_DOWN_S;
    } else if (t <= STOW_DOWN_S + STOW_DWELL_S) {
      state.stowT = 1;
    } else if (wantsPlatformStow()) {
      state.stowT = 1;
      state.phase = 'ready';
      state.reloadElapsed = 0;
      syncFcUi();
    } else if (t <= RELOAD_TOTAL_S) {
      const u = (t - STOW_DOWN_S - STOW_DWELL_S) / STOW_UP_S;
      state.stowT = 1 - u;
    } else {
      state.stowT = 0;
      state.phase = 'ready';
      state.reloadElapsed = 0;
      syncFcUi();
    }
  }

  /**
   * 进站沉架 / 离站升架（与装填互斥；装填中不抢 stowT）。
   * @param {number} dt
   */
  function tickPlatformStow(dt) {
    if (state.phase === 'reloading') return;
    const want = wantsPlatformStow() ? 1 : 0;
    if (Math.abs(state.stowT - want) < 0.001) {
      state.stowT = want;
      return;
    }
    const rate = want > state.stowT ? 1 / STOW_DOWN_S : 1 / STOW_UP_S;
    const step = rate * Math.max(0, dt);
    if (state.stowT < want) state.stowT = Math.min(want, state.stowT + step);
    else state.stowT = Math.max(want, state.stowT - step);
  }

  /**
   * 解析当前选中索敌目标（磷光滞后或照射实时）。
   * @returns {{ id: string, x: number, y: number, label?: string, live: boolean, ageMs?: number } | null}
   */
  function resolveSelectedTarget() {
    const list = window.LpRadarScope?.getTargetingContacts?.() || [];
    if (!state.selectedTargetId) return null;
    return list.find((c) => String(c.id) === String(state.selectedTargetId)) || null;
  }

  /**
   * 由目标品质计算瞄准点：照射=精确；磷光=随余晖年龄加散布。
   * @param {{ x: number, y: number, live: boolean, ageMs?: number }} target
   */
  function aimPointForTarget(target) {
    if (target.live) return { x: target.x, y: target.y };
    const fadeMs = window.LpRadarScope?.getBlipFadeMs?.() || 8000;
    const t = Math.min(1, (target.ageMs || 0) / fadeMs);
    const spread = STALE_AIM_SPREAD_MIN + t * (STALE_AIM_SPREAD_MAX - STALE_AIM_SPREAD_MIN);
    const ang = Math.random() * Math.PI * 2;
    return {
      x: target.x + Math.cos(ang) * spread,
      y: target.y + Math.sin(ang) * spread,
    };
  }

  /**
   * 由目标水平距离映射发射仰角：近距高抛、远距平射。
   * @param {number} horizDist 世界像素（仅 +X 前方）
   */
  function elevationFromHorizDist(horizDist) {
    const d = Math.max(ELEV_DIST_NEAR, Math.min(ELEV_DIST_FAR, horizDist));
    const t = (d - ELEV_DIST_NEAR) / (ELEV_DIST_FAR - ELEV_DIST_NEAR);
    return ELEV_NEAR_RAD + t * (ELEV_FAR_RAD - ELEV_NEAR_RAD);
  }

  /** 发射架相对贴图原点的世界 Y 偏移（待发抬高 − 装填/进站下沉）。 */
  function launcherDrawY() {
    return scaleArt(STOW_DROP_ART) * state.stowT - scaleArt(LAUNCHER_RAISE_ART);
  }

  /** 伸缩枢轴世界坐标（与发射架绘制同一 Y 偏移）。 */
  function pivotWorld() {
    const Spec = getSpec();
    const car = Spec?.carriageById?.(CAR_ID);
    if (!car) return null;
    return {
      x: car.worldX + scaleArt(PIVOT_ART_X),
      y: scaleArt(PIVOT_ART_Y) + launcherDrawY(),
    };
  }

  /** 炮口相对枢轴的局部偏移（待发贴图姿态）。 */
  function muzzleLocalFromPivot() {
    return {
      x: scaleArt(MUZZLE_ART_X - PIVOT_ART_X),
      y: scaleArt(MUZZLE_ART_Y - PIVOT_ART_Y),
    };
  }

  /** 将局部偏移绕仰角旋转到世界位移。 */
  function rotateLocalOffset(local, angleRad) {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    return {
      x: local.x * c - local.y * s,
      y: local.x * s + local.y * c,
    };
  }

  /** 发射架炮口世界坐标（含仰角与装填下沉）。 */
  function muzzleWorld() {
    const pivot = pivotWorld();
    if (!pivot) return null;
    const off = rotateLocalOffset(muzzleLocalFromPivot(), state.elevRad);
    return { x: pivot.x + off.x, y: pivot.y + off.y };
  }

  /**
   * 根据火控选中目标更新目标仰角；装填/无目标时回正。
   * @param {number} dt
   */
  function tickElevation(dt) {
    let targetElev = 0;
    if (isReady() && state.fcOpen) {
      const contact = resolveSelectedTarget();
      const pivot = pivotWorld();
      if (contact && pivot && contact.x > pivot.x) {
        targetElev = elevationFromHorizDist(contact.x - pivot.x);
      }
    }
    state.elevTargetRad = targetElev;
    const delta = state.elevTargetRad - state.elevRad;
    const maxStep = ELEV_SLEW_RAD_S * Math.max(0, dt);
    if (Math.abs(delta) <= maxStep) state.elevRad = state.elevTargetRad;
    else state.elevRad += Math.sign(delta) * maxStep;
  }

  /**
   * 尝试开火：需待发、保险拉开、已选目标、有弹药；照射目标可实时跟踪。
   * @returns {boolean}
   */
  function tryFire() {
    if (!hasCarriage()) return false;
    if (isWeaponSuppressed()) {
      window.LiminalInteract?.showToast?.('月台停靠中无法发射');
      return false;
    }
    if (!isReady()) {
      window.LiminalInteract?.showToast?.('正在装填');
      return false;
    }
    if (state.safetyOpen < SAFETY_OPEN_MIN) {
      window.LiminalInteract?.showToast?.('请先滑开保险盖');
      return false;
    }
    const target = resolveSelectedTarget();
    if (!target) {
      window.LiminalInteract?.showToast?.('请选择索敌目标');
      return false;
    }
    if (ammoCount() <= 0) {
      window.LiminalInteract?.showToast?.('弹药箱没有火箭弹');
      return false;
    }
    const muzzle = muzzleWorld();
    if (!muzzle) return false;
    const spent = consumeAmmo(1);
    if (spent <= 0) return false;
    const aim = aimPointForTarget(target);

    state.rockets.push({
      x: muzzle.x,
      y: muzzle.y,
      tx: aim.x,
      ty: aim.y,
      targetId: String(target.id),
      liveTrack: !!target.live,
    });
    playLaunchSfx(muzzle.x, muzzle.y);
    window.LpPressure?.noteTashaRocketFire?.(muzzle.x);
    beginReload();
    setSafetyOpen(0);
    syncFcUi();
    const tag = target.live ? '照射锁定' : '磷光';
    window.LiminalInteract?.showToast?.(`发射 → ${target.label || '目标'}（${tag}）`);
    return true;
  }

  /**
   * 火箭弹命中：对范围内小怪造成伤害并播尘土。
   * @param {number} x
   * @param {number} y
   */
  function explodeAt(x, y) {
    window.LpImpactFx?.spawnDust?.(x, y, {
      surface: 'ground',
      scale: 2.2,
    });
    const mobs = window.LpMobs?.listHostiles?.() || [];
    const r2 = ROCKET_AOE * ROCKET_AOE;
    for (const m of mobs) {
      const dx = m.x - x;
      const dy = m.y - y;
      if (dx * dx + dy * dy > r2) continue;
      window.LpMobs?.damageMob?.(m.id, ROCKET_DAMAGE);
    }
  }

  /**
   * 推进在途火箭。
   * @param {number} dt
   */
  function tickRockets(dt) {
    if (!state.rockets.length) return;
    const liveTargets = window.LpRadarScope?.getTargetingContacts?.() || [];
    const next = [];
    for (const r of state.rockets) {
      if (r.liveTrack && r.targetId) {
        const live = liveTargets.find(
          (c) => String(c.id) === String(r.targetId) && c.live
        );
        if (live) {
          r.tx = live.x;
          r.ty = live.y;
        } else {
          r.liveTrack = false;
        }
      }
      const dx = r.tx - r.x;
      const dy = r.ty - r.y;
      const dist = Math.hypot(dx, dy);
      const step = ROCKET_SPEED * dt;
      if (dist <= step || dist < 4) {
        explodeAt(r.tx, r.ty);
        continue;
      }
      r.x += (dx / dist) * step;
      r.y += (dy / dist) * step;
      next.push(r);
    }
    state.rockets = next;
  }

  /** 打开火控台面板。 */
  function openFireControl() {
    if (!hasCarriage()) return false;
    if (window.LpGuardTurret?.isManned?.()) {
      window.LpGuardTurret.exitTurret();
    }
    if (window.LpGuardCrateUi?.isOpen?.()) window.LpGuardCrateUi.close();
    if (window.LpInventory?.isOpen?.()) window.LpInventory.close();
    if (window.LpBoilerPanel?.isOpen?.()) window.LpBoilerPanel.close();
    if (window.LpFuelFeed?.isOpen?.()) window.LpFuelFeed.close();
    if (window.LpAutoConsole?.isOpen?.()) window.LpAutoConsole.close();
    ensureFcDom();
    state.fcOpen = true;
    setSafetyOpen(0);
    if (fcRoot) {
      fcRoot.hidden = false;
      fcRoot.setAttribute('aria-hidden', 'false');
    }
    document.body.classList.add('lp-tasha-fc-open');
    window.LpTouchControls?.setEnabled?.(false);
    window.LpArmedAmmo?.activate?.(CAR_ID);
    syncFcUi();
    return true;
  }

  /** 关闭火控台。 */
  function closeFireControl() {
    if (!state.fcOpen) return false;
    state.fcOpen = false;
    state.safetyDragging = false;
    setSafetyOpen(0);
    if (fcRoot) {
      fcRoot.hidden = true;
      fcRoot.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('lp-tasha-fc-open');
    window.LpTouchControls?.setEnabled?.(true);
    window.LpArmedAmmo?.deactivate?.();
    return true;
  }

  /** 弹药箱 F：打开存取面板。 */
  function interactAmmo() {
    if (state.fcOpen) {
      closeFireControl();
      return true;
    }
    if (window.LpGuardCrateUi?.isOpen?.() && window.LpGuardCrateUi.getMode?.() === 'tasha') {
      window.LpGuardCrateUi.close();
      return true;
    }
    window.LpGuardCrateUi?.openTasha?.();
    return true;
  }

  /** 设置保险盖开度 0–1。 */
  function setSafetyOpen(v) {
    state.safetyOpen = Math.max(0, Math.min(1, Number(v) || 0));
    if (fcSafety) {
      fcSafety.style.transform = `translateX(${state.safetyOpen * 100}%)`;
    }
    if (fcFireBtn) {
      const can =
        state.safetyOpen >= SAFETY_OPEN_MIN &&
        isReady() &&
        Boolean(resolveSelectedTarget()) &&
        ammoCount() > 0 &&
        !isWeaponSuppressed();
      fcFireBtn.disabled = !can;
      fcFireBtn.classList.toggle('is-armed', can);
    }
  }

  /** 确保火控 DOM 引用与指针绑定。 */
  function ensureFcDom() {
    if (fcRoot) return;
    fcRoot = document.getElementById('lpTashaFcRoot');
    if (!fcRoot) return;
    fcLampReady = document.getElementById('lpTashaFcLampReady');
    fcLampLoad = document.getElementById('lpTashaFcLampLoad');
    fcSeekList = document.getElementById('lpTashaFcSeekList');
    fcFireBtn = document.getElementById('lpTashaFcFire');
    fcSafety = document.getElementById('lpTashaFcSafety');
    fcSafetyTrack = document.getElementById('lpTashaFcSafetyTrack');
    fcAmmoReadout = document.getElementById('lpTashaFcAmmo');
    fcStatus = document.getElementById('lpTashaFcStatus');
    fcIrstCanvas = document.getElementById('lpTashaFcIrst');
    fcIrstCtx = fcIrstCanvas?.getContext?.('2d') || null;
    fcIrstTrack = document.getElementById('lpTashaFcIrstTrack');
    fcIrstMode = document.getElementById('lpTashaFcIrstMode');
    fcIrstRange = document.getElementById('lpTashaFcIrstRange');

    document.getElementById('lpTashaFcClose')?.addEventListener('click', () => {
      closeFireControl();
    });
    fcRoot.querySelector('.lp-tasha-fc-backdrop')?.addEventListener('click', () => {
      closeFireControl();
    });
    fcFireBtn?.addEventListener('click', (ev) => {
      ev.preventDefault();
      tryFire();
    });
    document.getElementById('lpTashaFcIrstPrev')?.addEventListener('click', () => {
      cycleIrstTarget(-1);
    });
    document.getElementById('lpTashaFcIrstNext')?.addEventListener('click', () => {
      cycleIrstTarget(1);
    });
    fcIrstCanvas?.addEventListener('pointerdown', (event) => {
      if (!state.fcOpen) return;
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      pickIrstAtClient(event.clientX, event.clientY);
    });
    bindIrstKeys();

    const onSafetyDown = (event) => {
      if (!state.fcOpen || !fcSafetyTrack) return;
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      state.safetyDragging = true;
      state.safetyPointerId = event.pointerId;
      state.safetyStartX = event.clientX;
      state.safetyStartOpen = state.safetyOpen;
      fcSafetyTrack.setPointerCapture?.(event.pointerId);
    };
    const onSafetyMove = (event) => {
      if (!state.safetyDragging || event.pointerId !== state.safetyPointerId) return;
      const w = fcSafetyTrack?.clientWidth || 120;
      const dx = event.clientX - state.safetyStartX;
      setSafetyOpen(state.safetyStartOpen + dx / Math.max(40, w * 0.85));
    };
    const onSafetyUp = (event) => {
      if (event.pointerId !== state.safetyPointerId) return;
      state.safetyDragging = false;
      state.safetyPointerId = null;
      if (state.safetyOpen < SAFETY_OPEN_MIN) setSafetyOpen(0);
      else setSafetyOpen(1);
    };
    fcSafetyTrack?.addEventListener('pointerdown', onSafetyDown);
    fcSafetyTrack?.addEventListener('pointermove', onSafetyMove);
    fcSafetyTrack?.addEventListener('pointerup', onSafetyUp);
    fcSafetyTrack?.addEventListener('pointercancel', onSafetyUp);
  }

  /** 刷新火控灯号 / 索敌列表 / 读数。 */
  function syncFcUi() {
    ensureFcDom();
    if (!state.fcOpen) return;
    const ready = isReady();
    const loading = state.phase === 'reloading';
    fcLampReady?.classList.toggle('is-on', ready);
    fcLampLoad?.classList.toggle('is-on', loading);
    fcLampLoad?.classList.toggle('is-blink', loading);
    if (fcAmmoReadout) fcAmmoReadout.textContent = String(ammoCount());
    if (fcStatus) {
      const target = resolveSelectedTarget();
      if (isWeaponSuppressed()) fcStatus.textContent = '月台抑制';
      else if (wantsPlatformStow() && state.stowT > 0.15) fcStatus.textContent = '进站沉架';
      else if (loading) fcStatus.textContent = '正在装填';
      else if (ammoCount() <= 0) fcStatus.textContent = '无弹';
      else if (!target) fcStatus.textContent = '选择目标';
      else if (target.live) fcStatus.textContent = '照射锁定';
      else fcStatus.textContent = '磷光跟踪';
    }
    renderSeekList();
    paintIrstScope();
    setSafetyOpen(state.safetyOpen);
  }

  /** 渲染索敌列表（与 IRST 轨号同步）。 */
  function renderSeekList() {
    if (!fcSeekList) return;
    const contacts = window.LpRadarScope?.getTargetingContacts?.() || [];
    if (
      state.selectedTargetId &&
      !contacts.some((c) => String(c.id) === String(state.selectedTargetId))
    ) {
      state.selectedTargetId = null;
    }
    /* 先绘一次以生成轨号缓存（列表依赖 trackNo） */
    if (fcIrstCanvas) {
      const cssW = Math.max(160, fcIrstCanvas.clientWidth || 280);
      const cssH = Math.max(160, fcIrstCanvas.clientHeight || cssW);
      buildIrstPlots(cssW, cssH);
    }
    const byId = new Map(irstPlotCache.map((p) => [p.id, p]));
    const frag = document.createDocumentFragment();
    const rows = irstPlotCache.length
      ? irstPlotCache
      : contacts.map((c, i) => ({
          id: String(c.id),
          label: c.label || c.kind || String(c.id),
          live: !!c.live,
          trackNo: i + 1,
        }));
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'lp-tasha-fc-seek-empty';
      empty.textContent = window.LpRadarScope?.isOpen?.()
        ? '扫描中…将锁定扇区对准目标可实时跟踪'
        : '请打开绘轨雷达扫描，或由队友持续照射目标';
      frag.appendChild(empty);
    } else {
      for (const row of rows) {
        const plot = byId.get(String(row.id)) || row;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lp-tasha-fc-seek-row';
        btn.classList.toggle('is-illuminated', plot.live);
        btn.classList.toggle('is-stale', !plot.live);
        btn.classList.toggle(
          'is-selected',
          String(state.selectedTargetId) === String(plot.id)
        );
        btn.innerHTML =
          `<span class="lp-tasha-fc-seek-lamp" aria-hidden="true"></span>` +
          `<span class="lp-tasha-fc-seek-label">${String(plot.trackNo).padStart(2, '0')} ${plot.label}</span>` +
          `<span class="lp-tasha-fc-seek-tag">${
            plot.live ? '照射中' : '磷光'
          }</span>`;
        btn.addEventListener('click', () => {
          state.selectedTargetId = String(plot.id);
          syncFcUi();
        });
        frag.appendChild(btn);
      }
    }
    fcSeekList.replaceChildren(frag);
  }

  /**
   * 每帧：装填动画、火箭弹道、火控索敌刷新。
   * @param {number} dt
   */
  function tick(dt) {
    if (!hasCarriage()) {
      if (state.fcOpen) closeFireControl();
      return;
    }
    tickReload(dt);
    tickPlatformStow(dt);
    tickElevation(dt);
    tickRockets(dt);
    if (state.fcOpen) {
      paintIrstScope();
      seekTimer += dt;
      if (seekTimer >= 0.2) {
        seekTimer = 0;
        syncFcUi();
      }
    }
  }

  /**
   * 绘制升降杆：底座锁在舱内地板，顶端跟着发射架，只伸缩不穿底盘。
   * 不随仰角旋转（桅杆保持竖直）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ worldX: number }} car
   * @param {{ MODULE_W: number, MODULE_H: number, FLOOR_Y: number }} Spec
   * @param {number} launcherYOff
   */
  function drawTelescopicMast(ctx, car, Spec, launcherYOff) {
    const slot = layers.telescopic;
    if (!slot?.ready || !slot.img) return;
    const floorY = Spec.FLOOR_Y;
    const naturalHeadY = scaleArt(TELESCOPIC_HEAD_ART_Y);
    const naturalLen = floorY - naturalHeadY;
    if (naturalLen <= 1) return;
    const targetHeadY = naturalHeadY + launcherYOff;
    const targetLen = Math.max(scaleArt(48), floorY - targetHeadY);
    const sy = targetLen / naturalLen;
    ctx.save();
    ctx.beginPath();
    ctx.rect(car.worldX, 0, Spec.MODULE_W, floorY);
    ctx.clip();
    ctx.translate(0, floorY);
    ctx.scale(1, sy);
    ctx.drawImage(
      slot.img,
      car.worldX,
      -floorY,
      Spec.MODULE_W,
      Spec.MODULE_H
    );
    ctx.restore();
  }

  /**
   * 绘制伸缩机 / 发射架 / 在轨火箭与在途弹。
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    if (!hasCarriage()) return;
    const Spec = getSpec();
    const car = Spec?.carriageById?.(CAR_ID);
    if (!car || !Spec) return;
    const yOff = launcherDrawY();
    const carIndex = Spec.CARRIAGES.findIndex((c) => c.id === CAR_ID);
    const pivot = pivotWorld();

    const paintLayers = () => {
      const drawImg = (slot, angleRad = 0) => {
        if (!slot?.ready || !slot.img || !pivot) return;
        ctx.save();
        ctx.translate(pivot.x, pivot.y);
        ctx.rotate(angleRad);
        ctx.translate(-pivot.x, -pivot.y);
        ctx.drawImage(
          slot.img,
          car.worldX,
          yOff,
          Spec.MODULE_W,
          Spec.MODULE_H
        );
        ctx.restore();
      };
      drawTelescopicMast(ctx, car, Spec, yOff);
      drawImg(layers.launcher, state.elevRad);
      /* 装填中弹药已消耗不画弹；进站沉架时仍随架下沉显示待发弹 */
      if (state.phase === 'ready' && ammoCount() > 0) {
        drawImg(layers.rocket, state.elevRad);
      }
    };

    if (window.LpCarriageBob?.withCarDraw && carIndex >= 0) {
      window.LpCarriageBob.withCarDraw(ctx, car, carIndex, paintLayers);
    } else {
      paintLayers();
    }

    for (const r of state.rockets) {
      const ang = Math.atan2(r.ty - r.y, r.tx - r.x);
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.rotate(ang);
      if (layers.rocket.ready && layers.rocket.img) {
        /* 源图全幅 2250；火箭本体约 (580,502)–(1346,589) */
        const sx = 580;
        const sy = 502;
        const sw = 1346 - 580;
        const sh = 589 - 502;
        const dw = scaleArt(sw) * 0.55;
        const dh = scaleArt(sh) * 0.55;
        ctx.drawImage(layers.rocket.img, sx, sy, sw, sh, -dw * 0.2, -dh * 0.5, dw, dh);
      } else {
        ctx.fillStyle = '#e7e5e4';
        ctx.fillRect(-18, -4, 36, 8);
        ctx.fillStyle = '#b91c1c';
        ctx.beginPath();
        ctx.moveTo(18, 0);
        ctx.lineTo(28, -5);
        ctx.lineTo(28, 5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  preloadLayers();
  ensureInventory();
  ensureFcDom();

  window.LpTashaRocket = {
    tick,
    draw,
    isManned,
    isFireControlOpen,
    openFireControl,
    closeFireControl,
    close: closeFireControl,
    isOpen: isFireControlOpen,
    interactAmmo,
    ammoCount,
    getAmmoInventory,
    depositItem,
    withdrawItem,
    tryFire,
    isReady,
    saveCrates,
  };
})();
