/**
 * 阈限月台：两节车厢顶板横版走动；角色复用 Avatar 皮套与程序化动作。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;
  const Entity = window.AvatarEntity;
  const canvas = document.getElementById('lpCanvas');
  const ctx = canvas.getContext('2d');

  const userId = document.body.dataset.userId || '';
  const nickname = document.body.dataset.nickname || '旅人';

  const JUMP_SPEED = 520;
  const GRAVITY = 1400;
  const MOVE_SPEED = Entity.MOVE_SPEED;
  const RUN_SPEED = Entity.RUN_SPEED || Entity.MOVE_SPEED * 1.6;
  const HALF_W = (Entity.AVATAR_COLLISION_WIDTH * Entity.AVATAR_DRAW_SCALE) / 2;

  const platforms = Spec.buildWalkPlatforms();
  let worldLeft = platforms[0].left + HALF_W;
  let worldRight = platforms[platforms.length - 1].right - HALF_W;

  /** 编组变更后重算走道边界。 */
  function refreshWalkBounds() {
    const next = Spec.buildWalkPlatforms();
    if (!next?.length) return;
    platforms.length = 0;
    for (const p of next) platforms.push(p);
    worldLeft = platforms[0].left + HALF_W;
    worldRight = platforms[platforms.length - 1].right - HALF_W;
  }

  const local = {
    x: Spec.defaultSpawnX(),
    y: 0,
    vx: 0,
    vy: 0,
    onGround: true,
    kneel: 0,
  };

  /** 本地生命与受击硬直（小怪触碰）；联机权威伤害为后续项。 */
  const PLAYER_MAX_HP = 100;
  let playerHp = PLAYER_MAX_HP;
  let hitStunT = 0;
  let hitInvulnT = 0;

  const avatar = Entity.createAvatarEntity({
    id: userId,
    nickname,
    x: local.x,
    y: Spec.FLOOR_Y,
  });

  const keys = new Set();
  const carImages = new Map();
  let viewW = 0;
  let viewH = 0;
  let dpr = 1;
  let baseZoom = 1;
  let zoom = 1;
  /** 加燃料模式镜头倍率（平滑插值到 1.7）。 */
  let feedZoomMul = 1;
  let lastTs = 0;
  let loopStarted = false;
  /** 电脑端窗口是否聚焦；失焦时暂停主循环以省 CPU/GPU。 */
  let windowFocused =
    typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  /** 是否已排队下一帧（rAF），避免 focus 唤醒与尾调度叠帧。 */
  let frameScheduled = false;
  /** 当前 rAF 句柄；失焦时取消以免再跑一帧重负载。 */
  let frameRafId = 0;

  /** 电脑端准星（屏幕坐标）与平滑镜头焦点（世界坐标）。 */
  const pointer = { x: 0, y: 0, known: false };
  const camFocus = { x: local.x, y: Spec.FLOOR_Y };
  const LOOK_WEIGHT = 0.58;
  const LOOK_WEIGHT_Y = 0.36;
  /**
   * 列车准星竖直牵引：向下（轨下）压缩、向上（车顶）略放大，
   * 再经 clampLookLead 非对称钳制。
   */
  const LOOK_DOWN_COMPRESS = 0.32;
  const LOOK_UP_BOOST = 1.12;
  /** 列车构图：地板落在屏幕的比例（越大越靠下 → 轨下更少、车顶更多）。 */
  const TRAIN_FLOOR_SCREEN_Y = 0.7;
  const TRAIN_FLOOR_SCREEN_Y_COARSE = 0.66;
  const CAM_SMOOTH = 9;
  /**
   * 传送级硬对齐阈值（世界距离）。须大于地牢 FLOOR_GAP≈794，
   * 否则爬楼/换层会触发硬切产生顿挫。
   */
  const CAM_SNAP_DIST = 1500;
  /** 月台/地牢竖直焦点相对脚底上抬（世界 px），让躯干更近屏中。 */
  const PLAT_CAM_BODY_LIFT = 56;
  /** |ΔY| 超过此值时加快竖直追焦，减少楼梯间镜头滞后露虚空。 */
  const PLAT_CAM_Y_CATCHUP = 72;
  const crosshairEl = document.getElementById('lpCrosshair');
  const crosshairAltEl = document.getElementById('lpCrosshairAlt');

  const coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)');

  /** 读取触控输入（移动端；无模块时回退并带上自动奔跑偏好）。 */
  function readTouchInput() {
    return (
      window.LpTouchControls?.read() || {
        direction: 0,
        jump: false,
        kneel: false,
        interact: false,
        fire: false,
        sprintToggle: Boolean(window.LpInputBindings?.getAutoRun?.()),
        look: { x: 0, y: 0, mag: 0, active: false, ready: false },
      }
    );
  }

  /** 交互键显示文案。 */
  function formatInteractKey() {
    const label = window.LpInputBindings?.formatAction('interact') || 'F';
    return label.split(' / ')[0];
  }

  /** 物品栏键显示文案。 */
  function formatInventoryKey() {
    const label = window.LpInputBindings?.formatAction('inventory') || 'Tab';
    return label.split(' / ')[0];
  }

  /** 是否有全屏 UI（物品栏 / 列车·地牢地图 / 锅炉 / 加燃料 / 弹药箱 / 雷达 / 塔莎火控 / 枢机 / 设施编辑 / 月台编组）。 */
  function isUiOpen() {
    return (
      (window.LpInventory?.isOpen() ?? false) ||
      (window.LpTrainMap?.isOpen() ?? false) ||
      (window.LpDungeonMap?.isOpen?.() ?? false) ||
      (window.LpBoilerPanel?.isOpen() ?? false) ||
      (window.LpFuelFeed?.isOpen?.() ?? false) ||
      (window.LpGuardCrateUi?.isOpen?.() ?? false) ||
      (window.LpRadarScope?.isOpen?.() ?? false) ||
      (window.LpTashaRocket?.isFireControlOpen?.() ?? false) ||
      (window.LpAutoConsole?.isOpen?.() ?? false) ||
      (window.LpFacilityEdit?.isOpen?.() ?? false) ||
      (window.LpPlatform?.isEditOpen?.() ?? false)
    );
  }

  /** 物品栏是否打开。 */
  function isInventoryOpen() {
    return window.LpInventory?.isOpen() ?? false;
  }

  /** 是否触屏设备布局。 */
  function isCoarsePointer() {
    return coarsePointer.matches;
  }

  /** 是否处于准星镜头模式（桌面鼠标 / 移动端瞄准摇杆）。 */
  function isAimCameraMode() {
    return !isUiOpen();
  }

  let desktopFireHeld = false;

  /** 同步准星显示与系统光标（双联时另跟对角线 2 号准星）。 */
  function syncAimCursor() {
    const aim = isAimCameraMode() && pointer.known;
    const turret = window.LpGuardTurret?.isManned?.() ?? false;
    const dual = Boolean(turret && window.LpGuardTurret?.isSoloDual?.());
    document.body.classList.toggle('lp-aim-mode', !isCoarsePointer() && !isUiOpen());
    document.body.classList.toggle('lp-turret-mode', turret);
    if (!crosshairEl) return;
    crosshairEl.hidden = !aim;
    if (aim) {
      crosshairEl.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
      window.LpCombat?.syncCrosshairBloom?.();
    }
    if (crosshairAltEl) {
      const showAlt = aim && dual;
      crosshairAltEl.hidden = !showAlt;
      if (showAlt) {
        crosshairAltEl.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
      }
    }
  }

  /** 屏幕坐标 → 世界坐标（基于当前相机）。 */
  function screenToWorld(screenX, screenY, view) {
    return {
      x: (screenX - view.offsetX) / view.zoom,
      y: (screenY - view.offsetY) / view.zoom,
    };
  }

  /** 世界坐标 → 屏幕坐标。 */
  function worldToScreen(worldX, worldY, view) {
    return {
      x: worldX * view.zoom + view.offsetX,
      y: worldY * view.zoom + view.offsetY,
    };
  }

  /** 移动端准星硬吸附半径（屏幕 px）；摇杆作方向偏置选目标，非精确自由瞄。 */
  const TOUCH_AIM_SNAP_RADIUS_PX = 168;
  /** 无锥内目标时的半球兜底半径（相对玩家屏幕点）。 */
  const TOUCH_AIM_FALLBACK_RADIUS_PX = 280;
  /** 摇杆锥半角余弦（约 ±58°）；锥内优先。 */
  const TOUCH_AIM_CONE_COS = 0.53;
  /** 锥外候选加分惩罚（越大越不愿选锥外）。 */
  const TOUCH_AIM_OUT_OF_CONE_PENALTY = 220;
  /** 粘滞切换余量：挑战者须明显更优才换目标。 */
  const TOUCH_AIM_STICKY_MARGIN = 48;
  /** 首次吸附 / 换目标时准星追上目标的速率（1/s）。 */
  const TOUCH_AIM_SNAP_LERP = 16;
  /** 已粘滞时准星跟随目标的速率（1/s）。 */
  const TOUCH_AIM_TRACK_LERP = 24;
  /** 松手后准星回到自由瞄点的速率（1/s）。 */
  const TOUCH_AIM_RELEASE_LERP = 12;
  /** 友方吸附用的胸口相对脚底偏移（与医疗箱瞄准一致）。 */
  const TOUCH_AIM_ALLY_CHEST_DY = 56;
  /** 友方缺 radius 时的世界半径占位。 */
  const TOUCH_AIM_ALLY_RADIUS = 28;

  /** @type {string|number|null} 当前粘滞目标 id（仅触控瞄准路径）。 */
  let touchAimSnapId = null;
  /** @type {'enemy'|'ally'|'any'|'none'|null} 粘滞建立时的目标类；换持物不兼容则清。 */
  let touchAimSnapClass = null;
  /** @type {{ x: number, y: number }|null} 平滑后的准星屏幕坐标。 */
  let touchAimSmoothed = null;

  /**
   * 将准星平滑移向目标点（指数逼近，避免硬跳）。
   * @param {number} tx
   * @param {number} ty
   * @param {number} rate 速率 1/s
   * @param {number} dt
   * @returns {{ x: number, y: number }}
   */
  function lerpTouchAimPointer(tx, ty, rate, dt) {
    if (!touchAimSmoothed) {
      touchAimSmoothed = { x: tx, y: ty };
      return touchAimSmoothed;
    }
    const k = 1 - Math.exp(-Math.max(0, rate) * Math.max(0, dt));
    touchAimSmoothed.x += (tx - touchAimSmoothed.x) * k;
    touchAimSmoothed.y += (ty - touchAimSmoothed.y) * k;
    return touchAimSmoothed;
  }

  /**
   * 解析当前手持物对应的准星吸附目标类（医疗→友方、武器→敌方等）。
   * @returns {'enemy'|'ally'|'any'|'none'}
   */
  function resolveTouchAimTargetClass() {
    const Catalog = window.LpItemCatalog;
    let item = null;
    if (window.LpMedkit?.isHoldingMedkit?.()) {
      item =
        window.LpMedkit.getHeldFirstAidSlot?.()?.item ||
        window.LpMedkit.getHeldMedkitSlot?.()?.item ||
        Catalog?.getItem?.('medkit') ||
        null;
    } else if (window.LpFireExtinguisher?.isHolding?.()) {
      item = Catalog?.getItem?.('fire_extinguisher') || null;
    } else {
      item =
        window.LpCombat?.getHeldVisibleItem?.() ||
        window.LpCombat?.getHeldWeaponItem?.() ||
        null;
    }
    if (Catalog?.getAimTargetClass) return Catalog.getAimTargetClass(item);
    if (window.LpMedkit?.isHoldingMedkit?.()) return 'ally';
    if (window.LpFireExtinguisher?.isHolding?.()) return 'none';
    return 'enemy';
  }

  /**
   * 收集敌方实体（世界坐标 + 半径），供触控吸附。
   * @returns {Array<{ id: string|number, x: number, y: number, radius: number }>}
   */
  function listTouchAimHostiles() {
    const hostiles =
      window.LpMobs?.listHostiles?.() ||
      window.LpCombat?.listHostiles?.() ||
      [];
    const out = [];
    for (let i = 0; i < hostiles.length; i += 1) {
      const h = hostiles[i];
      if (h?.id == null) continue;
      const wx = Number(h.x);
      const wy = Number(h.y);
      if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;
      out.push({
        id: h.id,
        x: wx,
        y: wy,
        radius: Math.max(0, Number(h.radius) || 0),
      });
    }
    return out;
  }

  /**
   * 收集联机友方（胸口点），供医疗类吸附；跳过断线与已死亡。
   * @returns {Array<{ id: string|number, x: number, y: number, radius: number }>}
   */
  function listTouchAimAllies() {
    const out = [];
    const remoteMap = window.LiminalSession?.remotes?.();
    if (!remoteMap || typeof remoteMap.values !== 'function') return out;
    for (const remote of remoteMap.values()) {
      if (!remote || remote._lpDisconnected) continue;
      if (remote._lpLifeState === 'dead') continue;
      const id = remote.id;
      if (id == null || id === '') continue;
      const wx = Number(remote.x);
      const ry = Number(
        remote.y != null ? remote.y : remote._physicsY != null ? remote._physicsY : NaN
      );
      if (!Number.isFinite(wx) || !Number.isFinite(ry)) continue;
      out.push({
        id,
        x: wx,
        y: ry - TOUCH_AIM_ALLY_CHEST_DY,
        radius: TOUCH_AIM_ALLY_RADIUS,
      });
    }
    return out;
  }

  /**
   * 按手持物亲和性列出可吸附实体（enemy / ally / any / none）。
   * @param {'enemy'|'ally'|'any'|'none'} affinity
   * @returns {Array<{ id: string|number, x: number, y: number, radius: number }>}
   */
  function listTouchAimEntities(affinity) {
    if (affinity === 'none') return [];
    if (affinity === 'ally') return listTouchAimAllies();
    if (affinity === 'enemy') return listTouchAimHostiles();
    return listTouchAimHostiles().concat(listTouchAimAllies());
  }

  /**
   * 在当前亲和性实体列表中按 id 取屏幕坐标；不可见或不兼容则 null。
   * @param {string|number|null} id
   * @param {{ zoom: number, offsetX: number, offsetY: number }} view
   * @param {'enemy'|'ally'|'any'|'none'} affinity
   * @returns {{ x: number, y: number }|null}
   */
  function touchAimScreenOfId(id, view, affinity) {
    if (id == null || affinity === 'none') return null;
    const want = String(id);
    const entities = listTouchAimEntities(affinity);
    for (let i = 0; i < entities.length; i += 1) {
      const e = entities[i];
      if (e?.id == null || String(e.id) !== want) continue;
      const scr = worldToScreen(e.x, e.y, view);
      if (
        scr.x < -64 ||
        scr.x > viewW + 64 ||
        scr.y < -64 ||
        scr.y > viewH + 64
      ) {
        return null;
      }
      return { x: scr.x, y: scr.y };
    }
    return null;
  }

  /**
   * 换持物导致目标类变化，或粘滞目标已不在合法列表时，清除粘滞。
   * @param {'enemy'|'ally'|'any'|'none'} affinity
   */
  function clearTouchAimStickyIfInvalid(affinity) {
    if (touchAimSnapClass != null && touchAimSnapClass !== affinity) {
      touchAimSnapId = null;
      touchAimSnapClass = null;
      return;
    }
    if (touchAimSnapId == null) {
      touchAimSnapClass = null;
      return;
    }
    if (affinity === 'none') {
      touchAimSnapId = null;
      touchAimSnapClass = null;
      return;
    }
    const stillValid = listTouchAimEntities(affinity).some(
      (e) => e?.id != null && String(e.id) === String(touchAimSnapId)
    );
    if (!stillValid) {
      touchAimSnapId = null;
      touchAimSnapClass = null;
    }
  }

  /**
   * 移动端目标选择器：摇杆锥偏置 + 按手持物过滤敌/友；硬吸附并粘滞跟随。
   * 无合法目标时自由瞄。按住选目标；松手仍跟上次合法目标。桌面不调用。
   * @param {number} rawX 摇杆换算的自由瞄屏幕 X
   * @param {number} rawY 摇杆换算的自由瞄屏幕 Y
   * @param {{ zoom: number, offsetX: number, offsetY: number }} view
   * @param {{ x?: number, y?: number, mag?: number, active?: boolean, ready?: boolean }} look
   * @param {{ x: number, y: number }} originScreen 玩家瞄准锚点屏幕坐标
   * @param {number} dt
   * @returns {{ x: number, y: number }}
   */
  function applyTouchAimSnap(rawX, rawY, view, look, originScreen, dt) {
    const affinity = resolveTouchAimTargetClass();
    clearTouchAimStickyIfInvalid(affinity);

    const stickActive = Boolean(look?.active);

    /* 松手：继续跟随上次吸附目标，方便另一拇指开火；目标失效则回自由瞄。 */
    if (!stickActive) {
      const stickyScr = touchAimScreenOfId(touchAimSnapId, view, affinity);
      if (stickyScr) {
        return lerpTouchAimPointer(stickyScr.x, stickyScr.y, TOUCH_AIM_TRACK_LERP, dt);
      }
      touchAimSnapId = null;
      touchAimSnapClass = null;
      return lerpTouchAimPointer(rawX, rawY, TOUCH_AIM_RELEASE_LERP, dt);
    }

    if (affinity === 'none') {
      touchAimSnapId = null;
      touchAimSnapClass = null;
      return lerpTouchAimPointer(rawX, rawY, TOUCH_AIM_RELEASE_LERP, dt);
    }

    const entities = listTouchAimEntities(affinity);
    const lx = Number(look?.x) || 0;
    const ly = Number(look?.y) || 0;
    const stickLen = Math.hypot(lx, ly);
    const hasStickDir = Boolean(look?.ready) && stickLen > 0.01;
    const stickDx = hasStickDir ? lx / stickLen : 0;
    const stickDy = hasStickDir ? ly / stickLen : 0;
    const facingDx = avatar.facing >= 0 ? 1 : -1;
    const biasDx = hasStickDir ? stickDx : facingDx;
    const biasDy = hasStickDir ? stickDy : 0;

    /** @type {Array<{ id: string|number, scrX: number, scrY: number, distRaw: number, inCone: boolean, score: number }>} */
    const candidates = [];
    for (let i = 0; i < entities.length; i += 1) {
      const e = entities[i];
      const scr = worldToScreen(e.x, e.y, view);
      if (
        scr.x < -64 ||
        scr.x > viewW + 64 ||
        scr.y < -64 ||
        scr.y > viewH + 64
      ) {
        continue;
      }
      const mobScreenR = Math.max(0, Number(e.radius) || 0) * view.zoom;
      const snapR = TOUCH_AIM_SNAP_RADIUS_PX + mobScreenR * 0.55;
      const distRaw = Math.hypot(rawX - scr.x, rawY - scr.y);
      const distOrigin = Math.hypot(originScreen.x - scr.x, originScreen.y - scr.y);
      const toOx = scr.x - originScreen.x;
      const toOy = scr.y - originScreen.y;
      const toLen = Math.hypot(toOx, toOy) || 1;
      const coneDot = (toOx / toLen) * biasDx + (toOy / toLen) * biasDy;
      const inCone = coneDot >= TOUCH_AIM_CONE_COS;
      const inSnap = distRaw <= snapR;
      const inFallback =
        !inSnap && distOrigin <= TOUCH_AIM_FALLBACK_RADIUS_PX + mobScreenR && coneDot > 0;
      if (!inSnap && !inFallback) continue;

      let score = distRaw;
      if (!inCone) score += TOUCH_AIM_OUT_OF_CONE_PENALTY;
      if (inFallback) score += 80;
      score -= coneDot * 28;
      if (e.id != null && String(e.id) === String(touchAimSnapId)) {
        score -= TOUCH_AIM_STICKY_MARGIN;
      }
      candidates.push({
        id: e.id,
        scrX: scr.x,
        scrY: scr.y,
        distRaw,
        inCone,
        score,
      });
    }

    if (!candidates.length) {
      touchAimSnapId = null;
      touchAimSnapClass = null;
      return lerpTouchAimPointer(rawX, rawY, TOUCH_AIM_RELEASE_LERP, dt);
    }

    /* 有锥内候选时只在锥内选；否则用半球兜底。 */
    const conePool = candidates.filter((c) => c.inCone);
    const pool = conePool.length ? conePool : candidates;
    let best = pool[0];
    for (let i = 1; i < pool.length; i += 1) {
      if (pool[i].score < best.score) best = pool[i];
    }

    const sameTarget =
      touchAimSnapId != null && String(touchAimSnapId) === String(best.id);
    touchAimSnapId = best.id != null ? best.id : null;
    touchAimSnapClass = touchAimSnapId != null ? affinity : null;
    const rate = sameTarget ? TOUCH_AIM_TRACK_LERP : TOUCH_AIM_SNAP_LERP;
    return lerpTouchAimPointer(best.scrX, best.scrY, rate, dt);
  }

  /**
   * 移动端瞄准摇杆可及屏幕领先（与桌面鼠标覆盖视口相当的椭圆）。
   * 桌面准星可落在视口任意点；摇杆满推应对齐近半屏水平/垂直，而非 min(w,h)*0.42 各向同性短半径。
   * @returns {{ maxLeadX: number, maxLeadY: number }}
   */
  function touchAimMaxLeadPx() {
    const leadScale = window.LpGuardTurret?.getAimLeadScale?.() ?? 1;
    const turret = window.LpGuardTurret?.isManned?.() ?? false;
    const frac = turret ? 0.48 : 0.46;
    return {
      maxLeadX: viewW * frac * leadScale,
      maxLeadY: viewH * frac * leadScale,
    };
  }

  /**
   * 移动端：瞄准摇杆方向 × 把手距离 → 准星屏幕位置（松手保持方向与距离）。
   * 满推领先覆盖近整屏椭圆（对齐桌面鼠标可瞄范围）；近距合法目标硬吸附粘滞。
   * @param {number} [dt]
   */
  function syncTouchAimPointer(dt) {
    if (!isCoarsePointer() || isUiOpen()) return;
    const look =
      window.LpTouchControls?.getLook?.() || {
        x: 0,
        y: 0,
        mag: 0,
        active: false,
        ready: false,
      };
    const view = cameraView();
    const aimAnchorY = avatar.y - 56;
    const playerScreen = worldToScreen(local.x, aimAnchorY, view);
    const { maxLeadX, maxLeadY } = touchAimMaxLeadPx();
    let rawX;
    let rawY;
    if (look.ready) {
      const mag = Math.min(1, Math.max(0, Number(look.mag) || 0));
      rawX = playerScreen.x + look.x * maxLeadX * mag;
      rawY = playerScreen.y + look.y * maxLeadY * mag;
    } else {
      const facing = avatar.facing >= 0 ? 1 : -1;
      rawX = playerScreen.x + facing * maxLeadX * 0.55;
      rawY = playerScreen.y - maxLeadY * 0.08;
    }
    const snapped = applyTouchAimSnap(
      rawX,
      rawY,
      view,
      look,
      playerScreen,
      Number.isFinite(dt) ? dt : 1 / 60
    );
    pointer.x = snapped.x;
    pointer.y = snapped.y;
    pointer.known = true;
  }

  /**
   * 准星对应的世界瞄准点。
   * 必须用 cameraView()（与绘制同一矩阵）；列车地板锚在 TRAIN_FLOOR_SCREEN_Y，
   * 若按屏心换算，卫士机炮弹道会整体低于准星。
   */
  function getAimWorld() {
    if (pointer.known) {
      return screenToWorld(pointer.x, pointer.y, cameraView());
    }
    const facing = avatar.facing >= 0 ? 1 : -1;
    return { x: local.x + facing * 160, y: avatar.y - 56 };
  }

  /** 持枪/换弹用瞄准点（换弹时抬枪露顶匣；调试面板可锁定瞄准角）。 */
  function getWeaponAimWorld() {
    return (
      window.LpHoldPoseDebug?.getAimWorld?.(avatar)
      || window.LpReloadAction?.getAimOverride?.(avatar)
      || getAimWorld()
    );
  }

  /** 枪口世界坐标（持枪时沿瞄准方向；否则胸部占位）。 */
  function getMuzzleWorld() {
    const aim = getWeaponAimWorld();
    const item = window.LpCombat?.getHeldWeaponItem?.();
    if (item && window.LpWeaponHold?.getMuzzleWorld) {
      return window.LpWeaponHold.getMuzzleWorld(avatar, aim, item);
    }
    const facing = avatar.facing >= 0 ? 1 : -1;
    return {
      x: local.x + facing * 22,
      y: avatar.y - 58,
    };
  }

  /** 抛壳口世界坐标。 */
  function getEjectWorld() {
    const aim = getWeaponAimWorld();
    const item = window.LpCombat?.getHeldWeaponItem?.();
    if (item && window.LpWeaponHold?.getEjectWorld) {
      return window.LpWeaponHold.getEjectWorld(avatar, aim, item);
    }
    return getMuzzleWorld();
  }

  /** 向当前瞄准方向开火（手持武器或卫兵防御炮塔）；持医疗箱/灭火器时改走专用逻辑。 */
  function requestFire() {
    if (window.LpPlayerDeath?.isIncapacitated?.()) return;
    if (isUiOpen() || !window.LpCombat) return;
    if (window.LpMedkit?.isHoldingMedkit?.()) return;
    if (window.LpFireExtinguisher?.isHolding?.()) return;
    window.LpPressure?.noteAction?.();
    const aim = getAimWorld();
    if (window.LpGuardTurret?.isManned?.()) {
      window.LpGuardTurret.tryFire(aim.x, aim.y);
      return;
    }
    const muzzle = getMuzzleWorld();
    const eject = getEjectWorld();
    window.LpCombat.tryFire({
      originX: muzzle.x,
      originY: muzzle.y,
      ejectX: eject.x,
      ejectY: eject.y,
      dirX: aim.x - muzzle.x,
      dirY: aim.y - muzzle.y,
      facing: avatar.facing,
      moveSpeed: local.vx,
    });
  }

  /**
   * 按住时是否应连发：入座机炮，或手持全自动/机炮类武器，或持医疗箱/灭火器持续作用。
   * 半自动仅依赖 pointerdown / keydown / lp:fire 单发。
   */
  function shouldHoldFire() {
    if (window.LpGuardTurret?.isManned?.()) return true;
    if (window.LpMedkit?.isHoldingMedkit?.()) return true;
    if (window.LpFireExtinguisher?.isHolding?.()) return true;
    return Boolean(window.LpCombat?.isHeldWeaponFullAuto?.());
  }

  /**
   * 每帧轮询开火键/指针是否仍按住；全自动或入座机炮或医疗箱时触发。
   * 入座 early-return 路径也必须调用，否则长按无法连发。
   */
  function pollHoldFire() {
    const touch = readTouchInput();
    const fireHeld =
      touch.fire ||
      window.LpTouchControls?.isFireHeld?.() ||
      desktopFireHeld ||
      window.LpInputBindings?.isPressed('fire', keys);
    if (fireHeld && window.LpMedkit?.isHoldingMedkit?.() && !window.LpGuardTurret?.isManned?.()) {
      return;
    }
    if (fireHeld && window.LpFireExtinguisher?.isHolding?.() && !window.LpGuardTurret?.isManned?.()) {
      return;
    }
    if (fireHeld && shouldHoldFire()) requestFire();
  }

  /** 每帧推进医疗箱持续治疗（与 pollHoldFire 共用按住判定）。 */
  function tickMedkit(dt) {
    if (isUiOpen() || window.LpGuardTurret?.isManned?.()) return;
    const touch = readTouchInput();
    const fireHeld =
      touch.fire ||
      window.LpTouchControls?.isFireHeld?.() ||
      desktopFireHeld ||
      window.LpInputBindings?.isPressed('fire', keys);
    if (!fireHeld) return;
    const aim = getAimWorld();
    const remotes = [];
    const remoteMap = window.LiminalSession?.remotes?.();
    if (remoteMap && typeof remoteMap.values === 'function') {
      for (const r of remoteMap.values()) remotes.push(r);
    }
    window.LpMedkit?.tick?.(dt, {
      fireHeld: true,
      aimX: aim.x,
      aimY: aim.y,
      selfX: local.x,
      selfY: avatar.y,
      remotes,
      localUserId: userId,
    });
  }

  /** 每帧推进灭火器喷射（按住开火；与医疗箱互斥由持有物决定）。 */
  function tickFireExtinguisher(dt) {
    if (isUiOpen() || window.LpGuardTurret?.isManned?.()) return;
    const touch = readTouchInput();
    const fireHeld =
      touch.fire ||
      window.LpTouchControls?.isFireHeld?.() ||
      desktopFireHeld ||
      window.LpInputBindings?.isPressed('fire', keys);
    const aim = getAimWorld();
    window.LpFireExtinguisher?.tick?.(dt, {
      fireHeld: Boolean(fireHeld),
      aimX: aim.x,
      aimY: aim.y,
      avatar,
      selfX: local.x,
      selfY: avatar.y,
    });
    window.LpFireExtinguisher?.updatePrompt?.(local.x, avatar.y);
  }

  /** 回复本地生命（医疗箱等）；不超过上限。濒死/死亡中忽略（复活走专用路径）。 */
  function healPlayer(amount) {
    if (window.LpPlayerDeath?.isIncapacitated?.()) return playerHp;
    const add = Math.max(0, Number(amount) || 0);
    if (add <= 0) return playerHp;
    playerHp = Math.min(PLAYER_MAX_HP, playerHp + add);
    syncHpHud();
    return playerHp;
  }

  /** 刷新左上角生命条（委托 LpHudVitals）。 */
  function syncHpHud() {
    window.LpHudVitals?.syncHp?.(playerHp, PLAYER_MAX_HP);
  }

  /** 装填：灭火器近站补满；选中蜂鸟走抓取换弹；否则手持武器（含换弹动画）。 */
  function requestReload() {
    if (isUiOpen() || window.LpGuardTurret?.isManned?.()) return;
    if (window.LpFireExtinguisher?.isHolding?.()) {
      window.LpFireExtinguisher.tryRefill?.(local.x, avatar.y);
      return;
    }
    if (window.LpHummingbirdDrone?.isDroneSelected?.()) {
      window.LpHummingbirdDrone.tryReload?.();
      return;
    }
    window.LpCombat?.tryReload?.();
  }

  /** 与 avatar-lobby 一致：把 skins API 条目转成 appearance。 */
  function appearanceFromSkin(skin) {
    if (!skin) {
      return {
        skinId: null,
        kind: 'plain',
        heightScale: Entity.DEFAULT_HEIGHT_SCALE,
        contentHash: '',
      };
    }
    return {
      skinId: skin.id,
      kind: skin.kind || 'plain',
      heightScale: skin.height_scale ?? Entity.DEFAULT_HEIGHT_SCALE,
      contentHash: skin.content_hash || skin.created_at || '',
    };
  }

  /** 拉取当前穿戴皮套并应用到本地 avatar（与大厅同一 API / Entity.loadAppearance）。 */
  async function loadWornAppearance() {
    try {
      const response = await fetch('/avatar-lobby/skins');
      if (!response.ok) {
        console.warn('[liminal] skins API', response.status);
        return;
      }
      const payload = await response.json();
      const skins = payload.skins || [];
      const wornId = payload.worn;
      // 与大厅一致：只应用已穿戴皮套，不擅自换成 skins[0]
      const skin = wornId ? skins.find((item) => item.id === wornId) || null : null;
      const appearance = appearanceFromSkin(skin);
      // 先预热本地皮套库（含当前穿戴），远端同 URL 复用 Cache Storage
      window.AvatarSkinCache?.preloadSkins?.(skins);
      await Entity.loadAppearance(avatar, appearance);
      window.LiminalSession?.setAppearance?.(appearance);
      syncAvatarPose();
      avatar._lpSkinMeta = skin
        ? { id: skin.id, name: skin.name, kind: skin.kind }
        : null;
    } catch (error) {
      console.warn('[liminal] loadWornAppearance failed', error);
    }
  }

  /**
   * 脚底相对当前平台顶边的世界 Y → avatar 绘制锚点（与大厅一致：锚点在身中，脚在 +AVATAR_SIZE/2）。
   * @param {number} physicsY
   * @param {object} [entity]
   * @param {number} [atX]
   * @param {{ preferY?: number, remember?: boolean } | null | undefined} [floorOpts]
   */
  function stageYFromPhysics(physicsY, entity = avatar, atX = local.x, floorOpts) {
    const floorY = floorAt(atX, floorOpts) ?? Spec.FLOOR_Y;
    return (
      floorY
      + physicsY
      - Entity.AVATAR_SIZE / 2
      - Entity.footGroundLiftPx(entity)
    );
  }

  /** 同步运动状态到 avatar 实体（供绘制与程序化动作）。 */
  function syncAvatarPose() {
    avatar.x = local.x;
    avatar.y = stageYFromPhysics(local.y);
    avatar.vx = local.vx;
    avatar.vy = local.vy;
    avatar.onGround = local.onGround;
    avatar.kneel = local.kneel;
  }

  /**
   * 远端实体的舞台 Y；只读查层并缓存 `_lpFloorY`，不改写本机 lastPlatformFloorY。
   * @param {object} entity
   * @param {number} physicsY
   */
  function remoteStageY(entity, physicsY) {
    const prefer =
      entity?._lpFloorY != null && Number.isFinite(Number(entity._lpFloorY))
        ? Number(entity._lpFloorY)
        : undefined;
    const floorY =
      floorAt(entity.x, { preferY: prefer, remember: false }) ?? Spec.FLOOR_Y;
    if (Number.isFinite(floorY)) entity._lpFloorY = floorY;
    return stageYFromPhysics(physicsY, entity, entity.x, {
      preferY: floorY,
      remember: false,
    });
  }

  /** 预加载两节车厢贴图。 */
  function loadCarImages() {
    return Promise.all(
      Spec.CARRIAGES.map(
        (car) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              carImages.set(car.id, img);
              resolve();
            };
            img.onerror = reject;
            img.src = car.image;
          })
      )
    );
  }

  /** 根据视口高度计算基础缩放，移动端略缩小以露出触控区。 */
  function updateZoom() {
    const base = isCoarsePointer() ? viewH / 1040 : viewH / 860;
    baseZoom = Math.min(Math.max(base, 0.32), 1.2);
    zoom = baseZoom * feedZoomMul;
  }

  /** 同步 canvas 像素尺寸。 */
  function resizeStage() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
    updateZoom();
  }

  /** 当前场景地面 Y（列车走道或月台/地牢所站楼层）。 */
  function sceneFloorY() {
    if (window.LpPlatform?.getScene?.() === 'platform') {
      return (
        window.LpPlatform.platformFloorAt?.(local.x) ??
        window.LpPlatform.getPlatformWalkBounds?.().floorY ??
        Spec.FLOOR_Y
      );
    }
    return Spec.FLOOR_Y;
  }

  /** 是否在月台/地牢场景（镜头构图与列车走道不同）。 */
  function isPlatformScene() {
    return window.LpPlatform?.getScene?.() === 'platform';
  }

  /**
   * 月台/地牢镜头竖直锚点：脚底世界 Y 再上抬到躯干附近。
   * 含 local.y（跳跃相对位移），楼梯逐级变化时焦点连续。
   */
  function platformCamAnchorY() {
    return sceneFloorY() + local.y - PLAT_CAM_BODY_LIFT;
  }

  /**
   * 限制镜头相对玩家的最大偏移，避免角色跑出安全区。
   * Y 锚在当前场景地面（非列车 Spec.FLOOR_Y），否则地牢多层会被拽向列车地板高度。
   */
  function clampLookLead(targetX, targetY) {
    const turret = window.LpGuardTurret?.isManned?.() ?? false;
    const lead = window.LpGuardTurret?.getAimLeadScale?.() ?? 1;
    const onPlat = isPlatformScene();
    /* 月台略收紧 look-ahead，角色更靠屏中 */
    const leadFracX = turret ? 0.4 : onPlat ? 0.22 : 0.36;
    /* 列车：上探车顶多、下探轨下少；炮塔仍允许较大仰角 */
    const leadFracYUp = turret ? 0.62 : onPlat ? 0.18 : 0.44;
    const leadFracYDown = turret ? 0.22 : onPlat ? 0.1 : 0.1;
    const maxLeadX = (viewW * leadFracX * lead) / zoom;
    const maxLeadUp = (viewH * leadFracYUp * lead) / zoom;
    const maxLeadDown = (viewH * leadFracYDown * lead) / zoom;
    const anchorY = onPlat ? platformCamAnchorY() : sceneFloorY();
    return {
      x: Math.max(local.x - maxLeadX, Math.min(local.x + maxLeadX, targetX)),
      y: Math.max(anchorY - maxLeadUp, Math.min(anchorY + maxLeadDown, targetY)),
    };
  }

  /**
   * 将镜头焦点钳到月台/地牢内容包围盒；内容小于视口时居中，避免大片虚空。
   * 列车场景无包围盒时原样返回。
   */
  function clampCameraToContent(focusX, focusY) {
    const bounds = window.LpPlatform?.getCameraBounds?.();
    if (!bounds) return { x: focusX, y: focusY };
    const halfW = viewW / (2 * zoom);
    const halfH = viewH / (2 * zoom);
    const spanX = bounds.right - bounds.left;
    const spanY = bounds.bottom - bounds.top;
    let x = focusX;
    let y = focusY;
    if (spanX <= halfW * 2) {
      x = (bounds.left + bounds.right) * 0.5;
    } else {
      x = Math.max(bounds.left + halfW, Math.min(bounds.right - halfW, focusX));
    }
    if (spanY <= halfH * 2) {
      y = (bounds.top + bounds.bottom) * 0.5;
    } else {
      y = Math.max(bounds.top + halfH, Math.min(bounds.bottom - halfH, focusY));
    }
    return { x, y };
  }

  /** 立刻把镜头锁到本地玩家当前楼层（进出月台传送后避免慢追）。 */
  function snapCameraToLocal() {
    const focusY = isPlatformScene() ? platformCamAnchorY() : sceneFloorY();
    const c = clampCameraToContent(local.x, focusY);
    camFocus.x = c.x;
    camFocus.y = c.y;
  }

  /**
   * 世界坐标相机。
   * 桌面：焦点偏向鼠标准星；移动端：偏向瞄准摇杆虚拟准星。
   * 驾驶台：人物落在操作台上方空白区；加燃料 / 其它 UI 对准站立角色。
   * 设施编辑：锁在舱体重心，水平居中，竖直略上偏避开底栏。
   * 月台/地牢：角色近屏中（不用列车「地板贴底」构图）。
   */
  function cameraView() {
    const boilerOpen = window.LpBoilerPanel?.isOpen?.() ?? false;
    const feedOpen =
      (window.LpFuelFeed?.isOpen?.() ?? false) ||
      (window.LpGuardCrateUi?.isOpen?.() ?? false);
    const facilityEditOpen = window.LpFacilityEdit?.isOpen?.() ?? false;
    const onPlat = isPlatformScene();

    if (facilityEditOpen) {
      const focusX = viewW * 0.5;
      /* 底栏托盘占下沿，把舱体锚到略偏上的可视区 */
      const cabinScreenY = viewH * (isCoarsePointer() ? 0.36 : 0.42);
      return {
        zoom,
        offsetX: focusX - camFocus.x * zoom,
        offsetY: cabinScreenY - camFocus.y * zoom,
      };
    }

    if (boilerOpen) {
      /* 操作台约占下半屏，把角色锚到上方空白区中部 */
      const focusX = viewW * 0.5;
      const avatarScreenY = viewH * (isCoarsePointer() ? 0.28 : 0.30);
      return {
        zoom,
        offsetX: focusX - camFocus.x * zoom,
        offsetY: avatarScreenY - camFocus.y * zoom,
      };
    }

    /* 月台/地牢：始终近中心构图（列车走道才用地板贴 ~62% 的构图） */
    if (onPlat) {
      return {
        zoom,
        offsetX: viewW * 0.5 - camFocus.x * zoom,
        offsetY: viewH * (isCoarsePointer() ? 0.48 : 0.5) - camFocus.y * zoom,
      };
    }

    if (feedOpen || isUiOpen() || !pointer.known) {
      const focusX = viewW * (isCoarsePointer() ? 0.5 : 0.48);
      const floorScreenY =
        viewH * (isCoarsePointer() ? TRAIN_FLOOR_SCREEN_Y_COARSE : TRAIN_FLOOR_SCREEN_Y);
      return {
        zoom,
        offsetX: focusX - camFocus.x * zoom,
        offsetY: floorScreenY - camFocus.y * zoom,
      };
    }
    /* 列车准星模式：地板仍偏下，把多出的竖直视野留给车厢上方 */
    {
      const floorScreenY =
        viewH * (isCoarsePointer() ? TRAIN_FLOOR_SCREEN_Y_COARSE : TRAIN_FLOOR_SCREEN_Y);
      return {
        zoom,
        offsetX: viewW * 0.5 - camFocus.x * zoom,
        offsetY: floorScreenY - camFocus.y * zoom,
      };
    }
  }

  /** 每帧平滑更新镜头焦点与控制台 / 加燃料放大 / 炮塔缩小。 */
  function stepCamera(dt) {
    const feedOpen =
      (window.LpFuelFeed?.isOpen?.() ?? false) ||
      (window.LpGuardCrateUi?.isOpen?.() ?? false);
    const boilerOpen = window.LpBoilerPanel?.isOpen?.() ?? false;
    const turretManned = window.LpGuardTurret?.isManned?.() ?? false;
    const facilityFocus = window.LpFacilityEdit?.getCameraFocus?.() || null;
    const onPlat = isPlatformScene();
    /* 驾驶台略放大；加燃料 / 弹药箱更近；炮塔拉远以便仰射 */
    const wantMul = feedOpen ? 2.35 : boilerOpen ? 1.55 : turretManned ? 0.52 : 1;
    const zoomEase = turretManned || Math.abs(feedZoomMul - 1) > 0.02 ? 3.4 : 5.8;
    feedZoomMul += (wantMul - feedZoomMul) * (1 - Math.exp(-zoomEase * dt));
    zoom = baseZoom * feedZoomMul;

    let targetX = local.x;
    const sceneFloor = sceneFloorY();
    /* 月台/地牢跟躯干锚；列车仍跟地板（走道贴底构图） */
    let targetY = onPlat ? platformCamAnchorY() : sceneFloor;
    if (facilityFocus) {
      /* 设施编辑：锁焦舱体重心，不跟随站位偏移 */
      targetX = facilityFocus.x;
      targetY = facilityFocus.y;
    } else if (boilerOpen) {
      /* 焦点略抬到躯干，配合上方构图 */
      targetY = sceneFloor - 48;
    } else if (feedOpen) {
      targetY = sceneFloor - 70;
    } else if (isAimCameraMode() && pointer.known) {
      const world = screenToWorld(pointer.x, pointer.y, cameraView());
      /* 月台 look-ahead 更轻，角色保持近中心 */
      const lookW = onPlat ? 0.28 : LOOK_WEIGHT;
      let lookY = turretManned ? 0.58 : onPlat ? 0.12 : LOOK_WEIGHT_Y;
      const anchorY = onPlat ? platformCamAnchorY() : sceneFloor;
      /* 换层追焦中压低准星竖直牵引，避免与楼梯平滑抢 Y */
      if (onPlat && Math.abs(camFocus.y - anchorY) > PLAT_CAM_Y_CATCHUP) {
        lookY *= 0.35;
      }
      targetX = local.x * (1 - lookW) + world.x * lookW;
      let blendedY = anchorY * (1 - lookY) + world.y * lookY;
      /* 列车：鼠标下探轨下压缩、上探车顶略加强 */
      if (!onPlat) {
        const dY = blendedY - anchorY;
        if (dY > 0) blendedY = anchorY + dY * LOOK_DOWN_COMPRESS;
        else if (dY < 0) blendedY = anchorY + dY * LOOK_UP_BOOST;
      }
      targetY = blendedY;
      const clamped = clampLookLead(targetX, targetY);
      targetX = clamped.x;
      targetY = clamped.y;
    }

    if (onPlat && !facilityFocus) {
      const boxed = clampCameraToContent(targetX, targetY);
      targetX = boxed.x;
      targetY = boxed.y;
    }

    const dx = targetX - camFocus.x;
    const dy = targetY - camFocus.y;
    const dist2 = dx * dx + dy * dy;
    /* 仅传送级距离硬对齐；单层换高（≈794）走平滑，避免爬楼顿挫 */
    if (dist2 > CAM_SNAP_DIST * CAM_SNAP_DIST) {
      camFocus.x = targetX;
      camFocus.y = targetY;
      return;
    }

    /* 进入设施编辑时略加快锁焦，退出后仍用常规平滑回到玩家 */
    const focusEase = facilityFocus
      ? CAM_SMOOTH * 1.85
      : turretManned
        ? CAM_SMOOTH * 0.72
        : CAM_SMOOTH;
    let yEase = focusEase;
    if (onPlat && !facilityFocus) {
      const absDy = Math.abs(dy);
      if (absDy > PLAT_CAM_Y_CATCHUP) {
        /* |ΔY| 越大追得越紧，全层高差时约 2.2×，不硬切 */
        yEase =
          focusEase * (1.2 + Math.min(1.0, (absDy - PLAT_CAM_Y_CATCHUP) / 520));
      }
    }
    const tx = 1 - Math.exp(-focusEase * dt);
    const ty = 1 - Math.exp(-yEase * dt);
    camFocus.x += dx * tx;
    camFocus.y += dy * ty;
  }

  /**
   * 查询某 x 处可走平台顶边（世界 Y）。月台场景用月台/地牢地板。
   * @param {number} x
   * @param {{ preferY?: number, remember?: boolean } | null | undefined} [opts]
   *        透传给 LpPlatform.platformFloorAt；队友查询须 `remember: false`。
   */
  function floorAt(x, opts) {
    if (isPlatformScene()) {
      if (window.LpPlatform.platformFloorAt) {
        return window.LpPlatform.platformFloorAt(x, opts);
      }
      return window.LpPlatform.getPlatformWalkBounds?.().floorY ?? Spec.FLOOR_Y;
    }
    let best = null;
    for (const platform of platforms) {
      if (x >= platform.left && x <= platform.right) {
        if (best === null || platform.y < best) best = platform.y;
      }
    }
    return best;
  }

  /** 当前场景行走左右界。 */
  function walkBounds() {
    if (window.LpPlatform?.getScene?.() === 'platform') {
      const b = window.LpPlatform.getPlatformWalkBounds?.();
      if (b) return { left: b.left, right: b.right };
    }
    return { left: worldLeft, right: worldRight };
  }

  /**
   * 小型地牢实心墙碰撞：把门洞以外的隔断挡住，只能经走廊进出房间。
   */
  function applyDungeonWallCollision() {
    if (window.LpPlatform?.getScene?.() !== 'platform') return;
    if (window.LpPlatform?.getPlatformKind?.() !== 'small') return;
    const dungeon = window.LpPlatform?.getDungeon?.();
    if (!dungeon?.walls?.length || !window.LpDungeon?.resolveBody) return;
    const floorY = floorAt(local.x);
    if (floorY == null || !Number.isFinite(floorY)) return;
    const out = window.LpDungeon.resolveBody(dungeon, {
      x: local.x,
      physicsY: local.y,
      vy: local.vy,
      floorY,
    });
    local.x = out.x;
    local.y = out.physicsY;
    local.vy = out.vy;
  }

  function approach(value, target, maxStep) {
    if (value < target) return Math.min(value + maxStep, target);
    return Math.max(value - maxStep, target);
  }

  /**
   * 小怪触碰：若在炮塔等岗位上则先离席，再扣血、击飞，并给关节初速做简易布娃娃。
   * 仅走 mob onHit 路径；其它伤害源不经此函数，不会误踢下岗。
   * @param {{ damage?: number, knockVx?: number, knockVy?: number }} hit
   */
  function applyMobHit(hit) {
    if (window.LpPlayerDeath?.isIncapacitated?.()) return;
    if (hitInvulnT > 0 || hitStunT > 0.2) return;
    /* 岗位上受击：走与 F 离席相同的 exitTurret，再按站立受击处理击退 */
    if (window.LpGuardTurret?.isManned?.()) {
      window.LpGuardTurret.exitTurret();
    }
    if (window.LpTashaRocket?.isFireControlOpen?.()) {
      window.LpTashaRocket.closeFireControl();
    }
    const dmg = Math.max(0, Number(hit?.damage) || 0);
    playerHp = Math.max(0, playerHp - dmg);
    syncHpHud();
    window.LpPressure?.noteMobHit?.(local.x);
    if (playerHp <= 0) {
      window.LpPlayerDeath?.onLethalHit?.({
        x: local.x,
        exitTurret: () => {
          window.LpGuardTurret?.exitTurret?.();
          window.LpTashaRocket?.closeFireControl?.();
        },
      });
    }
    const kx = Number(hit?.knockVx) || 0;
    const ky = Number(hit?.knockVy) || -280;
    local.vx = kx;
    local.vy = Math.min(local.vy, ky);
    local.onGround = false;
    hitStunT = 0.62;
    hitInvulnT = 0.9;
    avatar.moveDirection = 0;
    avatar.gait = 'walk';
    avatar.leanVelocity += Math.sign(kx || 1) * 9;
    avatar.squashVelocity = Math.max(avatar.squashVelocity, 3.2);
    const joints = avatar.joints;
    if (joints) {
      const flop = 14 + Math.abs(kx) * 0.012;
      for (const key of Object.keys(joints)) {
        const j = joints[key];
        if (!j) continue;
        j.velocity += (Math.random() - 0.5) * flop * 2;
      }
    }
  }

  /** 组装重生钩子（仓储传送 / 满血 / 短暂无敌）。 */
  function respawnHooks() {
    return {
      local,
      avatar,
      restoreHp() {
        playerHp = PLAYER_MAX_HP;
        syncHpHud();
      },
      syncPose: syncAvatarPose,
      setInvuln(t) {
        hitInvulnT = Math.max(0, Number(t) || 0);
        hitStunT = 0;
      },
    };
  }

  /** 濒死时仅保留重力落地与倒地姿势，忽略移动/开火。 */
  function stepIncapacitatedPhysics(dt) {
    if (hitInvulnT > 0) hitInvulnT = Math.max(0, hitInvulnT - dt);
    hitStunT = 0;
    local.vx *= Math.exp(-3.2 * dt);
    const bounds = walkBounds();
    local.x = Math.max(bounds.left, Math.min(bounds.right, local.x + local.vx * dt));
    avatar.moveDirection = 0;
    avatar.gait = 'walk';
    const wasOnGround = local.onGround;
    local.vy += GRAVITY * dt;
    local.y += local.vy * dt;
    const floorY = floorAt(local.x);
    if (floorY !== null && local.y >= 0) {
      local.y = 0;
      if (!wasOnGround) {
        avatar.squashVelocity = Math.min(Math.max(local.vy - 180, 0) / 100, 4.6);
      }
      local.vy = 0;
      local.onGround = true;
      if (Math.abs(local.vx) < 40) local.vx *= 0.5;
    } else {
      local.onGround = false;
    }
    applyDungeonWallCollision();
    Entity.updateEntityMotion(avatar, dt);
    window.LpPlayerDeath?.applyDownedPose?.(avatar, dt);
    local.kneel = avatar.kneel || 0;
    syncAvatarPose();
    const extras = window.LpPlayerDeath?.poseExtras?.() || {};
    window.LiminalSession?.maybeSendPose?.({
      x: local.x,
      y: local.y,
      vx: local.vx,
      vy: local.vy,
      facing: avatar.facing,
      onGround: local.onGround,
      gait: avatar.gait,
      headLook: 0,
      aimX: null,
      aimY: null,
      lifeState: extras.lifeState,
      downedRemain: extras.downedRemain,
      deathCause: extras.deathCause,
    });
  }

  /** 受击硬直期间：忽略移动输入，只保留击飞动量与重力落地。 */
  function stepHitStunPhysics(dt) {
    hitStunT = Math.max(0, hitStunT - dt);
    local.vx *= Math.exp(-2.4 * dt);
    const bounds = walkBounds();
    local.x = Math.max(bounds.left, Math.min(bounds.right, local.x + local.vx * dt));
    avatar.moveDirection = 0;
    avatar.gait = 'walk';
    const wasOnGround = local.onGround;
    local.vy += GRAVITY * dt;
    local.y += local.vy * dt;
    const floorY = floorAt(local.x);
    if (floorY !== null && local.y >= 0) {
      local.y = 0;
      if (!wasOnGround) {
        avatar.squashVelocity = Math.min(Math.max(local.vy - 180, 0) / 100, 4.6);
      }
      local.vy = 0;
      local.onGround = true;
      if (Math.abs(local.vx) < 40) local.vx *= 0.5;
    } else {
      local.onGround = false;
    }
    applyDungeonWallCollision();
    Entity.updateEntityMotion(avatar, dt);
    syncAvatarPose();
  }

  /** 积分玩家运动；y 为相对平台顶边的物理高度（地面 0，腾空为负）。 */
  function stepPhysics(dt) {
    if (hitInvulnT > 0) hitInvulnT = Math.max(0, hitInvulnT - dt);

    if (window.LpPlayerDeath?.isIncapacitated?.()) {
      stepIncapacitatedPhysics(dt);
      return;
    }

    if (hitStunT > 0 && !isUiOpen() && !window.LpGuardTurret?.isManned?.()) {
      stepHitStunPhysics(dt);
      {
        const aim = getWeaponAimWorld();
        window.LiminalSession?.maybeSendPose?.({
          x: local.x,
          y: local.y,
          vx: local.vx,
          vy: local.vy,
          facing: avatar.facing,
          onGround: local.onGround,
          gait: avatar.gait,
          headLook: avatar.headLook,
          aimX: aim?.x,
          aimY: aim?.y,
        });
      }
      return;
    }

    if (isUiOpen() || window.LpGuardTurret?.isManned?.()) {
      local.vx = 0;
      local.kneel += (0 - local.kneel) * Math.min(1, dt * 10);
      avatar.gait = 'walk';
      avatar.moveDirection = 0;
      if (window.LpGuardTurret?.isManned?.() && isAimCameraMode() && pointer.known) {
        const world = screenToWorld(pointer.x, pointer.y, cameraView());
        window.LpGuardTurret.aimBoth(world.x, world.y);
        if (Math.abs(world.x - local.x) > 12) {
          avatar.facing = world.x < local.x ? -1 : 1;
        }
      }
      if (local.y < 0) {
        local.vy += GRAVITY * dt;
        local.y += local.vy * dt;
        if (local.y >= 0) {
          local.y = 0;
          local.vy = 0;
          local.onGround = true;
        }
      } else {
        local.y = 0;
        local.vy = 0;
        local.onGround = true;
      }
      Entity.updateEntityMotion(avatar, dt);
      syncAvatarPose();
      if (
        !isUiOpen() &&
        !window.LpGuardTurret?.isManned?.() &&
        window.LpCombat?.getHeldWeaponItem?.()
      ) {
        if (window.LpReloadAction?.isBusy?.()) {
          window.LpReloadAction.applyArmPose(avatar);
        } else {
          const held = window.LpCombat?.getHeldWeaponItem?.();
          window.LpWeaponHold?.applyAimArmPose?.(avatar, getWeaponAimWorld(), held);
        }
      }
      {
        const aim = getWeaponAimWorld();
        window.LiminalSession?.maybeSendPose?.({
          x: local.x,
          y: local.y,
          vx: local.vx,
          vy: local.vy,
          facing: avatar.facing,
          onGround: local.onGround,
          gait: avatar.gait,
          headLook: avatar.headLook,
          aimX: aim?.x,
          aimY: aim?.y,
        });
      }
      // 入座机炮时本分支会 return，须在此轮询长按连发（与下方步行路径共用 pollHoldFire）
      if (!isUiOpen() && window.LpGuardTurret?.isManned?.()) pollHoldFire();
      return;
    }

    const touch = readTouchInput();
    let direction = touch.direction;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) direction = -1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) direction = 1;

    const kneelHeld =
      Boolean(touch.kneel) ||
      Boolean(window.LpInputBindings?.isPressed('kneel', keys));
    const kneel = kneelHeld;
    if (kneel) direction = 0;

    if (direction !== 0) avatar.facing = direction;
    avatar.moveDirection = direction;
    if (direction !== 0 || kneel) window.LpPressure?.noteAction?.();

    // 瞄准时朝向跟随准星（可边走边看）
    if (isAimCameraMode() && pointer.known) {
      const world = screenToWorld(pointer.x, pointer.y, cameraView());
      if (Math.abs(world.x - local.x) > 12) {
        avatar.facing = world.x < local.x ? -1 : 1;
      }
    }

    const kneelTarget = kneel && local.onGround ? 1 : 0;
    local.kneel += (kneelTarget - local.kneel) * Math.min(1, dt * 10);

    const autoRun = Boolean(window.LpInputBindings?.getAutoRun?.());
    let wantRun = false;
    if (direction !== 0 && !kneel) {
      if (isCoarsePointer()) {
        /* 触控：跑/走按钮锁定；进房时 applyAutoRunPreference 已按偏好置位。 */
        wantRun = Boolean(
          window.LpTouchControls?.isSprintOn?.() ?? touch.sprintToggle
        );
      } else {
        /* 桌面：默认步态 XOR 按住奔跑键（自动奔跑时按住改为行走）。 */
        const sprintHeld = Boolean(window.LpInputBindings?.isPressed('sprint', keys));
        wantRun = autoRun !== sprintHeld;
      }
    }
    avatar.gait = wantRun ? 'run' : 'walk';

    const moveSpeed = wantRun ? RUN_SPEED : MOVE_SPEED;
    const targetVelocity = kneel ? 0 : direction * moveSpeed;
    const acceleration = kneel ? 2600 : direction === 0 ? 1100 : wantRun ? 1900 : 1500;
    local.vx = approach(local.vx, targetVelocity, acceleration * dt);
    const bounds = walkBounds();
    local.x = Math.max(bounds.left, Math.min(bounds.right, local.x + local.vx * dt));

    const jumpPressed =
      touch.jump ||
      keys.has('Space') ||
      keys.has('ArrowUp') ||
      keys.has('KeyW');
    if (jumpPressed && local.onGround && !kneel && local.kneel < 0.2) {
      local.vy = -JUMP_SPEED;
      local.onGround = false;
      window.LpPressure?.noteAction?.();
    }

    const wasOnGround = local.onGround;
    local.vy += GRAVITY * dt;
    local.y += local.vy * dt;

    const floorY = floorAt(local.x);
    if (floorY !== null && local.y >= 0) {
      local.y = 0;
      if (!wasOnGround) {
        avatar.squashVelocity = Math.min(Math.max(local.vy - 180, 0) / 100, 4.6);
      }
      local.vy = 0;
      local.onGround = true;
    } else {
      local.onGround = false;
    }

    applyDungeonWallCollision();

    Entity.updateEntityMotion(avatar, dt);
    syncAvatarPose();
    if (
      !isUiOpen() &&
      !window.LpGuardTurret?.isManned?.() &&
      window.LpCombat?.getHeldWeaponItem?.()
    ) {
      if (window.LpReloadAction?.isBusy?.()) {
        window.LpReloadAction.applyArmPose(avatar);
      } else {
        const held = window.LpCombat?.getHeldWeaponItem?.();
        window.LpWeaponHold?.applyAimArmPose?.(avatar, getWeaponAimWorld(), held);
      }
    }
    {
      const aim = getWeaponAimWorld();
      window.LiminalSession?.maybeSendPose?.({
        x: local.x,
        y: local.y,
        vx: local.vx,
        vy: local.vy,
        facing: avatar.facing,
        onGround: local.onGround,
        gait: avatar.gait,
        headLook: avatar.headLook,
        aimX: aim?.x,
        aimY: aim?.y,
      });
    }

    pollHoldFire();

    const activeSpot = window.LiminalInteract?.findActive(local) || null;
    window.LpTouchControls?.setInteractVisible(Boolean(activeSpot), activeSpot?.actionLabel);
    const inStorage =
      !isUiOpen() &&
      window.LiminalCarriageSpec?.carriageAt?.(local.x)?.id === 'storage';
    window.LpTouchControls?.setStorageHint?.(inStorage);
  }

  /**
   * 绘制单节车厢贴图（世界坐标）。
   * 颠簸仅经 LpCarriageBob 作用于本贴图；地板/碰撞/交互坐标不变。
   */
  function drawCarriage(car, carIndex) {
    const img = carImages.get(car.id);
    if (!img) return;
    const paint = () => {
      ctx.drawImage(img, car.worldX, 0, Spec.MODULE_W, Spec.MODULE_H);
    };
    if (window.LpCarriageBob?.withCarDraw) {
      window.LpCarriageBob.withCarDraw(ctx, car, carIndex, paint);
    } else {
      paint();
    }
  }

  /** 单帧渲染。 */
  function drawFrame() {
    const view = cameraView();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(
      view.zoom * dpr, 0, 0, view.zoom * dpr,
      view.offsetX * dpr, view.offsetY * dpr
    );

    const onPlatformScene = window.LpPlatform?.getScene?.() === 'platform';
    if (onPlatformScene) {
      /* 月台/地牢也铺世界背景（站厅主题），避免场景外一片死黑 */
      window.LpWorldBackground?.draw?.(ctx);
      window.LpPlatform.draw?.(ctx);
      window.LiminalSession?.drawRemotes?.(ctx, view, dpr);
      const heldItem = window.LpCombat?.getHeldVisibleItem?.()
        || window.LpCombat?.getHeldWeaponItem?.();
      const holdingVisible =
        Boolean(heldItem) &&
        !isUiOpen() &&
        !window.LpPlayerDeath?.isIncapacitated?.();
      const holdingGun =
        holdingVisible && window.LpItemCatalog?.isWeapon?.(heldItem.id);
      Entity.drawAvatar(ctx, avatar, view, dpr, holdingGun ? { skipBackArm: true } : {});
      if (holdingVisible) {
        const weaponAim = getWeaponAimWorld();
        window.LpWeaponHold?.drawHeldWeapon?.(ctx, avatar, weaponAim, heldItem);
        if (holdingGun) {
          window.LpReloadAction?.draw?.(ctx, avatar, weaponAim);
          Entity.drawBackArm?.(ctx, avatar);
        }
      }
      /* 灭火器水雾叠在手持贴图之上 */
      window.LpFireExtinguisher?.draw?.(ctx);
      if (window.LpPlatform?.getPlatformKind?.() === 'small') {
        window.LpMobs?.draw?.(ctx);
        window.LpMobDeathFx?.draw?.(ctx);
      }
      /* 伴飞无人机：月台/地牢与列车同逻辑，须在场景 return 前绘制 */
      window.LpHummingbirdDrone?.draw?.(ctx);
      window.LpHummingbirdDrone?.drawRemotes?.(ctx);
      if (window.LpPlatform?.getPlatformKind?.() === 'small') {
        window.LpCombat?.draw?.(ctx);
        window.LpImpactFx?.draw?.(ctx);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      window.LpStationTransit?.draw?.(ctx, {
        width: canvas.width,
        height: canvas.height,
        dpr,
      });
      window.LiminalInteract?.drawActivePrompt(ctx, local, view, dpr, formatInteractKey(), {
        showPrompt: !isCoarsePointer() && !isUiOpen(),
        inventoryKeyLabel: formatInventoryKey(),
        mobile: isCoarsePointer(),
      });
      return;
    }

    /* 世界背景（阈限深空）在轨/车之下；屏幕滤镜在世界绘完后、HUD 前 */
    window.LpWorldBackground?.draw?.(ctx);
    /* 中景视差：慢于轨卷，夹在背景与轨道之间 */
    window.LpParallaxLayers?.drawMidground?.(ctx);
    /* 轨道在车厢之下；炮管亦在贴图下，白球/车身挡住炮尾；火光/抛壳在贴图之上 */
    window.LpTrack?.draw?.(ctx);
    window.LpGuardTurret?.draw?.(ctx);
    Spec.CARRIAGES.forEach((car, i) => drawCarriage(car, i));
    window.LpTashaRocket?.draw?.(ctx);
    window.LpFacilityEdit?.draw?.(ctx);
    window.LpCarriageFire?.draw?.(ctx);
    window.LpGuardTurret?.drawFx?.(ctx);
    window.LiminalSession?.drawRemotes?.(ctx, view, dpr);
    const heldItem = window.LpCombat?.getHeldVisibleItem?.()
      || window.LpCombat?.getHeldWeaponItem?.();
    /* 控制台/面板打开或濒死/死亡时仅隐藏手持绘制与持枪层序，不卸装备 */
    const holdingVisible =
      Boolean(heldItem) &&
      !window.LpGuardTurret?.isManned?.() &&
      !isUiOpen() &&
      !window.LpPlayerDeath?.isIncapacitated?.();
    const holdingGun =
      holdingVisible && window.LpItemCatalog?.isWeapon?.(heldItem.id);
    /* 持枪层序（远→近）：后腿→前臂(橙/护木)→身→前腿→头→枪→换弹匣→后臂(红/握把) */
    /* 工具：整身画完后再叠贴图（无双臂 IK） */
    Entity.drawAvatar(ctx, avatar, view, dpr, holdingGun ? { skipBackArm: true } : {});
    if (holdingVisible) {
      const weaponAim = getWeaponAimWorld();
      window.LpWeaponHold?.drawHeldWeapon?.(ctx, avatar, weaponAim, heldItem);
      if (holdingGun) {
        window.LpReloadAction?.draw?.(ctx, avatar, weaponAim);
        Entity.drawBackArm?.(ctx, avatar);
      }
    }
    /* 灭火器水雾叠在手持贴图之上，避免被罐身挡住 */
    window.LpFireExtinguisher?.draw?.(ctx);
    window.LpGroundLoot?.draw?.(ctx);
    /* 小怪在车厢之上，避免被贴图完全挡住；轨面怪仍可见于底盘外 */
    window.LpMobs?.draw?.(ctx);
    window.LpMobDeathFx?.draw?.(ctx);
    window.LpHummingbirdDrone?.draw?.(ctx);
    window.LpCombat?.draw(ctx);
    window.LpImpactFx?.draw?.(ctx);
    /* 前景视差：快于轨卷，掠过屏幕边缘，强化速度感 */
    window.LpParallaxLayers?.drawForeground?.(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    window.LpViewFilters?.apply?.(ctx, {
      width: canvas.width,
      height: canvas.height,
      dpr,
    });
    window.LpStationTransit?.draw?.(ctx, {
      width: canvas.width,
      height: canvas.height,
      dpr,
    });
    window.LiminalInteract?.drawActivePrompt(ctx, local, view, dpr, formatInteractKey(), {
      showPrompt: !isCoarsePointer() && !isUiOpen(),
      inventoryKeyLabel: formatInventoryKey(),
      mobile: isCoarsePointer(),
    });
  }

  /** 隐藏页签，或电脑端窗口失焦时，跳过重负载模拟/绘制。 */
  function shouldThrottleBackground() {
    if (document.hidden) return true;
    if (!isCoarsePointer() && !windowFocused) return true;
    return false;
  }

  /** 取消已排队的 rAF。 */
  function cancelScheduledFrame() {
    if (frameRafId) {
      cancelAnimationFrame(frameRafId);
      frameRafId = 0;
    }
    frameScheduled = false;
  }

  /**
   * 续跑主循环：前台用 rAF；后台（hidden / 电脑失焦）停调度，
   * 由 focus / visibilitychange 唤醒。WS ping 不依赖本循环。
   */
  function scheduleFrame() {
    if (!loopStarted || frameScheduled) return;
    if (shouldThrottleBackground()) return;
    frameScheduled = true;
    frameRafId = requestAnimationFrame((ts) => {
      frameRafId = 0;
      frameScheduled = false;
      frame(ts);
    });
  }

  /** 前台恢复时清巨 dt 并立刻踢一帧。 */
  function kickLoopIfRunning() {
    if (!loopStarted) return;
    lastTs = 0;
    cancelScheduledFrame();
    scheduleFrame();
  }

  /** 主循环。 */
  function frame(ts) {
    /* 后台：跳过物理/绘制并停 rAF；恢复时清 lastTs 避免巨 dt */
    if (shouldThrottleBackground()) {
      lastTs = 0;
      return;
    }
    if (!lastTs) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;
    syncTouchAimPointer(dt);
    stepPhysics(dt);
    window.LpPlayerDeath?.tick?.(dt, {
      avatar,
      keys,
      coarse: isCoarsePointer(),
    });
    window.LpPlayerDeath?.watchAllyDeaths?.(local.x);
    window.LiminalSession?.tickRemotes?.(dt, remoteStageY);
    window.LpTrainDrive?.tick(dt);
    window.LpPlatform?.tick?.(dt);
    window.LpWorldBackground?.tick?.(dt);
    window.LpParallaxLayers?.tick?.(dt);
    window.LpStationTransit?.tick?.(dt);
    window.LpTrack?.tick?.(dt);
    window.LpGroundLoot?.tickTrackScroll?.();
    window.LpCarriageBob?.tick?.(dt);
    window.LpCombat?.tick(dt, {
      floorY: Spec.FLOOR_Y,
      floorAt,
      moveSpeed: local.vx,
    });
    window.LpImpactFx?.tick?.(dt);
    window.LpMobDeathFx?.tick?.(dt);
    window.LpReloadAction?.tick?.(dt);
    window.LpGuardTurret?.tick?.(dt);
    window.LpTashaRocket?.tick?.(dt);
    if (
      !window.LpPlayerDeath?.isIncapacitated?.() &&
      !window.LpGuardTurret?.isManned?.() &&
      !window.LpTashaRocket?.isManned?.()
    ) {
      const aim = getAimWorld();
      window.LpHummingbirdDrone?.tick?.(dt, {
        playerX: local.x,
        playerY: avatar.y,
        aimX: aim.x,
        aimY: aim.y,
        facing: avatar.facing,
      });
    } else {
      window.LpHummingbirdDrone?.despawn?.();
    }
    {
      const avatarH = Entity.AVATAR_SIZE * Entity.AVATAR_DRAW_SCALE * (avatar.heightScale || 1);
      const incap = Boolean(window.LpPlayerDeath?.isIncapacitated?.());
      const onPlat = window.LpPlatform?.getScene?.() === 'platform';
      const smallPlat = onPlat && window.LpPlatform?.getPlatformKind?.() === 'small';
      if (!onPlat || smallPlat) {
        window.LpMobs?.tick?.(dt, {
          player: {
            x: local.x,
            y: avatar.y,
            halfW: HALF_W,
            height: avatarH,
            /* 濒死/死亡期间无敌；入座仍可被打 */
            invuln: hitInvulnT > 0 || incap,
          },
          onHit: applyMobHit,
          view: cameraView(),
          viewW,
          viewH,
        });
      }
    }
    window.LpAutoSensors?.tick?.(dt);
    window.LpAutoExecutors?.tick?.(dt);
    if (!window.LpPlayerDeath?.isIncapacitated?.()) tickMedkit(dt);
    if (!window.LpPlayerDeath?.isIncapacitated?.()) tickFireExtinguisher(dt);
    window.LpCarriageFire?.tick?.(dt);
    window.LpPressure?.tick?.(dt, {
      localX: local.x,
      active: !window.LpPlayerDeath?.isIncapacitated?.(),
    });
    window.LpHudVitals?.tick?.();
    stepCamera(dt);
    syncAimCursor();
    updateLocalHeadLook(dt);
    window.LpBoilerPanel?.syncFromState?.();
    window.LpTrainAudio?.tick(dt);
    window.LpPlatformAmbience?.tick?.(dt);
    window.LpPlatformDockMusic?.tick?.(dt);
    window.LpFunEgg?.tick?.(dt);
    window.LpTrainMinimap?.syncFromWorldX?.(local.x);
    window.LpTrainMap?.syncFromWorldX?.(local.x);
    window.LpDungeonFow?.tick?.();
    window.LpDungeonMinimap?.tick?.();
    window.LpDungeonMap?.tick?.();
    drawFrame();
    scheduleFrame();
  }

  /** 电脑端：头看向鼠标（身后或仰角过大则回正）。 */
  function updateLocalHeadLook(dt) {
    if (!Entity.updateHeadLook) return;
    if (isCoarsePointer() || isUiOpen() || !pointer.known) {
      Entity.updateHeadLook(avatar, null, dt);
      return;
    }
    const view = cameraView();
    Entity.updateHeadLook(avatar, screenToWorld(pointer.x, pointer.y, view), dt);
  }

  /** 启动游戏循环（素材与皮套就绪后）。 */
  function startLoop() {
    if (loopStarted) return;
    loopStarted = true;
    syncAvatarPose();
    window.LpInventory?.flushSeedOverflow?.(local.x);
    window.LpMobs?.reset?.({
      view: cameraView(),
      viewW,
      viewH,
    });
    scheduleFrame();
  }

  /** 首次按键/触控时解锁音频，预热武器/点火 SFX，并开启列车行驶与月台环境/停靠 BGM 通道。 */
  function bindAudioUnlock() {
    const unlockOnce = () => {
      const sfxReady = window.LpSfx?.unlock?.() || Promise.resolve();
      Promise.resolve(sfxReady)
        .then(() => {
          const held = window.LpCombat?.getHeldWeaponItem?.();
          const reloadSfx =
            window.LpCombat?.RELOAD_SFX ||
            '/static/games/liminal-platform/audio/weapons/reload-1911.wav?v=2';
          const ignitionSfx =
            window.LpTrainDrive?.IGNITION_SFX ||
            '/static/games/liminal-platform/audio/train-ignition.wav?v=1';
          if (held?.fireSound) {
            window.LpSfx?.preload?.([held.fireSound, reloadSfx, ignitionSfx]);
          } else {
            window.LpSfx?.preload?.([
              '/static/games/liminal-platform/audio/weapons/gur-65-shot.wav?v=1',
              reloadSfx,
              ignitionSfx,
            ]);
          }
          window.LpFunEgg?.preload?.();
        })
        .catch(() => {});
      window.LpTrainAudio?.unlock()
        .then(() => window.LpTrainAudio?.setAmbient(true))
        .catch(() => {});
      window.LpPlatformAmbience?.unlock?.()
        .then(() => window.LpPlatformAmbience?.setAmbient?.(true))
        .catch(() => {});
      window.LpPlatformDockMusic?.unlock?.()
        .then(() => window.LpPlatformDockMusic?.setMusic?.(true))
        .catch(() => {});
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
    };
    window.addEventListener('pointerdown', unlockOnce, { passive: true });
    window.addEventListener('keydown', unlockOnce);
  }

  /** 关闭燃料/驾驶台/弹药箱/雷达/列车·地牢地图等操作台；若有关闭则返回 true。 */
  function closeConsoleUi() {
    if (window.LpTrainMap?.isOpen()) {
      window.LpTrainMap.close();
      return true;
    }
    if (window.LpDungeonMap?.isOpen?.()) {
      window.LpDungeonMap.close();
      return true;
    }
    if (window.LpFuelFeed?.isOpen()) {
      window.LpFuelFeed.close();
      return true;
    }
    if (window.LpGuardCrateUi?.isOpen()) {
      window.LpGuardCrateUi.close();
      return true;
    }
    if (window.LpBoilerPanel?.isOpen()) {
      window.LpBoilerPanel.close();
      return true;
    }
    if (window.LpRadarScope?.isOpen()) {
      window.LpRadarScope.close();
      return true;
    }
    if (window.LpTashaRocket?.isFireControlOpen?.()) {
      window.LpTashaRocket.closeFireControl();
      return true;
    }
    if (window.LpAutoConsole?.isOpen()) {
      window.LpAutoConsole.close();
      return true;
    }
    if (window.LpFacilityEdit?.isOpen()) {
      window.LpFacilityEdit.exit(true);
      return true;
    }
    if (window.LpPlatform?.isEditOpen?.()) {
      window.LpPlatform.closeEdit?.();
      return true;
    }
    return false;
  }

  window.addEventListener('keydown', (event) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    keys.add(event.code);

    if (window.LpPlayerDeath?.tryRespawnFromEvent?.(event, respawnHooks())) {
      event.preventDefault();
      return;
    }
    if (window.LpPlayerDeath?.isIncapacitated?.()) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Tab', 'KeyS'].includes(event.code)) {
        event.preventDefault();
      }
      return;
    }

    if (window.LpInputBindings?.matchesKeyEvent('inventory', event)) {
      event.preventDefault();
      if (window.LpFacilityEdit?.isOpen()) window.LpFacilityEdit.exit(true);
      if (window.LpTrainMap?.isOpen()) window.LpTrainMap.close();
      if (window.LpDungeonMap?.isOpen?.()) window.LpDungeonMap.close();
      if (window.LpBoilerPanel?.isOpen()) window.LpBoilerPanel.close();
      if (window.LpFuelFeed?.isOpen()) window.LpFuelFeed.close();
      if (window.LpGuardCrateUi?.isOpen()) window.LpGuardCrateUi.close();
      if (window.LpRadarScope?.isOpen()) window.LpRadarScope.close();
      if (window.LpAutoConsole?.isOpen()) window.LpAutoConsole.close();
      window.LpInventory?.toggle(local.x);
      return;
    }

    /* 地图：小型月台 → 地牢图；列车 → 编组图；可与其它操作台互关；不与物品栏抢 Tab */
    if (window.LpInputBindings?.matchesKeyEvent('trainMap', event)) {
      event.preventDefault();
      if (window.LpInventory?.isOpen()) return;
      if (window.LpFacilityEdit?.isOpen()) window.LpFacilityEdit.exit(true);
      if (window.LpDungeonMap?.isOpen?.()) {
        window.LpDungeonMap.close();
        return;
      }
      if (window.LpTrainMap?.isOpen()) {
        window.LpTrainMap.close();
        return;
      }
      if (window.LpBoilerPanel?.isOpen()) window.LpBoilerPanel.close();
      if (window.LpFuelFeed?.isOpen()) window.LpFuelFeed.close();
      if (window.LpGuardCrateUi?.isOpen()) window.LpGuardCrateUi.close();
      if (window.LpRadarScope?.isOpen()) window.LpRadarScope.close();
      if (window.LpAutoConsole?.isOpen()) window.LpAutoConsole.close();
      if (window.LpDungeonMap?.shouldHandle?.()) {
        window.LpDungeonMap.open();
      } else {
        window.LpTrainMap?.open?.(local.x);
      }
      return;
    }

    /* 设施编辑：默认 P；不可编辑车厢无反应；编辑中再按保存退出 */
    if (event.code === 'KeyP' && !event.repeat) {
      event.preventDefault();
      window.LpFacilityEdit?.toggle?.(local.x);
      return;
    }

    if (isUiOpen()) {
      if (event.code === 'Escape') {
        if (!closeConsoleUi()) window.LpInventory?.close();
        return;
      }
      // 操作台离席与交互键一致（默认 F）；地图仅 Esc / M / 点空白关闭
      if (
        window.LpInputBindings?.matchesKeyEvent('interact', event) &&
        !window.LpTrainMap?.isOpen() &&
        !window.LpDungeonMap?.isOpen?.() &&
        closeConsoleUi()
      ) {
        event.preventDefault();
      }
      return;
    }

    if (window.LpInputBindings?.matchesKeyEvent('interact', event)) {
      window.LiminalInteract?.tryInteract(local);
    }
    if (window.LpInputBindings?.matchesKeyEvent('handsHud', event)) {
      event.preventDefault();
      /* 武装入座：与手部共用键，循环弹种；否则切换手部槽。 */
      if (window.LpArmedAmmo?.isActive?.()) {
        window.LpArmedAmmo.cycle();
      } else {
        window.LpHandsHud?.cycleActive?.();
      }
    }
    /* 武装入座：数字键 1…N 选弹种；否则 1/2/3 选手部槽（同点 HUD）。 */
    if (!event.repeat) {
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit) {
        const n = Number(digit[1]);
        if (window.LpArmedAmmo?.isActive?.()) {
          event.preventDefault();
          window.LpArmedAmmo.selectByNumber(n);
        } else if (n >= 1 && n <= 3) {
          event.preventDefault();
          window.LpHandsHud?.selectByNumber?.(n);
        }
      }
    }
    if (window.LpInputBindings?.matchesKeyEvent('fire', event)) {
      event.preventDefault();
      requestFire();
    }
    if (window.LpInputBindings?.matchesKeyEvent('reload', event)) {
      event.preventDefault();
      requestReload();
    }
    if (window.LpInputBindings?.matchesKeyEvent('sprint', event)) {
      /* 触控：奔跑键边沿切换锁定。桌面只用按住（见 wantRun XOR），不在此 toggle。 */
      if (isCoarsePointer()) {
        event.preventDefault();
        window.LpTouchControls?.toggleSprint?.();
      }
    }
    if (
      window.LpInputBindings?.isPressed?.('kneel', new Set([event.code])) ||
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Tab', 'KeyS'].includes(event.code)
    ) {
      event.preventDefault();
    }
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('pointermove', (event) => {
    if (isCoarsePointer()) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.known = true;
  });
  canvas.addEventListener('pointerdown', (event) => {
    if (window.LpPlayerDeath?.tryRespawnFromEvent?.(event, respawnHooks())) {
      event.preventDefault();
      return;
    }
    if (window.LpPlayerDeath?.isIncapacitated?.()) return;
    if (isCoarsePointer() || isUiOpen()) return;
    if (event.button !== 0) return;
    desktopFireHeld = true;
    requestFire();
  });
  window.addEventListener('pointerdown', (event) => {
    if (!window.LpPlayerDeath?.canAcceptRespawnInput?.()) return;
    if (event.target === canvas) return;
    if (window.LpPlayerDeath.tryRespawnFromEvent(event, respawnHooks())) {
      event.preventDefault();
    }
  });
  canvas.addEventListener('contextmenu', (event) => {
    if (window.LpPlayerDeath?.tryRespawnFromEvent?.(event, respawnHooks())) {
      event.preventDefault();
    }
  });
  window.addEventListener('pointerup', (event) => {
    if (event.button === 0) desktopFireHeld = false;
  });
  window.addEventListener('pointercancel', () => {
    desktopFireHeld = false;
  });
  window.addEventListener('pointerleave', () => {
    if (isCoarsePointer()) return;
    pointer.known = false;
    desktopFireHeld = false;
    syncAimCursor();
  });
  window.addEventListener('blur', () => {
    windowFocused = false;
    keys.clear();
    if (!isCoarsePointer()) pointer.known = false;
    desktopFireHeld = false;
    syncAimCursor();
    lastTs = 0;
    cancelScheduledFrame();
  });
  window.addEventListener('focus', () => {
    windowFocused = true;
    kickLoopIfRunning();
  });
  window.addEventListener('resize', resizeStage);
  coarsePointer.addEventListener('change', () => {
    updateZoom();
    syncAimCursor();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      windowFocused =
        typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      window.LpTrainAudio?.resume();
      window.LpPlatformAmbience?.resume?.();
      window.LpPlatformDockMusic?.resume?.();
      window.LpSfx?.resume?.();
      loadWornAppearance().then(syncAvatarPose);
      kickLoopIfRunning();
    } else {
      keys.clear();
      window.LpTrainAudio?.suspend();
      window.LpPlatformAmbience?.suspend?.();
      window.LpPlatformDockMusic?.suspend?.();
      window.LpSfx?.suspend?.();
      lastTs = 0;
      cancelScheduledFrame();
    }
  });

  bindAudioUnlock();
  window.LpTouchControls?.applyAutoRunPreference?.();
  window.LiminalSession?.start?.({ userId, nickname });
  syncHpHud();
  window.LpGame = {
    getLocalAvatar: () => avatar,
    /** 本地玩家世界 X（压力同车判定 / HUD）。 */
    getLocalX: () => local.x,
    /** 全屏 UI（物品栏/锅炉/燃料/弹药箱/雷达/枢机/设施编辑）是否打开；联机上报可据此隐藏持枪。 */
    isUiOpen,
    /** 当前相机视图（供设施编辑等叠层做屏幕↔世界换算）。 */
    getCameraView: () => cameraView(),
    /** 屏幕坐标 → 世界坐标。 */
    screenToWorld,
    /** 本地玩家当前生命值。 */
    getHp: () => playerHp,
    getMaxHp: () => PLAYER_MAX_HP,
    /** 回复生命（医疗箱等）；返回回血后的当前 HP。 */
    heal: healPlayer,
    /** 是否濒死或最终死亡（不可移动/开火）。 */
    isIncapacitated: () => Boolean(window.LpPlayerDeath?.isIncapacitated?.()),
    isDowned: () => Boolean(window.LpPlayerDeath?.isDowned?.()),
    isDead: () => Boolean(window.LpPlayerDeath?.isDead?.()),
    getLifeState: () => window.LpPlayerDeath?.getLifeState?.() || 'alive',
    /** 调试：直接触发一次击飞受击。 */
    debugMobHit(hit) {
      applyMobHit(hit || { damage: 10, knockVx: 400, knockVy: -320 });
    },
    /** 调试：直接扣至 0 血进入濒死/死亡。 */
    debugKill() {
      playerHp = 0;
      syncHpHud();
      window.LpPlayerDeath?.onLethalHit?.({ x: local.x });
    },
    /** 令本地角色朝向列车前进方向（屏幕右 / 世界 +X）。 */
    faceTrainForward() {
      const dir = Spec.TRAIN_FORWARD_X >= 0 ? 1 : -1;
      avatar.facing = dir;
      syncAvatarPose();
    },
    /** 调试：传送到指定车厢走道内。 */
    teleportToCar(carId) {
      const car = Spec.CARRIAGES.find((c) => c.id === carId);
      if (!car) return false;
      local.x = car.worldX + Spec.WALK_LEFT + Spec.scaleArt(80);
      local.vx = 0;
      syncAvatarPose();
      return true;
    },
    /** 编组变更后重算走道边界。 */
    refreshWalkBounds,
    /** 传送到指定连接处中心（月台回车）。 */
    teleportToCoupler(couplerIndex) {
      const x = window.LpPlatform?.couplerWorldX?.(couplerIndex);
      if (x == null || !Number.isFinite(x)) return false;
      local.x = x;
      local.vx = 0;
      local.y = 0;
      local.onGround = true;
      syncAvatarPose();
      return true;
    },
  };

  /** 应用服务端广播的队友医箱复活（本机为目标或复活者）。 */
  window.addEventListener('lp:player-revived', (event) => {
    const d = event.detail || {};
    const localId = String(userId || '');
    const targetId = String(d.targetId || '');
    const byId = String(d.by || '');
    if (targetId && targetId === localId) {
      window.LpPlayerDeath?.applyAllyRevive?.({
        maxHp: PLAYER_MAX_HP,
        setHp(hp) {
          playerHp = Math.max(0, Math.min(PLAYER_MAX_HP, Number(hp) || 0));
          syncHpHud();
        },
        avatar,
        local,
        syncPose: syncAvatarPose,
        setInvuln(t) {
          hitInvulnT = Math.max(0, Number(t) || 0);
          hitStunT = 0;
        },
      });
    }
    if (byId && byId === localId) {
      window.LpPlayerDeath?.applyReviverPressureRelief?.(local.x);
    }
  });
  window.addEventListener('lp:turret-enter', (event) => {
    const turretId = event.detail?.turretId === 'right' ? 'right' : 'left';
    const spotId = turretId === 'right' ? 'guard-turret-right' : 'guard-turret-left';
    const spot = window.LiminalInteract?.INTERACTABLES?.find((s) => s.id === spotId);
    if (spot) {
      local.x = spot.worldX;
      local.vx = 0;
      syncAvatarPose();
    }
  });
  /** 进出月台/地牢时立刻锁焦，避免列车坐标慢追导致角色卡在角落。 */
  window.addEventListener('liminal:platform-scene', () => {
    snapCameraToLocal();
  });
  window.addEventListener('lp:interact', () => {
    window.LpPressure?.noteAction?.();
    if (closeConsoleUi()) return;
    if (isUiOpen()) return;
    window.LiminalInteract?.tryInteract(local);
  });
  window.addEventListener('lp:fire', () => {
    if (isUiOpen()) return;
    requestFire();
  });
  window.addEventListener('lp:inventory-toggle', () => {
    window.LpInventory?.toggle(local.x);
  });
  resizeStage();
  /** 车厢首帧就绪后收起启动遮罩。 */
  function hideBootSplash() {
    const splash = document.getElementById('lpBootSplash');
    if (!splash || splash.classList.contains('is-done')) return;
    splash.classList.add('is-done');
    splash.setAttribute('aria-busy', 'false');
    const remove = () => splash.remove();
    splash.addEventListener('transitionend', remove, { once: true });
    window.setTimeout(remove, 400);
  }
  // 车厢与皮套分开加载：皮套失败不阻断进关，也不误报「车厢素材失败」
  loadCarImages()
    .then(() => {
      hideBootSplash();
      startLoop();
      return loadWornAppearance();
    })
    .catch(() => {
      hideBootSplash();
      const hint = document.getElementById('lpLoadError');
      if (hint) hint.hidden = false;
      window.LpTouchControls?.setEnabled(false);
    });
})();
