/**
 * 月台首通：列车 / 月台两套场景切换（连接处 F 下月台；月台回车点 F 上车）。
 * - 停靠：路线进度接近站点且车速≈0 → atPlatform（亦可 debugDock）
 * - 站间距约满档 150s；离站后雷达延迟 60–120s（种子）才显示下一站
 * - 自动驾驶：LpAutoAutopilot 读传感近站急刹；本模块钳制路线避免冲过站
 * - 回车重生在离开时的同一连接处索引
 * - 月台灰矩形占位 + 编辑台（会话内编组顺序/空车·仓储显隐）
 * - 发车锁：任一玩家仍在月台场景时禁止非零油门
 */
(() => {
  const Spec = () => window.LiminalCarriageSpec;
  const GREY = '#c8c8c8';
  const GREY_DARK = '#9a9a9a';
  const GREY_EDIT = '#b0b0b0';

  /**
   * 站点间距（路线单位；与速度积分同量纲）。
   * 满档巡航 route 速率 ≈ MAX_SPEED(5)×220 = 1100 u/s → 约 150s 一程（1–3 分钟中段）。
   */
  const STATION_SPACING = 165000;
  /**
   * 离站后雷达显示「下一站」的行驶时间（秒，按世界种子+离站站序取值）。
   * 落在 60–120，保证满档下仍早于到站、符合「行驶约 1–2 分钟后才见下一站」。
   */
  const RADAR_REVEAL_SEC_MIN = 60;
  const RADAR_REVEAL_SEC_MAX = 120;
  /** 前方有月台传感距离（对齐 LpAutoSensors.PLATFORM_AHEAD_DIST）。 */
  const AHEAD_DIST = 800;
  /**
   * 小怪禁近火车缓冲区（路线单位）：当前/最近站心前后各此距离。
   * 满档巡航 ≈ MAX_SPEED(5)×220 = 1100 u/s → 约 14s 行程；远大于 AHEAD_DIST(800)，
   * 进站缓行时墙钟更长，体感为「月台前后一带」，而非传感窗那么短。
   * LpMobs：区内轨面/俯冲不朝火车靠拢，且不刷列车波次怪。
   */
  const MOB_TRAIN_SAFE_DIST = 15000;
  /**
   * 可停靠距离阈值（路线单位）。
   * 须宽于自动驾驶近站急刹后的滑行余量；过窄会冲过站永远停不上。
   */
  const DOCK_DIST = 160;
  /**
   * 进站钳制：距站小于此值时不再让 route 冲过站点（等车停稳后 dock）。
   * 对齐自动驾驶 DIST_EMERGENCY / DIST_CREEP 量级。
   */
  const CAPTURE_DIST = 300;
  /** 车速视为停稳。 */
  const STOP_SPEED = 0.08;

  /**
   * 清空跨场景短暂 VFX / 弹道（进出月台时调用，避免粒子与弹壳残留涨内存）。
   * 列车机炮弹壳/火光一并清掉，防止停靠后漏进月台画面。
   */
  function clearSceneTransientFx() {
    window.LpCombat?.clearWorldFx?.();
    window.LpImpactFx?.clear?.();
    window.LpMobDeathFx?.clear?.();
    window.LpGuardTurret?.clearFlashes?.();
    window.LpFireExtinguisher?.clearMist?.();
    window.LpMobBubbleFill?.reset?.();
  }
  /** 连接处交互半宽（世界）。 */
  const COUPLER_RADIUS = 90;
  /** 月台场景尺寸（世界）。 */
  const PLAT_W = 2200;
  const PLAT_H = 900;
  const PLAT_FLOOR_Y = 720;
  const PLAT_WALK_LEFT = 120;
  const PLAT_WALK_RIGHT = PLAT_W - 120;

  /** @type {'train'|'platform'} */
  let scene = 'train';
  let routeX = 0;
  let atPlatform = false;
  let forceDock = false;
  /** 离开火车时记住的连接处索引（回车用）。 */
  let exitCouplerIndex = 0;
  /** 月台场景内本地 X（相对月台原点）。 */
  let platformLocalX = PLAT_WALK_LEFT + 200;
  let editOpen = false;
  /** @type {number|null} */
  let worldSeed = null;
  /** 停靠锁定的站序（routeX / spacing）。 */
  let lockedStationIndex = 0;
  /** @type {'small'|'large'|null} */
  let platformKind = null;
  /** @type {ReturnType<typeof window.LpDungeon.generate>|null} */
  let dungeon = null;
  /** 月台多楼层：上一帧所站地板 Y，供 floorAt 近邻选择。 */
  let lastPlatformFloorY = null;
  /** 最近一次楼层 Y 变化（叠井楼梯时偏向继续上/下）。 */
  let lastFloorDelta = 0;
  /** 本程离站时刻（performance.now）；未离站为 null。 */
  let departedAtMs = null;
  /** 本程雷达揭示下一站所需行驶秒数（离站时按种子锁定）。 */
  let radarRevealSec = 90;
  /** 雷达铁轨走向缓存（seed+站序）；量程只裁窗口。 */
  let trackAlignCache = { key: '', pts: null };

  const editRoot = document.getElementById('lpPlatformEditRoot');
  const editList = document.getElementById('lpPlatformEditList');
  const editAdd = document.getElementById('lpPlatformEditAdd');
  const editStatus = document.getElementById('lpPlatformEditStatus');

  /** @type {{ carId: string, pointerId: number, startX: number }|null} */
  let editDrag = null;

  /**
   * 编组连接处列表（节间连廊中心）。
   * @returns {Array<{ index: number, worldX: number, leftCarId: string, rightCarId: string }>}
   */
  function listCouplers() {
    const S = Spec();
    const cars = S?.CARRIAGES;
    if (!cars?.length) return [];
    const out = [];
    for (let i = 0; i < cars.length - 1; i += 1) {
      const left = cars[i];
      const right = cars[i + 1];
      const leftEdge = left.worldX + S.WALK_RIGHT;
      const rightEdge = right.worldX + S.WALK_LEFT;
      out.push({
        index: i,
        worldX: (leftEdge + rightEdge) / 2,
        leftCarId: left.id,
        rightCarId: right.id,
      });
    }
    return out;
  }

  /** 最近连接处；过远返回 null。 */
  function nearestCoupler(worldX) {
    const list = listCouplers();
    let best = null;
    let bestD = Infinity;
    for (const c of list) {
      const d = Math.abs(worldX - c.worldX);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best || bestD > COUPLER_RADIUS) return null;
    return best;
  }

  /** 连接处世界 X；越界夹到合法索引。 */
  function couplerWorldX(index) {
    const list = listCouplers();
    if (!list.length) return Spec()?.defaultSpawnX?.() ?? 0;
    const i = Math.max(0, Math.min(list.length - 1, index | 0));
    return list[i].worldX;
  }

  /** 到下一站点的前方距离（路线单位）。对齐站心时为 0。 */
  function distanceToStation() {
    if (forceDock) return 0;
    const mod = ((routeX % STATION_SPACING) + STATION_SPACING) % STATION_SPACING;
    /* mod≈0 表示正好处在站心（非整站间距外的「下一站」） */
    if (mod < 0.75) return 0;
    return STATION_SPACING - mod;
  }

  /**
   * 沿路线到最近站心的距离（前方或刚驶过的后方取较小者）。
   * 停靠 / 强制停靠视为 0；供小怪禁近火车区判定。
   * @returns {number}
   */
  function distanceToNearestStation() {
    if (atPlatform || forceDock) return 0;
    const mod = ((routeX % STATION_SPACING) + STATION_SPACING) % STATION_SPACING;
    if (mod < 0.75) return 0;
    const ahead = STATION_SPACING - mod;
    const behind = mod;
    return Math.min(ahead, behind);
  }

  /**
   * 列车是否处于月台前后缓冲区内（含停靠）。
   * 区内小怪不应再朝火车接近；见 MOB_TRAIN_SAFE_DIST。
   * @returns {boolean}
   */
  function isNearPlatformMobSafeZone() {
    return distanceToNearestStation() <= MOB_TRAIN_SAFE_DIST;
  }

  /** 刷新 LpAutoSensors 月台 stub。 */
  function syncSensorStub() {
    const dist = distanceToStation();
    window.LpAutoSensors?.setPlatformStub?.({
      platformAhead: atPlatform || dist <= AHEAD_DIST,
      atPlatform,
      distanceAhead: atPlatform ? 0 : dist,
    });
  }

  /** 是否停靠月台。 */
  function isAtPlatform() {
    return atPlatform;
  }

  /** 本机是否在月台场景。 */
  function isLocalOnPlatform() {
    return scene === 'platform';
  }

  /** 当前场景。 */
  function getScene() {
    return scene;
  }

  /**
   * 联机远端或本机是否仍有人在月台。
   * @returns {boolean}
   */
  function anyPlayerOnPlatform() {
    if (scene === 'platform') return true;
    const remotes = window.LiminalSession?.remotes?.();
    if (!remotes) return false;
    for (const remote of remotes.values()) {
      if (remote._lpDisconnected) continue;
      if (remote._lpScene === 'platform') return true;
    }
    return false;
  }

  /** 是否允许离开空档发车（停靠时要求全员在车厢上，含拉汽笛者）。 */
  function canDepart() {
    return atPlatform ? !anyPlayerOnPlatform() : true;
  }

  /** 发车锁文案；可发车时 null。 */
  function getDepartBlockReason() {
    if (!atPlatform) return null;
    if (!anyPlayerOnPlatform()) return null;
    if (scene === 'platform') return '还有玩家在月台上（你仍在月台，请先回车）';
    return '还有玩家在月台上';
  }

  /**
   * 由世界种子与离站站序得到本程雷达揭示延迟（秒）。
   * @param {number} fromStationIndex
   * @returns {number}
   */
  function pickRadarRevealSec(fromStationIndex) {
    const seed = getWorldSeed() >>> 0;
    const idx = (fromStationIndex | 0) >>> 0;
    let h = (seed ^ Math.imul(idx + 1, 0x9e3779b9)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    const span = RADAR_REVEAL_SEC_MAX - RADAR_REVEAL_SEC_MIN;
    return RADAR_REVEAL_SEC_MIN + (h % (span + 1));
  }

  /**
   * 离站：解除停靠、推离站心，并锁定本程雷达揭示计时。
   * @returns {number} 离站时的站序
   */
  function leavePlatformRoute() {
    const from = lockedStationIndex;
    forceDock = false;
    atPlatform = false;
    routeX = Math.floor(routeX / STATION_SPACING) * STATION_SPACING + 4;
    departedAtMs = performance.now();
    radarRevealSec = pickRadarRevealSec(from);
    syncSensorStub();
    window.dispatchEvent(
      new CustomEvent('liminal:platform-depart', {
        detail: { stationIndex: from },
      })
    );
    return from;
  }

  /**
   * 进站停靠上升沿：对齐站心并广播 arrive（供柱列 FX / BGM 等）。
   */
  function enterDockedState() {
    atPlatform = true;
    lockedStationIndex = stationIndexFromRoute();
    routeX =
      Math.floor(routeX / STATION_SPACING + 1e-9) * STATION_SPACING +
      STATION_SPACING;
    window.dispatchEvent(
      new CustomEvent('liminal:platform-arrive', {
        detail: { stationIndex: lockedStationIndex },
      })
    );
  }

  /**
   * 行驶中是否已可在雷达上显示下一站标。
   * 停靠显示当前站；离站后须满揭示秒数，或已进入近站传感窗（避免盲进站）。
   * @returns {boolean}
   */
  function isNextPlatformRadarVisible() {
    if (atPlatform || forceDock) return true;
    if (departedAtMs == null) return true;
    if (distanceToStation() <= AHEAD_DIST) return true;
    const elapsedSec = (performance.now() - departedAtMs) / 1000;
    return elapsedSec >= radarRevealSec;
  }

  /**
   * 自动驾驶汽笛发车：校验全员在车后立刻离站，驶向下一个月台。
   * 解除 forceDock / atPlatform，并把 route 略推离站心，避免下一帧再进停靠窗。
   * @returns {boolean} 是否已开始离站
   */
  function beginDepart() {
    if (!atPlatform) return false;
    if (!canDepart()) return false;
    leavePlatformRoute();
    return true;
  }

  /** 写入房间世界种子（快照 / 离线本地种）；同步背景与视差层重建。 */
  function setWorldSeed(seed) {
    if (seed == null || !Number.isFinite(Number(seed))) return;
    worldSeed = Number(seed) >>> 0;
    window.LpWorldBackground?.setSeed?.(worldSeed);
    window.LpParallaxLayers?.setSeed?.(worldSeed);
  }

  /** 当前世界种子；无则本地生成一次。 */
  function getWorldSeed() {
    if (worldSeed == null) {
      worldSeed = (Math.random() * 0x1fffffffffffff) >>> 0;
    }
    return worldSeed;
  }

  /** 由 routeX 推算站序。 */
  function stationIndexFromRoute() {
    return Math.max(0, Math.floor(routeX / STATION_SPACING + 1e-6));
  }

  /** 当前（或停靠锁定）站序。 */
  function getStationIndex() {
    return atPlatform ? lockedStationIndex : stationIndexFromRoute();
  }

  /** 解析当前站月台类型。 */
  function resolvePlatformKind(stationIndex) {
    const D = window.LpDungeon;
    if (!D?.resolveKind) return 'large';
    return D.resolveKind(getWorldSeed(), stationIndex | 0);
  }

  /** 当前月台类型（进站后缓存）。 */
  function getPlatformKind() {
    if (platformKind) return platformKind;
    return resolvePlatformKind(getStationIndex());
  }

  /** 当前地牢实例（仅 small）。 */
  function getDungeon() {
    return dungeon;
  }

  /** 地牢房间高度占位（与 LpDungeon.ROOM_H 对齐；仅作 topY 缺失时的回退）。 */
  const ROOM_H_FALLBACK = window.LpDungeon?.ROOM_H || 634;

  /** 月台行走边界（供主循环）。 */
  function getPlatformWalkBounds() {
    if (platformKind === 'small' && dungeon) {
      return {
        left: dungeon.bounds.left,
        right: dungeon.bounds.right,
        floorY: dungeon.spawnFloorY || dungeon.bounds.floorY,
      };
    }
    return {
      left: PLAT_WALK_LEFT + 40,
      right: PLAT_WALK_RIGHT - 40,
      floorY: PLAT_FLOOR_Y,
    };
  }

  /**
   * 月台/地牢镜头可显示内容包围盒（世界坐标）。
   * 供主循环钳制镜头，避免画面落到内容外的大片虚空。
   * 底边上沿须够大：halfH≈viewH/(2zoom) 常见 400–500，若 bottom 仅 floor+140，
   * 则 bottom-halfH 远高于最低层地板，角色会被钳到屏底并露出上层虚空。
   * @returns {{ left: number, right: number, top: number, bottom: number }|null}
   */
  function getCameraBounds() {
    if (scene !== 'platform') return null;
    if (platformKind === 'small' && dungeon) {
      const floorY = dungeon.bounds.floorY ?? dungeon.baseFloorY ?? PLAT_FLOOR_Y;
      const top = Number.isFinite(dungeon.topY)
        ? dungeon.topY - 80
        : floorY - ROOM_H_FALLBACK * 3;
      return {
        left: dungeon.bounds.left,
        right: dungeon.bounds.right,
        top,
        /* 覆盖最低层居中（含躯干上抬）所需的视口半高余量 */
        bottom: floorY + 560,
      };
    }
    return {
      left: PLAT_WALK_LEFT,
      right: PLAT_WALK_RIGHT,
      top: PLAT_FLOOR_Y - 420,
      bottom: PLAT_FLOOR_Y + 400,
    };
  }

  /**
   * 月台多楼层地板查询；无地牢时退回单层。
   * 默认写入 lastPlatformFloorY（本机站立层记忆，防楼梯叠 x 跳层）。
   * 队友/FoW/小地图只读时传 `{ remember: false }`，避免污染本机层记忆。
   * @param {number} x
   * @param {{ preferY?: number, remember?: boolean } | number | null | undefined} [opts]
   *        对象：preferY / remember；若传有限数字则视为 preferY 且不记忆。
   */
  function platformFloorAt(x, opts) {
    let preferY = lastPlatformFloorY;
    let remember = true;
    if (opts != null && typeof opts === 'object') {
      if (Number.isFinite(Number(opts.preferY))) preferY = Number(opts.preferY);
      if (opts.remember === false) remember = false;
    } else if (Number.isFinite(Number(opts))) {
      preferY = Number(opts);
      remember = false;
    }
    if (platformKind === 'small' && dungeon) {
      const biasY =
        Number.isFinite(preferY) && lastFloorDelta
          ? preferY + lastFloorDelta
          : undefined;
      const y = window.LpDungeon?.floorAt?.(dungeon, x, preferY, biasY);
      if (y != null) {
        if (remember) {
          if (Number.isFinite(lastPlatformFloorY) && y !== lastPlatformFloorY) {
            lastFloorDelta = y - lastPlatformFloorY;
          }
          lastPlatformFloorY = y;
        }
        return y;
      }
      const fallback = dungeon.spawnFloorY || dungeon.bounds.floorY;
      if (remember) {
        lastFloorDelta = 0;
        lastPlatformFloorY = fallback;
      }
      return fallback;
    }
    if (remember) {
      lastFloorDelta = 0;
      lastPlatformFloorY = PLAT_FLOOR_Y;
    }
    return PLAT_FLOOR_Y;
  }

  /** 月台交互点（回车 / 编辑台 或 地牢点）。 */
  function platformSpots() {
    if (platformKind === 'small' && dungeon?.spots) {
      return dungeon.spots;
    }
    const returnX = PLAT_WALK_LEFT + 280;
    const editX = PLAT_WALK_LEFT + 900;
    return [
      {
        id: 'platform-board',
        action: 'boardTrain',
        actionLabel: '返回列车',
        worldX: returnX,
        interactRadiusX: 110,
        rect: { x: returnX - 70, y: PLAT_FLOOR_Y - 160, w: 140, h: 160 },
      },
      {
        id: 'platform-edit',
        action: 'openPlatformEdit',
        actionLabel: '打开编组编辑台',
        worldX: editX,
        interactRadiusX: 120,
        rect: { x: editX - 80, y: PLAT_FLOOR_Y - 140, w: 160, h: 140 },
      },
    ];
  }

  /**
   * 当前可交互节点（列车连接处或月台点）。
   * @param {{ x: number, onGround?: boolean, y?: number }} local
   */
  function findActive(local) {
    if (!local?.onGround) return null;
    if (scene === 'platform') {
      let best = null;
      let bestD = Infinity;
      for (const spot of platformSpots()) {
        const d = Math.abs(local.x - spot.worldX);
        if (d > spot.interactRadiusX) continue;
        if (d < bestD) {
          bestD = d;
          best = spot;
        }
      }
      return best;
    }
    if (!atPlatform) return null;
    const c = nearestCoupler(local.x);
    if (!c) return null;
    return {
      id: `coupler-${c.index}`,
      action: 'enterPlatform',
      actionLabel: '进入月台',
      worldX: c.worldX,
      couplerIndex: c.index,
      interactRadiusX: COUPLER_RADIUS,
    };
  }

  /** 离线：本会话已按此站序填过月台仓则不再清空重灌（对齐服务端 _platform_loot_station）。 */
  let offlinePlatformLootStation = null;

  /** 确保月台仓库袋已按当前站种子填装（联机问服 / 离线本地）。 */
  function ensurePlatformLoot(stationIndex) {
    const seed = getWorldSeed();
    const idx = stationIndex | 0;
    if (window.LpInventoryNet?.isActive?.()) {
      window.LpInventoryNet.sendOp?.({
        action: 'ensure_platform_storage',
        stationIndex: idx,
      });
      return;
    }
    if (offlinePlatformLootStation === idx) return;
    const inv = window.LpInventory?.getPlatformStorageInventory?.();
    if (inv && window.LpDungeon?.fillPlatformInventory) {
      window.LpDungeon.fillPlatformInventory(inv, seed, idx);
      offlinePlatformLootStation = idx;
    }
  }

  /** 切入月台场景（记住连接处）。 */
  function enterPlatformFromCoupler(couplerIndex, trainLocal) {
    exitCouplerIndex = Math.max(0, couplerIndex | 0);
    lockedStationIndex = stationIndexFromRoute();
    platformKind = resolvePlatformKind(lockedStationIndex);
    dungeon = null;
    lastPlatformFloorY = null;
    lastFloorDelta = 0;
    if (platformKind === 'small' && window.LpDungeon?.generate) {
      dungeon = window.LpDungeon.generate(getWorldSeed(), lockedStationIndex);
      ensurePlatformLoot(lockedStationIndex);
      window.LpMobs?.spawnDungeonFromLayout?.(dungeon);
      window.LpDungeonFow?.bindDungeon?.(dungeon);
    } else {
      window.LpMobs?.clearDungeonMobs?.();
      /* 大型月台主循环不 tick mobs，须在此清列车波次，否则回车后冻结怪复活 */
      window.LpMobs?.clearTrainWaveMobs?.();
      window.LpDungeonFow?.reset?.();
    }
    clearSceneTransientFx();
    scene = 'platform';
    const spots = platformSpots();
    platformLocalX = spots[0]?.worldX ?? PLAT_WALK_LEFT + 200;
    const spawnY =
      platformKind === 'small' && dungeon
        ? dungeon.spawnFloorY
        : PLAT_FLOOR_Y;
    lastPlatformFloorY = spawnY;
    lastFloorDelta = 0;
    if (trainLocal) {
      trainLocal.x = platformLocalX;
      trainLocal.vx = 0;
      trainLocal.y = 0;
      trainLocal.onGround = true;
    }
    window.LpPlatformAmbience?.setPlayerOnPlatformStub?.(true);
    const kindLabel = platformKind === 'small' ? '小型月台（地牢）' : '大型月台';
    window.LiminalInteract?.showToast?.(`已进入${kindLabel}`);
    window.dispatchEvent(
      new CustomEvent('liminal:platform-scene', {
        detail: { scene, kind: platformKind, stationIndex: lockedStationIndex },
      })
    );
  }

  /** 从月台回车到记住的连接处。 */
  function boardTrain(trainLocal) {
    scene = 'train';
    dungeon = null;
    lastPlatformFloorY = null;
    lastFloorDelta = 0;
    platformKind = null;
    window.LpMobs?.clearDungeonMobs?.();
    window.LpDungeonFow?.reset?.();
    clearSceneTransientFx();
    const x = couplerWorldX(exitCouplerIndex);
    if (trainLocal) {
      trainLocal.x = x;
      trainLocal.vx = 0;
      trainLocal.y = 0;
      trainLocal.onGround = true;
    } else {
      window.LpGame?.teleportToCoupler?.(exitCouplerIndex);
    }
    window.LpPlatformAmbience?.setPlayerOnPlatformStub?.(false);
    closeEdit();
    window.LiminalInteract?.showToast?.(
      `已返回列车（连接处 ${exitCouplerIndex + 1}）`
    );
    window.dispatchEvent(
      new CustomEvent('liminal:platform-scene', { detail: { scene } })
    );
    return true;
  }

  /** 打开编组编辑 UI。 */
  function openEdit() {
    if (!editRoot) {
      window.LiminalInteract?.showToast?.('编组编辑台未就绪');
      return false;
    }
    editOpen = true;
    editRoot.hidden = false;
    editRoot.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-platform-edit-open');
    renderEditList();
    return true;
  }

  /** 关闭编组编辑 UI。 */
  function closeEdit() {
    editOpen = false;
    if (editRoot) {
      editRoot.hidden = true;
      editRoot.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('lp-platform-edit-open');
  }

  /** 是否打开编组编辑。 */
  function isEditOpen() {
    return editOpen;
  }

  /**
   * 应用编组顺序（可变车：empty / storage / tasha 可隐；核心车固定保留）。
   * @param {string[]} orderIds
   */
  function applyComposition(orderIds) {
    const S = Spec();
    if (!S?.CARRIAGES) return false;
    const byId = Object.fromEntries(S.CARRIAGES.map((c) => [c.id, c]));
    const core = ['guard', 'power', 'huigui', 'shuji'];
    const optional = ['storage', 'empty', 'tasha'];
    const next = [];
    const seen = new Set();
    for (const id of orderIds) {
      if (!byId[id] || seen.has(id)) continue;
      if (!core.includes(id) && !optional.includes(id)) continue;
      next.push(byId[id]);
      seen.add(id);
    }
    for (const id of core) {
      if (!seen.has(id) && byId[id]) {
        next.push(byId[id]);
        seen.add(id);
      }
    }
    if (next.length < 2) return false;
    S.CARRIAGES.length = 0;
    for (let i = 0; i < next.length; i += 1) {
      const car = next[i];
      car.worldX = S.COUPLER_JOIN_OFFSET * i;
      S.CARRIAGES.push(car);
    }
    window.LiminalInteract?.rebuildInteractables?.();
    window.LpGame?.refreshWalkBounds?.();
    window.LpTrainMinimap?.refresh?.();
    window.LpTrainMap?.refresh?.();
    if (editStatus) {
      editStatus.textContent = '已应用本会话编组（联机权威同步后续接入）';
    }
    return true;
  }

  /** 刷新编辑台：横向编组图 + 拖拽换位 + 可选车移除/加回。 */
  function renderEditList() {
    if (!editList) return;
    const S = Spec();
    const cars = S?.CARRIAGES || [];
    editList.innerHTML = '';
    editDrag = null;

    cars.forEach((car, index) => {
      if (index > 0) {
        const coupler = document.createElement('li');
        coupler.className = 'lp-platform-edit-coupler';
        coupler.setAttribute('aria-hidden', 'true');
        editList.appendChild(coupler);
      }

      const entry = S.mapEntryFor?.(car) || {
        id: car.id,
        label: car.label || car.id,
        shortLabel: car.map?.shortLabel || car.label || car.id,
        kind: car.map?.kind || 'default',
        tone: car.map?.tone,
        icon: car.icon,
      };
      const kindClass = `lp-map-car--${entry.kind || 'default'}`;
      const item = document.createElement('li');
      item.className = `lp-platform-edit-car lp-train-map-car ${kindClass}`;
      item.dataset.carId = car.id;
      item.dataset.index = String(index);
      if (entry.tone) item.style.setProperty('--lp-map-tone', entry.tone);
      item.title = `${entry.label} · 拖拽调整位置`;

      const body = document.createElement('button');
      body.type = 'button';
      body.className = 'lp-train-map-car-body lp-platform-edit-car-handle';
      body.setAttribute('aria-label', `拖拽 ${entry.label}`);
      if (entry.icon) {
        const img = document.createElement('img');
        img.className = 'lp-train-map-car-icon';
        img.src = entry.icon;
        img.alt = '';
        img.draggable = false;
        body.appendChild(img);
        body.classList.add('has-icon');
      }
      const short = document.createElement('span');
      short.className = 'lp-train-map-car-label';
      short.textContent = entry.shortLabel;
      body.appendChild(short);
      const name = document.createElement('span');
      name.className = 'lp-train-map-car-name';
      name.textContent = entry.label;
      body.appendChild(name);
      item.appendChild(body);

      if (car.id === 'empty' || car.id === 'storage' || car.id === 'tasha') {
        const rem = document.createElement('button');
        rem.type = 'button';
        rem.className = 'lp-platform-edit-remove';
        rem.textContent = '移除';
        rem.addEventListener('click', (ev) => {
          ev.stopPropagation();
          removeOptional(car.id);
        });
        item.appendChild(rem);
      }

      body.addEventListener('pointerdown', (ev) => {
        if (ev.button != null && ev.button !== 0) return;
        beginEditDrag(ev, car.id, item);
      });

      editList.appendChild(item);
    });

    if (editAdd) {
      editAdd.innerHTML = '';
      let any = false;
      for (const id of ['tasha', 'storage', 'empty']) {
        if (cars.some((c) => c.id === id)) continue;
        const tpl = carTemplate(id);
        if (!tpl) continue;
        any = true;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lp-platform-edit-add-btn';
        btn.textContent = `+ ${tpl.label}`;
        btn.addEventListener('click', () => addOptional(id));
        editAdd.appendChild(btn);
      }
      editAdd.hidden = !any;
    }
  }

  /**
   * 开始拖拽换位。
   * @param {PointerEvent} ev
   * @param {string} carId
   * @param {HTMLElement} item
   */
  function beginEditDrag(ev, carId, item) {
    if (!editList || editDrag) return;
    editDrag = {
      carId,
      pointerId: ev.pointerId,
      startX: ev.clientX,
    };
    item.classList.add('is-dragging');
    try {
      item.setPointerCapture(ev.pointerId);
    } catch (_) {
      /* ignore */
    }
    const onMove = (e) => {
      if (!editDrag || e.pointerId !== editDrag.pointerId) return;
      updateEditDragHover(e.clientX);
    };
    const onUp = (e) => {
      if (!editDrag || e.pointerId !== editDrag.pointerId) return;
      const targetIndex = editInsertIndexAt(e.clientX);
      const fromId = editDrag.carId;
      endEditDrag();
      if (targetIndex != null) reorderCarToIndex(fromId, targetIndex);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    updateEditDragHover(ev.clientX);
  }

  /** 清除拖拽态与插入高亮。 */
  function endEditDrag() {
    editDrag = null;
    editList?.querySelectorAll('.lp-platform-edit-car').forEach((node) => {
      node.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    });
  }

  /**
   * 根据指针 X 计算插入下标（落在某节中线左侧=该下标，右侧=下标+1）。
   * @param {number} clientX
   * @returns {number|null}
   */
  function editInsertIndexAt(clientX) {
    if (!editList) return null;
    const nodes = [...editList.querySelectorAll('.lp-platform-edit-car')];
    if (!nodes.length) return null;
    let best = nodes.length;
    for (let i = 0; i < nodes.length; i += 1) {
      const rect = nodes[i].getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) {
        best = i;
        break;
      }
    }
    return best;
  }

  /** 拖拽过程中高亮落点。 */
  function updateEditDragHover(clientX) {
    if (!editList || !editDrag) return;
    const nodes = [...editList.querySelectorAll('.lp-platform-edit-car')];
    const insertAt = editInsertIndexAt(clientX);
    nodes.forEach((node, i) => {
      node.classList.toggle('is-drop-before', insertAt === i);
      node.classList.toggle('is-drop-after', insertAt === nodes.length && i === nodes.length - 1);
    });
  }

  /**
   * 将车厢移到目标下标（考虑拖起后原位腾出）。
   * @param {string} carId
   * @param {number} insertAt
   */
  function reorderCarToIndex(carId, insertAt) {
    const S = Spec();
    const cars = S?.CARRIAGES;
    if (!cars) return;
    const from = cars.findIndex((c) => c.id === carId);
    if (from < 0) return;
    let to = Math.max(0, Math.min(cars.length, insertAt | 0));
    if (to > from) to -= 1;
    if (to === from) {
      renderEditList();
      return;
    }
    const ids = cars.map((c) => c.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    applyComposition(ids);
    renderEditList();
  }

  /** 可选车厢模板（从当前或默认描述重建）。 */
  function carTemplate(id) {
    const S = Spec();
    const existing = S?.carriageById?.(id);
    if (existing) return existing;
    if (id === 'tasha') {
      return {
        id: 'tasha',
        label: '塔莎火箭弹车厢',
        image:
          '/static/games/liminal-platform/img/cars/tasha-rocket/tasha-rocket-car-base.png?v=1',
        icon: '/static/games/liminal-platform/img/cars/tasha-rocket/tasha-rocket-icon.png?v=1',
        worldX: 0,
        map: { shortLabel: '塔莎', kind: 'artillery', tone: '#9a3412' },
      };
    }
    if (id === 'storage') {
      return {
        id: 'storage',
        label: '仓储车厢',
        image: '/static/games/liminal-platform/img/cars/storage-car.png?v=5',
        icon: '/static/games/liminal-platform/img/cars/storage-car-icon.png?v=1',
        worldX: 0,
        facilityEditable: true,
        map: { shortLabel: '仓储', kind: 'cargo', tone: '#64748b' },
      };
    }
    if (id === 'empty') {
      return {
        id: 'empty',
        label: '空车厢',
        image: '/static/games/liminal-platform/img/cars/empty-car.png?v=1',
        icon: '/static/games/liminal-platform/img/cars/empty-car-icon.png?v=1',
        worldX: 0,
        facilityEditable: true,
        map: { shortLabel: '空车', kind: 'cargo', tone: '#475569' },
      };
    }
    return null;
  }

  /** 移动车厢相对顺序。 */
  function moveCar(carId, delta) {
    const S = Spec();
    const cars = S?.CARRIAGES;
    if (!cars) return;
    const i = cars.findIndex((c) => c.id === carId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cars.length) return;
    const tmp = cars[i];
    cars[i] = cars[j];
    cars[j] = tmp;
    applyComposition(cars.map((c) => c.id));
    renderEditList();
  }

  /** 移除可选车厢。 */
  function removeOptional(carId) {
    const S = Spec();
    if (!S?.CARRIAGES) return;
    if (carId !== 'empty' && carId !== 'storage' && carId !== 'tasha') return;
    applyComposition(S.CARRIAGES.filter((c) => c.id !== carId).map((c) => c.id));
    renderEditList();
  }

  /** 添加可选车厢到尾部核心车之前。 */
  function addOptional(carId) {
    const S = Spec();
    if (!S?.CARRIAGES) return;
    if (S.CARRIAGES.some((c) => c.id === carId)) return;
    const tpl = carTemplate(carId);
    if (!tpl) return;
    const clone = { ...tpl, map: { ...(tpl.map || {}) } };
    const ids = S.CARRIAGES.map((c) => c.id);
    const powerIdx = ids.indexOf('power');
    if (powerIdx >= 0) ids.splice(powerIdx, 0, carId);
    else ids.push(carId);
    S.CARRIAGES.push(clone);
    applyComposition(ids);
    renderEditList();
  }

  /**
   * 尝试交互（连接处下月台 / 月台回车 / 编辑台 / 安全屋车辆仓 / 地牢仓）。
   * @param {{ x: number, onGround?: boolean, y?: number, vx?: number }} local
   */
  function tryInteract(local) {
    const spot = findActive(local);
    if (!spot) return false;
    if (spot.action === 'enterPlatform') {
      enterPlatformFromCoupler(spot.couplerIndex ?? 0, local);
      return true;
    }
    if (spot.action === 'boardTrain') {
      return boardTrain(local);
    }
    if (spot.action === 'openPlatformEdit') {
      return openEdit();
    }
    if (spot.action === 'openVehicleStorage') {
      window.LpInventory?.openVehicleStorage?.(local.x);
      return true;
    }
    if (spot.action === 'openPlatformStorage') {
      window.LpInventory?.openPlatformStorage?.(local.x);
      return true;
    }
    return false;
  }

  /**
   * 每帧：积分路线、更新停靠、同步传感与环境音。
   * @param {number} dt
   */
  function tick(dt) {
    const drive = window.LpTrainDrive;
    const speed = Number(drive?.getState?.()?.speed) || 0;
    const throttle = Number(drive?.getState?.()?.throttle) || 0;
    const step = Math.max(0, Number(dt) || 0);
    const absSpeed = Math.abs(speed);

    if (!atPlatform && !forceDock) {
      const distBefore = distanceToStation();
      /* 进站捕捉：接近站点时钳制 route，避免冲过 DOCK 窗后永远到不了站 */
      const brakingIn =
        absSpeed > STOP_SPEED &&
        distBefore <= CAPTURE_DIST &&
        (Math.abs(throttle) < 0.5 ||
          Boolean(window.LpAutoAutopilot?.isEngaged?.()));
      if (brakingIn) {
        const advance = absSpeed * 220 * step;
        if (advance >= distBefore) {
          /* 贴到本站：route 对齐站台零点（mod≈0） */
          routeX = Math.floor(routeX / STATION_SPACING + 1e-9) * STATION_SPACING + STATION_SPACING;
        } else {
          routeX += advance;
        }
      } else {
        routeX += absSpeed * 220 * step;
      }
    }

    const dist = distanceToStation();
    const stopped = absSpeed <= STOP_SPEED;

    if (forceDock) {
      atPlatform = true;
    } else if (atPlatform) {
      /* 全员回车且油门离开空档、开始移动后离站（手动发车路径） */
      if (canDepart() && Math.abs(throttle) > 0.01 && absSpeed > STOP_SPEED) {
        leavePlatformRoute();
      }
    } else if (stopped && dist <= DOCK_DIST) {
      enterDockedState();
      window.LiminalInteract?.showToast?.('列车已停靠月台，连接处按 F 进入');
    }

    syncSensorStub();
    window.LpPlatformAmbience?.setPlayerOnPlatformStub?.(
      scene === 'platform' ? true : false
    );

    /* 停靠且有人在月台：本地也锁油门（离线/联机提示） */
    if (atPlatform && anyPlayerOnPlatform()) {
      const th = Number(drive?.getState?.()?.throttle) || 0;
      if (Math.abs(th) > 0.01) {
        drive?.setThrottle?.(0);
        const reason = getDepartBlockReason();
        if (reason) window.LiminalInteract?.showToast?.(reason, 1200);
      }
    }
  }

  /**
   * 绘制月台场景（大型灰块 或 小型地牢）。
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    if (scene !== 'platform') return;
    if (platformKind === 'small' && dungeon) {
      window.LpDungeon?.draw?.(ctx, dungeon, exitCouplerIndex);
      return;
    }
    const S = Spec();
    const floorY = PLAT_FLOOR_Y;

    ctx.fillStyle = '#1a1f2a';
    ctx.fillRect(0, 0, PLAT_W, PLAT_H);

    /* 站台主体 */
    ctx.fillStyle = GREY;
    ctx.fillRect(80, floorY - 40, PLAT_W - 160, 220);
    ctx.fillStyle = GREY_DARK;
    ctx.fillRect(80, floorY - 40, PLAT_W - 160, 12);

    /* 轨侧示意条 */
    ctx.fillStyle = '#6b7280';
    ctx.fillRect(40, floorY + 8, 48, 16);
    ctx.fillRect(PLAT_W - 88, floorY + 8, 48, 16);

    for (const spot of platformSpots()) {
      const r = spot.rect;
      ctx.fillStyle = spot.action === 'openPlatformEdit' ? GREY_EDIT : '#d4d4d4';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = 'rgba(30,30,30,0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.fillStyle = '#333';
      ctx.font = `${Math.max(14, (S?.scaleArt?.(18) || 18))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        spot.action === 'boardTrain' ? '回车' : '编辑台',
        r.x + r.w / 2,
        r.y + r.h / 2
      );
    }

    /* 标题 */
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('大型月台', 100, 80);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(`回车连接处 #${exitCouplerIndex + 1}`, 100, 108);
  }

  /**
   * 雷达站心：与 PPI 原点同一点（绘轨走道中心，否则编组中点）。
   * @returns {{ x: number, y: number }|null}
   */
  function getRadarStationOrigin() {
    const S = Spec();
    if (!S?.CARRIAGES?.length) return null;
    const y = S.TRACK_Y ?? S.FLOOR_Y;
    const scope = S.carriageById?.('huigui');
    if (scope) {
      return {
        x: scope.worldX + (S.WALK_LEFT + S.WALK_RIGHT) / 2,
        y,
      };
    }
    const first = S.CARRIAGES[0];
    const last = S.CARRIAGES[S.CARRIAGES.length - 1];
    return {
      x: (first.worldX + last.worldX + S.MODULE_W) / 2,
      y,
    };
  }

  /**
   * 路线距离 → 示波器径向距离：量程内用真值（缩放会动）；超出则贴外环表示超程。
   * @param {number} routeDist
   * @returns {number}
   */
  function radarBlipRouteDist(routeDist) {
    const d = Math.max(0, Number(routeDist) || 0);
    if (d <= 0) return 0;
    const rangeRaw = Number(window.LpRadarScope?.getRange?.());
    const range =
      Number.isFinite(rangeRaw) && rangeRaw > 0 ? rangeRaw : 4800;
    if (d <= range) return d;
    return range * 0.96;
  }

  /**
   * 停靠时轨面月台标长度（世界 px）：大型用 PLAT_W；小型用地牢宽，未生成前用下限。
   * @returns {number}
   */
  function dockTrackMarkerLength() {
    if (getPlatformKind() === 'small') {
      const w = Number(dungeon?.width);
      if (w > 0) return w;
      return Math.max(1200, PLAT_W);
    }
    return PLAT_W;
  }

  /**
   * 进站瞬间轨面白标的世界 X 跨度（编组中心对齐月台长度）；未停靠返回 null。
   * LpTrack 在停靠上升沿把该跨度钉入 scroll 轨面坐标并随轨平移；本函数不随车速更新。
   * @returns {{ left: number, right: number }|null}
   */
  function getDockTrackMarkerSpan() {
    if (!isAtPlatform()) return null;
    const S = Spec();
    if (!S?.CARRIAGES?.length) return null;
    const mid =
      (S.CARRIAGES[0].worldX +
        S.CARRIAGES[S.CARRIAGES.length - 1].worldX +
        S.MODULE_W) /
      2;
    const half = dockTrackMarkerLength() * 0.5;
    return { left: mid - half, right: mid + half };
  }

  /**
   * 雷达月台标：相对列车航向前方的站点位置（世界近似）。
   * 停靠显示当前站；离站后在揭示延迟内返回 null（下一站尚未出现在雷达上）。
   * @returns {{ x: number, y: number, label?: string }|null}
   */
  function getRadarPlatformBlip() {
    if (!isNextPlatformRadarVisible()) return null;
    const S = Spec();
    const origin = getRadarStationOrigin();
    if (!S?.CARRIAGES?.length || !origin) return null;
    const routeDist = atPlatform ? 0 : distanceToStation();
    const dist = radarBlipRouteDist(routeDist);
    const forward = S.TRAIN_FORWARD_X >= 0 ? 1 : -1;
    return {
      x: origin.x + forward * dist,
      y: origin.y,
      label: '月台',
    };
  }

  /** 雷达铁轨生成覆盖（世界单位）：按最大量程一次生成，缩放只裁剪。 */
  const TRACK_ALIGN_COVER = 12600;
  /** 轨向相对前进轴最大偏角（约 28°），避免绕成圈。 */
  const TRACK_MAX_HEADING = 0.48;
  /** 会让线 / 侧线轨距（世界单位）。 */
  const TRACK_LANE_SEP = 240;

  /**
   * 确定性 0–1 随机（worldSeed ⊕ stationIndex ⊕ salt）。
   * @param {number} salt
   */
  function trackRand(salt) {
    const seed =
      (Number(getWorldSeed()) >>> 0) ^
      ((Number(getStationIndex()) * 0x9e3779b9) >>> 0);
    const v = window.LpDungeon?.hash2?.(seed, salt | 0);
    if (Number.isFinite(v)) return (v >>> 0) / 4294967296;
    let h = (seed ^ (salt | 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  }

  /**
   * 从原点沿 ±u 铺铁路走向：长直线 + 偶发缓弯（非正弦波形）。
   * heading=0 表示沿前进轴；过原点保持顺直，列车落在本线上。
   * @param {1|-1} sign +u 前方 / −u 后方
   * @param {number} keyOff 哈希盐
   * @returns {Array<{ u: number, lat: number }>}
   */
  function appendTrackSide(sign, keyOff) {
    let u = 0;
    let lat = 0;
    let heading = 0;
    /** @type {Array<{ u: number, lat: number }>} */
    const out = [];
    let k = 0;
    while ((sign > 0 ? u : -u) < TRACK_ALIGN_COVER && k < 70) {
      k += 1;
      const roll = trackRand(keyOff + k * 31);
      if (roll < 0.58) {
        const len = 2000 + trackRand(keyOff + 800 + k) * 3600;
        const n = Math.max(2, Math.round(len / 200));
        const ds = len / n;
        for (let i = 0; i < n; i += 1) {
          u += sign * Math.cos(heading) * ds;
          lat += sign * Math.sin(heading) * ds;
          out.push({ u, lat });
        }
        continue;
      }
      const mag = ((14 + trackRand(keyOff + 900 + k) * 28) * Math.PI) / 180;
      const dir = trackRand(keyOff + 950 + k) > 0.5 ? 1 : -1;
      let turn = dir * mag;
      const nextH = heading + turn;
      if (Math.abs(nextH) > TRACK_MAX_HEADING) {
        const room = TRACK_MAX_HEADING * 0.92 - Math.abs(heading);
        if (room < 0.06) {
          const len = 1800 + trackRand(keyOff + 880 + k) * 2000;
          const n = Math.max(2, Math.round(len / 200));
          const ds = len / n;
          for (let i = 0; i < n; i += 1) {
            u += sign * Math.cos(heading) * ds;
            lat += sign * Math.sin(heading) * ds;
            out.push({ u, lat });
          }
          continue;
        }
        turn = Math.sign(turn || dir) * room;
      }
      const radius = 2400 + trackRand(keyOff + 970 + k) * 4000;
      const arcLen = Math.abs(turn) * radius;
      const n = Math.max(5, Math.round(arcLen / 180));
      const ds = arcLen / n;
      const dH = turn / n;
      for (let i = 0; i < n; i += 1) {
        heading += dH;
        u += sign * Math.cos(heading) * ds;
        lat += sign * Math.sin(heading) * ds;
        out.push({ u, lat });
      }
    }
    return out;
  }

  /**
   * 本线 (u, lat) 折线：缓存至 seed/站序变化；过原点 lat=0。
   * @returns {Array<{ u: number, lat: number }>}
   */
  function getTrackAlignmentUL() {
    const key = `${Number(getWorldSeed()) >>> 0}|${getStationIndex() | 0}`;
    if (trackAlignCache.key === key && trackAlignCache.pts?.length) {
      return trackAlignCache.pts;
    }
    const ahead = appendTrackSide(1, 0x1000);
    const behind = appendTrackSide(-1, 0x3000);
    behind.reverse();
    /** @type {Array<{ u: number, lat: number }>} */
    const pts = [...behind, { u: 0, lat: 0 }, ...ahead];
    trackAlignCache = { key, pts };
    return pts;
  }

  /**
   * (u, lat) → 世界坐标（u 沿列车前进，lat 为轨面侧向）。
   * @param {Array<{ u: number, lat: number }>} ul
   * @param {number} midX
   * @param {number} midY
   * @param {number} forward
   */
  function trackUlToWorld(ul, midX, midY, forward) {
    return ul.map((p) => ({
      x: midX + forward * p.u,
      y: midY + p.lat,
    }));
  }

  /**
   * 在 u 处对相邻点线性插值。
   * @param {{ u: number, lat: number }} a
   * @param {{ u: number, lat: number }} b
   * @param {number} u
   */
  function lerpTrackUL(a, b, u) {
    const t = (u - a.u) / (b.u - a.u || 1);
    return { u, lat: a.lat + (b.lat - a.lat) * t };
  }

  /**
   * 裁到当前量程可见半跨；跨边界时补端点，避免近距只剩 1 点而不画轨。
   * @param {Array<{ u: number, lat: number }>} ul
   * @param {number} halfSpan
   */
  function clipTrackUL(ul, halfSpan) {
    if (!ul?.length) return [];
    const lo = -halfSpan;
    const hi = halfSpan;
    /** @type {Array<{ u: number, lat: number }>} */
    const out = [];
    for (let i = 0; i < ul.length; i += 1) {
      const p = ul[i];
      const prev = i > 0 ? ul[i - 1] : null;
      if (prev) {
        if ((prev.u < lo && p.u >= lo) || (prev.u >= lo && p.u < lo)) {
          out.push(lerpTrackUL(prev, p, lo));
        }
        if ((prev.u <= hi && p.u > hi) || (prev.u > hi && p.u <= hi)) {
          out.push(lerpTrackUL(prev, p, hi));
        }
      }
      if (p.u >= lo && p.u <= hi) out.push(p);
    }
    return out;
  }

  /**
   * 会让线：在本线一段区间内经道岔平滑岔出再汇合。
   * @param {Array<{ u: number, lat: number }>} main
   * @param {number} sideSign +1 / −1
   * @param {number} startU
   * @param {number} endU
   * @param {number} sep
   */
  function buildPassingLoop(main, sideSign, startU, endU, sep) {
    if (endU - startU < 600) return [];
    const turnout = Math.min(520, (endU - startU) * 0.28);
    /** @type {Array<{ u: number, lat: number }>} */
    const out = [];
    for (const p of main) {
      if (p.u < startU || p.u > endU) continue;
      let t = 1;
      if (p.u < startU + turnout) t = (p.u - startU) / turnout;
      else if (p.u > endU - turnout) t = (endU - p.u) / turnout;
      t = Math.max(0, Math.min(1, t));
      t *= t * (3 - 2 * t);
      out.push({ u: p.u, lat: p.lat + sideSign * sep * t });
    }
    return out;
  }

  /**
   * 本列主轨世界折线；量程只决定可见窗口，走向不随缩放变成波形。
   * @returns {Array<{ x: number, y: number }>}
   */
  function buildOwnTrackSpine() {
    const origin = getRadarStationOrigin();
    const S = Spec();
    if (!origin || !S?.CARRIAGES?.length) return [];
    const forward = S.TRAIN_FORWARD_X >= 0 ? 1 : -1;
    const rangeRaw = Number(window.LpRadarScope?.getRange?.());
    const range =
      Number.isFinite(rangeRaw) && rangeRaw > 0 ? rangeRaw : 4800;
    const halfSpan = range * 0.98;
    const ul = clipTrackUL(getTrackAlignmentUL(), halfSpan);
    if (ul.length < 2) return [];
    return trackUlToWorld(ul, origin.x, origin.y, forward);
  }

  /**
   * 将折线沿路径法向平移（侧线保持大致平行，而不是整条 +Y）。
   * @param {Array<{ x: number, y: number }>} spine
   * @param {number} offset
   * @returns {Array<{ x: number, y: number }>}
   */
  function offsetTrackSpine(spine, offset) {
    if (spine.length < 2) return spine.map((p) => ({ x: p.x, y: p.y + offset }));
    /** @type {Array<{ x: number, y: number }>} */
    const out = [];
    for (let i = 0; i < spine.length; i += 1) {
      let dx;
      let dy;
      if (i === 0) {
        dx = spine[1].x - spine[0].x;
        dy = spine[1].y - spine[0].y;
      } else if (i === spine.length - 1) {
        dx = spine[i].x - spine[i - 1].x;
        dy = spine[i].y - spine[i - 1].y;
      } else {
        dx = spine[i + 1].x - spine[i - 1].x;
        dy = spine[i + 1].y - spine[i - 1].y;
      }
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      out.push({
        x: spine[i].x + nx * offset,
        y: spine[i].y + ny * offset,
      });
    }
    return out;
  }

  /**
   * 雷达「铁轨线路」网络：本线 + 若干会让/侧线（道岔岔出，非整条平行波形）。
   * @returns {Array<{ id: string, kind: 'own'|'siding', lane: number, label: string, points: Array<{ x: number, y: number }> }>}
   */
  function getRadarTrackRoutes() {
    const S = Spec();
    const origin = getRadarStationOrigin();
    if (!S?.CARRIAGES?.length || !origin) return [];
    const midX = origin.x;
    const midY = origin.y;
    const forward = S.TRAIN_FORWARD_X >= 0 ? 1 : -1;
    const rangeRaw = Number(window.LpRadarScope?.getRange?.());
    const range =
      Number.isFinite(rangeRaw) && rangeRaw > 0 ? rangeRaw : 4800;
    const halfSpan = range * 0.98;
    const mainUL = clipTrackUL(getTrackAlignmentUL(), halfSpan * 1.05);
    if (mainUL.length < 2) return [];
    /** @type {Array<{ id: string, kind: 'own'|'siding', lane: number, label: string, points: Array<{ x: number, y: number }> }>} */
    const routes = [
      {
        id: 'track-own',
        kind: 'own',
        lane: 0,
        label: '本线',
        points: trackUlToWorld(clipTrackUL(mainUL, halfSpan), midX, midY, forward),
      },
    ];
    const loops = [
      {
        id: 'track-siding-n',
        lane: 1,
        label: '侧线 N',
        sign: -1,
        start: -4200 + trackRand(0x51) * 2800,
        len: 1600 + trackRand(0x52) * 1800,
      },
      {
        id: 'track-siding-s',
        lane: -1,
        label: '侧线 S',
        sign: 1,
        start: 800 + trackRand(0x53) * 3600,
        len: 1400 + trackRand(0x54) * 2000,
      },
      {
        id: 'track-siding-n2',
        lane: 1,
        label: '侧线 N',
        sign: -1,
        start: 5200 + trackRand(0x55) * 2400,
        len: 1200 + trackRand(0x56) * 1400,
      },
    ];
    for (const loop of loops) {
      const ul = buildPassingLoop(
        mainUL,
        loop.sign,
        loop.start,
        loop.start + loop.len,
        TRACK_LANE_SEP
      );
      const vis = clipTrackUL(ul, halfSpan);
      if (vis.length < 3) continue;
      routes.push({
        id: loop.id,
        kind: 'siding',
        lane: loop.lane,
        label: loop.label,
        points: trackUlToWorld(vis, midX, midY, forward),
      });
    }
    return routes;
  }

  /**
   * 雷达铁轨折线（兼容旧接口）：仅本列主轨点列。
   * @returns {Array<{ x: number, y: number }>}
   */
  function getRadarTrackPolyline() {
    return buildOwnTrackSpine();
  }

  /**
   * 调试强制停靠；传 false 取消。无参则切换。
   * @param {boolean} [on]
   */
  function debugDock(on) {
    if (on == null) forceDock = !forceDock;
    else forceDock = Boolean(on);
    if (forceDock) {
      const was = atPlatform;
      atPlatform = true;
      window.LpTrainDrive?.setThrottle?.(0);
      if (!was) {
        window.dispatchEvent(
          new CustomEvent('liminal:platform-arrive', {
            detail: { stationIndex: getStationIndex() },
          })
        );
      }
    } else if (scene === 'platform') {
      /* 保持场景；仅解除强制 */
    } else {
      const was = atPlatform;
      atPlatform = false;
      if (was) {
        window.dispatchEvent(
          new CustomEvent('liminal:platform-depart', {
            detail: { stationIndex: lockedStationIndex },
          })
        );
      }
    }
    syncSensorStub();
    window.LiminalInteract?.showToast?.(
      forceDock ? '调试：强制停靠月台' : '调试：取消强制停靠'
    );
  }

  /* URL ?dock=1 进入即强制停靠；?platform=small|large 强制类型（见 LpDungeon.resolveKind） */
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('dock') === '1') {
      forceDock = true;
      atPlatform = true;
    }
  } catch (_) {
    /* ignore */
  }

  /* 离线本地种子（联机由 world_snapshot 覆盖） */
  getWorldSeed();

  editRoot?.querySelector('#lpPlatformEditClose')?.addEventListener('click', () => {
    closeEdit();
  });

  window.LpPlatform = {
    getScene,
    isAtPlatform,
    isLocalOnPlatform,
    anyPlayerOnPlatform,
    canDepart,
    getDepartBlockReason,
    beginDepart,
    findActive,
    tryInteract,
    tick,
    draw,
    getPlatformWalkBounds,
    getCameraBounds,
    platformFloorAt,
    getPlatformKind,
    getDungeon,
    getStationIndex,
    setWorldSeed,
    getWorldSeed,
    getDockTrackMarkerSpan,
    getRadarStationOrigin,
    getRadarPlatformBlip,
    getRadarTrackPolyline,
    getRadarTrackRoutes,
    distanceToNearestStation,
    isNearPlatformMobSafeZone,
    /** 小怪禁近火车缓冲（路线单位）；只读常量供调试。 */
    MOB_TRAIN_SAFE_DIST,
    debugDock,
    listCouplers,
    couplerWorldX,
    getExitCouplerIndex: () => exitCouplerIndex,
    openEdit,
    closeEdit,
    isEditOpen,
    enterPlatformFromCoupler,
    boardTrain,
  };

  syncSensorStub();
})();
