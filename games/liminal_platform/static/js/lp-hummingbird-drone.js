/**
 * 蜂鸟护卫无人机：手部栏装备后本地伴飞，自动点射小口径弹药。
 *
 * 运动：本地权威角色式跟飞（加速 / 阻尼 / 钳速），联机 pose 上报 + 软矫正。
 * 玩家操作炮塔/设备时改为当前车厢走道内巡逻；装填（选中 + R）仍抓取→捣鼓→放飞。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const ITEM_ID = 'hummingbird_drone';

  /** 装填节拍（秒）。 */
  const RELOAD = {
    grab: 0.3,
    fiddle: 1.15,
    release: 0.35,
    /** 捣鼓段内提交弹匣的归一化进度。 */
    commitAt: 0.48,
  };

  /** 与枪械换弹同文案的进行中提示（LiminalInteract toast）。 */
  const RELOAD_HINT = '装填中…';

  /** 联机：本机权威，软矫正门槛；硬对齐仅灾难级误差（车厢跨度量级）。 */
  const SOFT_ERR = 48;
  const SOFT_BLEND = 0.12;
  const SNAP_ERR = 720;
  const MAX_SPEED = 420;
  const ACCEL = 980;
  const DAMP = 7.5;
  /** 巡逻：相对跟飞略慢，走道两端内收（源图像素经 WORLD_SCALE）。 */
  const PATROL_SPEED = 240;
  const PATROL_ACCEL = 560;
  const PATROL_DAMP = 6.5;
  const PATROL_FLIP_DIST = 28;
  const PATROL_INSET_ART = 56;
  /** 脱绳过远时加强追赶加速（仍连续，不瞬移）。 */
  const CATCHUP_DIST = 160;
  const CATCHUP_ACCEL_MUL = 1.55;
  /**
   * 距主人移速曲线：ownerDist ∈ [NEAR, FAR] → scale ∈ [MIN, MAX]（smoothstep）。
   * 巡逻仍按主人距缩放（非巡逻目标距），远离时能尽快回跟。
   */
  const OWNER_SPEED_NEAR = 72;
  const OWNER_SPEED_FAR = 420;
  const OWNER_SPEED_MIN = 0.55;
  const OWNER_SPEED_MAX = 1.85;
  /** 视觉俯仰：水平速度相对朝向；满倾角对应参考速。 */
  const LEAN_MAX = 0.28;
  const LEAN_SPEED_REF = 220;
  /** 默认上下漂浮频率（Hz）；图鉴可覆盖。 */
  const BOB_HZ_DEFAULT = 1.1;
  /** 软绳：略超 leash 时轻拉；过远交给 desire 加速追，避免瞬拉。 */
  const SOFT_LEASH_RATE = 2.8;
  const SOFT_LEASH_MAX_OVER = 2.4;

  /** 左右各半节车厢 → 相对无人机的水平交战半径。 */
  function engageRangeX() {
    const Spec = window.LiminalCarriageSpec;
    const moduleW = Number(Spec?.MODULE_W) || 1980;
    return 0.5 * moduleW;
  }

  const imgs = {
    body: null,
    barrel: null,
  };

  /** 本地伴飞；无手部无人机时为 null。 */
  let drone = null;

  /** 远端无人机：playerId → 平滑状态。 */
  const remotes = new Map();

  /**
   * 预加载机身 / 炮管贴图。
   * @param {string} bodyUrl
   * @param {string} barrelUrl
   */
  function preload(bodyUrl, barrelUrl) {
    if (bodyUrl) {
      const img = new Image();
      img.src = bodyUrl;
      imgs.body = img;
    }
    if (barrelUrl) {
      const img = new Image();
      img.src = barrelUrl;
      imgs.barrel = img;
    }
  }

  /** 手部栏中的蜂鸟无人机槽（任一主手格）；初始化缺省弹匣。 */
  function getDroneHandSlot() {
    const hands = window.LpInventory?.getHandsInventory?.();
    if (!hands || !Catalog?.isCompanionDrone) return null;
    for (let index = 0; index < hands.size(); index += 1) {
      if (hands.isCovered?.(index)) continue;
      let stack = hands.getSlot(index);
      if (!stack || !Catalog.isCompanionDrone(stack.itemId)) continue;
      const item = Catalog.getItem(stack.itemId);
      if (!item) continue;
      if (item.magazineSize != null && stack.mag == null) {
        stack = hands.updateSlot?.(index, { mag: item.magazineSize }) || {
          ...stack,
          mag: item.magazineSize,
        };
      }
      return { hands, index, stack, item };
    }
    return null;
  }

  /** 当前选中手部槽是否就是蜂鸟无人机。 */
  function isDroneSelected() {
    const held = getDroneHandSlot();
    if (!held) return false;
    const active = window.LpHandsHud?.getActiveIndex?.();
    return active === held.index;
  }

  /** 是否正在抓取/捣鼓/放飞装填（禁止开火）。 */
  function isReloading() {
    return Boolean(drone && drone.reloadPhase);
  }

  /**
   * 本地玩家是否占用设备（离自由活动）：炮塔入座、锅炉/加燃料、雷达、枢机、弹药箱 UI。
   * 不含物品栏 / 列车地图（非设备席位）。
   * @returns {boolean}
   */
  function isPlayerEquipmentBusy() {
    if (window.LpGuardTurret?.isManned?.()) return true;
    if (window.LpBoilerPanel?.isOpen?.()) return true;
    if (window.LpFuelFeed?.isOpen?.()) return true;
    if (window.LpRadarScope?.isOpen?.()) return true;
    if (window.LpAutoConsole?.isOpen?.()) return true;
    if (window.LpGuardCrateUi?.isOpen?.()) return true;
    return false;
  }

  /**
   * 按世界 X 解析巡逻车厢：优先 carriageAt，否则取走道中心最近的一节。
   * @param {number} worldX
   * @returns {object|null}
   */
  function resolvePatrolCar(worldX) {
    const Spec = window.LiminalCarriageSpec;
    if (!Spec?.CARRIAGES?.length) return null;
    const at = Spec.carriageAt?.(worldX);
    if (at) return at;
    const midLocal = (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2;
    let best = null;
    let bestD = Infinity;
    for (const car of Spec.CARRIAGES) {
      const d = Math.abs(car.worldX + midLocal - worldX);
      if (d < bestD) {
        bestD = d;
        best = car;
      }
    }
    return best;
  }

  /**
   * 当前车厢走道巡逻水平范围与舱内悬停高度。
   * @param {object} car
   * @returns {{ left: number, right: number, y: number }}
   */
  function patrolBounds(car) {
    const Spec = window.LiminalCarriageSpec;
    const inset = Spec.scaleArt?.(PATROL_INSET_ART) || PATROL_INSET_ART;
    const item = Catalog.getItem(ITEM_ID) || {};
    const hoverY = Number(item.hoverOffsetY) || -78;
    return {
      left: car.worldX + Spec.WALK_LEFT + inset,
      right: car.worldX + Spec.WALK_RIGHT - inset,
      y: Spec.FLOOR_Y + hoverY,
    };
  }

  /**
   * 设备占用时的巡逻期望点：在走道两端间来回悬停。
   * @param {{ playerX: number, facing: number }} ctx
   * @returns {{ x: number, y: number, maxLeash: number, skipLeash: boolean } | null}
   */
  function patrolDesire(ctx) {
    if (!drone) return null;
    const car = resolvePatrolCar(ctx.playerX);
    if (!car) return null;
    const bounds = patrolBounds(car);
    const span = Math.max(40, bounds.right - bounds.left);
    if (drone.patrolCarId !== car.id) {
      drone.patrolCarId = car.id;
      drone.patrolDir = ctx.facing >= 0 ? 1 : -1;
    }
    if (!drone.patrolDir) {
      drone.patrolDir = ctx.facing >= 0 ? 1 : -1;
    }
    let targetX = drone.patrolDir >= 0 ? bounds.right : bounds.left;
    if (Math.abs(drone.x - targetX) < PATROL_FLIP_DIST) {
      drone.patrolDir *= -1;
      targetX = drone.patrolDir >= 0 ? bounds.right : bounds.left;
    }
    return {
      x: targetX,
      y: bounds.y,
      maxLeash: span,
      skipLeash: true,
    };
  }

  /** 销毁伴飞运行时（卸下手部栏）。 */
  function despawn() {
    if (drone?.reloadPhase) clearReloadHint();
    drone = null;
  }

  /**
   * 确保伴飞体存在并挂上图鉴绘制参数。
   * @param {object} item
   * @param {{ playerX: number, playerY: number, facing: number }} [anchor]
   */
  function ensureSpawn(item, anchor) {
    if (drone) return drone;
    if (item?.bodySprite) preload(item.bodySprite, item.barrelSprite);
    const facing = anchor?.facing >= 0 ? 1 : -1;
    const px = Number(anchor?.playerX) || 0;
    const py = Number(anchor?.playerY) || 0;
    drone = {
      x: px + facing * 36,
      y: py - 78,
      vx: 0,
      vy: 0,
      aimAngle: facing >= 0 ? 0 : Math.PI,
      facing,
      bobT: Math.random() * Math.PI * 2,
      bobY: 0,
      burstLeft: 0,
      shotCd: 0.35,
      targetId: null,
      /** @type {null | 'grab' | 'fiddle' | 'release'} */
      reloadPhase: null,
      reloadT: 0,
      reloadCommit: false,
      holdX: px + facing * 22,
      holdY: py - 42,
      /** 巡逻方向：+1 向右端，-1 向左端；非巡逻时为 null。 */
      patrolDir: null,
      patrolCarId: null,
    };
    return drone;
  }

  /**
   * 交战参照车厢：优先无人机所在走道舱，否则玩家；连廊/舱外无节时不可交战。
   * @param {number} playerX
   * @returns {string|null}
   */
  function engageRefCarId(playerX) {
    const Spec = window.LiminalCarriageSpec;
    if (!Spec?.carriageAt) return null;
    if (drone?.x != null && Number.isFinite(Number(drone.x))) {
      const atDrone = Spec.carriageAt(Number(drone.x));
      if (atDrone?.id) return atDrone.id;
    }
    if (playerX != null && Number.isFinite(Number(playerX))) {
      const atPlayer = Spec.carriageAt(Number(playerX));
      if (atPlayer?.id) return atPlayer.id;
    }
    return null;
  }

  /**
   * 敌方是否可被蜂鸟交战：须舱内战斗态，且目标在参照节同车厢或左右相邻节。
   * 对齐 mob inCabin / phase inside（含舱内空漂）；rail、dive、jump/enter 入舱途中不打。
   * @param {{ x?: number, inCabin?: boolean, phase?: string }} h
   * @param {string} refCarId
   */
  function isDroneCabinEngageTarget(h, refCarId) {
    if (!h || !refCarId) return false;
    if (h.x == null || !Number.isFinite(Number(h.x))) return false;
    const p = String(h.phase || '');
    /* 稳态舱内才打；inCabin 含 jump/enter，入舱途中仍排除。 */
    const cabinPresent =
      p === 'inside' ||
      (typeof h.inCabin === 'boolean' && h.inCabin && !p);
    if (!cabinPresent) return false;
    const Spec = window.LiminalCarriageSpec;
    const car = Spec?.carriageAt?.(Number(h.x));
    if (!car?.id) return false;
    return Boolean(Spec.areCarriagesSameOrAdjacent?.(car.id, refCarId));
  }

  /**
   * 弹道起点：优先炮口，否则机身。
   * @param {object|null|undefined} item
   */
  function shotOrigin(item) {
    if (item && drone) return getMuzzleWorld(item);
    if (drone) return { x: drone.x, y: drone.y + (drone.bobY || 0) };
    return null;
  }

  /**
   * 从起点到目标点弹道是否清通（地牢墙 / 车底；无检测接口则视为通）。
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   */
  function hasClearShot(x0, y0, x1, y1) {
    const clears = window.LpCombat?.projectileClearsToPoint;
    if (typeof clears !== 'function') return true;
    return clears(x0, y0, x1, y1);
  }

  /**
   * 在交战半径内按锚点选最近敌人。
   * 车厢场景：同节或相邻节舱内；月台/地牢无车厢时仅按射程（不套舱内规则）。
   * 地牢还须枪口到目标无墙遮挡，避免隔墙选敌开火。
   * @param {number} anchorX 选敌距离优先锚点 X
   * @param {number} anchorY 选敌距离优先锚点 Y
   * @param {number} playerX 无人机无车厢时交战参照回退用
   * @param {object|null|undefined} [item] 用于炮口视线
   * @returns {object|null}
   */
  function pickTarget(anchorX, anchorY, playerX, item) {
    const hostiles = window.LpCombat?.listHostiles?.() || [];
    const rangeX = engageRangeX();
    const originX =
      drone?.x != null && Number.isFinite(Number(drone.x))
        ? Number(drone.x)
        : Number(playerX);
    const onPlatform = window.LpPlatform?.getScene?.() === 'platform';
    const refCarId = onPlatform ? null : engageRefCarId(playerX);
    if (!onPlatform && !refCarId) return null;
    const origin = shotOrigin(item);
    let best = null;
    let bestD2 = Infinity;
    for (const h of hostiles) {
      if (!h || h.x == null || !Number.isFinite(Number(h.x))) continue;
      const hx = Number(h.x);
      if (Math.abs(hx - originX) > rangeX) continue;
      if (!onPlatform && !isDroneCabinEngageTarget(h, refCarId)) continue;
      const hy =
        h.y != null && Number.isFinite(Number(h.y)) ? Number(h.y) : anchorY;
      if (
        onPlatform &&
        origin &&
        !hasClearShot(origin.x, origin.y, hx, hy)
      ) {
        continue;
      }
      const d2 = (hx - anchorX) ** 2 + (hy - anchorY) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { ...h, x: hx, y: hy };
      }
    }
    return best;
  }

  /**
   * 角色抓取时的持握点（胸前偏前手侧）。
   * @param {{ playerX: number, playerY: number, facing: number }} ctx
   */
  function holdPoint(ctx) {
    const face = ctx.facing >= 0 ? 1 : -1;
    return {
      x: ctx.playerX + face * 22,
      y: ctx.playerY - 44,
    };
  }

  /**
   * 正常伴飞期望点（选中环绕准星 / 未选中悬停身旁）。
   * @param {{ playerX: number, playerY: number, aimX: number, aimY: number, facing: number, selected: boolean }} ctx
   */
  function hoverDesire(ctx) {
    const item = Catalog.getItem(ITEM_ID) || {};
    const hoverX = Number(item.hoverOffsetX) || 36;
    const hoverY = Number(item.hoverOffsetY) || -78;
    const maxLeash = Number(item.leashRadius) || 110;
    if (ctx.selected) {
      const toAimX = ctx.aimX - ctx.playerX;
      const toAimY = ctx.aimY - ctx.playerY;
      const aimLen = Math.hypot(toAimX, toAimY) || 1;
      const pull = Math.min(maxLeash * 0.85, Math.max(42, aimLen * 0.28));
      return {
        x: ctx.playerX + (toAimX / aimLen) * pull,
        y: ctx.playerY + (toAimY / aimLen) * pull * 0.55 - 40,
        maxLeash,
      };
    }
    return {
      x: ctx.playerX + ctx.facing * hoverX,
      y: ctx.playerY + hoverY,
      maxLeash,
    };
  }

  /**
   * 按与主人的距离得到移速/加速倍率：近处悬停更稳，远处加快追赶。
   * 巡逻同样用主人距（不用巡逻端点距），以便远离时能尽快回跟。
   * @param {{ playerX: number, playerY: number }} ctx
   * @returns {number}
   */
  function ownerDistSpeedScale(ctx) {
    if (!drone) return 1;
    const od = Math.hypot(drone.x - ctx.playerX, drone.y - ctx.playerY);
    const span = Math.max(1, OWNER_SPEED_FAR - OWNER_SPEED_NEAR);
    const t = Math.max(0, Math.min(1, (od - OWNER_SPEED_NEAR) / span));
    const s = t * t * (3 - 2 * t);
    return OWNER_SPEED_MIN + s * (OWNER_SPEED_MAX - OWNER_SPEED_MIN);
  }

  /**
   * 角色式跟飞：朝目标点加速并阻尼；永不硬写 x/y。
   * 巡逻时 tune.skipLeash 关闭相对玩家的软绳，以免拖回设备席。
   * 基础 maxSpeed/accel 再乘 ownerDistSpeedScale（距主人）。
   * @param {number} dt
   * @param {{ x: number, y: number }} desire
   * @param {{ playerX: number, playerY: number }} ctx
   * @param {number} maxLeash
   * @param {{ maxSpeed?: number, accel?: number, damp?: number, skipLeash?: boolean }} [tune]
   */
  function integrateToward(dt, desire, ctx, maxLeash, tune = {}) {
    if (!drone) return;
    const ownerScale = ownerDistSpeedScale(ctx);
    let maxSpeed = (tune.maxSpeed ?? MAX_SPEED) * ownerScale;
    let accel = (tune.accel ?? ACCEL) * ownerScale;
    const damp = tune.damp ?? DAMP;
    const skipLeash = Boolean(tune.skipLeash);
    const dx = desire.x - drone.x;
    const dy = desire.y - drone.y;
    const dist = Math.hypot(dx, dy) || 1;

    /* 模式切换 / 脱绳过远：加强加速追上，仍连续积分。 */
    if (dist > CATCHUP_DIST) {
      accel *= CATCHUP_ACCEL_MUL;
    }

    /* 接近目标时减速，避免弹簧过冲；远处满加速。 */
    const arrive = Math.min(1, dist / 48);
    const ax = (dx / dist) * accel * arrive;
    const ay = (dy / dist) * accel * arrive;
    drone.vx += ax * dt;
    drone.vy += ay * dt;
    const dampF = Math.max(0, 1 - damp * dt);
    drone.vx *= dampF;
    drone.vy *= dampF;
    const spdCap = dist > CATCHUP_DIST ? maxSpeed * 1.25 : maxSpeed;
    const spd = Math.hypot(drone.vx, drone.vy);
    if (spd > spdCap) {
      drone.vx = (drone.vx / spd) * spdCap;
      drone.vy = (drone.vy / spd) * spdCap;
    }
    drone.x += drone.vx * dt;
    drone.y += drone.vy * dt;

    /* 软绳：仅略超 leash 时轻拉；过远交给 desire 加速，避免瞬拉感。 */
    if (skipLeash || drone.reloadPhase) return;
    const soft = maxLeash * 1.12;
    const hardBand = maxLeash * SOFT_LEASH_MAX_OVER;
    const after = Math.hypot(drone.x - ctx.playerX, drone.y - ctx.playerY);
    if (after > soft && after < hardBand) {
      const over = after - soft;
      const pull = Math.min(0.28, over / after) * Math.min(1, dt * SOFT_LEASH_RATE);
      drone.x -= (drone.x - ctx.playerX) * pull;
      drone.y -= (drone.y - ctx.playerY) * pull;
    }
  }

  /**
   * 沿水平速度方向的视觉俯仰（仅绘制；右移低头向右、左移向左；与瞄准朝向无关）。
   * lean = clamp(vx / LEAN_SPEED_REF, -1, 1) * LEAN_MAX
   * @param {{ vx?: number }} entity
   * @returns {number} 弧度；在朝向镜像之前施加（世界空间）
   */
  function flightLeanRad(entity) {
    const vx = Number(entity.vx) || 0;
    const u = Math.max(-1, Math.min(1, vx / LEAN_SPEED_REF));
    return u * LEAN_MAX;
  }

  /**
   * 推进装填状态机：grab → fiddle（中途提交弹匣）→ release → 恢复伴飞。
   * @param {number} dt
   * @param {{ playerX: number, playerY: number, facing: number }} ctx
   * @param {object} held
   */
  function updateReload(dt, ctx, held) {
    if (!drone || !drone.reloadPhase) return;
    const hold = holdPoint(ctx);
    drone.holdX = hold.x;
    drone.holdY = hold.y;
    drone.reloadT += dt;

    if (drone.reloadPhase === 'grab') {
      integrateToward(dt, hold, ctx, 80, {
        maxSpeed: 520,
        accel: 1600,
        damp: 5,
      });
      if (drone.reloadT >= RELOAD.grab || Math.hypot(drone.x - hold.x, drone.y - hold.y) < 10) {
        drone.reloadPhase = 'fiddle';
        drone.reloadT = 0;
        drone.reloadCommit = false;
      }
      return;
    }

    if (drone.reloadPhase === 'fiddle') {
      /* 贴身轻晃，模拟捣鼓 */
      const wobble = Math.sin(drone.reloadT * 14) * 2.2;
      const tuck = {
        x: hold.x + (ctx.facing >= 0 ? 1 : -1) * wobble,
        y: hold.y + Math.sin(drone.reloadT * 9) * 1.6,
      };
      integrateToward(dt, tuck, ctx, 60, {
        maxSpeed: 180,
        accel: 900,
        damp: 10,
      });
      drone.aimAngle = ctx.facing >= 0 ? -0.35 : Math.PI + 0.35;
      drone.facing = ctx.facing >= 0 ? 1 : -1;
      if (!drone.reloadCommit && drone.reloadT / RELOAD.fiddle >= RELOAD.commitAt) {
        drone.reloadCommit = true;
        commitReloadAmmo(held);
      }
      if (drone.reloadT >= RELOAD.fiddle) {
        if (!drone.reloadCommit) {
          drone.reloadCommit = true;
          commitReloadAmmo(held);
        }
        drone.reloadPhase = 'release';
        drone.reloadT = 0;
      }
      return;
    }

    if (drone.reloadPhase === 'release') {
      const desire = hoverDesire({
        ...ctx,
        aimX: ctx.playerX + (ctx.facing >= 0 ? 1 : -1) * 120,
        aimY: ctx.playerY - 40,
        selected: isDroneSelected(),
      });
      integrateToward(dt, desire, ctx, desire.maxLeash, {
        maxSpeed: 480,
        accel: 1200,
        damp: 5.5,
      });
      if (drone.reloadT >= RELOAD.release) {
        drone.reloadPhase = null;
        drone.reloadT = 0;
        drone.reloadCommit = false;
        drone.shotCd = 0.2;
        clearReloadHint();
      }
    }
  }

  /** 枪械换弹动画占用时不抢 toast。 */
  function isGunReloadBusy() {
    return Boolean(window.LpReloadAction?.isBusy?.());
  }

  /** 显示与枪械相同的「装填中…」；枪械忙则跳过。 */
  function showReloadHint() {
    if (isGunReloadBusy()) return;
    const ms = Math.ceil((RELOAD.grab + RELOAD.fiddle + RELOAD.release + 0.4) * 1000);
    window.LiminalInteract?.showToast?.(RELOAD_HINT, ms);
  }

  /** 装填结束时清掉本模块的进行中提示（不碰枪械或其它 toast）。 */
  function clearReloadHint() {
    if (isGunReloadBusy()) return;
    window.LiminalInteract?.clearToastIf?.(RELOAD_HINT);
  }

  /**
   * 跟飞或设备占用时的车厢巡逻；装填中改走 updateReload。
   * @param {number} dt
   * @param {{ playerX: number, playerY: number, aimX: number, aimY: number, facing: number, selected: boolean }} ctx
   */
  function updateMotion(dt, ctx) {
    if (!drone) return;
    if (drone.reloadPhase) return;

    const busy = isPlayerEquipmentBusy();
    let desire;
    let tune;
    if (busy) {
      desire = patrolDesire(ctx);
      if (desire) {
        tune = {
          maxSpeed: PATROL_SPEED,
          accel: PATROL_ACCEL,
          damp: PATROL_DAMP,
          skipLeash: true,
        };
      }
    } else {
      drone.patrolDir = null;
      drone.patrolCarId = null;
    }
    if (!desire) {
      desire = hoverDesire(ctx);
      tune = undefined;
    }
    integrateToward(dt, desire, ctx, desire.maxLeash, tune);

    const item = Catalog.getItem(ITEM_ID) || {};
    const bobAmp = Number(item.bobAmp) || 5.5;
    const bobHz = Number(item.bobHz) || BOB_HZ_DEFAULT;
    drone.bobT += dt * bobHz * Math.PI * 2;
    drone.bobY = Math.sin(drone.bobT) * bobAmp;
    if (Math.abs(drone.vx) > 8) {
      drone.facing = drone.vx >= 0 ? 1 : -1;
    }
  }

  /**
   * 炮口世界坐标（按当前 aimAngle / 镜像）。
   * @param {object} item
   */
  function getMuzzleWorld(item) {
    if (!drone) return { x: 0, y: 0 };
    const mount = item.barrelMount || { x: 0, y: 10.2 };
    const pivotX = Number(item.barrelPivotX) || 9.2;
    const muzzleLen = Number(item.muzzleLength) || 34;
    const drawY = drone.y + (drone.bobY || 0);
    const mx = drone.x + mount.x;
    const my = drawY + mount.y;
    const ang = drone.aimAngle;
    const tipLocal = muzzleLen - pivotX;
    return {
      x: mx + Math.cos(ang) * tipLocal,
      y: my + Math.sin(ang) * tipLocal,
    };
  }

  /**
   * 扣除一发弹匣（仅离线权威；联机本地扣减供 UI，快照可能回写）。
   * @param {{ hands: object, index: number, stack: object, item: object }} held
   * @returns {boolean}
   */
  function consumeMagRound(held) {
    const mag = held.stack.mag ?? 0;
    if (mag <= 0) return false;
    const next = held.hands.updateSlot?.(held.index, { mag: mag - 1 });
    if (next) held.stack = next;
    else held.stack.mag = mag - 1;
    window.LpInventory?.persistAndRender?.();
    window.LpHandsHud?.render?.();
    return true;
  }

  /**
   * 从背包/手部消耗小口径子弹写入弹匣（装填关键帧或离线即时）。
   * @param {{ hands: object, index: number, stack: object, item: object }} held
   * @returns {boolean}
   */
  function commitReloadAmmo(held) {
    if (!held) return false;
    const { item, stack } = held;
    if (!item.magazineSize || !item.ammoId) return false;
    const need = item.magazineSize - (stack.mag ?? 0);
    if (need <= 0) return false;
    const have =
      (window.LpInventory?.getPlayerInventory?.()?.countItem?.(item.ammoId) ?? 0) +
      (window.LpInventory?.getHandsInventory?.()?.countItem?.(item.ammoId) ?? 0);
    if (have <= 0) return false;

    if (window.LpInventoryNet?.isActive?.()) {
      window.LpInventoryNet.sendOp({
        action: 'reload',
        handIndex: held.index,
      });
      return true;
    }

    const take = Math.min(need, have);
    const removed = window.LpInventory?.consumeItem?.(item.ammoId, take) ?? 0;
    if (removed <= 0) return false;
    const nextMag = (stack.mag ?? 0) + removed;
    const next = held.hands.updateSlot?.(held.index, { mag: nextMag });
    if (next) held.stack = next;
    else stack.mag = nextMag;
    window.LpInventory?.persistAndRender?.();
    window.LpHandsHud?.render?.();
    window.LiminalInteract?.showToast?.(
      `无人机装填 ${removed} 发（${(next || stack).mag}/${item.magazineSize}）`
    );
    return true;
  }

  /**
   * 发射单发小口径弹（走 LpCombat.spawnProjectile，不占玩家开火冷却）。
   * 开火前校验弹道清通；提前点被墙挡住则改打当前坐标，仍不通则不开火、不扣弹。
   * @param {object} held
   * @param {object} target
   */
  function fireOne(held, target) {
    const { item } = held;
    const muzzle = getMuzzleWorld(item);
    let aimX = target.x;
    let aimY = target.y;
    const lead = window.LpCombat?.predictLeadAim?.(muzzle.x, muzzle.y, target);
    if (
      lead &&
      Number.isFinite(lead.x) &&
      hasClearShot(muzzle.x, muzzle.y, lead.x, lead.y)
    ) {
      aimX = lead.x;
      aimY = lead.y;
    } else if (!hasClearShot(muzzle.x, muzzle.y, target.x, target.y)) {
      return false;
    }
    if (!consumeMagRound(held)) return false;
    const dirX = aimX - muzzle.x;
    const dirY = aimY - muzzle.y;
    const facing = dirX >= 0 ? 1 : -1;
    drone.aimAngle = Math.atan2(dirY, dirX);
    drone.facing = facing;

    const pressureScale = window.LpPressure?.getAccuracySpreadScale?.() ?? 1;
    const baseDeg = item.spreadBaseDeg ?? 1.4;
    const bloomDeg = item.spreadBloomDeg ?? 4;
    const spreadRad = ((baseDeg + bloomDeg * 0.25) * Math.PI) / 180 * pressureScale;
    const ang = drone.aimAngle + (Math.random() * 2 - 1) * spreadRad;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);

    window.LpCombat?.spawnProjectile?.({
      originX: muzzle.x,
      originY: muzzle.y,
      dirX: dx,
      dirY: dy,
      facing,
      weaponId: item.weaponId || ITEM_ID,
      item,
      style: item.projectileStyle || 'bullet',
      flash: true,
      damage: item.damage,
      range: item.maxRange,
    });
    window.LpCombat?.playFireSfxAt?.(item, muzzle.x, muzzle.y, {
      volume: (item.fireSoundVolume ?? 0.42) * 0.85,
    });
    return true;
  }

  /**
   * 点射状态机：3 连发，发间短间隔，轮间较长冷却。装填中跳过。
   * @param {number} dt
   * @param {object} held
   * @param {object|null} target
   */
  function updateCombat(dt, held, target) {
    if (!drone || !held) return;
    if (drone.reloadPhase) {
      drone.burstLeft = 0;
      return;
    }
    const item = held.item;
    const burstSize = Math.max(1, Number(item.burstCount) || 3);
    const shotGap = Number(item.burstShotGap) || 0.075;
    const burstGap = Number(item.burstCooldown) || 0.55;

    drone.shotCd = Math.max(0, drone.shotCd - dt);

    if (target) {
      const muzzle = getMuzzleWorld(item);
      drone.aimAngle = Math.atan2(target.y - muzzle.y, target.x - muzzle.x);
      drone.targetId = target.id != null ? String(target.id) : null;
    } else {
      drone.targetId = null;
      const rest = drone.facing >= 0 ? 0 : Math.PI;
      let d = rest - drone.aimAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      drone.aimAngle += d * Math.min(1, dt * 4);
    }

    if (!target) {
      drone.burstLeft = 0;
      return;
    }
    if ((held.stack.mag ?? 0) <= 0) {
      drone.burstLeft = 0;
      return;
    }
    if (drone.shotCd > 0) return;

    if (drone.burstLeft <= 0) {
      drone.burstLeft = burstSize;
    }
    if (fireOne(held, target)) {
      drone.burstLeft -= 1;
      drone.shotCd = drone.burstLeft > 0 ? shotGap : burstGap;
    } else {
      drone.burstLeft = 0;
      drone.shotCd = burstGap;
    }
  }

  /**
   * 选中无人机时按 R：开始抓取→捣鼓→放飞装填；已在装填中则吞掉按键。
   * @returns {boolean} true 表示已处理（不再交给枪械换弹）
   */
  function tryReload() {
    const held = getDroneHandSlot();
    if (!held) {
      window.LiminalInteract?.showToast?.('没有装备蜂鸟无人机');
      return false;
    }
    if (!isDroneSelected()) return false;
    if (!drone) {
      ensureSpawn(held.item, {
        playerX: window.LpGame?.getLocalX?.() ?? 0,
        playerY: 0,
        facing: 1,
      });
    }
    if (drone.reloadPhase) {
      return true;
    }
    const { item, stack } = held;
    if (!item.magazineSize || !item.ammoId) return true;
    const need = item.magazineSize - (stack.mag ?? 0);
    if (need <= 0) {
      window.LiminalInteract?.showToast?.('无人机弹匣已满');
      return true;
    }
    const have =
      (window.LpInventory?.getPlayerInventory?.()?.countItem?.(item.ammoId) ?? 0) +
      (window.LpInventory?.getHandsInventory?.()?.countItem?.(item.ammoId) ?? 0);
    if (have <= 0) {
      const ammoName = Catalog.getItem(item.ammoId)?.name || '弹药';
      window.LiminalInteract?.showToast?.(`没有${ammoName}`);
      return true;
    }

    drone.reloadPhase = 'grab';
    drone.reloadT = 0;
    drone.reloadCommit = false;
    drone.burstLeft = 0;
    drone.bobY = 0;
    showReloadHint();
    return true;
  }

  /**
   * 若选中无人机则优先走本模块装填；否则 false 交给枪械换弹。
   * @returns {boolean}
   */
  function tryReloadIfSelected() {
    if (!isDroneSelected()) return false;
    return tryReload();
  }

  /**
   * 联机 pose 附加字段（本地权威位姿）；无伴飞时返回 null。
   * @returns {null | { droneX: number, droneY: number, droneVx: number, droneVy: number, droneAim: number, dronePhase: number }}
   */
  function poseExtras() {
    if (!drone) return null;
    const phase =
      drone.reloadPhase === 'grab'
        ? 1
        : drone.reloadPhase === 'fiddle'
          ? 2
          : drone.reloadPhase === 'release'
            ? 3
            : 0;
    return {
      droneX: drone.x,
      droneY: drone.y,
      droneVx: drone.vx,
      droneVy: drone.vy,
      droneAim: drone.aimAngle,
      dronePhase: phase,
    };
  }

  /**
   * 服务端回显本机无人机位姿：本地权威优先软 lerp；仅灾难级误差才硬对齐。
   * @param {{ droneX?: number, droneY?: number, droneVx?: number, droneVy?: number, droneAim?: number }} pose
   */
  function applyServerPose(pose) {
    if (!drone || !pose) return;
    if (drone.reloadPhase) return;
    const sx = Number(pose.droneX);
    const sy = Number(pose.droneY);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
    const err = Math.hypot(drone.x - sx, drone.y - sy);
    if (err <= SOFT_ERR) return;
    if (err > SNAP_ERR) {
      /* 仅房间级/传送级偏差：硬对齐一次，非每帧路径。 */
      drone.x = sx;
      drone.y = sy;
      drone.vx = Number(pose.droneVx) || 0;
      drone.vy = Number(pose.droneVy) || 0;
      if (Number.isFinite(Number(pose.droneAim))) drone.aimAngle = Number(pose.droneAim);
      return;
    }
    const k = SOFT_BLEND;
    drone.x += (sx - drone.x) * k;
    drone.y += (sy - drone.y) * k;
    if (Number.isFinite(Number(pose.droneVx))) {
      drone.vx += (Number(pose.droneVx) - drone.vx) * k;
    }
    if (Number.isFinite(Number(pose.droneVy))) {
      drone.vy += (Number(pose.droneVy) - drone.vy) * k;
    }
  }

  /**
   * 写入远端无人机目标快照（由 world_snapshot 驱动）。
   * @param {string} playerId
   * @param {null | { droneX?: number, droneY?: number, droneVx?: number, droneVy?: number, droneAim?: number, dronePhase?: number }} pose
   */
  function applyRemotePose(playerId, pose) {
    const id = String(playerId || '');
    if (!id) return;
    if (
      !pose ||
      !Number.isFinite(Number(pose.droneX)) ||
      !Number.isFinite(Number(pose.droneY))
    ) {
      remotes.delete(id);
      return;
    }
    let remote = remotes.get(id);
    if (!remote) {
      remote = {
        x: Number(pose.droneX),
        y: Number(pose.droneY),
        vx: Number(pose.droneVx) || 0,
        vy: Number(pose.droneVy) || 0,
        aimAngle: Number(pose.droneAim) || 0,
        bobT: Math.random() * Math.PI * 2,
        bobY: 0,
        tx: Number(pose.droneX),
        ty: Number(pose.droneY),
        tvx: Number(pose.droneVx) || 0,
        tvy: Number(pose.droneVy) || 0,
        tAim: Number(pose.droneAim) || 0,
        phase: Number(pose.dronePhase) || 0,
      };
      remotes.set(id, remote);
      const item = Catalog.getItem(ITEM_ID);
      if (item?.bodySprite) preload(item.bodySprite, item.barrelSprite);
      return;
    }
    remote.tx = Number(pose.droneX);
    remote.ty = Number(pose.droneY);
    remote.tvx = Number(pose.droneVx) || 0;
    remote.tvy = Number(pose.droneVy) || 0;
    if (Number.isFinite(Number(pose.droneAim))) remote.tAim = Number(pose.droneAim);
    remote.phase = Number(pose.dronePhase) || 0;
  }

  /** 远端离开房间时清伴飞。 */
  function clearRemote(playerId) {
    remotes.delete(String(playerId || ''));
  }

  /** 清空全部远端伴飞（换房）。 */
  function clearAllRemotes() {
    remotes.clear();
  }

  /**
   * 平滑推进远端无人机朝快照目标（默认软追；仅灾难级误差硬对齐）。
   * @param {number} dt
   */
  function tickRemotes(dt) {
    const item = Catalog.getItem(ITEM_ID) || {};
    const bobAmp = Number(item.bobAmp) || 5.5;
    const bobHz = Number(item.bobHz) || BOB_HZ_DEFAULT;
    for (const remote of remotes.values()) {
      const err = Math.hypot(remote.tx - remote.x, remote.ty - remote.y);
      if (err > SNAP_ERR) {
        remote.x = remote.tx;
        remote.y = remote.ty;
        remote.vx = remote.tvx;
        remote.vy = remote.tvy;
        remote.aimAngle = remote.tAim;
      } else {
        /* 误差越大追得稍快，但仍是连续 lerp，避免 96px 级每帧硬切。 */
        const chase = err > CATCHUP_DIST ? 8 : 6;
        const k = Math.min(1, dt * chase);
        remote.x += (remote.tx - remote.x) * k;
        remote.y += (remote.ty - remote.y) * k;
        remote.vx += (remote.tvx - remote.vx) * k;
        remote.vy += (remote.tvy - remote.vy) * k;
        let dAim = remote.tAim - remote.aimAngle;
        while (dAim > Math.PI) dAim -= Math.PI * 2;
        while (dAim < -Math.PI) dAim += Math.PI * 2;
        remote.aimAngle += dAim * k;
      }
      remote.bobT += dt * bobHz * Math.PI * 2;
      remote.bobY = remote.phase >= 1 && remote.phase <= 2 ? 0 : Math.sin(remote.bobT) * bobAmp;
    }
  }

  /**
   * 绘制单个无人机实体（本地或远端共用）。
   * 机身+炮管共用沿 vx 的移动俯仰（flightLeanRad）；炮管另加瞄准仰角。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ x: number, y: number, aimAngle: number, bobY?: number, vx?: number }} entity
   */
  function drawEntity(ctx, entity) {
    const item = Catalog.getItem(ITEM_ID);
    if (!item) return;
    if (!imgs.body && item.bodySprite) preload(item.bodySprite, item.barrelSprite);

    const bodyW = Number(item.bodyDrawW) || 56;
    const bodyH = Number(item.bodyDrawH) || 24;
    const barrelW = Number(item.barrelDrawW) || 34;
    const barrelH = Number(item.barrelDrawH) || 4;
    const mount = item.barrelMount || { x: 0, y: 10.2 };
    const pivotX = Number(item.barrelPivotX) || 9.2;
    const pivotY = Number(item.barrelPivotY) || 0.45;

    const drawY = entity.y + (entity.bobY || 0);
    let ang = entity.aimAngle;
    while (ang > Math.PI) ang -= Math.PI * 2;
    while (ang <= -Math.PI) ang += Math.PI * 2;
    const faceLeft = Math.cos(ang) < 0;
    const elev = Math.atan2(Math.sin(ang), Math.abs(Math.cos(ang)));
    const lean = flightLeanRad(entity);

    const barrelImg = imgs.barrel;
    const bodyImg = imgs.body;

    /* 父变换：速度俯仰；子级再镜像 / 炮管仰角。 */
    ctx.save();
    ctx.translate(entity.x, drawY);
    ctx.rotate(lean);

    ctx.save();
    ctx.translate(mount.x, mount.y);
    if (faceLeft) ctx.scale(-1, 1);
    ctx.rotate(elev);
    if (barrelImg?.complete && barrelImg.naturalWidth) {
      ctx.drawImage(barrelImg, -pivotX, -pivotY, barrelW, barrelH);
    } else {
      ctx.fillStyle = '#3a614d';
      ctx.fillRect(-pivotX, -pivotY, barrelW * 0.35, barrelH);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(-pivotX + barrelW * 0.32, -pivotY + 1, barrelW * 0.68, barrelH - 2);
    }
    ctx.restore();

    ctx.save();
    if (faceLeft) ctx.scale(-1, 1);
    if (bodyImg?.complete && bodyImg.naturalWidth) {
      ctx.drawImage(bodyImg, -bodyW / 2, -bodyH / 2, bodyW, bodyH);
    } else {
      ctx.fillStyle = '#4a7a5c';
      ctx.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
    }
    ctx.restore();

    ctx.restore();
  }

  /**
   * 绘制本机伴飞（炮管下层 + 机身上层）。
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    if (!drone) return;
    drawEntity(ctx, drone);
  }

  /**
   * 绘制其它玩家的伴飞无人机（仅与本机同场景的主人；避免月台/列车异场景幽灵机）。
   * @param {CanvasRenderingContext2D} ctx
   */
  function drawRemotes(ctx) {
    const localScene =
      window.LpPlatform?.getScene?.() === 'platform' ? 'platform' : 'train';
    const owners = window.LiminalSession?.remotes?.();
    for (const [id, remote] of remotes.entries()) {
      const owner = owners?.get?.(id);
      if (owner?._lpDisconnected) continue;
      const ownerScene = owner?._lpScene === 'platform' ? 'platform' : 'train';
      if (ownerScene !== localScene) continue;
      drawEntity(ctx, remote);
    }
  }

  /**
   * 每帧：生成/销毁、跟飞或装填、选敌、点射。
   * @param {number} dt
   * @param {{ playerX: number, playerY: number, aimX: number, aimY: number, facing?: number }} ctx
   */
  function tick(dt, ctx = {}) {
    if (window.LpPlayerDeath?.isIncapacitated?.()) {
      despawn();
      return;
    }
    const held = getDroneHandSlot();
    if (!held) {
      despawn();
      return;
    }
    ensureSpawn(held.item, {
      playerX: ctx.playerX,
      playerY: ctx.playerY,
      facing: ctx.facing >= 0 ? 1 : -1,
    });

    /* 下月台/进地牢后世界坐标跳变：过远则瞬移到身旁，避免“有装备但看不见” */
    if (
      drone &&
      window.LpPlatform?.getScene?.() === 'platform' &&
      Math.hypot(drone.x - ctx.playerX, drone.y - ctx.playerY) > 520
    ) {
      const face = ctx.facing >= 0 ? 1 : -1;
      drone.x = ctx.playerX + face * 36;
      drone.y = ctx.playerY - 78;
      drone.vx = 0;
      drone.vy = 0;
    }

    const selected = isDroneSelected();
    const facing = ctx.facing >= 0 ? 1 : -1;
    const motionCtx = {
      playerX: ctx.playerX,
      playerY: ctx.playerY,
      aimX: ctx.aimX,
      aimY: ctx.aimY,
      facing,
      selected,
    };

    if (drone.reloadPhase) {
      updateReload(dt, motionCtx, held);
    } else {
      updateMotion(dt, motionCtx);
      const busy = isPlayerEquipmentBusy();
      const anchorX = busy ? drone.x : selected ? ctx.aimX : ctx.playerX;
      const anchorY = busy ? drone.y : selected ? ctx.aimY : ctx.playerY - 40;
      const target = pickTarget(anchorX, anchorY, ctx.playerX, held.item);
      updateCombat(dt, held, target);
    }
  }

  window.LpHummingbirdDrone = {
    ITEM_ID,
    RELOAD,
    engageRangeX,
    getDroneHandSlot,
    isDroneSelected,
    isReloading,
    isPlayerEquipmentBusy,
    tryReload,
    tryReloadIfSelected,
    tick,
    draw,
    drawRemotes,
    tickRemotes,
    despawn,
    getDrone: () => drone,
    poseExtras,
    applyServerPose,
    applyRemotePose,
    clearRemote,
    clearAllRemotes,
  };
})();

