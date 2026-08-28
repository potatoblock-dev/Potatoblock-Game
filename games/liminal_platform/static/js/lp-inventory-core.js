/**
 * 物品栏核心：多格占位、堆叠、存取与本地持久化。
 * 手部库存 ignoreItemSize=true，仍受 canHoldInHand 限制。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const STORAGE_KEY = 'liminal-platform-inventory-v7';
  /** 不迁移旧档：默认 4×2 背包，帆布挎包扩至 6×4。 */
  const LEGACY_KEYS = [];

  /** 装备栏槽位键（与 UI 人偶一致）。 */
  const EQUIP_SLOT_KEYS = ['head', 'chest', 'legs', 'accessory', 'accessory', 'backpack'];
  const BACKPACK_EQUIP_INDEX = 5;
  /** 未装备扩容包时的背包尺寸。 */
  const PLAYER_BASE_COLS = 4;
  const PLAYER_BASE_ROWS = 2;
  /** 手部：左/右主手（0/1）+ 3 号工具槽（index 2，禁枪；医疗箱等）。 */
  const HANDS_COLS = 3;
  const HANDS_ROWS = 1;
  /** 手部 3 号槽（0-based index 2）：工具/医疗箱。 */
  const HANDS_UTILITY_INDEX = 2;

  /** 按库存身份返回有效叠加上限（委托图鉴 maxStackIn）。 */
  function maxStackFor(invId, item) {
    if (Catalog.maxStackIn) return Catalog.maxStackIn(invId, item);
    return item?.maxStack ?? 1;
  }

  /** 创建空槽位数组。 */
  function emptySlots(size) {
    return Array.from({ length: size }, () => null);
  }

  /** 读取堆叠朝向：仅 0° 与顺时针 90° 两态。 */
  function stackRot(stack) {
    return stack && Number(stack.rot) === 90 ? 90 : 0;
  }

  /** 按朝向返回占格宽高（90° 时交换 w/h）。 */
  function orientedSize(itemId, rot = 0) {
    const base = Catalog.getItemSize(itemId);
    if (Number(rot) === 90) return { w: base.h, h: base.w };
    return { w: base.w, h: base.h };
  }

  /** 在 0° / 90° 之间切换朝向。 */
  function toggledRot(rot) {
    return Number(rot) === 90 ? 0 : 90;
  }

  /** 规范化堆叠数据（不含占位标记；武器保留弹匣余弹；医疗箱保留耐久；灭火器保留弹药；保留 rot）。bagId 决定叠加上限。 */
  function normalizeStack(stack, bagId = null) {
    if (!stack?.itemId || !stack.qty) return null;
    if (stack.occupiedBy != null) return null;
    const item = Catalog.getItem(stack.itemId);
    if (!item) return null;
    const cap = maxStackFor(bagId, item);
    const qty = Math.max(1, Math.min(stack.qty, cap));
    const out = { itemId: item.id, qty };
    if (item.type === 'weapon' && item.magazineSize) {
      const magRaw = stack.mag != null ? Number(stack.mag) : item.magazineSize;
      out.mag = Math.max(0, Math.min(item.magazineSize, Math.floor(magRaw)));
    }
    if (item.maxDurability) {
      const durRaw = stack.dur != null ? Number(stack.dur) : item.maxDurability;
      out.dur = Math.max(0, Math.min(item.maxDurability, Math.floor(durRaw)));
    }
    if (item.maxAmmo) {
      const ammoRaw = stack.ammo != null ? Number(stack.ammo) : item.maxAmmo;
      const ammo = Number.isFinite(ammoRaw) ? ammoRaw : item.maxAmmo;
      out.ammo = Math.max(0, Math.min(item.maxAmmo, ammo));
    }
    if (stackRot(stack) === 90) out.rot = 90;
    return out;
  }

  /** 是否为占位格。 */
  function isOccupancyMarker(slot) {
    return Boolean(slot && slot.occupiedBy != null);
  }

  class Inventory {
    /**
     * @param {string} id 库存标识
     * @param {number} cols 列数
     * @param {number} rows 行数
     * @param {Array} seed 初始堆叠
     * @param {{ ignoreItemSize?: boolean, slotKeys?: string[] }} options
     */
    constructor(id, cols, rows, seed = [], options = {}) {
      this.id = id;
      this.cols = cols;
      this.rows = rows;
      this.ignoreItemSize = Boolean(options.ignoreItemSize);
      this.slotKeys = options.slotKeys ? [...options.slotKeys] : null;
      this.slots = emptySlots(cols * rows);
      for (const entry of seed) {
        if (entry.index >= 0 && entry.index < this.slots.length) {
          this.placeStack(entry.index, entry.stack);
        }
      }
    }

    /** 槽位总数。 */
    size() {
      return this.slots.length;
    }

    /** 该库存中物品占用的宽高（可按 rot 交换）。 */
    sizeFor(itemId, rot = 0) {
      if (this.ignoreItemSize) return { w: 1, h: 1 };
      return orientedSize(itemId, rot);
    }

    /** 是否允许放入此库存；装备栏需指定槽位下标。手部 0/1 仅武器（或可任意手槽物品），快捷槽禁止武器；双仓储分流设施。 */
    acceptsItem(itemId, index = null) {
      if (!Catalog.getItem(itemId)) return false;
      if (this.id === 'hands') {
        if (!Catalog.canHoldInHand(itemId)) return false;
        if (Catalog.canHoldAnyHandSlot?.(itemId)) return true;
        const isWeapon = Boolean(Catalog.isWeapon?.(itemId));
        if (index == null) {
          // 未指定槽：武器可进 0/1，其它可进 3 号槽（index 2）；具体格由 canPlaceAt 判定。
          return true;
        }
        if (index === HANDS_UTILITY_INDEX) return !isWeapon;
        return isWeapon;
      }
      if (this.slotKeys) {
        if (index == null) {
          return this.slotKeys.some((key, i) =>
            Catalog.canEquipInSlot(itemId, key) && !this.getSlot(i)
          );
        }
        const key = this.slotKeys[index];
        return Catalog.canEquipInSlot(itemId, key);
      }
      if (this.id === 'storage') {
        return !Catalog.isPlaceableFacility?.(itemId);
      }
      if (this.id === 'storage_facility') {
        return Boolean(Catalog.isPlaceableFacility?.(itemId));
      }
      return true;
    }

    /** 该库存内物品叠加上限（仓储可叠更高）。 */
    stackCap(itemId) {
      const item = Catalog.getItem(itemId);
      if (!item) return 1;
      return maxStackFor(this.id, item);
    }

    /** 行列 → 下标。 */
    indexAt(col, row) {
      if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
      return row * this.cols + col;
    }

    /** 下标 → 行列。 */
    coordsOf(index) {
      return {
        col: index % this.cols,
        row: Math.floor(index / this.cols),
      };
    }

    /** 以 origin 为左上角，物品覆盖的全部下标（rot 影响足迹）。 */
    footprint(origin, itemId, rot = 0) {
      const { w, h } = this.sizeFor(itemId, rot);
      const { col, row } = this.coordsOf(origin);
      const cells = [];
      for (let dy = 0; dy < h; dy += 1) {
        for (let dx = 0; dx < w; dx += 1) {
          const idx = this.indexAt(col + dx, row + dy);
          if (idx < 0) return null;
          cells.push(idx);
        }
      }
      return cells;
    }

    /** 点击任意格时解析到原点下标。 */
    originIndex(index) {
      const raw = this.slots[index];
      if (!raw) return index;
      if (isOccupancyMarker(raw)) return raw.occupiedBy;
      return index;
    }

    /** 读取逻辑堆叠（占位格返回原点物品；返回拷贝，勿直接改字段）。 */
    getSlot(index) {
      const origin = this.originIndex(index);
      const raw = this.slots[origin];
      if (!raw || isOccupancyMarker(raw)) return null;
      return { ...raw };
    }

    /**
     * 就地更新原点堆叠字段（如 mag），并经 normalizeStack 约束。
     * @returns {object|null} 更新后的堆叠副本
     */
    updateSlot(index, patch) {
      const origin = this.originIndex(index);
      const raw = this.slots[origin];
      if (!raw || isOccupancyMarker(raw)) return null;
      const normalized = normalizeStack({ ...raw, ...patch }, this.id);
      if (!normalized) return null;
      this.slots[origin] = normalized;
      return { ...normalized };
    }

    /** 该格是否为多格物品的非原点占位。 */
    isCovered(index) {
      return isOccupancyMarker(this.slots[index]);
    }

    /** 原点格的占格尺寸（用于 UI span）。 */
    spanAt(index) {
      const stack = this.getSlot(index);
      if (!stack || this.originIndex(index) !== index) return { w: 1, h: 1 };
      return this.sizeFor(stack.itemId, stackRot(stack));
    }

    /** 检查能否以 origin 放置（可忽略某原点占用的格；rot 影响足迹）。 */
    canPlaceAt(origin, itemId, ignoreOrigin = -1, rot = 0) {
      if (!this.acceptsItem(itemId, origin)) return false;
      const cells = this.footprint(origin, itemId, rot);
      if (!cells) return false;
      for (const idx of cells) {
        const raw = this.slots[idx];
        if (!raw) continue;
        const owner = isOccupancyMarker(raw) ? raw.occupiedBy : idx;
        if (owner === ignoreOrigin) continue;
        return false;
      }
      return true;
    }

    /** 清除某原点及其占位。 */
    clearFootprint(origin) {
      const raw = this.slots[origin];
      if (!raw || isOccupancyMarker(raw)) {
        this.slots[origin] = null;
        return;
      }
      const cells = this.footprint(origin, raw.itemId, stackRot(raw)) || [origin];
      for (const idx of cells) this.slots[idx] = null;
    }

    /** 在 origin 写入堆叠并标记占位；失败返回 false。 */
    placeStack(origin, stack, ignoreOrigin = -1) {
      const normalized = normalizeStack(stack, this.id);
      if (!normalized) return false;
      if (!this.canPlaceAt(origin, normalized.itemId, ignoreOrigin, stackRot(normalized))) {
        return false;
      }
      if (ignoreOrigin >= 0) this.clearFootprint(ignoreOrigin);
      else this.clearFootprint(origin);

      const cells = this.footprint(origin, normalized.itemId, stackRot(normalized));
      this.slots[origin] = normalized;
      for (const idx of cells) {
        if (idx === origin) continue;
        this.slots[idx] = { occupiedBy: origin };
      }
      return true;
    }

    /**
     * 切换原点堆叠朝向（0↔90）；新足迹放不下则拒绝并保持原状。
     * @returns {boolean} 是否已旋转
     */
    toggleRotation(origin) {
      const stack = this.getSlot(origin);
      if (!stack || this.originIndex(origin) !== origin) return false;
      const nextRot = toggledRot(stackRot(stack));
      if (!this.canPlaceAt(origin, stack.itemId, origin, nextRot)) return false;
      const next = { ...stack, rot: nextRot };
      if (nextRot === 0) delete next.rot;
      this.clearFootprint(origin);
      return this.placeStack(origin, next);
    }

    /** 写入槽位（单格兼容 API；多格物品需空足足迹）。 */
    setSlot(index, stack) {
      const origin = this.originIndex(index);
      this.clearFootprint(origin);
      if (!stack) return;
      this.placeStack(origin, stack);
    }

    /** 取走原点堆叠并清空足迹。 */
    takeSlot(index) {
      const origin = this.originIndex(index);
      const stack = this.getSlot(origin);
      if (!stack) return null;
      this.clearFootprint(origin);
      return stack;
    }

    /** 两槽互换（仅在双方足迹互不冲突时成功）。 */
    swapSlots(a, b) {
      const oa = this.originIndex(a);
      const ob = this.originIndex(b);
      if (oa === ob) return;
      const stackA = this.getSlot(oa);
      const stackB = this.getSlot(ob);
      this.clearFootprint(oa);
      this.clearFootprint(ob);
      if (stackB && !this.canPlaceAt(oa, stackB.itemId, -1, stackRot(stackB))) {
        if (stackA) this.placeStack(oa, stackA);
        if (stackB) this.placeStack(ob, stackB);
        return;
      }
      if (stackA && !this.canPlaceAt(ob, stackA.itemId, -1, stackRot(stackA))) {
        if (stackA) this.placeStack(oa, stackA);
        if (stackB) this.placeStack(ob, stackB);
        return;
      }
      if (stackB) this.placeStack(oa, stackB);
      if (stackA) this.placeStack(ob, stackA);
    }

    /** 寻找可放置 origin（可指定朝向）。 */
    findPlaceIndex(itemId, rot = 0) {
      for (let i = 0; i < this.slots.length; i += 1) {
        if (this.canPlaceAt(i, itemId, -1, rot)) return i;
      }
      return -1;
    }

    /** 合并同类堆叠，返回剩余数量。 */
    addItem(itemId, qty) {
      const item = Catalog.getItem(itemId);
      if (!item || qty <= 0) return qty;
      if (!this.acceptsItem(itemId)) return qty;
      const cap = this.stackCap(itemId);

      let remaining = qty;
      for (let i = 0; i < this.slots.length && remaining > 0; i += 1) {
        const raw = this.slots[i];
        if (!raw || isOccupancyMarker(raw) || raw.itemId !== itemId) continue;
        const space = cap - raw.qty;
        if (space <= 0) continue;
        const moved = Math.min(space, remaining);
        raw.qty += moved;
        remaining -= moved;
      }

      while (remaining > 0) {
        const origin = this.findPlaceIndex(itemId);
        if (origin < 0) break;
        const moved = Math.min(cap, remaining);
        this.placeStack(origin, { itemId, qty: moved });
        remaining -= moved;
      }

      return remaining;
    }

    /** 从库存扣除物品，返回实际扣除数量。 */
    removeItem(itemId, qty) {
      if (qty <= 0) return 0;
      let need = qty;
      let removed = 0;
      for (let i = 0; i < this.slots.length && need > 0; i += 1) {
        const raw = this.slots[i];
        if (!raw || isOccupancyMarker(raw) || raw.itemId !== itemId) continue;
        const take = Math.min(raw.qty, need);
        if (take >= raw.qty) this.clearFootprint(i);
        else raw.qty -= take;
        need -= take;
        removed += take;
      }
      return removed;
    }

    /** 统计某物品数量。 */
    countItem(itemId) {
      let total = 0;
      for (let i = 0; i < this.slots.length; i += 1) {
        const raw = this.slots[i];
        if (!raw || isOccupancyMarker(raw) || raw.itemId !== itemId) continue;
        total += raw.qty;
      }
      return total;
    }

    /** 导出可序列化快照（只存原点堆叠）。 */
    toJSON() {
      return {
        id: this.id,
        cols: this.cols,
        rows: this.rows,
        ignoreItemSize: this.ignoreItemSize,
        slotKeys: this.slotKeys,
        slots: this.slots.map((slot) => {
          if (!slot || isOccupancyMarker(slot)) return null;
          const out = { itemId: slot.itemId, qty: slot.qty };
          if (slot.mag != null) out.mag = slot.mag;
          if (slot.dur != null) out.dur = slot.dur;
          if (slot.ammo != null) out.ammo = slot.ammo;
          if (stackRot(slot) === 90) out.rot = 90;
          return out;
        }),
      };
    }

    /** 从快照恢复并重建占位。 */
    static fromJSON(data, options = {}) {
      const ignoreItemSize =
        options.ignoreItemSize ?? Boolean(data.ignoreItemSize);
      const slotKeys = options.slotKeys ?? data.slotKeys ?? null;
      const inv = new Inventory(data.id, data.cols, data.rows, [], {
        ignoreItemSize,
        slotKeys: slotKeys || undefined,
      });
      const pending = [];
      for (let i = 0; i < (data.slots || []).length; i += 1) {
        const stack = normalizeStack(data.slots[i], inv.id);
        if (stack) pending.push({ index: i, stack });
      }
      for (const entry of pending) {
        if (!inv.placeStack(entry.index, entry.stack)) {
          inv.addItem(entry.stack.itemId, entry.stack.qty);
        }
      }
      return inv;
    }
  }

  const PLAYER_SEED = [
    { index: 0, stack: { itemId: 'work_satchel', qty: 1 } },
    { index: 2, stack: { itemId: 'coal', qty: 16 } },
    { index: 3, stack: { itemId: 'scrap', qty: 4 } },
    /* turret_ammo 现为 1×2，基础 4×2 装不下 → PLAYER_OVERFLOW_SEED */
    { index: 6, stack: { itemId: 'small_caliber_ammo', qty: 54 } },
  ];

  /** 开局放不下进背包的物品（生成时丢到脚边地面）。 */
  const PLAYER_OVERFLOW_SEED = [
    { itemId: 'wrench', qty: 1 },
    { itemId: 'signal_lamp', qty: 1 },
    { itemId: 'work_cap', qty: 1 },
    { itemId: 'work_vest', qty: 1 },
    { itemId: 'work_pants', qty: 1 },
    { itemId: 'turret_ammo', qty: 24 },
  ];

  const STORAGE_SEED = [
    { index: 0, stack: { itemId: 'coal', qty: 100 } },
    { index: 1, stack: { itemId: 'lumber', qty: 64 } },
    { index: 2, stack: { itemId: 'iron_ingot', qty: 40 } },
    { index: 3, stack: { itemId: 'scrap', qty: 20 } },
    { index: 4, stack: { itemId: 'turret_ammo', qty: 80 } },
    { index: 5, stack: { itemId: 'small_caliber_ammo', qty: 90 } },
    { index: 6, stack: { itemId: 'medkit', qty: 1, dur: 40 } },
    { index: 8, stack: { itemId: 'first_aid_kit', qty: 1 } },
    { index: 16, stack: { itemId: 'gur65', qty: 1, mag: 27 } },
    { index: 19, stack: { itemId: 'hummingbird_drone', qty: 1, mag: 120 } },
    { index: 24, stack: { itemId: 'fire_extinguisher', qty: 1, ammo: 100 } },
  ];

  /** 设施专用仓库开局种子。 */
  const FACILITY_STORAGE_SEED = [
    { index: 0, stack: { itemId: 'facility_crate', qty: 8 } },
    { index: 1, stack: { itemId: 'facility_workbench', qty: 2 } },
    { index: 3, stack: { itemId: 'facility_shelf', qty: 4 } },
    { index: 5, stack: { itemId: 'facility_locker', qty: 3 } },
    { index: 8, stack: { itemId: 'facility_fire_extinguisher_station', qty: 2 } },
  ];

  /** 装备栏背包槽物品。 */
  function getEquippedBackpack(equip) {
    if (!equip) return null;
    return equip.getSlot(BACKPACK_EQUIP_INDEX);
  }

  /** 按装备的扩容包决定背包宽高。 */
  function resolvePlayerBagSize(equip) {
    const worn = getEquippedBackpack(equip);
    if (worn) {
      const item = Catalog.getItem(worn.itemId);
      if (item?.bagCols && item?.bagRows) {
        return {
          cols: Math.max(1, item.bagCols | 0),
          rows: Math.max(1, item.bagRows | 0),
        };
      }
    }
    return { cols: PLAYER_BASE_COLS, rows: PLAYER_BASE_ROWS };
  }

  /** 收集库存中全部逻辑堆叠（保留弹匣）。 */
  function collectStacks(inventory) {
    const list = [];
    for (let i = 0; i < inventory.size(); i += 1) {
      if (inventory.isCovered(i)) continue;
      const stack = inventory.getSlot(i);
      if (stack) list.push(stack);
    }
    return list;
  }

  /** 拷贝堆叠字段（qty / mag / dur / ammo / rot），供整理合并使用。 */
  function cloneStackFields(stack) {
    const out = { itemId: stack.itemId, qty: stack.qty };
    if (stack.mag != null) out.mag = stack.mag;
    if (stack.dur != null) out.dur = stack.dur;
    if (stack.ammo != null) out.ammo = stack.ammo;
    if (stackRot(stack) === 90) out.rot = 90;
    return out;
  }

  /**
   * 合并可叠加同类堆叠至该库存叠加上限；带 mag/dur 或 cap≤1 的堆保持独立。
   * @returns {object[]}
   */
  function mergeStacksForSort(stacks, bagId) {
    const merged = [];
    const openByItem = new Map();
    for (const raw of stacks) {
      const stack = cloneStackFields(raw);
      const item = Catalog.getItem(stack.itemId);
      if (!item) continue;
      const cap = maxStackFor(bagId, item);
      if (cap <= 1 || stack.mag != null || stack.dur != null || stack.ammo != null) {
        merged.push(stack);
        continue;
      }
      let remaining = stack.qty;
      while (remaining > 0) {
        let idx = openByItem.get(stack.itemId);
        if (idx == null) {
          const next = { itemId: stack.itemId, qty: 0 };
          if (stackRot(stack) === 90) next.rot = 90;
          merged.push(next);
          idx = merged.length - 1;
          openByItem.set(stack.itemId, idx);
        }
        const target = merged[idx];
        const space = cap - target.qty;
        if (space <= 0) {
          openByItem.delete(stack.itemId);
          continue;
        }
        const take = Math.min(space, remaining);
        target.qty += take;
        remaining -= take;
        if (target.qty >= cap) openByItem.delete(stack.itemId);
      }
    }
    return merged.filter((s) => s.qty > 0);
  }

  /** 整理放置排序键：占格面积降序 → type → itemId → mag。 */
  function compareStacksForSort(a, b) {
    const itemA = Catalog.getItem(a.itemId) || {};
    const itemB = Catalog.getItem(b.itemId) || {};
    const sizeA = orientedSize(a.itemId, stackRot(a));
    const sizeB = orientedSize(b.itemId, stackRot(b));
    const areaDiff = sizeB.w * sizeB.h - sizeA.w * sizeA.h;
    if (areaDiff !== 0) return areaDiff;
    const typeA = String(itemA.type || '');
    const typeB = String(itemB.type || '');
    if (typeA !== typeB) return typeA < typeB ? -1 : 1;
    if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
    const magA = a.mag != null ? Number(a.mag) : -1;
    const magB = b.mag != null ? Number(b.mag) : -1;
    return magB - magA;
  }

  /**
   * 整理放置：在当前朝向与交替朝向中选更靠左上的合法格（正方形足迹不试交替）。
   * 两者同格时保留 preferredRot；都放不下返回 null。
   * @returns {{ dest: number, rot: number } | null}
   */
  function pickSortPlacement(inventory, itemId, preferredRot) {
    const prefer = Number(preferredRot) === 90 ? 90 : 0;
    const destPrefer = inventory.findPlaceIndex(itemId, prefer);
    const base = orientedSize(itemId, 0);
    if (base.w === base.h) {
      if (destPrefer < 0) return null;
      return { dest: destPrefer, rot: prefer };
    }
    const alt = toggledRot(prefer);
    const destAlt = inventory.findPlaceIndex(itemId, alt);
    if (destPrefer < 0 && destAlt < 0) return null;
    if (destPrefer < 0) return { dest: destAlt, rot: alt };
    if (destAlt < 0) return { dest: destPrefer, rot: prefer };
    if (destAlt < destPrefer) return { dest: destAlt, rot: alt };
    return { dest: destPrefer, rot: prefer };
  }

  /**
   * 自动整理：合并可叠加堆，再按足迹左上紧凑重排（可旋转 0↔90；不碰手部/装备）。
   * 放不下时回滚并返回 false。
   * @returns {boolean}
   */
  function sortInventory(inventory) {
    if (!inventory || inventory.ignoreItemSize || inventory.slotKeys) return false;
    if (
      inventory.id !== 'player' &&
      inventory.id !== 'storage' &&
      inventory.id !== 'storage_facility'
    ) {
      return false;
    }
    const collected = collectStacks(inventory);
    if (!collected.length) return true;
    const merged = mergeStacksForSort(collected, inventory.id);
    merged.sort(compareStacksForSort);
    const snapshot = inventory.slots.map((slot) => (slot ? { ...slot } : null));
    inventory.slots = emptySlots(inventory.size());
    for (const stack of merged) {
      const picked = pickSortPlacement(inventory, stack.itemId, stackRot(stack));
      if (!picked) {
        inventory.slots = snapshot;
        return false;
      }
      let place = stack;
      if (picked.rot !== stackRot(stack)) {
        place = cloneStackFields(stack);
        if (picked.rot === 90) place.rot = 90;
        else delete place.rot;
      }
      if (!inventory.placeStack(picked.dest, place)) {
        inventory.slots = snapshot;
        return false;
      }
    }
    return true;
  }

  /**
   * 就地调整背包尺寸；放不下的堆叠返回 overflow 数组。
   * @returns {object[]}
   */
  function resizeInventory(inventory, cols, rows) {
    if (inventory.cols === cols && inventory.rows === rows) return [];
    const stacks = collectStacks(inventory);
    inventory.cols = cols;
    inventory.rows = rows;
    inventory.slots = emptySlots(cols * rows);
    const overflow = [];
    for (const stack of stacks) {
      let placed = false;
      for (let i = 0; i < inventory.size(); i += 1) {
        if (inventory.canPlaceAt(i, stack.itemId, -1, stackRot(stack))) {
          inventory.placeStack(i, stack);
          placed = true;
          break;
        }
      }
      if (!placed) {
        const leftover = inventory.addItem(stack.itemId, stack.qty);
        if (leftover > 0) {
          const drop = { itemId: stack.itemId, qty: leftover };
          if (stack.mag != null) drop.mag = stack.mag;
          if (stackRot(stack) === 90) drop.rot = 90;
          overflow.push(drop);
        } else if (stack.mag != null || stackRot(stack) === 90) {
          for (let i = 0; i < inventory.size(); i += 1) {
            const raw = inventory.slots[i];
            if (raw && !isOccupancyMarker(raw) && raw.itemId === stack.itemId) {
              if (stack.mag != null) raw.mag = stack.mag;
              if (stackRot(stack) === 90) raw.rot = 90;
              else delete raw.rot;
              break;
            }
          }
        }
      }
    }
    return overflow;
  }

  /** 按装备同步玩家背包尺寸，返回掉落堆叠。 */
  function syncPlayerBagToEquip(player, equip) {
    const size = resolvePlayerBagSize(equip);
    return resizeInventory(player, size.cols, size.rows);
  }

  /** 新建默认背包（宽 4 × 高 2）。 */
  function createDefaultPlayer() {
    return new Inventory('player', PLAYER_BASE_COLS, PLAYER_BASE_ROWS, PLAYER_SEED);
  }

  /** 新建默认物资仓库。 */
  function createDefaultStorage() {
    return new Inventory('storage', 8, 8, STORAGE_SEED);
  }

  /** 新建默认设施仓库。 */
  function createDefaultFacilityStorage() {
    return new Inventory('storage_facility', 8, 8, FACILITY_STORAGE_SEED);
  }

  /** 新建空地牢仓库（仓库房本地仓；进站按种子填装，不连通车辆仓）。 */
  function createEmptyPlatformStorage() {
    return new Inventory('platform_storage', 6, 6);
  }

  /**
   * TEST_ONLY — remove after playtest：物资仓种子补到 maxStack（或缺省 qty），取用不尽。
   * 与服务端 refill_storage_infinite 对齐；不碰玩家存入的非种子格；跳过可摆放设施。
   */
  function restoreTestInfiniteStorage(storage) {
    if (!storage || !window.LpItemCatalog?.TEST_AUTO_REFILL_CONSUMABLES) return;
    for (const entry of STORAGE_SEED) {
      const itemId = entry.stack.itemId;
      const item = Catalog.getItem(itemId);
      /* 可摆放设施不参与无限补货，否则编辑扣库无效。 */
      if (Catalog.isPlaceableFacility?.(itemId)) continue;
      const want = item?.maxStack || entry.stack.qty || 1;
      const have = storage.countItem(itemId) || 0;
      if (have >= want) continue;
      storage.addItem(itemId, want - have);
      const magSize = item?.magazineSize;
      const maxDur = item?.maxDurability;
      const maxAmmo = item?.maxAmmo;
      if (magSize == null && maxDur == null && maxAmmo == null) continue;
      for (let i = 0; i < storage.size(); i += 1) {
        if (storage.isCovered(i)) continue;
        const st = storage.slots[i];
        if (!st || st.itemId !== itemId) continue;
        if (magSize != null && st.mag == null) st.mag = magSize;
        if (maxDur != null && st.dur == null) st.dur = maxDur;
        if (maxAmmo != null && st.ammo == null) st.ammo = maxAmmo;
      }
    }
  }

  /**
   * 将物资仓中的可摆放设施整堆迁入设施仓（旧存档一次性迁移）。
   * @param {Inventory} storage
   * @param {Inventory} facilityStorage
   * @returns {number} 迁入的堆数
   */
  function migrateFacilitiesToFacilityWarehouse(storage, facilityStorage) {
    if (!storage || !facilityStorage) return 0;
    let moved = 0;
    for (let i = 0; i < storage.size(); i += 1) {
      if (storage.isCovered(i)) continue;
      const stack = storage.getSlot(i);
      if (!stack || !Catalog.isPlaceableFacility?.(stack.itemId)) continue;
      const taken = storage.takeSlot(i);
      if (!taken) continue;
      const leftover = facilityStorage.addItem(taken.itemId, taken.qty);
      if (leftover > 0) storage.addItem(taken.itemId, leftover);
      if (leftover < taken.qty) moved += 1;
    }
    return moved;
  }

  /**
   * 旧存档补种可摆放设施：仅当该 id 数量为 0 时按种子 qty 放入（不刷到 maxStack）。
   * @param {Inventory} facilityStorage
   */
  function ensurePlaceableFacilitySeeds(facilityStorage) {
    if (!facilityStorage) return;
    for (const entry of FACILITY_STORAGE_SEED) {
      const itemId = entry.stack.itemId;
      if (!Catalog.isPlaceableFacility?.(itemId)) continue;
      if ((facilityStorage.countItem(itemId) || 0) > 0) continue;
      facilityStorage.addItem(itemId, entry.stack.qty || 1);
    }
  }

  /** 新建手部三槽（左/右主手 + 快捷）；默认右手持 GUR-65。 */
  function createDefaultHands() {
    return new Inventory(
      'hands',
      HANDS_COLS,
      HANDS_ROWS,
      [{ index: 1, stack: { itemId: 'gur65', qty: 1, mag: 27 } }],
      { ignoreItemSize: true }
    );
  }

  /** 把堆叠退回背包（尽量保留武器弹匣与朝向）。 */
  function dumpStackToPlayer(player, stack) {
    if (!player || !stack) return;
    for (let i = 0; i < player.size(); i += 1) {
      if (player.isCovered(i)) continue;
      if (player.getSlot(i)) continue;
      if (player.canPlaceAt(i, stack.itemId, -1, stackRot(stack))) {
        player.placeStack(i, stack);
        return;
      }
    }
    player.addItem(stack.itemId, stack.qty);
  }

  /** 将旧双手槽扩展为三槽；武器槽清出非武器（可任意手槽物品除外），快捷槽清出枪械。 */
  function ensureHandsShape(hands, player) {
    let next = hands;
    if (hands.cols !== HANDS_COLS || hands.rows !== HANDS_ROWS || hands.size() !== HANDS_COLS) {
      next = new Inventory('hands', HANDS_COLS, HANDS_ROWS, [], { ignoreItemSize: true });
      for (let i = 0; i < Math.min(hands.size(), HANDS_COLS); i += 1) {
        if (hands.isCovered?.(i)) continue;
        const stack = hands.getSlot(i);
        if (!stack) continue;
        const anySlot = Catalog.canHoldAnyHandSlot?.(stack.itemId);
        if (i === HANDS_UTILITY_INDEX && Catalog.isWeapon?.(stack.itemId) && !anySlot) {
          dumpStackToPlayer(player, stack);
          continue;
        }
        if (i !== HANDS_UTILITY_INDEX && !Catalog.isWeapon?.(stack.itemId) && !anySlot) {
          dumpStackToPlayer(player, stack);
          continue;
        }
        if (next.canPlaceAt(i, stack.itemId, -1, stackRot(stack))) next.placeStack(i, stack);
        else dumpStackToPlayer(player, stack);
      }
    }

    for (let i = 0; i < HANDS_UTILITY_INDEX; i += 1) {
      const stack = next.getSlot(i);
      if (
        stack &&
        !Catalog.isWeapon?.(stack.itemId) &&
        !Catalog.canHoldAnyHandSlot?.(stack.itemId)
      ) {
        dumpStackToPlayer(player, next.takeSlot(i));
      }
    }
    const util = next.getSlot(HANDS_UTILITY_INDEX);
    if (util && Catalog.isWeapon?.(util.itemId) && !Catalog.canHoldAnyHandSlot?.(util.itemId)) {
      const taken = next.takeSlot(HANDS_UTILITY_INDEX);
      dumpStackToPlayer(player, taken);
    }
    return next;
  }

  /** 新建装备栏（头/胸/腿/配件×2/背包）。 */
  function createDefaultEquip() {
    return new Inventory('equip', EQUIP_SLOT_KEYS.length, 1, [], {
      ignoreItemSize: true,
      slotKeys: EQUIP_SLOT_KEYS,
    });
  }

  /** 将背包校正到当前装备对应的尺寸。 */
  function ensurePlayerShape(player, equip) {
    const size = resolvePlayerBagSize(equip);
    if (player.cols === size.cols && player.rows === size.rows) {
      return { player, overflow: [] };
    }
    const overflow = resizeInventory(player, size.cols, size.rows);
    return { player, overflow };
  }

  /** 将旧装备栏扩展到含背包槽。 */
  function ensureEquipShape(equip) {
    const need = EQUIP_SLOT_KEYS.length;
    if (equip.size() === need) {
      equip.slotKeys = [...EQUIP_SLOT_KEYS];
      return equip;
    }
    const next = createDefaultEquip();
    for (let i = 0; i < Math.min(equip.size(), next.size()); i += 1) {
      const stack = equip.getSlot(i);
      if (stack) next.placeStack(i, stack);
    }
    return next;
  }

  /** 组装一套库存（含缺省装备栏），并校正网格尺寸。 */
  function bundleInventories(partial) {
    const equip = ensureEquipShape(partial.equip || createDefaultEquip());
    const shaped = ensurePlayerShape(partial.player, equip);
    const player = shaped.player;
    return {
      player,
      storage: partial.storage,
      facilityStorage: partial.facilityStorage || createDefaultFacilityStorage(),
      platformStorage: partial.platformStorage || createEmptyPlatformStorage(),
      hands: ensureHandsShape(partial.hands || createDefaultHands(), player),
      equip,
      overflow: shaped.overflow || [],
      seedOverflow: partial.seedOverflow || null,
    };
  }

  /** 从旧版存档迁移。 */
  function migrateFromLegacy() {
    for (const key of LEGACY_KEYS) {
      const saved = localStorage.getItem(key);
      if (!saved) continue;
      try {
        const parsed = JSON.parse(saved);
        return bundleInventories({
          player: Inventory.fromJSON(parsed.player),
          storage: Inventory.fromJSON(parsed.storage),
          facilityStorage: parsed.storage_facility
            ? Inventory.fromJSON(parsed.storage_facility)
            : new Inventory('storage_facility', 8, 8),
          hands: parsed.hands
            ? Inventory.fromJSON(parsed.hands, { ignoreItemSize: true })
            : createDefaultHands(),
          equip: parsed.equip
            ? Inventory.fromJSON(parsed.equip, {
                ignoreItemSize: true,
                slotKeys: EQUIP_SLOT_KEYS,
              })
            : createDefaultEquip(),
        });
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /** 读取或初始化持久化库存。 */
  function loadInventories() {
    const saved = localStorage.getItem(STORAGE_KEY);
    let loaded;
    if (!saved) {
      loaded =
        migrateFromLegacy() ||
        bundleInventories({
          player: createDefaultPlayer(),
          storage: createDefaultStorage(),
          facilityStorage: createDefaultFacilityStorage(),
          hands: createDefaultHands(),
          equip: createDefaultEquip(),
          seedOverflow: PLAYER_OVERFLOW_SEED,
        });
    } else {
      try {
        const parsed = JSON.parse(saved);
        loaded = bundleInventories({
          player: Inventory.fromJSON(parsed.player),
          storage: Inventory.fromJSON(parsed.storage),
          facilityStorage: parsed.storage_facility
            ? Inventory.fromJSON(parsed.storage_facility)
            : new Inventory('storage_facility', 8, 8),
          hands: parsed.hands
            ? Inventory.fromJSON(parsed.hands, { ignoreItemSize: true })
            : createDefaultHands(),
          equip: parsed.equip
            ? Inventory.fromJSON(parsed.equip, {
                ignoreItemSize: true,
                slotKeys: EQUIP_SLOT_KEYS,
              })
            : createDefaultEquip(),
        });
      } catch {
        loaded = bundleInventories({
          player: createDefaultPlayer(),
          storage: createDefaultStorage(),
          facilityStorage: createDefaultFacilityStorage(),
          hands: createDefaultHands(),
          equip: createDefaultEquip(),
          seedOverflow: PLAYER_OVERFLOW_SEED,
        });
      }
    }
    migrateFacilitiesToFacilityWarehouse(loaded.storage, loaded.facilityStorage);
    ensurePlaceableFacilitySeeds(loaded.facilityStorage);
    return loaded;
  }

  /** 保存库存到 localStorage。 */
  function saveInventories(player, storage, hands, equip, facilityStorage) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        player: player.toJSON(),
        storage: storage.toJSON(),
        storage_facility: (facilityStorage || createDefaultFacilityStorage()).toJSON(),
        hands: hands.toJSON(),
        equip: equip.toJSON(),
      })
    );
  }

  /**
   * 判断「弹药堆 → 武器格」是否为装填意图（目标是带弹匣的武器）。
   * 兼容与否另用 Catalog.weaponAcceptsAmmo；此处只识别交互类型。
   */
  function isAmmoOntoWeaponIntent(ammoStack, weaponStack) {
    if (!ammoStack || !weaponStack) return false;
    const ammoItem = Catalog.getItem(ammoStack.itemId);
    const weaponItem = Catalog.getItem(weaponStack.itemId);
    if (!ammoItem || !weaponItem) return false;
    if (ammoItem.type !== 'ammo') return false;
    return Boolean(
      Catalog.isWeapon(weaponStack.itemId) && weaponItem.magazineSize != null
    );
  }

  /**
   * 用弹药堆装填武器格弹匣；不交换槽位。
   * @returns {{ ok: boolean, loaded: number, leftover: object|null }}
   *   ok=false：不匹配或非武器意图，leftover 为原弹药堆（调用方原位放回）。
   *   ok=true：已写入 mag；leftover 为剩余弹药（null=用尽）。
   */
  function tryLoadAmmoOntoWeapon(weaponInv, weaponIndex, ammoStack) {
    const incoming = normalizeStack(ammoStack);
    if (!incoming || !weaponInv) {
      return { ok: false, loaded: 0, leftover: ammoStack || null };
    }
    const origin = weaponInv.originIndex(weaponIndex);
    const weaponStack = weaponInv.getSlot(origin);
    if (!isAmmoOntoWeaponIntent(incoming, weaponStack)) {
      return { ok: false, loaded: 0, leftover: incoming };
    }
    const weaponItem = Catalog.getItem(weaponStack.itemId);
    if (!Catalog.weaponAcceptsAmmo(weaponItem, incoming.itemId)) {
      return { ok: false, loaded: 0, leftover: incoming };
    }
    const magSize = Number(weaponItem.magazineSize) || 0;
    const need = magSize - (weaponStack.mag ?? 0);
    if (need <= 0) {
      return { ok: true, loaded: 0, leftover: incoming };
    }
    const take = Math.min(need, incoming.qty);
    if (take <= 0) {
      return { ok: true, loaded: 0, leftover: incoming };
    }
    weaponInv.updateSlot(origin, { mag: (weaponStack.mag ?? 0) + take });
    const leftQty = incoming.qty - take;
    if (leftQty <= 0) return { ok: true, loaded: take, leftover: null };
    return {
      ok: true,
      loaded: take,
      leftover: { itemId: incoming.itemId, qty: leftQty },
    };
  }

  /** 将堆叠放入槽位，返回未能放入的部分（或交换出的堆叠）。 */
  function placeOnSlot(inventory, index, stack) {
    // 先按目标库存校验物品/弹匣，数量暂保留至仓储绝对上限，再按目标 cap 切 leftover。
    const probe = normalizeStack({ ...stack, qty: 1 }, inventory.id);
    if (!probe) return stack;
    const item = Catalog.getItem(probe.itemId);
    if (!item) return stack;
    const rawQty = Math.max(1, Math.floor(Number(stack?.qty) || 0));
    const transitCap = item.maxStack > 1 ? (Catalog.STORAGE_MAX_STACK || rawQty) : 1;
    const incoming = { ...probe, qty: Math.min(rawQty, transitCap) };
    if (stack?.mag != null && incoming.mag == null) incoming.mag = stack.mag;
    if (stack?.dur != null && incoming.dur == null) incoming.dur = stack.dur;
    if (stack?.ammo != null && incoming.ammo == null) incoming.ammo = stack.ammo;
    if (stackRot(stack) === 90) incoming.rot = 90;

    const origin = inventory.originIndex(index);
    if (!inventory.acceptsItem(incoming.itemId, origin)) return stack;

    const current = inventory.getSlot(origin);
    const cap = maxStackFor(inventory.id, item);

    if (!current) {
      const placeQty = Math.min(incoming.qty, cap);
      const leftoverQty = incoming.qty - placeQty;
      if (!inventory.placeStack(origin, { ...incoming, qty: placeQty })) return incoming;
      if (leftoverQty <= 0) return null;
      const leftover = { itemId: incoming.itemId, qty: leftoverQty };
      if (incoming.mag != null) leftover.mag = incoming.mag;
      if (incoming.dur != null) leftover.dur = incoming.dur;
      if (incoming.ammo != null) leftover.ammo = incoming.ammo;
      if (stackRot(incoming) === 90) leftover.rot = 90;
      return leftover;
    }

    if (current.itemId === incoming.itemId) {
      const space = cap - current.qty;
      if (space <= 0) return incoming;
      const moved = Math.min(space, incoming.qty);
      inventory.slots[origin].qty = current.qty + moved;
      const leftoverQty = incoming.qty - moved;
      if (leftoverQty <= 0) return null;
      const leftover = { itemId: incoming.itemId, qty: leftoverQty };
      if (incoming.mag != null) leftover.mag = incoming.mag;
      if (incoming.dur != null) leftover.dur = incoming.dur;
      if (incoming.ammo != null) leftover.ammo = incoming.ammo;
      if (stackRot(incoming) === 90) leftover.rot = 90;
      return leftover;
    }

    // 交换：先拿走目标，再尝试放入；失败则还原（整堆交换，不切超量）
    const removed = inventory.takeSlot(origin);
    if (incoming.qty > cap || !inventory.placeStack(origin, incoming)) {
      if (removed) inventory.placeStack(origin, removed);
      return incoming;
    }
    return removed;
  }

  /** Shift+点击：整堆转移到另一库存；手部/装备占满时与可接受槽互换。 */
  function quickTransfer(sourceInv, sourceIndex, targetInv) {
    const origin = sourceInv.originIndex(sourceIndex);
    const stack = sourceInv.getSlot(origin);
    if (!stack) return;
    if (!targetInv.acceptsItem(stack.itemId)) return;
    const item = Catalog.getItem(stack.itemId);
    if (item?.type === 'weapon' || stack.mag != null || stackRot(stack) === 90) {
      let dest = targetInv.findPlaceIndex(stack.itemId, stackRot(stack));
      if (dest < 0 && (targetInv.id === 'hands' || targetInv.id === 'equip')) {
        for (let i = 0; i < targetInv.size(); i += 1) {
          if (targetInv.isCovered?.(i)) continue;
          if (!targetInv.acceptsItem(stack.itemId, i)) continue;
          const existing = targetInv.getSlot(i);
          if (!existing) {
            dest = i;
            break;
          }
          if (existing.itemId === stack.itemId) continue;
          const displaced = placeOnSlot(targetInv, i, { ...stack });
          if (!displaced || displaced.itemId === stack.itemId) continue;
          sourceInv.takeSlot(origin);
          if (sourceInv.placeStack(origin, displaced)) return;
          const bagDest = sourceInv.findPlaceIndex(
            displaced.itemId,
            stackRot(displaced)
          );
          if (bagDest >= 0 && sourceInv.placeStack(bagDest, displaced)) return;
          /* 放不回背包：撤销交换 */
          const undo = placeOnSlot(targetInv, i, displaced);
          if (undo) sourceInv.placeStack(origin, undo);
          else sourceInv.placeStack(origin, stack);
          return;
        }
        if (dest < 0) return;
      }
      if (dest < 0) return;
      if (!targetInv.placeStack(dest, stack)) return;
      sourceInv.takeSlot(origin);
      return;
    }
    const leftover = targetInv.addItem(stack.itemId, stack.qty);
    if (leftover >= stack.qty) return;
    if (leftover <= 0) {
      sourceInv.takeSlot(origin);
    } else {
      sourceInv.slots[origin].qty = leftover;
    }
  }

  window.LpInventoryCore = {
    Inventory,
    EQUIP_SLOT_KEYS,
    BACKPACK_EQUIP_INDEX,
    PLAYER_BASE_COLS,
    PLAYER_BASE_ROWS,
    STORAGE_MAX_STACK: Catalog.STORAGE_MAX_STACK,
    maxStackFor,
    loadInventories,
    saveInventories,
    placeOnSlot,
    quickTransfer,
    normalizeStack,
    stackRot,
    orientedSize,
    toggledRot,
    resolvePlayerBagSize,
    syncPlayerBagToEquip,
    resizeInventory,
    collectStacks,
    sortInventory,
    getEquippedBackpack,
    isAmmoOntoWeaponIntent,
    tryLoadAmmoOntoWeapon,
    restoreTestInfiniteStorage,
    ensurePlaceableFacilitySeeds,
    migrateFacilitiesToFacilityWarehouse,
    createDefaultFacilityStorage,
    createEmptyPlatformStorage,
  };
})();
