/**
 * 武装车厢弹种 / 弹链：共享目录、车厢能力、循环开火游标、底部 HUD、弹药箱弹链编辑、详情浮层。
 *
 * 弹链仅本机：编辑与激活组存在 localStorage（STORAGE_KEY），每位操作者各自一套；
 * 不进服务端权威、不与其它玩家同步。远端开火仍靠子弹上的 ammoType 表现弹种。
 *
 * 开火规则（连发 + supportsBelts）：当前激活弹链按 slots 顺序循环打出；每组弹链自有 cursor，
 * 切组后再切回从该组上次位置继续。火炮类（supportsBelts:false）仅单选弹种，无弹链。
 *
 * 枢机自动化：`applyAmmoSelection` 写入内存 autoByCar（自动装载），不改写本机弹药箱弹链。
 * peek / advance 优先用 autoByCar；玩家入座或手动切组/弹种时清除该车自动装载。
 * 入座期间（activate / isManned）拒绝再写入 autoByCar，且 peek/advance/take 忽略残留 auto，
 * 连续单击与长按共用本机弹链游标；HUD 下划线经 scheduleRender 跟随游标。
 * 离席后重置 ammo 边沿闩并允许规则再设。
 * 无人卫士开火经 peekFireTypeId('guard') 读自动装载（与本机弹链隔离）。
 *
 * 损坏存档：缺失 / 未知 / 不在 allowedTypes 的槽位一律改为 ap，并写回 localStorage。
 */