/*
 * 装填状态机（选中 + R）：
 *   grab 0.30s → fiddle 1.15s（进度 0.48 提交弹匣）→ release 0.35s → hover
 *   期间不开火；弹药 small_caliber_ammo → stack.mag（上限 120）。
 *
 * 设备占用巡逻：
 *   isManned / 锅炉 / 加燃料 / 雷达 / 枢机 / 卫士箱 UI → 当前车厢 WALK 内往返。
 *   退出后恢复跟飞（选中准星 / 未选中身旁）。
 *   移速倍率仍按距主人（非巡逻端点），远离时可更快回跟。
 *
 * 距主人移速：
 *   scale = MIN + smoothstep((od-NEAR)/(FAR-NEAR)) * (MAX-MIN)
 *   NEAR=72 FAR=420 MIN=0.55 MAX=1.85；再乘 desire 追赶 / arrive。
 *
 * 视觉俯仰：
 *   lean = clamp(vx/LEAN_SPEED_REF, -1, 1) * LEAN_MAX（仅绘制；沿移动方向，非瞄准）。
 *
 * 联机：
 *   客户端模拟位姿；pose 带 droneX/Y/Vx/Vy/Aim/Phase；服务端回显广播。
 *   本机软矫正（>48px lerp k=0.12，>720px 才 snap）；远端软追，同阈值。
 *   跟飞积分永不硬写 x/y；脱绳靠加速追赶，不瞬移。
 *   弹道仍仅本地（与枪械本地先行一致）；远端可见伴飞体。
 */
