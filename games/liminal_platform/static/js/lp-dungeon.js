/**
 * 小型月台地牢：确定性布局（走廊 / 楼梯 / 安全屋·敌房·仓库房）。
 * 服务端只下发 world.seed；结构在客户端用 hash(seed, stationIndex) 生成。
 */
(() => {
  /**
   * 车厢足迹（与 carriage-spec 走道宽 × 舱内净空对齐；缺 Spec 时用 WORLD_SCALE=0.88 常量）。
   * 房间宽 ≈ 1.4–2.45× 走道宽；高约 2.55× 舱高，侧视更大。
   */
  const _car = window.LiminalCarriageSpec;
  const CAR_WALK_W = _car
    ? _car.WALK_RIGHT - _car.WALK_LEFT
    : 1514 * 0.88; /* ≈1332 */
  const CAR_CABIN_H = _car ? _car.CABIN_CEIL_INSET : 320 * 0.88; /* ≈282 */

  /* 层间空气隙 + 同层走廊保证房间 AABB 互不贴边 */
  const ROOM_H = Math.round(CAR_CABIN_H * 2.55); /* ≈719 */
  const ROOM_AIR_GAP = 180;
  const FLOOR_GAP = ROOM_H + ROOM_AIR_GAP; /* ≈899 */
  const BASE_FLOOR_Y = 720;
  const ROOM_W_MIN = Math.round(CAR_WALK_W * 1.4); /* ≈1865 */
  const ROOM_W_SPAN = Math.round(CAR_WALK_W * 1.05); /* 宽 ≈1865–3265 */
  const CORRIDOR_GAP_MIN = 280;
  const CORRIDOR_GAP_SPAN = 160;
  const ROOM_PAD = 16;
  const STAIR_LANDING = 72;
  const STAIR_STEP_W = 36;
  const STAIR_STEP_H = 28;
  const MARGIN = 80;
  const WALL_THICK = 20;
  const DOOR_H = 220;
  const CORRIDOR_H = 220;
  const PLAYER_HALF_W = 22;
  const PLAYER_BODY_H = 70;
  /** 枢纽发散布局：左右 + 对角可达更宽 */
  const MAX_WIDTH = 48000;
  /** 单房最多走廊条数（与草图「最多 3 条」对齐）。 */
  const MAX_ROOM_DEGREE = 3;
  /**
   * 侧视平面 6 向：水平 L/R + 四对角（无纯竖直）。
   * dc: 列步进；db: 楼层带步进（+1 = 更高 = 更小 floorY）。
   */
  const BRANCH_DIRS = [
    { id: 'E', dc: 1, db: 0 },
    { id: 'W', dc: -1, db: 0 },
    { id: 'NE', dc: 1, db: 1 },
    { id: 'NW', dc: -1, db: 1 },
    { id: 'SE', dc: 1, db: -1 },
    { id: 'SW', dc: -1, db: -1 },
  ];
  const BRANCH_OPP = { E: 'W', W: 'E', NE: 'SW', SW: 'NE', NW: 'SE', SE: 'NW' };

  /** 与服务端 inventory_authority.PLATFORM_LOOT_TABLE 对齐。 */
  const PLATFORM_LOOT_TABLE = [
    { itemId: 'coal', min: 8, max: 32 },
    { itemId: 'lumber', min: 6, max: 24 },
    { itemId: 'iron_ingot', min: 4, max: 16 },
    { itemId: 'scrap', min: 4, max: 20 },
    { itemId: 'small_caliber_ammo', min: 24, max: 90 },
    { itemId: 'turret_ammo', min: 10, max: 40 },
    { itemId: 'medkit', min: 1, max: 1 },
    { itemId: 'first_aid_kit', min: 1, max: 2 },
  ];

  /** JS Math.imul 兼容。 */
  function imul(a, b) {
    return Math.imul(a | 0, b | 0);
  }

  /** mulberry32：与服务端 _mulberry32 对齐。 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = imul(t ^ (t >>> 15), t | 1);
      t ^= t + imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 混合 worldSeed 与 stationIndex。 */
  function hash2(worldSeed, stationIndex) {
    let h = (worldSeed >>> 0) ^ imul((stationIndex | 0) + 1, 0x9e3779b9);
    h = imul(h ^ (h >>> 16), 0x85ebca6b);
    h = imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  /**
   * 判定月台类型：无种子默认 large；?platform=small|large 可强制。
   * @param {number|null|undefined} worldSeed
   * @param {number} stationIndex
   * @returns {'small'|'large'}
   */
  function resolveKind(worldSeed, stationIndex) {
    try {
      const force = new URLSearchParams(location.search).get('platform');
      if (force === 'small' || force === 'large') return force;
    } catch (_) {
      /* ignore */
    }
    if (worldSeed == null || !Number.isFinite(Number(worldSeed))) return 'large';
    const r = mulberry32(hash2(Number(worldSeed), stationIndex | 0))();
    return r < 0.5 ? 'small' : 'large';
  }

  /**
   * 生成地牢仓库堆叠列表（不写 Inventory；供 Core / 服务端对齐）。
   * @param {number} worldSeed
   * @param {number} stationIndex
   * @returns {Array<{ itemId: string, qty: number, mag?: number, dur?: number, ammo?: number }>}
   */
  function platformLootStacks(worldSeed, stationIndex) {
    const rng = mulberry32(hash2(worldSeed, stationIndex) ^ 0xa11ce);
    const Catalog = window.LpItemCatalog;
    const out = [];
    const pileCount = 4 + Math.floor(rng() * 5);
    for (let i = 0; i < pileCount; i += 1) {
      const entry = PLATFORM_LOOT_TABLE[Math.floor(rng() * PLATFORM_LOOT_TABLE.length)];
      const qty = entry.min + Math.floor(rng() * (entry.max - entry.min + 1));
      if (qty < 1) continue;
      const stack = { itemId: entry.itemId, qty };
      const item = Catalog?.getItem?.(entry.itemId);
      if (item?.magazineSize != null) stack.mag = item.magazineSize;
      if (item?.maxDurability != null) stack.dur = item.maxDurability;
      if (item?.maxAmmo != null) stack.ammo = item.maxAmmo;
      out.push(stack);
    }
    return out;
  }

  /**
   * 把战利品灌进 Inventory 实例（先清空）。
   * @param {object} inv
   * @param {number} worldSeed
   * @param {number} stationIndex
   */
  function fillPlatformInventory(inv, worldSeed, stationIndex) {
    if (!inv) return;
    for (let i = 0; i < inv.size(); i += 1) {
      if (inv.isCovered?.(i)) continue;
      if (inv.getSlot?.(i)) inv.takeSlot?.(i);
    }
    for (const stack of platformLootStacks(worldSeed, stationIndex)) {
      let placed = false;
      for (let i = 0; i < inv.size(); i += 1) {
        if (inv.isCovered?.(i) || inv.getSlot?.(i)) continue;
        if (inv.placeStack?.(i, { ...stack })) {
          placed = true;
          break;
        }
      }
      if (!placed) inv.addItem?.(stack.itemId, stack.qty);
    }
  }

  /** 追加一段可走平台。 */
  function pushWalk(walks, left, right, y) {
    if (right - left < 8) return;
    walks.push({ left, right, y });
  }

  /**
   * 楼梯井开槽：剔除与楼梯 X 重叠的长走道（其它层房间地板常水平盖住井）。
   * 短段（阶梯踏步）保留；长段拆成井左右两截。
   * @param {object[]} walks
   * @param {object[]} stairs
   */
  function carveWalksForStairs(walks, stairs) {
    if (!walks?.length || !stairs?.length) return;
    const stepMax = STAIR_STEP_W + 8;
    for (const s of stairs) {
      const x0 = Math.min(s.x0, s.x1);
      const x1 = Math.max(s.x0, s.x1);
      if (x1 - x0 < 8) continue;
      const next = [];
      for (const w of walks) {
        if (w.right - w.left <= stepMax) {
          next.push(w);
          continue;
        }
        if (w.right <= x0 || w.left >= x1) {
          next.push(w);
          continue;
        }
        if (w.left < x0) pushWalk(next, w.left, x0, w.y);
        if (w.right > x1) pushWalk(next, x1, w.right, w.y);
      }
      walks.length = 0;
      for (const w of next) walks.push(w);
    }
  }

  /**
   * 新跨层房间的水平额外错开：避免与已有楼梯井共用同一 X 带（上下楼梯叠井）。
   * @param {object} from
   * @param {{ dc: number, db: number }} dir
   * @param {object[]} stairs
   * @param {object[]} rooms
   */
  function verticalStairStagger(from, dir, stairs, rooms) {
    if (!dir.db) return 0;
    const span = estimateStairSpan(FLOOR_GAP) + STAIR_LANDING;
    let stagger = 0;
    for (const s of stairs) {
      const a = rooms.find((r) => r.id === s.fromRoomId);
      const b = rooms.find((r) => r.id === s.toRoomId);
      if (!a || !b) continue;
      if (a.id !== from.id && b.id !== from.id) continue;
      const left = a.left <= b.left ? a : b;
      const right = left === a ? b : a;
      const wellR = right.left;
      const wellL = left.right;
      /* 将要在 from 同侧再开一口井：错开一整段楼梯跨度 */
      if (dir.dc > 0 && wellR >= from.right - 4) stagger = Math.max(stagger, span);
      if (dir.dc < 0 && wellL <= from.left + 4) stagger = Math.max(stagger, span);
    }
    return stagger;
  }

  /**
   * 试算房间与 from 之间的楼梯井是否与已有楼梯 X 严重重叠。
   * @param {object} from
   * @param {{ left: number, right: number }} box
   * @param {object[]} stairs
   */
  function stairWellConflicts(from, box, stairs) {
    const wellL = Math.min(from.right, box.left);
    const wellR = Math.max(from.left, box.right);
    /* from 在左：井为 from.right .. box.left；from 在右：box.right .. from.left */
    let x0;
    let x1;
    if (from.right <= box.left) {
      x0 = from.right;
      x1 = box.left;
    } else if (box.right <= from.left) {
      x0 = box.right;
      x1 = from.left;
    } else {
      return true;
    }
    if (x1 - x0 < STAIR_LANDING) return true;
    for (const s of stairs) {
      const overlap = Math.min(x1, s.x1) - Math.max(x0, s.x0);
      if (overlap > STAIR_LANDING * 2) return true;
    }
    return false;
  }

  /** 在两层之间造阶梯走道（X 增大时从 lowerY 爬到 upperY，Y 越小越高）。 */
  function buildStairs(walks, x0, lowerY, upperY) {
    const rise = lowerY - upperY;
    if (rise <= 0) return x0;
    const steps = Math.max(2, Math.ceil(rise / STAIR_STEP_H));
    let x = x0;
    for (let i = 0; i <= steps; i += 1) {
      const y = lowerY - (rise * i) / steps;
      pushWalk(walks, x, x + STAIR_STEP_W + 4, y);
      x += STAIR_STEP_W;
    }
    return x;
  }

  /** 在两层之间造下行阶梯（X 增大时从 upperY 落到 lowerY）。 */
  function buildStairsDown(walks, x0, upperY, lowerY) {
    const drop = lowerY - upperY;
    if (drop <= 0) return x0;
    const steps = Math.max(2, Math.ceil(drop / STAIR_STEP_H));
    let x = x0;
    for (let i = 0; i <= steps; i += 1) {
      const y = upperY + (drop * i) / steps;
      pushWalk(walks, x, x + STAIR_STEP_W + 4, y);
      x += STAIR_STEP_W;
    }
    return x;
  }

  /** 估算跨层楼梯水平跨度（含两端 landing；与 buildStairs 步进次数对齐）。 */
  function estimateStairSpan(rise) {
    const steps = Math.max(2, Math.ceil(Math.abs(rise) / STAIR_STEP_H));
    return STAIR_LANDING * 2 + (steps + 1) * STAIR_STEP_W;
  }

  /** Fisher–Yates 打乱数组（原地）。 */
  function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /**
   * 按方向在已有房间旁试算新房 AABB（含走廊空隙）。
   * @param {object} from
   * @param {{ dc: number, db: number }} dir
   * @param {number} width
   * @param {() => number} rng
   * @param {number} [staggerX] 跨层时额外水平错开，减少叠井
   */
  function tentativeRoomBeside(from, dir, width, rng, staggerX = 0) {
    const rise = Math.abs(dir.db) * FLOOR_GAP;
    const need =
      dir.db === 0
        ? CORRIDOR_GAP_MIN + Math.floor(rng() * CORRIDOR_GAP_SPAN)
        : Math.max(
            CORRIDOR_GAP_MIN + Math.floor(rng() * CORRIDOR_GAP_SPAN),
            estimateStairSpan(rise) + 80
          ) + Math.max(0, staggerX);
    const floorY = from.floorY - dir.db * FLOOR_GAP;
    let left;
    if (dir.dc > 0) left = from.right + need;
    else left = from.left - need - width;
    return {
      left,
      right: left + width,
      floorY,
      ceilingY: floorY - ROOM_H,
    };
  }

  /**
   * 新房试算体积是否与已有房间隔离。
   * @param {object} candidate
   * @param {object[]} rooms
   */
  function fitsIsolated(candidate, rooms) {
    for (const room of rooms) {
      if (roomsAabbOverlap(candidate, room, ROOM_PAD)) return false;
    }
    return true;
  }

  /**
   * 铺通两房间：同层水平廊；跨层则两端 stub + 上行/下行楼梯。
   * @param {object[]} walks
   * @param {object[]} corridors
   * @param {object[]} stairs
   * @param {object} from
   * @param {object} to
   */
  function connectRooms(walks, corridors, stairs, from, to) {
    const leftRoom = from.left <= to.left ? from : to;
    const rightRoom = leftRoom === from ? to : from;
    leftRoom.doorR = true;
    rightRoom.doorL = true;
    const fromId = from.id;
    const toId = to.id;

    if (Math.abs(leftRoom.floorY - rightRoom.floorY) < 2) {
      pushCorridor(
        walks,
        corridors,
        leftRoom.right,
        rightRoom.left,
        leftRoom.floorY,
        leftRoom.floor,
        fromId,
        toId
      );
      return;
    }

    const gapL = leftRoom.right;
    const gapR = rightRoom.left;
    const stub = STAIR_LANDING;
    pushCorridor(walks, corridors, gapL, gapL + stub, leftRoom.floorY, leftRoom.floor, fromId, toId);

    let x = gapL + stub;
    if (leftRoom.floorY > rightRoom.floorY) {
      const x1 = buildStairs(walks, x, leftRoom.floorY, rightRoom.floorY);
      stairs.push({
        x0: x,
        x1,
        lowerY: leftRoom.floorY,
        upperY: rightRoom.floorY,
        floorFrom: leftRoom.floor,
        floorTo: rightRoom.floor,
        fromRoomId: fromId,
        toRoomId: toId,
      });
      x = x1;
    } else {
      const x1 = buildStairsDown(walks, x, leftRoom.floorY, rightRoom.floorY);
      stairs.push({
        x0: x,
        x1,
        lowerY: rightRoom.floorY,
        upperY: leftRoom.floorY,
        floorFrom: leftRoom.floor,
        floorTo: rightRoom.floor,
        fromRoomId: fromId,
        toRoomId: toId,
      });
      x = x1;
    }

    if (x < gapR) {
      pushCorridor(
        walks,
        corridors,
        x,
        gapR,
        rightRoom.floorY,
        rightRoom.floor,
        fromId,
        toId
      );
    } else {
      pushWalk(walks, Math.max(gapR - 12, x - STAIR_STEP_W), gapR, rightRoom.floorY);
    }
  }

  /**
   * 将全部几何沿 X 平移，使最左房间落在 margin 内。
   * 含 walls：须与 rooms/walks 同移，否则碰撞/绘制墙体停在 shift 前坐标。
   * @param {object} layout
   * @param {number} shiftX
   */
  function shiftLayoutX(layout, shiftX) {
    if (!shiftX) return;
    for (const room of layout.rooms) {
      room.left += shiftX;
      room.right += shiftX;
    }
    for (const w of layout.walks) {
      w.left += shiftX;
      w.right += shiftX;
    }
    for (const c of layout.corridors) {
      c.left += shiftX;
      c.right += shiftX;
    }
    for (const s of layout.stairs) {
      s.x0 += shiftX;
      s.x1 += shiftX;
    }
    for (const sp of layout.spawns) {
      sp.x += shiftX;
    }
    for (const wall of layout.walls || []) {
      wall.left += shiftX;
      wall.right += shiftX;
    }
  }

  /**
   * 两房间体积（含 pad）是否相交：同层贴边或跨层叠成一团时为 true。
   * @param {{ left: number, right: number, floorY: number, ceilingY: number }} a
   * @param {{ left: number, right: number, floorY: number, ceilingY: number }} b
   * @param {number} pad
   */
  function roomsAabbOverlap(a, b, pad) {
    if (a.right + pad <= b.left || b.right + pad <= a.left) return false;
    if (a.floorY + pad <= b.ceilingY || b.floorY + pad <= a.ceilingY) return false;
    return true;
  }

  /**
   * 校验所有房间两两隔离（仅开发期告警，不改布局）。
   * @param {Array<object>} rooms
   */
  function warnIfRoomsNotIsolated(rooms) {
    for (let i = 0; i < rooms.length; i += 1) {
      for (let j = i + 1; j < rooms.length; j += 1) {
        if (roomsAabbOverlap(rooms[i], rooms[j], ROOM_PAD)) {
          console.warn('[LpDungeon] rooms not isolated', rooms[i].id, rooms[j].id);
        }
      }
    }
  }

  /**
   * 铺一段同层水平走廊（房间隔离带），并登记 FoW 端点 id。
   * @param {object[]} walks
   * @param {object[]} corridors
   * @param {number} left
   * @param {number} right
   * @param {number} y
   * @param {number} floor
   * @param {string|null} fromRoomId
   * @param {string|null} toRoomId
   */
  function pushCorridor(walks, corridors, left, right, y, floor, fromRoomId, toRoomId) {
    pushWalk(walks, left, right, y);
    corridors.push({
      left,
      right,
      y,
      floor,
      height: CORRIDOR_H,
      fromRoomId,
      toRoomId,
    });
  }

  /**
   * 追加一块实心墙 AABB（canvas：top < bottom）。
   * kind='v' 仅水平碰撞（侧墙/门楣竖条）；kind='h' 仅竖直碰撞（顶板/走廊隔断填实）。
   * @param {object[]} walls
   * @param {number} left
   * @param {number} top
   * @param {number} right
   * @param {number} bottom
   * @param {'v'|'h'} kind
   */
  function pushWall(walls, left, top, right, bottom, kind) {
    if (right - left < 1 || bottom - top < 1) return;
    walls.push({ left, top, right, bottom, kind });
  }

  /**
   * 为单间生成侧墙与顶板；有门的一侧只砌门楣以上，门洞通走廊。
   * @param {object[]} walls
   * @param {{ left: number, right: number, floorY: number, ceilingY: number, doorL?: boolean, doorR?: boolean }} room
   */
  function buildRoomShell(walls, room) {
    const { left, right, floorY, ceilingY } = room;
    pushWall(walls, left, ceilingY, right, ceilingY + WALL_THICK, 'h');
    if (room.doorL) {
      pushWall(walls, left, ceilingY, left + WALL_THICK, floorY - DOOR_H, 'v');
    } else {
      pushWall(walls, left, ceilingY, left + WALL_THICK, floorY, 'v');
    }
    if (room.doorR) {
      pushWall(walls, right - WALL_THICK, ceilingY, right, floorY - DOOR_H, 'v');
    } else {
      pushWall(walls, right - WALL_THICK, ceilingY, right, floorY, 'v');
    }
  }

  /**
   * 走廊：隧道上方填实墙（房间之间的隔断），下方留 CORRIDOR_H 可走空洞。
   * @param {object[]} walls
   * @param {{ left: number, right: number, y: number }} corridor
   */
  function buildCorridorShell(walls, corridor) {
    const ceil = corridor.y - CORRIDOR_H;
    /* 隔断实体：从房间顶高落到隧道顶（只挡跳跃，不水平挤出） */
    pushWall(walls, corridor.left, corridor.y - ROOM_H, corridor.right, ceil, 'h');
    /* 隧道顶板厚度 */
    pushWall(walls, corridor.left, ceil - WALL_THICK, corridor.right, ceil, 'h');
  }

  /**
   * 根据房间门洞与走廊列表生成全部实心墙。
   * @param {object[]} rooms
   * @param {object[]} corridors
   * @returns {object[]}
   */
  function buildWalls(rooms, corridors) {
    const walls = [];
    for (const room of rooms) {
      buildRoomShell(walls, room);
    }
    for (const c of corridors) {
      buildCorridorShell(walls, c);
    }
    return walls;
  }

  /**
   * 竖直方向是否与墙重叠（开区间边缘不碰）。
   * @param {number} head
   * @param {number} feet
   * @param {{ top: number, bottom: number }} wall
   */
  function bodyOverlapsWallY(head, feet, wall) {
    return feet > wall.top && head < wall.bottom;
  }

  /**
   * 水平推离竖直侧墙；宽幅顶板/隔断不参与，避免走廊跳起被整条挤出。
   * @param {object[]} walls
   * @param {number} x
   * @param {number} halfW
   * @param {number} head
   * @param {number} feet
   */
  function resolveWallsX(walls, x, halfW, head, feet) {
    for (let pass = 0; pass < 3; pass += 1) {
      let left = x - halfW;
      let right = x + halfW;
      let hit = false;
      for (const w of walls) {
        if (w.kind === 'h') continue;
        if (!bodyOverlapsWallY(head, feet, w)) continue;
        if (right <= w.left || left >= w.right) continue;
        const mid = (w.left + w.right) * 0.5;
        if (x <= mid) x = w.left - halfW;
        else x = w.right + halfW;
        left = x - halfW;
        right = x + halfW;
        hit = true;
      }
      if (!hit) break;
    }
    return x;
  }

  /**
   * 头顶撞水平墙（顶板/走廊隔断）时压回脚下物理 Y，并清上跳速度。
   * @param {object[]} walls
   * @param {number} x
   * @param {number} halfW
   * @param {number} height
   * @param {number} floorY
   * @param {number} physicsY
   * @param {number} vy
   */
  function resolveWallsY(walls, x, halfW, height, floorY, physicsY, vy) {
    let feet = floorY + physicsY;
    let head = feet - height;
    const left = x - halfW;
    const right = x + halfW;
    for (const w of walls) {
      if (w.kind === 'v') continue;
      if (right <= w.left || left >= w.right) continue;
      if (head >= w.bottom || feet <= w.top) continue;
      if (head < w.bottom && feet > w.top) {
        const newHead = w.bottom;
        feet = newHead + height;
        physicsY = feet - floorY;
        if (vy < 0) vy = 0;
        head = newHead;
      }
    }
    return { physicsY, vy };
  }

  /**
   * 地牢实心墙碰撞：先 X 后顶板 Y（供主循环在位移后调用）。
   * @param {ReturnType<typeof generate>} dungeon
   * @param {{ x: number, physicsY: number, vy: number, floorY: number, halfW?: number, height?: number }} body
   */
  function resolveBody(dungeon, body) {
    const walls = dungeon?.walls;
    if (!walls?.length || !body) {
      return {
        x: body?.x ?? 0,
        physicsY: body?.physicsY ?? 0,
        vy: body?.vy ?? 0,
      };
    }
    const halfW = body.halfW ?? PLAYER_HALF_W;
    const height = body.height ?? PLAYER_BODY_H;
    const floorY = body.floorY;
    let x = body.x;
    let physicsY = body.physicsY;
    let vy = body.vy;
    let feet = floorY + physicsY;
    let head = feet - height;
    x = resolveWallsX(walls, x, halfW, head, feet);
    feet = floorY + physicsY;
    head = feet - height;
    const yOut = resolveWallsY(walls, x, halfW, height, floorY, physicsY, vy);
    return { x, physicsY: yOut.physicsY, vy: yOut.vy };
  }

  /**
   * 线段与墙 AABB 的进入参数 t（0=起点，1=终点）；起点已在墙内则忽略该墙。
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   * @param {{ left: number, top: number, right: number, bottom: number }} box
   * @returns {number|null}
   */
  function segmentEnterAabbT(x0, y0, x1, y1, box) {
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const p = [-dx, dx, -dy, dy];
    const q = [x0 - box.left, box.right - x0, y0 - box.top, box.bottom - y0];
    for (let i = 0; i < 4; i += 1) {
      if (Math.abs(p[i]) < 1e-12) {
        if (q[i] < 0) return null;
        continue;
      }
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
    if (t0 > t1) return null;
    if (t0 <= 1e-4) return null;
    return t0;
  }

  /**
   * 弹道线段撞到的最近地牢墙；无碰撞返回 null。
   * @param {ReturnType<typeof generate>|null|undefined} dungeon
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   * @returns {{ x: number, y: number, t: number, surface: 'wall' }|null}
   */
  function hitProjectileWall(dungeon, x0, y0, x1, y1) {
    const walls = dungeon?.walls;
    if (!walls?.length) return null;
    let bestT = Infinity;
    for (const w of walls) {
      const t = segmentEnterAabbT(x0, y0, x1, y1, w);
      if (t == null || t >= bestT) continue;
      bestT = t;
    }
    if (!Number.isFinite(bestT) || bestT > 1) return null;
    return {
      x: x0 + (x1 - x0) * bestT,
      y: y0 + (y1 - y0) * bestT,
      t: bestT,
      surface: 'wall',
    };
  }

  /**
   * 线段在命中终点前是否不被地牢墙挡住。
   * @param {ReturnType<typeof generate>|null|undefined} dungeon
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   */
  function clearsSegment(dungeon, x0, y0, x1, y1) {
    const hit = hitProjectileWall(dungeon, x0, y0, x1, y1);
    return !hit || hit.t + 1e-6 >= 1;
  }

  /**
   * 生成小型地牢：安全屋为根的枢纽/分叉图。
   * 6 向走廊（水平 + 对角），单房最多 3 条边；房间 AABB 仅经走廊/楼梯连通。
   * @param {number} worldSeed
   * @param {number} stationIndex
   */
  function generate(worldSeed, stationIndex) {
    const sub = hash2(worldSeed, stationIndex);
    const rng = mulberry32(sub);
    const rooms = [];
    const walks = [];
    const corridors = [];
    const stairs = [];
    const spawns = [];
    const links = [];

    /** @type {Map<string, number>} */
    const degree = new Map();
    /** @type {Map<string, Set<string>>} */
    const usedDirs = new Map();
    /** @type {Map<string, object>} */
    const byCell = new Map();

    const targetRooms = 5 + Math.floor(rng() * 4); /* 5–8 */
    const originX = 20000;
    const safeW = ROOM_W_MIN + Math.floor(rng() * ROOM_W_SPAN);
    const safe = {
      id: 'r0-0',
      type: 'safehouse',
      floor: 0,
      band: 0,
      col: 0,
      left: originX,
      right: originX + safeW,
      floorY: BASE_FLOOR_Y,
      ceilingY: BASE_FLOOR_Y - ROOM_H,
      doorL: false,
      doorR: false,
    };
    rooms.push(safe);
    degree.set(safe.id, 0);
    usedDirs.set(safe.id, new Set());
    byCell.set('0:0', safe);
    pushWalk(walks, safe.left, safe.right, safe.floorY);

    /** @type {object[]} */
    const frontier = [safe];

    /**
     * 从 from 沿 dir 生长一间新房并连廊；失败返回 false。
     * @param {object} from
     * @param {(typeof BRANCH_DIRS)[number]} dir
     */
    function tryBranch(from, dir) {
      if ((degree.get(from.id) || 0) >= MAX_ROOM_DEGREE) return false;
      const fromUsed = usedDirs.get(from.id);
      if (fromUsed.has(dir.id)) return false;

      const ncol = (from.col || 0) + dir.dc;
      const nband = (from.band || 0) + dir.db;
      const cellKey = `${ncol}:${nband}`;
      if (byCell.has(cellKey)) return false;

      const w = ROOM_W_MIN + Math.floor(rng() * ROOM_W_SPAN);
      const stagger = verticalStairStagger(from, dir, stairs, rooms);
      const box = tentativeRoomBeside(from, dir, w, rng, stagger);
      if (!fitsIsolated(box, rooms)) return false;
      if (dir.db && stairWellConflicts(from, box, stairs)) return false;

      const room = {
        id: `r${nband}-${ncol}`,
        type: 'enemy',
        floor: 0,
        band: nband,
        col: ncol,
        left: box.left,
        right: box.right,
        floorY: box.floorY,
        ceilingY: box.ceilingY,
        doorL: false,
        doorR: false,
      };
      rooms.push(room);
      degree.set(room.id, 0);
      usedDirs.set(room.id, new Set());
      byCell.set(cellKey, room);
      pushWalk(walks, room.left, room.right, room.floorY);

      connectRooms(walks, corridors, stairs, from, room);
      links.push({ fromRoomId: from.id, toRoomId: room.id, dir: dir.id });

      degree.set(from.id, (degree.get(from.id) || 0) + 1);
      degree.set(room.id, 1);
      fromUsed.add(dir.id);
      usedDirs.get(room.id).add(BRANCH_OPP[dir.id]);

      if ((degree.get(room.id) || 0) < MAX_ROOM_DEGREE) frontier.push(room);
      return true;
    }

    let guard = 0;
    while (rooms.length < targetRooms && frontier.length && guard < 200) {
      guard += 1;
      const safeDeg = degree.get(safe.id) || 0;
      /* 前期优先从安全屋抽枝，形成枢纽；其后偏向前沿分叉 */
      let fi;
      const safeFi = frontier.indexOf(safe);
      if (safeDeg < Math.min(MAX_ROOM_DEGREE, 2) && safeFi >= 0 && rng() < 0.85) {
        fi = safeFi;
      } else if (rng() < 0.65) {
        fi = frontier.length - 1;
      } else {
        fi = Math.floor(rng() * frontier.length);
      }
      const from = frontier[fi];
      if ((degree.get(from.id) || 0) >= MAX_ROOM_DEGREE) {
        frontier.splice(fi, 1);
        continue;
      }
      const dirs = shuffleInPlace(BRANCH_DIRS.slice(), rng);
      let grew = false;
      for (const dir of dirs) {
        if (rooms.length >= targetRooms) break;
        if ((degree.get(from.id) || 0) >= MAX_ROOM_DEGREE) break;
        if (tryBranch(from, dir)) {
          grew = true;
          break;
        }
      }
      if (!grew) frontier.splice(fi, 1);
    }

    /* 楼层带 → floor 下标（0 = 最低带 = 最大 floorY） */
    const floorYs = [...new Set(rooms.map((r) => r.floorY))].sort((a, b) => b - a);
    for (const room of rooms) {
      room.floor = floorYs.indexOf(room.floorY);
    }
    for (const c of corridors) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < floorYs.length; i += 1) {
        const d = Math.abs(floorYs[i] - c.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      c.floor = best;
    }
    for (const s of stairs) {
      const from = rooms.find((r) => r.id === s.fromRoomId);
      const to = rooms.find((r) => r.id === s.toRoomId);
      if (from) s.floorFrom = from.floor;
      if (to) s.floorTo = to.floor;
    }

    warnIfRoomsNotIsolated(rooms);

    /* 安全屋已固定；其余洗牌分配仓库 / 敌区 */
    const nonSafe = rooms.filter((r) => r.type !== 'safehouse');
    shuffleInPlace(nonSafe, rng);
    if (nonSafe.length) nonSafe[0].type = 'warehouse';
    for (let i = 1; i < nonSafe.length; i += 1) {
      nonSafe[i].type = 'enemy';
    }

    for (const room of rooms) {
      if (room.type !== 'enemy') continue;
      const n = 1 + Math.floor(rng() * 3);
      const pad = WALL_THICK + 40;
      const innerL = room.left + pad;
      const innerR = room.right - pad;
      /* 偏两侧三分点，减少死中央叠怪；最终落点仍由 LpMobs FOV 物化再调。 */
      const EDGE_T = [0.2, 0.5, 0.8];
      for (let s = 0; s < n; s += 1) {
        const t = EDGE_T[s] != null ? EDGE_T[s] : (s + 1) / (n + 1);
        let x = room.left + (room.right - room.left) * t;
        if (innerR > innerL) x = Math.min(innerR, Math.max(innerL, x));
        const species = rng() < 0.35 ? 'balloon' : 'bowling';
        spawns.push({
          x,
          floorY: room.floorY,
          ceilingY: room.ceilingY,
          roomId: room.id,
          species,
        });
      }
    }

    const walls = buildWalls(rooms, corridors);

    /* 楼梯井开槽须在 shift 前做：楼梯/走道仍是同一相对坐标 */
    carveWalksForStairs(walks, stairs);

    const safeRoom = rooms.find((r) => r.type === 'safehouse') || rooms[0];
    const warehouse = rooms.find((r) => r.type === 'warehouse') || safeRoom;
    const spawnX = (safeRoom.left + safeRoom.right) * 0.5;
    const boardX = safeRoom.left + 70;
    const vehicleStorageX = Math.max(boardX + 170, safeRoom.right - 90);
    const warehouseX = (warehouse.left + warehouse.right) * 0.5;

    let minLeft = Infinity;
    let maxRight = -Infinity;
    let minCeil = Infinity;
    let maxFloor = -Infinity;
    for (const room of rooms) {
      minLeft = Math.min(minLeft, room.left);
      maxRight = Math.max(maxRight, room.right);
      minCeil = Math.min(minCeil, room.ceilingY);
      maxFloor = Math.max(maxFloor, room.floorY);
    }
    const shiftX = MARGIN + 40 - minLeft;
    /* walls 与房间同批平移，否则 resolveBody / 绘制错位约 |shiftX| */
    const layout = { rooms, walks, corridors, stairs, spawns, walls };
    shiftLayoutX(layout, shiftX);
    minLeft += shiftX;
    maxRight += shiftX;

    const width = Math.max(1200, Math.min(MAX_WIDTH, maxRight + MARGIN));
    const height = Math.max(BASE_FLOOR_Y, maxFloor) + 180;
    const topY = minCeil - 40;
    const mapBounds = {
      minX: minLeft - 40,
      maxX: maxRight + 40,
      minY: minCeil - 40,
      maxY: maxFloor + 40,
    };

    return {
      kind: 'small',
      seed: sub,
      stationIndex: stationIndex | 0,
      width,
      height,
      topY,
      baseFloorY: BASE_FLOOR_Y,
      floors: floorYs,
      mapBounds,
      links,
      rooms,
      corridors,
      walls,
      stairs,
      walks,
      spawns,
      spawnX: spawnX + shiftX,
      spawnFloorY: safeRoom.floorY,
      spots: [
        {
          id: 'platform-board',
          action: 'boardTrain',
          actionLabel: '返回列车',
          worldX: boardX + shiftX,
          interactRadiusX: 110,
          rect: {
            x: boardX + shiftX - 70,
            y: safeRoom.floorY - 160,
            w: 140,
            h: 160,
          },
        },
        {
          id: 'platform-vehicle-storage',
          action: 'openVehicleStorage',
          actionLabel: '打开车辆仓库',
          worldX: vehicleStorageX + shiftX,
          interactRadiusX: 120,
          rect: {
            x: vehicleStorageX + shiftX - 80,
            y: safeRoom.floorY - 140,
            w: 160,
            h: 140,
          },
        },
        {
          id: 'platform-dungeon-warehouse',
          action: 'openPlatformStorage',
          actionLabel: '打开地牢仓库',
          worldX: warehouseX + shiftX,
          interactRadiusX: 120,
          rect: {
            x: warehouseX + shiftX - 80,
            y: warehouse.floorY - 140,
            w: 160,
            h: 140,
          },
        },
      ],
      bounds: {
        left: MARGIN + 20,
        right: width - MARGIN - 20,
        floorY: BASE_FLOOR_Y,
      },
    };
  }

  /**
   * 查询 x 处可走平台顶（Y 越小越高）。
   * 有 preferY 时优先取「一阶之内」的最近平台，避免被其它层长地板/叠井楼梯粘住；
   * 一阶内没有再退回全局最近（跌落/跨缺口）。
   * @param {ReturnType<typeof generate>} dungeon
   * @param {number} x
   * @param {number} [preferY]
   * @param {number} [biasY] 可选：倾向的下一高度（连续上下楼）
   */
  function floorAt(dungeon, x, preferY, biasY) {
    if (!dungeon?.walks?.length) return null;
    const prefer = Number.isFinite(preferY) ? preferY : null;
    const bias = Number.isFinite(biasY) ? biasY : null;
    /** 约一阶半：只粘相邻踏步，不跳到另一口井或隔层房间地板 */
    const SNAP = STAIR_STEP_H * 1.75;
    let bestNear = null;
    let bestNearScore = Infinity;
    let bestFar = null;
    let bestFarDist = Infinity;
    let bestHigh = null;
    for (const p of dungeon.walks) {
      if (x < p.left || x > p.right) continue;
      if (prefer === null) {
        if (bestHigh === null || p.y < bestHigh) bestHigh = p.y;
        continue;
      }
      const d = Math.abs(p.y - prefer);
      if (d < bestFarDist) {
        bestFarDist = d;
        bestFar = p.y;
      }
      if (d > SNAP) continue;
      let score = d;
      if (bias !== null) score += Math.abs(p.y - bias) * 0.05;
      if (score < bestNearScore) {
        bestNearScore = score;
        bestNear = p.y;
      }
    }
    if (prefer === null) return bestHigh;
    if (bestNear != null) return bestNear;
    return bestFar;
  }

  /**
   * 绘制地牢占位几何（房间壳 / 走廊隧道 / 实心墙 / 地板）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof generate>} dungeon
   * @param {number} exitCouplerIndex
   */
  function draw(ctx, dungeon, exitCouplerIndex) {
    if (!dungeon) return;
    ctx.fillStyle = '#12161e';
    ctx.fillRect(0, dungeon.topY - 40, dungeon.width, dungeon.height - dungeon.topY + 80);

    const typeColor = {
      safehouse: '#7dd3a0',
      enemy: '#c47a7a',
      warehouse: '#7aa3c4',
    };

    const Fow = window.LpDungeonFow;

    /* 走廊隧道内腔（墙体之下的可走空洞） */
    for (const c of dungeon.corridors || []) {
      const corrKnown = !Fow || Fow.isCorridorVisible?.(c);
      const h = c.height || CORRIDOR_H;
      ctx.fillStyle = corrKnown ? '#252a36' : '#181b22';
      ctx.fillRect(c.left, c.y - h, c.right - c.left, h);
    }

    for (const room of dungeon.rooms) {
      const known = !Fow || Fow.isRoomExplored?.(room.id);
      const inset = WALL_THICK;
      const ix = room.left + inset;
      const iy = room.ceilingY + inset;
      const iw = Math.max(0, room.right - room.left - inset * 2);
      const ih = Math.max(0, ROOM_H - inset);
      if (known) {
        ctx.fillStyle = typeColor[room.type] || '#888';
        ctx.globalAlpha = 0.22;
        ctx.fillRect(ix, iy, iw, ih);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = '#1a1e28';
        ctx.globalAlpha = 0.35;
        ctx.fillRect(ix, iy, iw, ih);
        ctx.globalAlpha = 1;
      }
      if (known) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label =
          room.type === 'safehouse' ? '安全屋' : room.type === 'warehouse' ? '仓库' : '敌区';
        ctx.fillText(label, (room.left + room.right) / 2, room.ceilingY + 28);
      }
    }

    /* 实心墙：房间隔断 + 门楣 + 走廊上填 */
    for (const w of dungeon.walls || []) {
      const midX = (w.left + w.right) * 0.5;
      const midY = (w.top + w.bottom) * 0.5;
      const floorGuess =
        dungeon.floors?.reduce?.(
          (best, fy) => (Math.abs(fy - midY) < Math.abs(best - midY) ? fy : best),
          dungeon.floors[0]
        ) ?? midY;
      const nearRoom = Fow?.roomAt?.(dungeon, midX, floorGuess);
      let wallKnown = !Fow;
      if (Fow) {
        if (nearRoom && Fow.isRoomExplored?.(nearRoom.id)) wallKnown = true;
        else {
          for (const c of dungeon.corridors || []) {
            if (midX < c.left - 2 || midX > c.right + 2) continue;
            if (Fow.isCorridorVisible?.(c)) {
              wallKnown = true;
              break;
            }
          }
        }
      }
      ctx.fillStyle = wallKnown ? '#3d4556' : '#22262f';
      ctx.fillRect(w.left, w.top, w.right - w.left, w.bottom - w.top);
      if (wallKnown) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(w.left, w.top, w.right - w.left, Math.min(4, w.bottom - w.top));
      }
    }

    /* 楼梯廊：竖向色带，与房间体积分离 */
    for (const s of dungeon.stairs || []) {
      const stairKnown = !Fow || Fow.isStairVisible?.(s);
      const x0 = Math.min(s.x0, s.x1);
      const x1 = Math.max(s.x0, s.x1);
      const y0 = Math.min(s.lowerY, s.upperY);
      const y1 = Math.max(s.lowerY, s.upperY);
      ctx.fillStyle = stairKnown ? 'rgba(90,100,120,0.35)' : 'rgba(30,34,42,0.4)';
      ctx.fillRect(x0, y0, Math.max(12, x1 - x0), y1 - y0);
    }

    for (const p of dungeon.walks) {
      ctx.fillStyle = '#9ca3af';
      ctx.fillRect(p.left, p.y - 6, p.right - p.left, 14);
    }

    for (const spot of dungeon.spots) {
      const r = spot.rect;
      const spotFloor = r.y + r.h;
      const spotRoom = Fow?.roomAt?.(dungeon, spot.worldX, spotFloor);
      const spotKnown = !Fow || !spotRoom || Fow.isRoomExplored?.(spotRoom.id);
      if (!spotKnown) continue;
      ctx.fillStyle =
        spot.action === 'openVehicleStorage'
          ? '#86efac'
          : spot.action === 'openPlatformStorage'
            ? '#93c5fd'
            : '#d4d4d4';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = 'rgba(30,30,30,0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.fillStyle = '#222';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const spotLabel =
        spot.action === 'boardTrain'
          ? '回车'
          : spot.action === 'openVehicleStorage'
            ? '仓储'
            : '地牢仓';
      ctx.fillText(spotLabel, r.x + r.w / 2, r.y + r.h / 2);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('小型月台 · 地牢', 100, dungeon.topY);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(`回车连接处 #${(exitCouplerIndex | 0) + 1}`, 100, dungeon.topY + 26);
  }

  window.LpDungeon = {
    mulberry32,
    hash2,
    resolveKind,
    generate,
    floorAt,
    draw,
    resolveBody,
    hitProjectileWall,
    clearsSegment,
    platformLootStacks,
    fillPlatformInventory,
    PLATFORM_LOOT_TABLE,
    BASE_FLOOR_Y,
    ROOM_H,
    CORRIDOR_H,
    DOOR_H,
    WALL_THICK,
    CAR_WALK_W,
    CAR_CABIN_H,
    MAX_WIDTH,
    MAX_ROOM_DEGREE,
    BRANCH_DIRS,
  };
})();