(() => {
  /** 本机弹链存档键（不进联机库存权威）。 */
  const STORAGE_KEY = 'lp-armed-belts-v1';

  /**
   * 弹种目录（AP=穿甲，T=曳光，rocket=塔莎火箭弹视觉占位）。
   * trail / bodyTint 供 LpCombat；penetrates 留给后续玩法。
   */
  const AMMO_TYPES = {
    ap: {
      id: 'ap',
      tag: 'AP',
      subtitle: '穿甲',
      color: '#3a404c',
      accent: '#555e6c',
      role: '穿甲',
      use: '低对比不透明穿甲弹：缩小弹体、无拖尾，便于隐蔽射击。',
      body: '#3a404c',
      band: '#262b35',
      tip: '#555e6c',
      trail: null,
      bodyScale: 0.62,
      bodyHScale: 0.42,
      tipHighlight: 0.12,
      flashScale: 0.55,
      penetrates: true,
    },
    t: {
      id: 't',
      tag: 'T',
      subtitle: '曳光',
      color: '#86efac',
      accent: '#166534',
      role: '曳光',
      use: '亮绿曳光弹：弹道拖尾；成功发射后下一发散布收窄（不叠加），便于校射。',
      body: '#86efac',
      band: '#166534',
      tip: '#ecfdf5',
      trail: {
        color: 'rgba(34, 197, 94, 0.92)',
        glow: 'rgba(74, 222, 128, 0.55)',
        length: 14,
        width: 3.2,
        linger: 0.35,
      },
      penetrates: false,
    },
    rocket: {
      id: 'rocket',
      tag: 'RKT',
      subtitle: '火箭',
      color: '#9a3412',
      accent: '#fb923c',
      role: '火箭弹',
      use: '塔莎火箭弹：需雷达持续照射目标；爆炸范围伤害。',
      body: '#d6d3d1',
      band: '#9a3412',
      tip: '#b91c1c',
      trail: {
        color: 'rgba(251, 146, 60, 0.9)',
        glow: 'rgba(234, 88, 12, 0.5)',
        length: 18,
        width: 4,
        linger: 0.4,
      },
      penetrates: false,
    },
  };

  /**
   * 车厢能力。supportsBelts=true 仅连发/机枪类可编辑弹链；火炮类只选单弹种。
   * 新武装车：registerCarriage(id, cfg) 或在此表追加。
   */
  const CARRIAGES = {
    guard: {
      id: 'guard',
      label: '卫士',
      /** 可用弹种顺序（单弹种模式 HUD；亦为弹链槽位可选集合）。 */
      allowedTypes: ['ap', 't'],
      supportsBelts: true,
      maxBelts: 4,
      slotsPerBelt: 3,
      /** 手动「添加一组」时的默认槽位。 */
      defaultSlots: ['ap', 'ap', 'ap'],
      /**
       * 首次获得 / 存档无弹链时灌入的默认组（留 1 组空位给玩家加）。
       * 组1 T/T/AP · 组2 T/T/T · 组3 AP/AP/AP；激活组 1，游标全 0。
       */
      defaultBelts: [
        ['t', 't', 'ap'],
        ['t', 't', 't'],
        ['ap', 'ap', 'ap'],
      ],
    },
    tasha: {
      id: 'tasha',
      label: '塔莎',
      allowedTypes: ['rocket'],
      supportsBelts: false,
    },
  };

  /** @deprecated 兼容旧调用；等同 allowedTypes。 */
  const LOADOUTS = Object.fromEntries(
    Object.entries(CARRIAGES).map(([id, c]) => [id, c.allowedTypes.slice()])
  );

  const state = {
    /** @type {string | null} */
    carriageId: null,
    /** 单弹种模式：allowedTypes 下标。 */
    typeIndex: 0,
    /** 弹链模式：激活组下标。 */
    activeBeltIndex: 0,
    /**
     * 各车厢弹链存档：{ belts: string[][], cursors: number[], activeBeltIndex: number }
     * @type {Record<string, { belts: string[][], cursors: number[], activeBeltIndex: number }>}
     */
    byCarriage: {},
    /**
     * 枢机自动装载（内存，不进 localStorage）：覆盖开火 peek/advance，不碰本机弹链。
     * @type {Record<string, { kind: 'type', ammo: string } | { kind: 'belt', slots: string[], cursor: number }>}
     */
    autoByCar: {},
  };

  let root = null;
  let listEl = null;
  let detailPanel = null;
  let detailBody = null;
  let detailIcon = null;
  let detailName = null;
  let detailMeta = null;
  let detailUse = null;
  /** @type {HTMLElement | null} */
  let crateBottomHost = null;
  let hideDetailTimer = 0;
  /** @type {HTMLElement | null} */
  let slotChooser = null;
  let hideChooserTimer = 0;
  /**
   * 当前展开的弹链槽位选择器上下文。
   * @type {{ carriageId: string, beltIndex: number, slotIndex: number, chip: HTMLElement } | null}
   */
  let openChooserRef = null;

  /** 弹链组行拖拽：移动超过该像素才激活（桌面）。 */
  const BELT_DRAG_MOVE_PX = 6;
  /** 触控长按后才激活拖拽，避免与列表滚动冲突。 */
  const BELT_DRAG_LONG_PRESS_MS = 420;
  /**
   * 弹药箱弹链组拖拽会话（仅编辑器内；与枢机规则拖拽同语义）。
   * @type {{
   *   carriageId: string,
   *   fromIndex: number,
   *   pointerId: number,
   *   startX: number,
   *   startY: number,
   *   active: boolean,
   *   fromHandle: boolean,
   *   longPressTimer: ReturnType<typeof setTimeout> | null,
   *   dropIndex: number | null,
   *   listEl: HTMLElement,
   * } | null}
   */
  let beltDrag = null;

  /** 取弹种定义；未知 id 回退 AP。 */
  function getType(id) {
    return AMMO_TYPES[id] || AMMO_TYPES.ap;
  }

  /** 车厢能力配置。 */
  function getCarriage(carriageId) {
    const id = carriageId || state.carriageId;
    return id ? CARRIAGES[id] || null : null;
  }

  /** 当前车厢是否支持弹链编辑/循环开火。 */
  function supportsBelts(carriageId) {
    return Boolean(getCarriage(carriageId)?.supportsBelts);
  }

  /**
   * 可用弹种 id 列表。
   * @param {string} [carriageId] 省略则用当前激活车厢
   */
  function getLoadout(carriageId) {
    const cfg = getCarriage(carriageId);
    return cfg ? cfg.allowedTypes.slice() : [];
  }

  /** 车厢允许集合内的 AP id；allowed 无 ap 时退回首项（卫士恒有 ap）。 */
  function coerceAmmoId(rawId, cfg) {
    const allowed = cfg.allowedTypes;
    const apId = allowed.includes('ap') ? 'ap' : allowed[0];
    if (rawId == null || rawId === '') return apId;
    const id = String(rawId).toLowerCase();
    return allowed.includes(id) ? id : apId;
  }

  /**
   * 规范化槽位：长度固定；缺失 / 未知 / 非 allowed → ap。
   * @returns {{ slots: string[], changed: boolean }}
   */
  function normalizeSlots(raw, cfg) {
    const n = cfg.slotsPerBelt || 3;
    const slots = [];
    let changed = false;
    for (let i = 0; i < n; i += 1) {
      const before = raw?.[i];
      const id = coerceAmmoId(before, cfg);
      if (String(before ?? '').toLowerCase() !== id) changed = true;
      slots.push(id);
    }
    if (!Array.isArray(raw) || raw.length !== n) changed = true;
    return { slots, changed };
  }

  /**
   * 首次初始化弹链：用 defaultBelts（若有），否则单组 defaultSlots。
   * 仅在存档缺失或 belts 为空时调用，不覆盖玩家已编辑数据。
   */
  function seedDefaultBelts(cfg) {
    const max = cfg.maxBelts || 4;
    const raw =
      Array.isArray(cfg.defaultBelts) && cfg.defaultBelts.length > 0
        ? cfg.defaultBelts.slice(0, max)
        : [cfg.defaultSlots];
    const belts = raw.map((slots) => normalizeSlots(slots, cfg).slots);
    return {
      belts,
      cursors: belts.map(() => 0),
      activeBeltIndex: 0,
    };
  }

  /** 序列化对比用：判断消毒是否改写了存档。 */
  function beltStoreFingerprint(store) {
    return JSON.stringify({
      belts: store?.belts,
      cursors: store?.cursors,
      activeBeltIndex: store?.activeBeltIndex,
    });
  }

  /**
   * 读取或初始化某车厢弹链存档（无弹链能力时返回 null）。
   * 消毒未知弹种为 ap；空 belts 灌入 defaultBelts。
   * @returns {{ store: object | null, changed: boolean }}
   */
  function ensureBeltStore(carriageId) {
    const cfg = getCarriage(carriageId);
    if (!cfg?.supportsBelts) return { store: null, changed: false };
    const id = cfg.id;
    let changed = false;
    if (!state.byCarriage[id]) {
      state.byCarriage[id] = seedDefaultBelts(cfg);
      changed = true;
    }
    const store = state.byCarriage[id];
    const before = beltStoreFingerprint(store);
    const nextBelts = [];
    for (const slots of (store.belts || []).slice(0, cfg.maxBelts)) {
      const norm = normalizeSlots(slots, cfg);
      nextBelts.push(norm.slots);
      if (norm.changed) changed = true;
    }
    store.belts = nextBelts;
    if (store.belts.length === 0) {
      const seeded = seedDefaultBelts(cfg);
      store.belts = seeded.belts;
      store.cursors = seeded.cursors;
      store.activeBeltIndex = seeded.activeBeltIndex;
      changed = true;
    }
    while (store.cursors.length < store.belts.length) {
      store.cursors.push(0);
      changed = true;
    }
    store.cursors = store.cursors.slice(0, store.belts.length).map((c, i) => {
      const n = store.belts[i].length;
      return ((Number(c) || 0) % n + n) % n;
    });
    if (store.activeBeltIndex < 0 || store.activeBeltIndex >= store.belts.length) {
      store.activeBeltIndex = 0;
      changed = true;
    }
    if (beltStoreFingerprint(store) !== before) changed = true;
    return { store, changed };
  }

  /** 读取或初始化弹链存档（兼容旧调用，忽略 changed）。 */
  function beltStore(carriageId) {
    return ensureBeltStore(carriageId).store;
  }

  /** 是否已有非空弹链数据（不触发首次 seed）。 */
  function hasBeltData(carriageId) {
    const id = String(carriageId || '').trim();
    const belts = state.byCarriage[id]?.belts;
    return Array.isArray(belts) && belts.length > 0;
  }

  /** 消毒后若有改写则写回本机存档。 */
  function persistIfChanged(changed) {
    if (changed) savePersisted();
  }

  /** 从 localStorage 加载弹链；损坏槽位改为 ap 并写回。 */
  function loadPersisted() {
    let dirty = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      for (const [id, data] of Object.entries(parsed)) {
        if (!CARRIAGES[id]?.supportsBelts || !data) continue;
        state.byCarriage[id] = {
          belts: Array.isArray(data.belts) ? data.belts : [],
          cursors: Array.isArray(data.cursors) ? data.cursors : [],
          activeBeltIndex: Number(data.activeBeltIndex) || 0,
        };
        if (ensureBeltStore(id).changed) dirty = true;
      }
    } catch (_) {
      /* ignore corrupt JSON; 下次 seed / 编辑会重建 */
    }
    persistIfChanged(dirty);
  }

  /**
   * 持久化弹链到本机 localStorage（始终写入；联机也不走服务端权威）。
   * 只写已有 byCarriage 条目，避免 save 时给未获得的车厢灌默认。
   */
  function savePersisted() {
    const out = {};
    for (const id of Object.keys(state.byCarriage)) {
      if (!CARRIAGES[id]?.supportsBelts) continue;
      const { store } = ensureBeltStore(id);
      if (!store) continue;
      out[id] = {
        belts: store.belts.map((s) => s.slice()),
        cursors: store.cursors.slice(),
        activeBeltIndex: store.activeBeltIndex,
      };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  }

  /** 导出弹链 JSON（本机弹药箱副本；非联机权威）。 */
  function beltsToJSON(carriageId) {
    const store = beltStore(carriageId || state.carriageId);
    if (!store) return null;
    return {
      belts: store.belts.map((s) => s.slice()),
      cursors: store.cursors.slice(),
      activeBeltIndex: store.activeBeltIndex,
    };
  }

  /**
   * 用本机快照覆盖弹链并消毒写回。
   * 仅应来自本机 crate / 迁移；勿接服务端权威 belts。
   */
  function applyBeltsFromSnapshot(carriageId, data) {
    const cfg = getCarriage(carriageId);
    if (!cfg?.supportsBelts || !data) return;
    state.byCarriage[cfg.id] = {
      belts: Array.isArray(data.belts) ? data.belts : [],
      cursors: Array.isArray(data.cursors) ? data.cursors : [],
      activeBeltIndex: Number(data.activeBeltIndex) || 0,
    };
    ensureBeltStore(cfg.id);
    // 快照可能含损坏槽位：消毒后一律写回本机文件。
    savePersisted();
    if (state.carriageId === cfg.id) {
      state.activeBeltIndex = state.byCarriage[cfg.id].activeBeltIndex;
    }
    render();
    renderBeltEditor();
  }

  /** 弹链槽位文案：T/AP/AP。 */
  function formatBeltPattern(slots) {
    return (slots || []).map((id) => getType(id).tag).join('/');
  }

  /** 当前激活弹链 slots；无弹链能力时 null。 */
  function getActiveBeltSlots() {
    const store = beltStore();
    if (!store) return null;
    return store.belts[store.activeBeltIndex] || null;
  }

  /**
   * 清除某车厢的枢机自动装载（入座接管或玩家手动切弹时调用）。
   * @param {string} [carriageId]
   */
  function clearAutoLoadout(carriageId) {
    const id = carriageId || state.carriageId;
    if (!id || !state.autoByCar[id]) return;
    delete state.autoByCar[id];
  }

  /**
   * 读取自动装载（副本）；无则 null。
   * @param {string} [carriageId]
   */
  function getAutoLoadout(carriageId) {
    const id = carriageId || state.carriageId;
    if (!id) return null;
    const auto = state.autoByCar[id];
    if (!auto) return null;
    if (auto.kind === 'type') return { kind: 'type', ammo: auto.ammo };
    return {
      kind: 'belt',
      slots: (auto.slots || []).slice(),
      cursor: auto.cursor || 0,
    };
  }

  /**
   * 卫士是否正被本机入座操控（入座时开火必须走本机弹链，忽略 autoByCar）。
   * @returns {boolean}
   */
  function isLocalMannedGuard() {
    return Boolean(window.LpGuardTurret?.isManned?.());
  }

  /**
   * 解析开火用车厢 id：显式参数 → 当前 activate → 入座卫士兜底 guard。
   * @param {string} [carriageId]
   * @returns {string | null}
   */
  function resolveFireCarriageId(carriageId) {
    const raw = String(carriageId || state.carriageId || '').trim();
    if (raw) return raw;
    return isLocalMannedGuard() ? 'guard' : null;
  }

  /**
   * 窥视下一发弹种 id（不推进游标）。
   * 无人：优先枢机 autoByCar。入座：始终本机弹链/弹种（忽略残留 auto）。
   * @param {string} [carriageId] 省略则用当前激活车厢 / 入座卫士
   */
  function peekFireTypeId(carriageId) {
    const id = resolveFireCarriageId(carriageId);
    const cfg = getCarriage(id);
    if (!cfg) return 'ap';
    const mannedSkipAuto = id === 'guard' && isLocalMannedGuard();
    const auto = id && !mannedSkipAuto ? state.autoByCar[id] : null;
    if (auto?.kind === 'type') {
      return coerceAmmoId(auto.ammo, cfg);
    }
    if (auto?.kind === 'belt' && auto.slots?.length) {
      return auto.slots[(auto.cursor || 0) % auto.slots.length];
    }
    if (cfg.supportsBelts) {
      const store = beltStore(id);
      const slots = store?.belts[store.activeBeltIndex];
      if (!slots?.length) return cfg.allowedTypes[0] || 'ap';
      const cursor = Number(store.cursors[store.activeBeltIndex]) || 0;
      return slots[((cursor % slots.length) + slots.length) % slots.length];
    }
    if (id && state.carriageId === id) {
      return cfg.allowedTypes[state.typeIndex] || cfg.allowedTypes[0] || 'ap';
    }
    return cfg.allowedTypes[0] || 'ap';
  }

  /**
   * 成功开火后推进：自动装载弹链 cursor+1；否则本机弹链组内 cursor+1。
   * 入座卫士只推进本机弹链（忽略 auto）。双联同发仍只调用一次。
   * HUD / 弹药箱弹链编辑器游标经 scheduleRender + renderBeltEditor 刷新。
   * @param {string} [carriageId]
   */
  function advanceFireCursor(carriageId) {
    const id = resolveFireCarriageId(carriageId);
    const cfg = getCarriage(id);
    if (!cfg) return;
    const mannedSkipAuto = id === 'guard' && isLocalMannedGuard();
    const auto = id && !mannedSkipAuto ? state.autoByCar[id] : null;
    if (auto?.kind === 'belt' && auto.slots?.length) {
      auto.cursor = ((Number(auto.cursor) || 0) + 1) % auto.slots.length;
      scheduleRender();
      renderBeltEditor();
      return;
    }
    if (auto?.kind === 'type') return;
    if (!cfg.supportsBelts) return;
    const store = beltStore(id);
    if (!store) return;
    const i = store.activeBeltIndex;
    const n = store.belts[i]?.length || 1;
    store.cursors[i] = ((Number(store.cursors[i]) || 0) + 1) % n;
    savePersisted();
    scheduleRender();
    renderBeltEditor();
  }

  /**
   * 成功耗弹后取本发弹种并推进游标（peek + advance 原子组合）。
   * 双联多枪口共用返回值，只调用一次。
   * @param {string} [carriageId]
   * @returns {string}
   */
  function takeFireTypeId(carriageId) {
    const typeId = peekFireTypeId(carriageId);
    advanceFireCursor(carriageId);
    return typeId;
  }

  /** 合并同帧多次 render，避免开火 pointerdown 中途 replaceChildren。 */
  let renderScheduled = 0;

  /** 安排下一微任务刷新武装 HUD（游标下划线等）。 */
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = 1;
    queueMicrotask(() => {
      renderScheduled = 0;
      render();
    });
  }

  /** 当前选中弹种定义（窥视下一发）。 */
  function getSelected() {
    if (!state.carriageId) return null;
    return getType(peekFireTypeId());
  }

  /** 当前选中弹种 id。 */
  function getSelectedId() {
    if (!state.carriageId) return null;
    return peekFireTypeId();
  }

  /** 武装 HUD 是否应对玩家可见。 */
  function isActive() {
    return Boolean(state.carriageId && getLoadout().length > 0);
  }

  /** 确保底部 HUD DOM。 */
  function ensureDom() {
    if (root) return;
    root = document.getElementById('lpArmedAmmoHud');
    if (!root) {
      root = document.createElement('div');
      root.id = 'lpArmedAmmoHud';
      root.className = 'lp-armed-ammo-hud';
      root.setAttribute('aria-label', '弹种');
      root.hidden = true;
      const stage = document.querySelector('.lp-stage') || document.body;
      stage.appendChild(root);
    }
    listEl = root.querySelector('.lp-armed-ammo-list');
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.className = 'lp-armed-ammo-list';
      listEl.setAttribute('role', 'listbox');
      listEl.setAttribute('aria-label', '弹种列表');
      root.appendChild(listEl);
    }
    ensureDetailDom();
  }

  /**
   * 确保弹种/弹链详情浮层存在，并挂到 document.body。
   * 必须离开 .lp-stage-ui（z-index:3）等低层叠上下文，否则会被弹药箱(23)等盖住。
   */
  function ensureDetailDom() {
    if (!detailPanel) {
      detailPanel = document.getElementById('lpArmedAmmoDetail');
      if (!detailPanel) {
        detailPanel = document.createElement('aside');
        detailPanel.id = 'lpArmedAmmoDetail';
        detailPanel.className = 'lp-inventory-detail lp-armed-ammo-detail';
        detailPanel.hidden = true;
        detailPanel.setAttribute('aria-live', 'polite');
        detailPanel.innerHTML =
          '<div class="lp-inventory-detail-body">' +
          '<div class="lp-inventory-detail-icon-wrap">' +
          '<span class="lp-inventory-item-icon lp-armed-ammo-detail-icon"></span>' +
          '</div>' +
          '<h3 class="lp-inventory-detail-name"></h3>' +
          '<dl class="lp-inventory-detail-meta"></dl>' +
          '<p class="lp-inventory-detail-use-label">作用</p>' +
          '<p class="lp-inventory-detail-use"></p>' +
          '</div>';
      }
      detailBody = detailPanel.querySelector('.lp-inventory-detail-body');
      detailIcon = detailPanel.querySelector('.lp-inventory-item-icon');
      detailName = detailPanel.querySelector('.lp-inventory-detail-name');
      detailMeta = detailPanel.querySelector('.lp-inventory-detail-meta');
      detailUse = detailPanel.querySelector('.lp-inventory-detail-use');
    }
    if (detailPanel.parentNode !== document.body) {
      document.body.appendChild(detailPanel);
    }
  }

  /** 定位详情浮层到指针旁（与物品栏同策略）。 */
  function positionDetail(clientX, clientY) {
    if (!detailPanel || detailPanel.hidden) return;
    const pad = 12;
    const rect = detailPanel.getBoundingClientRect();
    let left = clientX + 16;
    let top = clientY + 16;
    if (left + rect.width > window.innerWidth - pad) {
      left = clientX - rect.width - 12;
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - rect.height - pad;
    }
    left = Math.max(pad, left);
    top = Math.max(pad, top);
    detailPanel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** 隐藏详情浮层。 */
  function hideDetail() {
    if (hideDetailTimer) {
      window.clearTimeout(hideDetailTimer);
      hideDetailTimer = 0;
    }
    if (!detailPanel) return;
    detailPanel.hidden = true;
    detailPanel.style.transform = '';
  }

  /**
   * 显示弹种详情（物品栏同款布局：图标/名/元数据格/作用）。
   * @param {string} ammoId
   * @param {{ clientX?: number, clientY?: number }} [opts]
   */
  function showTypeDetail(ammoId, opts = {}) {
    ensureDetailDom();
    const def = getType(ammoId);
    if (detailIcon) {
      detailIcon.style.setProperty('--item-color', def.color || def.body);
      detailIcon.style.setProperty('--item-accent', def.accent || def.band);
      detailIcon.classList.remove('has-image');
      detailIcon.style.removeProperty('--lp-item-icon');
      detailIcon.textContent = def.tag;
    }
    if (detailName) detailName.textContent = `${def.tag} ${def.subtitle}`;
    if (detailMeta) {
      detailMeta.innerHTML =
        `<div><dt>标记</dt><dd>${def.tag}</dd></div>` +
        `<div><dt>类型</dt><dd>${def.role || def.subtitle}</dd></div>` +
        `<div><dt>拖尾</dt><dd>${def.trail ? '有' : '无'}</dd></div>` +
        `<div><dt>穿甲</dt><dd>${def.penetrates ? '是' : '否'}</dd></div>`;
    }
    if (detailUse) detailUse.textContent = def.use || '暂无说明';
    detailPanel.hidden = false;
    if (opts.clientX != null && opts.clientY != null) {
      detailPanel.style.transform = 'translate(-9999px, -9999px)';
      requestAnimationFrame(() => positionDetail(opts.clientX, opts.clientY));
    }
  }

  /**
   * 显示弹链详情。
   * @param {number} beltIndex
   * @param {{ clientX?: number, clientY?: number, carriageId?: string }} [opts]
   */
  function showBeltDetail(beltIndex, opts = {}) {
    ensureDetailDom();
    const cfg = getCarriage(opts.carriageId);
    const store = beltStore(opts.carriageId || state.carriageId);
    if (!cfg || !store || beltIndex < 0 || beltIndex >= store.belts.length) {
      hideDetail();
      return;
    }
    const slots = store.belts[beltIndex];
    const pattern = formatBeltPattern(slots);
    const cursor = store.cursors[beltIndex] || 0;
    const next = getType(slots[cursor % slots.length]);
    const active = beltIndex === store.activeBeltIndex;
    if (detailIcon) {
      detailIcon.style.setProperty('--item-color', '#a16207');
      detailIcon.style.setProperty('--item-accent', '#fbbf24');
      detailIcon.classList.remove('has-image');
      detailIcon.style.removeProperty('--lp-item-icon');
      detailIcon.textContent = String(beltIndex + 1);
    }
    if (detailName) detailName.textContent = `弹链 ${beltIndex + 1}`;
    if (detailMeta) {
      detailMeta.innerHTML =
        `<div><dt>序列</dt><dd>${pattern}</dd></div>` +
        `<div><dt>状态</dt><dd>${active ? '使用中' : '待命'}</dd></div>` +
        `<div><dt>下一发</dt><dd>${next.tag}</dd></div>` +
        `<div><dt>游标</dt><dd>${cursor + 1}/${slots.length}</dd></div>`;
    }
    if (detailUse) {
      detailUse.textContent =
        `连发按顺序循环：${pattern}，打完一轮后回到首位。切换弹链保留各组游标。`;
    }
    detailPanel.hidden = false;
    if (opts.clientX != null && opts.clientY != null) {
      detailPanel.style.transform = 'translate(-9999px, -9999px)';
      requestAnimationFrame(() => positionDetail(opts.clientX, opts.clientY));
    }
  }

  /** 绑定悬停详情（粗指针跳过，与物品栏一致）。 */
  function bindHoverDetail(el, showFn) {
    if (!el) return;
    el.addEventListener('pointerenter', (event) => {
      if (window.matchMedia?.('(pointer: coarse)')?.matches) return;
      if (hideDetailTimer) {
        window.clearTimeout(hideDetailTimer);
        hideDetailTimer = 0;
      }
      showFn(event);
    });
    el.addEventListener('pointermove', (event) => {
      if (detailPanel?.hidden) return;
      if (window.matchMedia?.('(pointer: coarse)')?.matches) return;
      positionDetail(event.clientX, event.clientY);
    });
    el.addEventListener('pointerleave', () => {
      hideDetailTimer = window.setTimeout(hideDetail, 80);
    });
  }

  /** 是否粗指针（触控优先），槽位用点击展开选择器。 */
  function isCoarsePointer() {
    return Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
  }

  /** 确保弹链槽位弹种选择浮层（挂 body，避免底栏裁切、压过弹药箱）。 */
  function ensureSlotChooserDom() {
    if (slotChooser) return;
    slotChooser = document.getElementById('lpGuardBeltChooser');
    if (!slotChooser) {
      slotChooser = document.createElement('div');
      slotChooser.id = 'lpGuardBeltChooser';
      slotChooser.className = 'lp-guard-belt-chooser';
      slotChooser.hidden = true;
      slotChooser.setAttribute('role', 'listbox');
      slotChooser.setAttribute('aria-label', '可选弹种');
      document.body.appendChild(slotChooser);
    }
    slotChooser.addEventListener('pointerenter', () => {
      if (hideChooserTimer) {
        window.clearTimeout(hideChooserTimer);
        hideChooserTimer = 0;
      }
    });
    slotChooser.addEventListener('pointerleave', () => {
      scheduleHideSlotChooser();
    });
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!slotChooser || slotChooser.hidden) return;
        const t = event.target;
        if (!(t instanceof Node)) return;
        if (slotChooser.contains(t)) return;
        if (openChooserRef?.chip?.contains(t)) return;
        hideSlotChooser();
        hideDetail();
      },
      true
    );
  }

  /** 延迟收起弹种选择器，便于指针从槽位移入浮层。 */
  function scheduleHideSlotChooser(ms = 180) {
    if (hideChooserTimer) window.clearTimeout(hideChooserTimer);
    hideChooserTimer = window.setTimeout(() => {
      hideChooserTimer = 0;
      hideSlotChooser();
      hideDetail();
    }, ms);
  }

  /** 关闭弹链槽位弹种选择器。 */
  function hideSlotChooser() {
    if (hideChooserTimer) {
      window.clearTimeout(hideChooserTimer);
      hideChooserTimer = 0;
    }
    if (openChooserRef?.chip) {
      openChooserRef.chip.classList.remove('is-chooser-open');
      openChooserRef.chip.setAttribute('aria-expanded', 'false');
    }
    openChooserRef = null;
    if (!slotChooser) return;
    slotChooser.hidden = true;
    slotChooser.replaceChildren();
  }

  /**
   * 将选择器定位到槽位 chip 旁（优先上方，空间不足则下方）。
   * @param {HTMLElement} anchorEl
   */
  function positionSlotChooser(anchorEl) {
    if (!slotChooser || slotChooser.hidden || !anchorEl) return;
    const pad = 8;
    const gap = 4;
    const rect = anchorEl.getBoundingClientRect();
    const chooserRect = slotChooser.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - chooserRect.width / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - chooserRect.width - pad));
    let top = rect.top - chooserRect.height - gap;
    if (top < pad) {
      top = rect.bottom + gap;
    }
    if (top + chooserRect.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - chooserRect.height - pad);
    }
    slotChooser.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /**
   * 展开槽位可选弹种浮层（来自车厢 allowedTypes）。
   * @param {string} carriageId
   * @param {number} beltIndex
   * @param {number} slotIndex
   * @param {HTMLElement} chip
   */
  function showSlotChooser(carriageId, beltIndex, slotIndex, chip) {
    const cfg = getCarriage(carriageId);
    if (!cfg?.supportsBelts || !chip) return;
    ensureSlotChooserDom();
    if (hideChooserTimer) {
      window.clearTimeout(hideChooserTimer);
      hideChooserTimer = 0;
    }
    if (
      openChooserRef &&
      openChooserRef.carriageId === carriageId &&
      openChooserRef.beltIndex === beltIndex &&
      openChooserRef.slotIndex === slotIndex &&
      slotChooser &&
      !slotChooser.hidden
    ) {
      positionSlotChooser(chip);
      return;
    }
    if (openChooserRef?.chip && openChooserRef.chip !== chip) {
      openChooserRef.chip.classList.remove('is-chooser-open');
      openChooserRef.chip.setAttribute('aria-expanded', 'false');
    }
    hideDetail();
    openChooserRef = { carriageId, beltIndex, slotIndex, chip };
    chip.classList.add('is-chooser-open');
    chip.setAttribute('aria-expanded', 'true');

    const store = beltStore(carriageId);
    const current = store?.belts[beltIndex]?.[slotIndex];
    const frag = document.createDocumentFragment();
    cfg.allowedTypes.forEach((id) => {
      const def = getType(id);
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'lp-guard-belt-chooser-opt';
      opt.dataset.ammoId = def.id;
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', id === current ? 'true' : 'false');
      opt.classList.toggle('is-current', id === current);
      opt.innerHTML =
        `<span class="lp-guard-belt-chooser-tag">${def.tag}</span>` +
        `<span class="lp-guard-belt-chooser-name">${def.subtitle}</span>`;
      opt.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const ok = setBeltSlot(carriageId, beltIndex, slotIndex, id);
        if (ok) {
          window.LiminalInteract?.showToast?.(
            `弹链 ${beltIndex + 1} 槽 ${slotIndex + 1} → 「${def.tag} ${def.subtitle}」`
          );
        }
        hideSlotChooser();
        hideDetail();
      });
      bindHoverDetail(opt, (ev) =>
        showTypeDetail(def.id, { clientX: ev.clientX, clientY: ev.clientY })
      );
      frag.appendChild(opt);
    });
    slotChooser.replaceChildren(frag);
    slotChooser.hidden = false;
    slotChooser.style.transform = 'translate(-9999px, -9999px)';
    requestAnimationFrame(() => positionSlotChooser(chip));
  }

  /**
   * 绑定槽位：悬停展开弹种列表；粗指针点击展开；细指针点击仍可循环切换。
   * @param {HTMLElement} chip
   * @param {string} carriageId
   * @param {number} beltIndex
   * @param {number} slotIndex
   */
  function bindSlotTypeChooser(chip, carriageId, beltIndex, slotIndex) {
    chip.setAttribute('aria-haspopup', 'listbox');
    chip.setAttribute('aria-expanded', 'false');
    chip.addEventListener('pointerenter', (event) => {
      if (isCoarsePointer() || event.pointerType === 'touch') return;
      showSlotChooser(carriageId, beltIndex, slotIndex, chip);
    });
    chip.addEventListener('pointerleave', () => {
      if (isCoarsePointer()) return;
      scheduleHideSlotChooser();
    });
    chip.addEventListener('click', () => {
      if (isCoarsePointer()) {
        if (
          openChooserRef?.chip === chip &&
          slotChooser &&
          !slotChooser.hidden
        ) {
          hideSlotChooser();
          hideDetail();
          return;
        }
        showSlotChooser(carriageId, beltIndex, slotIndex, chip);
        return;
      }
      cycleBeltSlot(carriageId, beltIndex, slotIndex);
      const store = beltStore(carriageId);
      const next = getType(store?.belts[beltIndex]?.[slotIndex]);
      window.LiminalInteract?.showToast?.(
        `弹链 ${beltIndex + 1} 槽 ${slotIndex + 1} → 「${next.tag} ${next.subtitle}」`
      );
    });
  }

  /** 刷新底部 HUD（弹链模式列组；单弹种模式列类型）。 */
  function render() {
    ensureDom();
    const cfg = getCarriage();
    const active = isActive();
    const uiBlocked =
      document.body.classList.contains('lp-inventory-open') ||
      document.body.classList.contains('lp-fuel-feed-open') ||
      document.body.classList.contains('lp-crate-feed-open') ||
      document.body.classList.contains('lp-boiler-panel-open') ||
      document.body.classList.contains('lp-radar-panel-open') ||
      document.body.classList.contains('lp-tasha-fc-open') ||
      document.body.classList.contains('lp-auto-console-open') ||
      document.body.classList.contains('lp-train-map-open') ||
      document.body.classList.contains('lp-dungeon-map-open');
    root.hidden = !active || uiBlocked;
    root.setAttribute('aria-hidden', root.hidden ? 'true' : 'false');
    root.setAttribute('aria-label', cfg?.supportsBelts ? '弹链' : '弹种');
    if (!active || !cfg) {
      listEl.replaceChildren();
      return;
    }

    const frag = document.createDocumentFragment();
    if (cfg.supportsBelts) {
      const store = beltStore();
      store.belts.forEach((slots, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lp-armed-ammo-slot lp-armed-ammo-belt';
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', i === store.activeBeltIndex ? 'true' : 'false');
        btn.classList.toggle('is-active', i === store.activeBeltIndex);
        btn.dataset.beltIndex = String(i);
        const cursor = store.cursors[i] || 0;
        const chips = slots
          .map((id, si) => {
            const def = getType(id);
            const next = si === cursor % slots.length;
            return (
              `<span class="lp-armed-ammo-chip${next ? ' is-next' : ''}" data-ammo-id="${def.id}">` +
              `${def.tag}</span>`
            );
          })
          .join('<span class="lp-armed-ammo-chip-sep">/</span>');
        btn.innerHTML =
          `<span class="lp-armed-ammo-tag">组 ${i + 1}</span>` +
          `<span class="lp-armed-ammo-sub lp-armed-ammo-belt-pattern">${chips}</span>` +
          `<span class="lp-armed-ammo-key">${i + 1}</span>`;
        btn.addEventListener('click', () => selectBeltIndex(i, { toast: true }));
        bindHoverDetail(btn, (e) =>
          showBeltDetail(i, { clientX: e.clientX, clientY: e.clientY })
        );
        frag.appendChild(btn);
      });
    } else {
      cfg.allowedTypes.forEach((id, i) => {
        const def = getType(id);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lp-armed-ammo-slot';
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', i === state.typeIndex ? 'true' : 'false');
        btn.classList.toggle('is-active', i === state.typeIndex);
        btn.dataset.ammoId = def.id;
        btn.dataset.index = String(i);
        btn.innerHTML =
          `<span class="lp-armed-ammo-tag">${def.tag}</span>` +
          `<span class="lp-armed-ammo-sub">${def.subtitle}</span>` +
          `<span class="lp-armed-ammo-key">${i + 1}</span>`;
        btn.addEventListener('click', () => selectTypeIndex(i, { toast: true }));
        bindHoverDetail(btn, (e) =>
          showTypeDetail(def.id, { clientX: e.clientX, clientY: e.clientY })
        );
        frag.appendChild(btn);
      });
    }
    listEl.replaceChildren(frag);
  }

  /**
   * 进入武装操控：启用该车厢能力并显示底栏。
   * 立刻清除该车 autoByCar，开火与 HUD 改用本机弹链/弹种；入座期间拒绝自动再写入。
   * 首次无存档时 seed 默认弹链；损坏槽位改为 ap 并写回本机。
   * @param {string} carriageId
   */
  function activate(carriageId) {
    const id = String(carriageId || '').trim();
    if (!CARRIAGES[id]) return;
    state.carriageId = id;
    clearAutoLoadout(id);
    const cfg = CARRIAGES[id];
    if (cfg.supportsBelts) {
      const { store, changed } = ensureBeltStore(id);
      state.activeBeltIndex = store.activeBeltIndex;
      persistIfChanged(changed);
    } else if (state.typeIndex < 0 || state.typeIndex >= cfg.allowedTypes.length) {
      state.typeIndex = 0;
    }
    render();
  }

  /**
   * 离席：隐藏底栏；放开 autoByCar 写入。
   * 重置该车 ammo 冲突域边沿闩，使仍为真的 select_ammo（含旧 edge）下一帧可再装载。
   */
  function deactivate() {
    const leftId = state.carriageId;
    state.carriageId = null;
    hideDetail();
    render();
    if (leftId) {
      window.LpAutoExecutors?.resetEdgeForDomain?.(leftId, 'ammo');
    }
  }

  /** 选中弹链组（0-based）；保留各组 cursor；清除该车自动装载。 */
  function selectBeltIndex(index, opts = {}) {
    const cid = opts.carriageId || state.carriageId;
    const store = beltStore(cid);
    if (!store || index < 0 || index >= store.belts.length) return false;
    clearAutoLoadout(cid);
    store.activeBeltIndex = index;
    if (!state.carriageId || state.carriageId === (getCarriage(cid)?.id || cid)) {
      state.activeBeltIndex = index;
    }
    savePersisted();
    render();
    renderBeltEditor();
    if (opts.toast) {
      const pattern = formatBeltPattern(store.belts[index]);
      window.LiminalInteract?.showToast?.(`选中 「弹链 ${index + 1} · ${pattern}」`);
    }
    return true;
  }

  /**
   * 单弹种模式：按 allowedTypes 下标选中；清除该车自动装载。
   * @param {number} index
   * @param {{ toast?: boolean, carriageId?: string }} [opts]
   */
  function selectTypeIndex(index, opts = {}) {
    const cid = opts.carriageId || state.carriageId;
    const loadout = getLoadout(cid);
    if (!loadout.length || index < 0 || index >= loadout.length) return false;
    clearAutoLoadout(cid);
    if (!state.carriageId || state.carriageId === (getCarriage(cid)?.id || cid)) {
      state.typeIndex = index;
    }
    render();
    if (opts.toast) {
      const def = getType(loadout[index]);
      window.LiminalInteract?.showToast?.(`选中 「${def.tag} ${def.subtitle}」`);
    }
    return true;
  }

  /**
   * 按弹种 id 选中（火炮类）；未知或不在 allowed 则失败。
   * @param {string} carriageId
   * @param {string} ammoId
   * @param {{ toast?: boolean }} [opts]
   */
  function selectTypeById(carriageId, ammoId, opts = {}) {
    const loadout = getLoadout(carriageId);
    const id = String(ammoId || '').toLowerCase();
    const index = loadout.indexOf(id);
    if (index < 0) return false;
    return selectTypeIndex(index, { ...opts, carriageId });
  }

  /**
   * 将给定 slots 写入本机弹链并激活：已有相同序列则切组；否则在上限内追加；已满则覆盖当前激活组。
   * 供枢机「选择弹种/弹链」运行时写入本地弹链权威。
   * @param {string} carriageId
   * @param {string[]} rawSlots
   * @param {{ toast?: boolean, label?: string }} [opts]
   */
  function activateOrInsertBelt(carriageId, rawSlots, opts = {}) {
    const cfg = getCarriage(carriageId);
    if (!cfg?.supportsBelts) return false;
    const store = beltStore(carriageId);
    if (!store) return false;
    const { slots } = normalizeSlots(rawSlots, cfg);
    const key = slots.join('/');
    let index = store.belts.findIndex((b) => (b || []).join('/') === key);
    if (index < 0) {
      if (store.belts.length < (cfg.maxBelts || 4)) {
        store.belts.push(slots.slice());
        store.cursors.push(0);
        index = store.belts.length - 1;
      } else {
        index = store.activeBeltIndex;
        if (index < 0 || index >= store.belts.length) index = 0;
        store.belts[index] = slots.slice();
        store.cursors[index] = 0;
      }
      savePersisted();
    }
    return selectBeltIndex(index, {
      toast: opts.toast,
      carriageId,
    });
  }

  /**
   * 枢机自动化选弹：写入 autoByCar（不改本机弹药箱弹链）。
   * 弹种：火炮 → type；连发车 → 全同型 slots 弹链装载。弹链：消毒 slots 后装载。
   * 同一 pattern 重复写入时保留 cursor（持续规则每帧调用不重置循环）。
   * 玩家已入座该车时拒绝写入（离席后规则可再设）。
   * @param {string} carriageId
   * @param {{ kind: 'type'|'belt', ammo?: string, slots?: string[] }} selection
   * @param {{ toast?: boolean }} [opts]
   */
  function applyAmmoSelection(carriageId, selection, opts = {}) {
    const cfg = getCarriage(carriageId);
    if (!cfg || !selection || !carriageId) return false;
    /* 入座中：拒绝自动装载（含 activate 未及时设 carriageId 时的 isManned 兜底）。 */
    if (state.carriageId === carriageId) return false;
    if (carriageId === 'guard' && isLocalMannedGuard()) return false;
    const prev = state.autoByCar[carriageId];

    if (selection.kind === 'type') {
      const ammo = coerceAmmoId(selection.ammo, cfg);
      if (!cfg.supportsBelts) {
        if (prev?.kind === 'type' && prev.ammo === ammo) return true;
        state.autoByCar[carriageId] = { kind: 'type', ammo };
        if (opts.toast) {
          const def = getType(ammo);
          window.LiminalInteract?.showToast?.(
            `自动装载 「${def.tag} ${def.subtitle}」`
          );
        }
        render();
        return true;
      }
      const slots = Array(cfg.slotsPerBelt || 3).fill(ammo);
      const key = slots.join('/');
      if (prev?.kind === 'belt' && (prev.slots || []).join('/') === key) {
        return true;
      }
      state.autoByCar[carriageId] = { kind: 'belt', slots, cursor: 0 };
      if (opts.toast) {
        window.LiminalInteract?.showToast?.(
          `自动装载 「${formatBeltPattern(slots)}」`
        );
      }
      render();
      return true;
    }

    if (selection.kind === 'belt') {
      if (!cfg.supportsBelts) return false;
      const { slots } = normalizeSlots(selection.slots || [], cfg);
      const key = slots.join('/');
      if (prev?.kind === 'belt' && (prev.slots || []).join('/') === key) {
        return true;
      }
      state.autoByCar[carriageId] = { kind: 'belt', slots, cursor: 0 };
      if (opts.toast) {
        window.LiminalInteract?.showToast?.(
          `自动装载 「${formatBeltPattern(slots)}」`
        );
      }
      render();
      return true;
    }
    return false;
  }

  /**
   * 兼容旧 API：弹链模式选组；单弹种模式选类型。
   * @param {number} index
   * @param {{ toast?: boolean }} [opts]
   */
  function selectIndex(index, opts = {}) {
    if (supportsBelts()) return selectBeltIndex(index, opts);
    return selectTypeIndex(index, opts);
  }

  /** 循环切换下一弹链/弹种（与 handsHud 共用键）。 */
  function cycle(opts = {}) {
    if (!isActive()) return false;
    if (supportsBelts()) {
      const store = beltStore();
      if (!store?.belts.length) return false;
      const next = (store.activeBeltIndex + 1) % store.belts.length;
      return selectBeltIndex(next, { toast: opts.toast !== false });
    }
    const loadout = getLoadout();
    if (!loadout.length) return false;
    return selectTypeIndex((state.typeIndex + 1) % loadout.length, {
      toast: opts.toast !== false,
    });
  }

  /** 数字键 1…N → 选中对应组/弹种。 */
  function selectByNumber(oneBased) {
    return selectIndex(oneBased - 1, { toast: true });
  }

  /** 循环某槽位弹种（编辑器用）。 */
  function cycleSlotType(currentId, cfg) {
    const allowed = cfg.allowedTypes;
    const i = allowed.indexOf(currentId);
    return allowed[(i + 1 + allowed.length) % allowed.length] || allowed[0];
  }

  /** 添加一组弹链（不超过 maxBelts）。 */
  function addBelt(carriageId) {
    const cfg = getCarriage(carriageId);
    const store = beltStore(carriageId);
    if (!cfg || !store || store.belts.length >= cfg.maxBelts) return false;
    store.belts.push(normalizeSlots(cfg.defaultSlots, cfg).slots);
    store.cursors.push(0);
    savePersisted();
    render();
    renderBeltEditor();
    return true;
  }

  /** 删除一组弹链（至少保留 1 组）。 */
  function removeBelt(carriageId, beltIndex) {
    const store = beltStore(carriageId);
    if (!store || store.belts.length <= 1) return false;
    if (beltIndex < 0 || beltIndex >= store.belts.length) return false;
    store.belts.splice(beltIndex, 1);
    store.cursors.splice(beltIndex, 1);
    if (store.activeBeltIndex >= store.belts.length) {
      store.activeBeltIndex = store.belts.length - 1;
    }
    savePersisted();
    render();
    renderBeltEditor();
    return true;
  }

  /**
   * 将弹链组挪到指定插入下标并写回本机存档。
   * dropIndex 为「除去被拖组后」的插入前位置（0=表首，length=表末），与枢机 moveRuleToSlot 一致。
   * 激活组与各组 cursor 随内容移动：拖走激活组时 activeBeltIndex 指向该组新下标。
   * @param {string} carriageId
   * @param {number} fromIndex
   * @param {number} dropIndex
   * @returns {boolean}
   */
  function moveBeltToSlot(carriageId, fromIndex, dropIndex) {
    const store = beltStore(carriageId);
    if (!store) return false;
    const n = store.belts.length;
    if (n <= 1) return false;
    if (fromIndex < 0 || fromIndex >= n) return false;
    let insertAt = Math.max(0, Number(dropIndex) || 0);
    if (insertAt === fromIndex) return false;

    const belt = store.belts.splice(fromIndex, 1)[0];
    const cursor = store.cursors.splice(fromIndex, 1)[0];
    let active = store.activeBeltIndex;
    let movedActive = false;
    if (active === fromIndex) {
      movedActive = true;
      active = 0;
    } else if (active > fromIndex) {
      active -= 1;
    }
    insertAt = Math.max(0, Math.min(insertAt, store.belts.length));
    store.belts.splice(insertAt, 0, belt);
    store.cursors.splice(insertAt, 0, cursor);
    if (movedActive) {
      store.activeBeltIndex = insertAt;
    } else if (insertAt <= active) {
      store.activeBeltIndex = active + 1;
    } else {
      store.activeBeltIndex = active;
    }

    const cfgId = getCarriage(carriageId)?.id || carriageId;
    if (!state.carriageId || state.carriageId === cfgId) {
      state.activeBeltIndex = store.activeBeltIndex;
    }
    savePersisted();
    render();
    renderBeltEditor();
    return true;
  }

  /** 设置某组某槽弹种。 */
  function setBeltSlot(carriageId, beltIndex, slotIndex, ammoId) {
    const cfg = getCarriage(carriageId);
    const store = beltStore(carriageId);
    if (!cfg || !store) return false;
    if (beltIndex < 0 || beltIndex >= store.belts.length) return false;
    if (slotIndex < 0 || slotIndex >= cfg.slotsPerBelt) return false;
    const id = String(ammoId || '').toLowerCase();
    if (!cfg.allowedTypes.includes(id)) return false;
    store.belts[beltIndex][slotIndex] = id;
    savePersisted();
    render();
    renderBeltEditor();
    return true;
  }

  /** 点击槽位：在 allowedTypes 间循环。 */
  function cycleBeltSlot(carriageId, beltIndex, slotIndex) {
    const cfg = getCarriage(carriageId);
    const store = beltStore(carriageId);
    if (!cfg || !store) return false;
    const cur = store.belts[beltIndex]?.[slotIndex];
    if (!cur) return false;
    return setBeltSlot(carriageId, beltIndex, slotIndex, cycleSlotType(cur, cfg));
  }

  /** 渲染弹药箱底栏：弹链编辑 或 弹种介绍（按 supportsBelts）。 */
  function renderCrateBottom() {
    endBeltDrag();
    hideSlotChooser();
    if (!crateBottomHost) return;
    const carriageId = crateBottomHost.dataset.carriageId || 'guard';
    const cfg = getCarriage(carriageId);
    crateBottomHost.replaceChildren();
    if (!cfg) {
      crateBottomHost.hidden = true;
      return;
    }
    crateBottomHost.hidden = false;
    crateBottomHost.classList.toggle('is-belt-mode', Boolean(cfg.supportsBelts));
    crateBottomHost.classList.toggle('is-type-mode', !cfg.supportsBelts);
    if (cfg.supportsBelts) {
      renderBeltEditorInto(crateBottomHost, carriageId, cfg);
    } else {
      renderTypeIntroInto(crateBottomHost, carriageId, cfg);
    }
  }

  /** 兼容旧名：刷新底栏。 */
  function renderBeltEditor() {
    renderCrateBottom();
  }

  /**
   * 火炮类底栏：弹种介绍 + 单选（不可建弹链）。
   * @param {HTMLElement} host
   * @param {string} carriageId
   * @param {object} cfg
   */
  function renderTypeIntroInto(host, carriageId, cfg) {
    const header = document.createElement('div');
    header.className = 'lp-guard-belt-header';
    const title = document.createElement('span');
    title.className = 'lp-guard-belt-title';
    title.textContent = '弹种';
    const note = document.createElement('span');
    note.className = 'lp-guard-type-note';
    note.textContent = '火炮仅可选弹种';
    header.append(title, note);
    host.appendChild(header);

    const list = document.createElement('div');
    list.className = 'lp-guard-type-list';
    cfg.allowedTypes.forEach((id, i) => {
      const def = getType(id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'lp-guard-type-card';
      card.dataset.ammoId = def.id;
      const active =
        state.carriageId === carriageId
          ? state.typeIndex === i
          : i === 0;
      card.classList.toggle('is-active', active);
      card.innerHTML =
        `<span class="lp-guard-type-tag">${def.tag}</span>` +
        `<span class="lp-guard-type-name">${def.subtitle}</span>` +
        `<span class="lp-guard-type-use">${def.use || ''}</span>`;
      card.addEventListener('click', () => {
        if (state.carriageId !== carriageId) activate(carriageId);
        selectTypeIndex(i, { toast: true });
        renderCrateBottom();
      });
      bindHoverDetail(card, (e) =>
        showTypeDetail(def.id, { clientX: e.clientX, clientY: e.clientY })
      );
      list.appendChild(card);
    });
    host.appendChild(list);

    const hint = document.createElement('p');
    hint.className = 'lp-guard-belt-hint';
    hint.textContent = '本车厢不支持自定义弹链；入座后用底栏或数字键切换弹种。';
    host.appendChild(hint);
  }

  /**
   * 连发类底栏：弹链创建/编辑。
   * @param {HTMLElement} host
   * @param {string} carriageId
   * @param {object} cfg
   */
  function renderBeltEditorInto(host, carriageId, cfg) {
    endBeltDrag();
    const store = beltStore(carriageId);

    const header = document.createElement('div');
    header.className = 'lp-guard-belt-header';
    const title = document.createElement('span');
    title.className = 'lp-guard-belt-title';
    title.textContent = '弹链';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'lp-guard-belt-add';
    addBtn.textContent = '添加弹链';
    addBtn.disabled = store.belts.length >= cfg.maxBelts;
    addBtn.title =
      store.belts.length >= cfg.maxBelts
        ? `最多 ${cfg.maxBelts} 组`
        : `还可添加 ${cfg.maxBelts - store.belts.length} 组`;
    addBtn.addEventListener('click', () => {
      if (addBelt(carriageId)) {
        window.LiminalInteract?.showToast?.(
          `已添加弹链 ${store.belts.length}`
        );
      }
    });
    header.append(title, addBtn);
    host.appendChild(header);

    const list = document.createElement('div');
    list.className = 'lp-guard-belt-list';
    store.belts.forEach((slots, bi) => {
      const row = document.createElement('div');
      row.className = 'lp-guard-belt-row';
      row.classList.toggle('is-active', bi === store.activeBeltIndex);
      row.dataset.beltIndex = String(bi);

      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'lp-guard-belt-handle';
      handle.textContent = '⋮⋮';
      handle.title = '拖拽调整组顺序';
      handle.setAttribute('aria-label', '拖拽排序');
      handle.disabled = store.belts.length <= 1;
      handle.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        beginBeltDrag(event, carriageId, bi, list, true);
      });

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'lp-guard-belt-label';
      label.textContent = `组 ${bi + 1}`;
      label.setAttribute('aria-pressed', bi === store.activeBeltIndex ? 'true' : 'false');
      label.addEventListener('click', (event) => {
        if (list.classList.contains('is-belt-dragging')) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        selectBeltIndex(bi, { toast: true, carriageId });
      });
      bindHoverDetail(label, (e) =>
        showBeltDetail(bi, {
          clientX: e.clientX,
          clientY: e.clientY,
          carriageId,
        })
      );

      const slotsEl = document.createElement('div');
      slotsEl.className = 'lp-guard-belt-slots';
      const cursor = Number(store.cursors[bi]) || 0;
      const activeBelt = bi === store.activeBeltIndex;
      slots.forEach((id, si) => {
        const def = getType(id);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'lp-guard-belt-chip';
        chip.dataset.ammoId = def.id;
        chip.textContent = def.tag;
        chip.title = `悬停选择弹种 · 点击循环 · ${def.tag} ${def.subtitle}`;
        /* 激活组当前开火槽：与底栏 HUD is-next 一致，开火后可看见游标前进 */
        if (activeBelt && slots.length && si === cursor % slots.length) {
          chip.classList.add('is-next');
        }
        bindSlotTypeChooser(chip, carriageId, bi, si);
        slotsEl.appendChild(chip);
        if (si < slots.length - 1) {
          const sep = document.createElement('span');
          sep.className = 'lp-guard-belt-sep';
          sep.textContent = '/';
          sep.setAttribute('aria-hidden', 'true');
          slotsEl.appendChild(sep);
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'lp-guard-belt-remove';
      removeBtn.textContent = '删除';
      removeBtn.disabled = store.belts.length <= 1;
      removeBtn.addEventListener('click', (event) => {
        if (list.classList.contains('is-belt-dragging')) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (removeBelt(carriageId, bi)) {
          window.LiminalInteract?.showToast?.('已删除弹链');
        }
      });

      row.append(handle, label, slotsEl, removeBtn);
      list.appendChild(row);
    });
    host.appendChild(list);

    const hint = document.createElement('p');
    hint.className = 'lp-guard-belt-hint';
    hint.textContent = `拖 ⋮⋮ 调整组顺序。悬停槽位展开可选弹种（如 AP / T）。连发按组内顺序循环。最多 ${cfg.maxBelts} 组 · 每组 ${cfg.slotsPerBelt} 槽。弹链仅保存在本机，每位操作者各自独立。`;
    host.appendChild(hint);
  }

  /** 清除弹链拖放插入线。 */
  function clearBeltDropIndicator(listEl) {
    if (!listEl) return;
    listEl.querySelectorAll('.lp-guard-belt-drop-line').forEach((el) => el.remove());
  }

  /**
   * 在列表插入下标处画水平插入线（相对非拖拽中行，与 moveBeltToSlot 下标一致）。
   * @param {HTMLElement} listEl
   * @param {number} index
   */
  function showBeltDropLine(listEl, index) {
    clearBeltDropIndicator(listEl);
    const line = document.createElement('div');
    line.className = 'lp-guard-belt-drop-line';
    line.setAttribute('aria-hidden', 'true');
    const rows = [...listEl.querySelectorAll('.lp-guard-belt-row')].filter(
      (r) => !r.classList.contains('is-dragging')
    );
    if (!rows.length || index <= 0) {
      const firstRow = listEl.querySelector('.lp-guard-belt-row');
      listEl.insertBefore(line, firstRow || listEl.firstChild);
      return;
    }
    if (index >= rows.length) {
      rows[rows.length - 1].after(line);
      return;
    }
    listEl.insertBefore(line, rows[index]);
  }

  /**
   * 按指针 Y 解析弹链组落点插入下标（除去被拖行）。
   * @param {HTMLElement} listEl
   * @param {number} clientY
   * @param {number} fromIndex
   * @returns {number}
   */
  function hitTestBeltDrop(listEl, clientY, fromIndex) {
    const rows = [...listEl.querySelectorAll('.lp-guard-belt-row')].filter(
      (r) => Number(r.dataset.beltIndex) !== fromIndex
    );
    if (!rows.length) return 0;
    let index = rows.length;
    for (let i = 0; i < rows.length; i += 1) {
      const mid = rows[i].getBoundingClientRect().top + rows[i].offsetHeight / 2;
      if (clientY < mid) {
        index = i;
        break;
      }
    }
    return index;
  }

  /** 结束弹链组拖拽并卸下 document 指针监听。 */
  function endBeltDrag() {
    if (!beltDrag) return;
    if (beltDrag.longPressTimer) {
      clearTimeout(beltDrag.longPressTimer);
      beltDrag.longPressTimer = null;
    }
    document.removeEventListener('pointermove', onBeltDragMove);
    document.removeEventListener('pointerup', onBeltDragUp);
    document.removeEventListener('pointercancel', onBeltDragUp);
    clearBeltDropIndicator(beltDrag.listEl);
    beltDrag.listEl.querySelectorAll('.lp-guard-belt-row.is-dragging').forEach((el) => {
      el.classList.remove('is-dragging');
    });
    beltDrag.listEl.classList.remove('is-belt-dragging');
    beltDrag = null;
  }

  /** 进入已激活拖拽态：源行半透明、列表禁选。 */
  function activateBeltDrag() {
    if (!beltDrag || beltDrag.active) return;
    beltDrag.active = true;
    hideSlotChooser();
    beltDrag.listEl.classList.add('is-belt-dragging');
    const row = beltDrag.listEl.querySelector(
      `.lp-guard-belt-row[data-belt-index="${beltDrag.fromIndex}"]`
    );
    if (row) row.classList.add('is-dragging');
  }

  /**
   * 拖拽中更新插入线；记录 dropIndex。
   * @param {PointerEvent} event
   */
  function onBeltDragMove(event) {
    if (!beltDrag || event.pointerId !== beltDrag.pointerId) return;
    const dx = event.clientX - beltDrag.startX;
    const dy = event.clientY - beltDrag.startY;
    const moved = Math.hypot(dx, dy) >= BELT_DRAG_MOVE_PX;
    if (!beltDrag.active) {
      /* 触控未进入拖拽前移动 → 取消，把滚动留给面板 */
      if (event.pointerType === 'touch' && moved) {
        endBeltDrag();
        return;
      }
      if (beltDrag.fromHandle || moved) {
        if (beltDrag.longPressTimer) {
          clearTimeout(beltDrag.longPressTimer);
          beltDrag.longPressTimer = null;
        }
        activateBeltDrag();
      } else {
        return;
      }
    }
    event.preventDefault();
    beltDrag.dropIndex = hitTestBeltDrop(
      beltDrag.listEl,
      event.clientY,
      beltDrag.fromIndex
    );
    showBeltDropLine(beltDrag.listEl, beltDrag.dropIndex);
    const src = beltDrag.listEl.querySelector(
      `.lp-guard-belt-row[data-belt-index="${beltDrag.fromIndex}"]`
    );
    if (src) src.classList.add('is-dragging');
  }

  /**
   * 松手：若已激活则 moveBeltToSlot 并刷新；否则忽略（手柄无点击语义）。
   * @param {PointerEvent} event
   */
  function onBeltDragUp(event) {
    if (!beltDrag || event.pointerId !== beltDrag.pointerId) return;
    const session = beltDrag;
    const wasActive = session.active;
    const { carriageId, fromIndex, dropIndex } = session;
    endBeltDrag();
    if (!wasActive || dropIndex == null) return;
    if (moveBeltToSlot(carriageId, fromIndex, dropIndex)) {
      window.LiminalInteract?.showToast?.('已调整弹链顺序');
    }
  }

  /**
   * 在拖动手柄上开始潜在拖拽（触控需长按；桌面手柄立即可拖）。
   * @param {PointerEvent} event
   * @param {string} carriageId
   * @param {number} fromIndex
   * @param {HTMLElement} listEl
   * @param {boolean} fromHandle
   */
  function beginBeltDrag(event, carriageId, fromIndex, listEl, fromHandle) {
    if (event.button != null && event.button !== 0) return;
    const store = beltStore(carriageId);
    if (!store || store.belts.length <= 1) return;
    if (beltDrag) endBeltDrag();
    beltDrag = {
      carriageId,
      fromIndex,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      fromHandle,
      longPressTimer: null,
      dropIndex: null,
      listEl,
    };
    document.addEventListener('pointermove', onBeltDragMove, { passive: false });
    document.addEventListener('pointerup', onBeltDragUp);
    document.addEventListener('pointercancel', onBeltDragUp);
    const isTouch = event.pointerType === 'touch';
    if (fromHandle && !isTouch) {
      activateBeltDrag();
      event.preventDefault();
      return;
    }
    if (isTouch) {
      beltDrag.longPressTimer = setTimeout(() => {
        if (!beltDrag || beltDrag.pointerId !== event.pointerId) return;
        activateBeltDrag();
      }, BELT_DRAG_LONG_PRESS_MS);
    }
  }

  /**
   * 将弹药箱底栏挂到容器：supportsBelts → 弹链编辑，否则弹种介绍。
   * @param {HTMLElement | null} host
   * @param {string} [carriageId='guard']
   */
  function mountCrateBottom(host, carriageId = 'guard') {
    crateBottomHost = host || null;
    if (!crateBottomHost) return;
    crateBottomHost.dataset.carriageId = carriageId;
    crateBottomHost.classList.add('lp-guard-ammo-bottom');
    renderCrateBottom();
  }

  /** @deprecated 同 mountCrateBottom */
  function mountBeltEditor(host, carriageId = 'guard') {
    mountCrateBottom(host, carriageId);
  }

  /** 卸下弹药箱底栏。 */
  function unmountCrateBottom() {
    endBeltDrag();
    hideSlotChooser();
    if (crateBottomHost) {
      crateBottomHost.replaceChildren();
      crateBottomHost.hidden = true;
      crateBottomHost.classList.remove('is-belt-mode', 'is-type-mode');
    }
    crateBottomHost = null;
    hideDetail();
  }

  /** @deprecated 同 unmountCrateBottom */
  function unmountBeltEditor() {
    unmountCrateBottom();
  }

  /**
   * 注册 / 覆盖武装车厢能力（未来火炮等）。
   * @param {string} id
   * @param {object} cfg
   */
  function registerCarriage(id, cfg) {
    const key = String(id || '').trim();
    if (!key || !cfg) return;
    CARRIAGES[key] = {
      id: key,
      label: cfg.label || key,
      allowedTypes: (cfg.allowedTypes || cfg.loadout || ['ap']).slice(),
      supportsBelts: Boolean(cfg.supportsBelts),
      maxBelts: cfg.maxBelts ?? 4,
      slotsPerBelt: cfg.slotsPerBelt ?? 3,
      defaultSlots: cfg.defaultSlots || null,
      defaultBelts: Array.isArray(cfg.defaultBelts) ? cfg.defaultBelts.map((b) => b.slice()) : null,
    };
    LOADOUTS[key] = CARRIAGES[key].allowedTypes.slice();
    if (!CARRIAGES[key].defaultSlots) {
      const t0 = CARRIAGES[key].allowedTypes[0];
      CARRIAGES[key].defaultSlots = Array(CARRIAGES[key].slotsPerBelt).fill(t0);
    }
  }

  loadPersisted();
  ensureDom();
  render();

  window.addEventListener('lp:turret-enter', () => {
    activate('guard');
  });
  window.addEventListener('lp:turret-exit', () => {
    deactivate();
  });
  const obs = new MutationObserver(render);
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  window.LpArmedAmmo = {
    AMMO_TYPES,
    CARRIAGES,
    LOADOUTS,
    getType,
    getCarriage,
    supportsBelts,
    getLoadout,
    getSelected,
    getSelectedId,
    peekFireTypeId,
    advanceFireCursor,
    takeFireTypeId,
    clearAutoLoadout,
    getAutoLoadout,
    formatBeltPattern,
    getActiveBeltSlots,
    beltsToJSON,
    applyBeltsFromSnapshot,
    hasBeltData,
    isActive,
    activate,
    deactivate,
    selectIndex,
    selectBeltIndex,
    selectTypeIndex,
    selectTypeById,
    selectByNumber,
    cycle,
    addBelt,
    removeBelt,
    moveBeltToSlot,
    setBeltSlot,
    cycleBeltSlot,
    activateOrInsertBelt,
    applyAmmoSelection,
    mountBeltEditor,
    unmountBeltEditor,
    mountCrateBottom,
    unmountCrateBottom,
    renderBeltEditor,
    renderCrateBottom,
    showTypeDetail,
    showBeltDetail,
    hideDetail,
    registerCarriage,
    render,
  };
})();
