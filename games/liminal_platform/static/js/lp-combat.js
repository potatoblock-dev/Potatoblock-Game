/**
 * 阈限月台战斗层：手持武器开火、后坐散布、弹匣、地上弹壳。
 * 约定：弹药/炮弹均为飞行实体（离散弹头）；禁止激光线。
 * 武装车厢 T（曳光）可带短绿色拖尾，弹体消失后尾迹再滞空渐隐；AP 无亮绿拖尾。
 * 卫士 T 的「下一发精准」由 LpGuardTurret.accuracyBuffPending 驱动散布/准星，本文件只做准星提示同步。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const DEFAULT_COOLDOWN = 0.22;
  /** T 曳光尾迹在弹体销毁后的默认滞空时长（秒）。 */
  const TRAIL_LINGER_LIFE = 0.35;
  /** 滞空尾迹条数上限（双塔连射时丢弃最旧，避免拖垮帧率）。 */
  const MAX_LINGERING_TRAILS = 32;
  /** 飞行弹体上限（卡顿/穿透连射时丢最旧，避免 shots 无限涨）。 */
  const MAX_SHOTS = 96;
  /** 弹壳粒子上限（落地滞留 CASING_REST_LIFE 秒；超限丢最旧）。 */
  const MAX_CASINGS = 160;
  /**
   * 弹道射程兜底（世界像素）。优先 style.maxRange / item.maxRange / options.range。
   * 旧值 560 过短，炮弹约 0.3s 即消失。
   */
  const DEFAULT_MAX_RANGE = 1600;
  const CASING_REST_LIFE = 4.0;
  const GRAVITY = 920;
  /** 小口径子弹飞行速度（GUR-65 / machine_gun bullet 样式）。 */
  const PROJECTILE_SPEED_BULLET = 3000;
  /** 机炮炮弹：快于步枪弹，大弹体仍需可见航迹。 */
  const PROJECTILE_SPEED_SHELL = 3600;
  /**
   * 枪炮准星中心最小空隙（像素）。
   * 高精度武器也略微散开，禁止四臂收成实心十字。
   */
  const CROSSHAIR_MIN_GAP_PX = 7;
  /** 机炮塔准星最小空隙（像素）；大于手持，匹配炮口散布观感。 */
  const TURRET_CROSSHAIR_MIN_GAP_PX = 14;
  /** 机炮塔满 bloom 时额外张开（像素）；刻意封顶，避免准星过大。 */
  const TURRET_BLOOM_GAP_PX = 10;
  /** spreadBaseDeg → 准星基础空隙的像素换算。 */
  const SPREAD_DEG_TO_GAP_PX = 4;
  /** 后坐满时额外张开（像素）。 */
  const RECOIL_GAP_PX = 22;
  /**
   * 手持枪械换弹 SFX（与开火同路径经 LpSfx）。
   * 在 LpReloadAction 入匣关键帧播放，不在抬枪第 0 帧（见 tryReload）。
   */
  const RELOAD_SFX =
    '/static/games/liminal-platform/audio/weapons/reload-1911.wav?v=2';
  /**
   * 单发手枪开火 SFX（已裁切就绪；尚未挂到 catalog.fireSound）。
   * 未来手枪/占位武器可直接引用，勿覆盖 GUR / 换弹等现有枪口音。
   */
  const PISTOL_FIRE_SFX =
    '/static/games/liminal-platform/audio/weapons/pistol-fire.wav?v=1';
  /**
   * 速射炮近距/同车厢单发（Bilibili BV1ws411Z7s5 A10 试射；目录 staged）。
   * 卫士塔是机炮武装，不走此轨；见 AUTOCANNON_*。
   */
  const RAPID_CANNON_FIRE_SFX =
    '/static/games/liminal-platform/audio/weapons/rapid-cannon-fire.wav?v=2';
  /**
   * 速射炮跨车厢远距单发（Bilibili BV1Vc411B76j；目录 staged，卫士塔不用）。
   */
  const RAPID_CANNON_FIRE_FAR_SFX =
    '/static/games/liminal-platform/audio/weapons/rapid-cannon-fire-far.wav?v=2';
  /**
   * 机炮同车厢近距单发（B站 BV1HQW9e3Eoo 01:34–01:41 裁切 ?v=5）。
   * 卫士塔 SHOT_SFX 与此同 URL；跨车厢仅靠 LpSfx 距离衰减，无独立 far 文件。
   */
  const AUTOCANNON_FIRE_SFX =
    '/static/games/liminal-platform/audio/weapons/autocannon-fire.wav?v=5';
  /**
   * 火炮单发开火 SFX（B站 BV1HQW9e3Eoo 裁切；已就绪，尚未挂 gameplay）。
   * 火炮车厢未编入列车前勿接线；见 artillery-fire.PROCESSING.txt。
   */
  const ARTILLERY_FIRE_SFX =
    '/static/games/liminal-platform/audio/weapons/artillery-fire.wav?v=1';

  /**
   * 弹种外观与默认射程（世界像素）。
   * kind: bullet=步枪/冲锋枪弹头；shell=机炮弹体。
   * maxRange：飞行实体在命中前可走的最大距离；lifetime ≈ maxRange/speed。
   * 默认：bullet 1600（~0.53s @ 3000）；shell 9600（~2.7s @ 3600，约数节车厢）。
   * 武器 catalog 可设 item.maxRange 覆盖；spawn 也可传 options.range。
   */
  const PROJECTILE_STYLE = {
    bullet: {
      kind: 'bullet',
      speed: PROJECTILE_SPEED_BULLET,
      maxRange: 1600,
      /* ~半原尺寸；勿再腰斩（曾误缩两次） */
      bodyLen: 4.5,
      bodyH: 1.2,
      tipLen: 1.6,
      tip: '#f5d0a0',
      body: '#c4a35a',
      band: '#8a6a2a',
      flashR: 11,
      /** 枪口环境照亮半径（世界像素，additive 软晕）。 */
      flashLightR: 56,
      /** 命中车底 / 轨道时播尘土；scale 控制喷溅大小。 */
      impactDust: true,
      impactDustScale: 1,
      /** 默认对小怪伤害（地面 hp18 / 空中 hp10）。 */
      damage: 6,
    },
    shell: {
      kind: 'shell',
      speed: PROJECTILE_SPEED_SHELL,
      maxRange: 9600,
      /* 绘制长度（仅外观）；机炮弹体再拉长一点 */
      bodyLen: 30,
      bodyH: 5.5,
      tipLen: 8,
      tip: '#f8fafc',
      body: '#d97706',
      band: '#92400e',
      flashR: 26,
      flashLightR: 118,
      impactDust: true,
      impactDustScale: 1.75,
      /** 机炮塔炮弹对小怪伤害。 */
      damage: 14,
    },
  };

  /** 手持开火枪口火光寿命（秒）。 */
  const MUZZLE_FLASH_LIFE = 0.11;

  const state = {
    cooldown: 0,
    weaponId: 'rifle_stub',
    /** 后坐散布标度 0–1，驱动准星张开与弹道偏移。 */
    recoil: 0,
    shots: [],
    casings: [],
    /**
     * T 曳光滞空尾迹（与弹体解耦）。
     * 每项：{ pts, life, maxLife, color, glow, width }
     */
    lingeringTrails: [],
  };

  /** 解析弹种样式键（物品 projectileStyle，或武器类别回退）。 */
  function resolveProjectileStyleKey(options = {}) {
    if (options.style && PROJECTILE_STYLE[options.style]) return options.style;
    if (options.style === 'rifle') return 'bullet';
    if (options.style === 'turret') return 'shell';
    const weaponId = options.weaponId || state.weaponId;
    if (weaponId === 'guard_turret' || weaponId === 'cannon_stub') return 'shell';
    const item = options.item || getHeldWeaponItem();
    if (item?.projectileStyle && PROJECTILE_STYLE[item.projectileStyle]) {
      return item.projectileStyle;
    }
    return 'bullet';
  }

  /** 当前武器冷却间隔。 */
  function getCooldown(item) {
    if (item?.fireCooldown != null) return item.fireCooldown;
    if (state.weaponId === 'cannon_stub') return 0.85;
    return DEFAULT_COOLDOWN;
  }

  /** 手持武器槽：仅用 HUD 选中槽；空槽/非武器视为徒手（不回退其它手槽）。 */
  function getHeldWeaponSlot() {
    const hands = window.LpInventory?.getHandsInventory?.();
    if (!hands || !Catalog?.isWeapon) return null;
    const preferred = window.LpHandsHud?.getActiveIndex?.();
    const order =
      preferred === 0 || preferred === 1 || preferred === 2
        ? [preferred]
        : [1, 0];
    for (const index of order) {
      if (index >= hands.size()) continue;
      if (hands.isCovered?.(index)) continue;
      let stack = hands.getSlot(index);
      if (!stack || !Catalog.isWeapon(stack.itemId)) continue;
      /* 伴飞无人机不占玩家手持开火槽 */
      if (Catalog.isCompanionDrone?.(stack.itemId)) continue;
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

  /** 当前持有的武器物品定义。 */
  function getHeldWeaponItem() {
    return getHeldWeaponSlot()?.item || null;
  }

  /**
   * 当前选中手槽上应画在角色手上的物品（武器或 drawHeld 工具）；仅看 HUD 选中槽。
   * @returns {object|null}
   */
  function getHeldVisibleItem() {
    const hands = window.LpInventory?.getHandsInventory?.();
    if (!hands || !Catalog?.showsHeldSprite) return getHeldWeaponItem();
    const preferred = window.LpHandsHud?.getActiveIndex?.();
    if (preferred !== 0 && preferred !== 1 && preferred !== 2) {
      return getHeldWeaponItem();
    }
    if (preferred >= hands.size()) return null;
    if (hands.isCovered?.(preferred)) return null;
    const stack = hands.getSlot(preferred);
    if (!stack || !Catalog.showsHeldSprite(stack.itemId)) return null;
    return Catalog.getItem(stack.itemId) || null;
  }

  /** 归一化方向；零向量时按朝向回退。 */
  function normalizeDir(dirX, dirY, facing) {
    const len = Math.hypot(dirX, dirY);
    if (len < 0.001) {
      return { x: facing >= 0 ? 1 : -1, y: 0 };
    }
    return { x: dirX / len, y: dirY / len };
  }

  /** 按角度旋转二维向量。 */
  function rotateDir(dir, radians) {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return { x: dir.x * c - dir.y * s, y: dir.x * s + dir.y * c };
  }

  /**
   * 计算准星中心空隙（像素）。
   * 手持：max(全局最小, spreadBaseDeg 换算) + 后坐张开；
   * 机炮塔：基础空隙 + 入座塔连射 bloom（封顶 TURRET_BLOOM_GAP_PX）；
   * T 精准电荷待用时按 ACCURACY_BUFF_SPREAD_SCALE 收窄空隙作提示。
   */
  function getCrosshairGapPx() {
    if (document.body.classList.contains('lp-turret-mode')) {
      const bloom = window.LpGuardTurret?.getFireBloom?.('primary') ?? 0;
      let gap = TURRET_CROSSHAIR_MIN_GAP_PX + bloom * TURRET_BLOOM_GAP_PX;
      if (window.LpGuardTurret?.isAccuracyBuffPending?.()) {
        const scale =
          window.LpGuardTurret?.ACCURACY_BUFF_SPREAD_SCALE ?? 0.4;
        gap =
          TURRET_CROSSHAIR_MIN_GAP_PX * 0.72 +
          bloom * TURRET_BLOOM_GAP_PX * scale;
      }
      return gap;
    }
    const item = getHeldWeaponItem();
    const baseDeg = item?.spreadBaseDeg ?? 0.8;
    const fromSpread = baseDeg * SPREAD_DEG_TO_GAP_PX;
    const baseGap = Math.max(CROSSHAIR_MIN_GAP_PX, fromSpread);
    return baseGap + state.recoil * RECOIL_GAP_PX;
  }

  /**
   * 双联 2 号塔对角线准星空隙（像素）；非双联时返回 null。
   * T 精准电荷时与主准星同样收窄。
   */
  function getSecondaryTurretCrosshairGapPx() {
    if (!document.body.classList.contains('lp-turret-mode')) return null;
    if (!window.LpGuardTurret?.isSoloDual?.()) return null;
    const bloom = window.LpGuardTurret?.getFireBloom?.('secondary') ?? 0;
    let gap = TURRET_CROSSHAIR_MIN_GAP_PX + bloom * TURRET_BLOOM_GAP_PX;
    if (window.LpGuardTurret?.isAccuracyBuffPending?.()) {
      const scale = window.LpGuardTurret?.ACCURACY_BUFF_SPREAD_SCALE ?? 0.4;
      gap =
        TURRET_CROSSHAIR_MIN_GAP_PX * 0.72 +
        bloom * TURRET_BLOOM_GAP_PX * scale;
    }
    return gap;
  }

  /**
   * 双联时按与 tryFire 相同的 canTurretFire 给主/+ 与斜向/X 准星上门控灰态。
   * 仅视觉；不改射界几何。非双联或尚无瞄准点时清除灰态。
   */
  function syncTurretCrosshairGate(primaryEl, altEl) {
    const GT = window.LpGuardTurret;
    const dual =
      document.body.classList.contains('lp-turret-mode') &&
      Boolean(GT?.isSoloDual?.());
    if (!dual) {
      primaryEl?.classList.remove('lp-crosshair-gated');
      altEl?.classList.remove('lp-crosshair-gated');
      return;
    }
    const manned = GT.getMannedId?.();
    const aim = GT.getLastAim?.();
    if (!manned || !aim?.valid) {
      primaryEl?.classList.remove('lp-crosshair-gated');
      altEl?.classList.remove('lp-crosshair-gated');
      return;
    }
    const secondaryId = manned === 'left' ? 'right' : 'left';
    const primaryOk = Boolean(GT.canTurretFire?.(aim.x, aim.y, manned));
    const secondaryOk = Boolean(GT.canTurretFire?.(aim.x, aim.y, secondaryId));
    primaryEl?.classList.toggle('lp-crosshair-gated', !primaryOk);
    altEl?.classList.toggle('lp-crosshair-gated', !secondaryOk);
  }

  /**
   * 同步准星张开尺寸到 --lp-aim-gap（覆盖 CSS）。
   * 机炮双联时另写对角线准星（#lpCrosshairAlt）的空隙，并按门控着色。
   * T 精准电荷待用时加 lp-crosshair-accuracy-buff（浅绿提示）。
   */
  function syncCrosshairBloom() {
    const gap = getCrosshairGapPx();
    const el = document.getElementById('lpCrosshair');
    const buffOn = Boolean(
      document.body.classList.contains('lp-turret-mode') &&
        window.LpGuardTurret?.isAccuracyBuffPending?.()
    );
    if (el) {
      el.style.setProperty('--lp-aim-gap', `${gap.toFixed(1)}px`);
      el.classList.toggle('lp-crosshair-accuracy-buff', buffOn);
    }

    const alt = document.getElementById('lpCrosshairAlt');
    if (!alt) {
      syncTurretCrosshairGate(el, null);
      return;
    }
    const altGap = getSecondaryTurretCrosshairGapPx();
    if (altGap == null) {
      alt.hidden = true;
      alt.classList.remove('lp-crosshair-accuracy-buff');
      syncTurretCrosshairGate(el, alt);
      return;
    }
    alt.style.setProperty('--lp-aim-gap', `${altGap.toFixed(1)}px`);
    alt.classList.toggle('lp-crosshair-accuracy-buff', buffOn);
    /* 显隐由 liminal-platform syncAimCursor 与 pointer 一并控制；此处只保证尺寸。 */
    if (document.body.classList.contains('lp-turret-mode')) {
      alt.hidden = Boolean(el?.hidden);
    }
    syncTurretCrosshairGate(el, alt);
  }

  /**
   * 抛出地上弹壳（从抛壳口飞出）。
   * 速度 = 沿枪管 forward + 世界向上 up（−Y）+ 法向 side 散布；卫士沿枪口外抛。
   * 卫士回收箱满时也走此路径播抛壳 FX（由 LpGuardTurret 调用）。
   */
  function spawnShellCasing(originX, originY, dirX, dirY, item) {
    const speed = item?.shellEjectSpeed || { forward: 220, up: 100, side: 35 };
    const len = Math.hypot(dirX, dirY) || 1;
    const fx = dirX / len;
    const fy = dirY / len;
    const nx = -fy;
    const ny = fx;
    const forward = Number(speed.forward) || 0;
    const lift = Number(speed.up) || 0;
    /* side 缺省：旧数据把大 up 当侧抛；新数据默认小散布。 */
    const side =
      speed.side != null
        ? Number(speed.side) || 0
        : forward < 0
          ? lift
          : 28;
    const worldUp = speed.side != null || forward >= 0 ? lift : Math.min(60, Math.abs(lift) * 0.35);
    const jitter = 0.85 + Math.random() * 0.3;
    const sideSign = Math.random() < 0.5 ? -1 : 1;
    const alongJ = jitter * (0.82 + Math.random() * 0.28);
    const sideJ = jitter * (0.7 + Math.random() * 0.45);
    while (state.casings.length >= MAX_CASINGS) {
      state.casings.shift();
    }
    state.casings.push({
      x: originX,
      y: originY,
      vx: (fx * forward + nx * side * sideSign) * alongJ,
      vy: (fy * forward + ny * side * sideSign) * alongJ - worldUp * sideJ,
      rot: Math.random() * Math.PI * 2,
      omega: (Math.random() * 10 + 4) * -sideSign,
      resting: false,
      restLife: CASING_REST_LIFE,
      scale: item?.shellCasingScale ?? 1,
      /** 轨面坐标系：车外/落地后随 LpTrack 卷动平移。 */
      trackFrame: false,
    });
  }

  /**
   * 弹壳落地高度：走道上用车厢地板；否则用轨下地面（或 TRACK_Y）。
   * @param {number} x
   * @param {{ floorY?: number, floorAt?: (x: number) => number|null }} options
   * @returns {{ y: number, onTrack: boolean }|null}
   */
  function casingLandSurface(x, options) {
    const floorAt = options.floorAt;
    const deckY =
      typeof floorAt === 'function' ? floorAt(x) : options.floorY ?? null;
    if (deckY != null) {
      return { y: deckY, onTrack: false };
    }
    const groundY =
      window.LpTrack?.getGroundTopY?.() ??
      window.LiminalCarriageSpec?.TRACK_Y ??
      null;
    if (groundY == null) return null;
    return { y: groundY, onTrack: true };
  }

  /**
   * 按 weaponId / 物品 id 解析带 fireSound 的图鉴项。
   * @param {string|null|undefined} weaponId
   * @returns {object|null}
   */
  function resolveFireSoundItem(weaponId) {
    if (!weaponId) return null;
    const id = String(weaponId);
    const direct = Catalog.getItem?.(id);
    if (direct?.fireSound) return direct;
    const items = Catalog.ITEMS;
    if (!items) return null;
    return (
      Object.values(items).find(
        (item) => item && item.fireSound && (item.weaponId === id || item.id === id)
      ) || null
    );
  }

  /**
   * 在世界坐标播放武器开火 SFX（经 LpSfx：同车厢满音量，否则距离衰减）。
   * @param {string|object|null|undefined} itemOrWeaponId
   * @param {number} x
   * @param {number} y
   * @param {{ volume?: number, rateJitter?: number, playbackRate?: number }} [extra]
   */
  function playFireSfxAt(itemOrWeaponId, x, y, extra = {}) {
    const item =
      itemOrWeaponId && typeof itemOrWeaponId === 'object'
        ? itemOrWeaponId
        : resolveFireSoundItem(itemOrWeaponId);
    if (!item?.fireSound) return;
    window.LpSfx?.play?.(item.fireSound, {
      volume: extra.volume ?? item.fireSoundVolume ?? 0.65,
      rateJitter: extra.rateJitter ?? item.fireSoundRateJitter ?? 0.04,
      playbackRate: extra.playbackRate,
      x,
      y,
    });
  }

  /**
   * 在本地玩家位置播放手持枪换弹 SFX（音量对齐 GUR 开火约 0.62）。
   * 仅由 tryReload 在入匣成功时调用，避免 spam R 叠播。
   */
  function playReloadSfx() {
    const avatar = window.LpGame?.getLocalAvatar?.();
    window.LpSfx?.play?.(RELOAD_SFX, {
      volume: 0.62,
      rateJitter: 0.02,
      x: avatar?.x,
      y: avatar?.y,
    });
  }

  /**
   * 尝试开火（须手持武器；有弹匣则扣弹）。
   * options.moveSpeed：水平速度，用于移动后坐。
   * options.ejectX/Y：抛壳口；缺省则靠近枪口略偏后。
   */
  function tryFire(options = {}) {
    if (window.LpReloadAction?.isBusy?.()) return null;
    if (state.cooldown > 0) return null;
    const held = getHeldWeaponSlot();
    if (!held) return null;
    const { item, stack } = held;
    const online = window.LpInventoryNet?.isActive?.();

    if (item.magazineSize != null) {
      const mag = stack.mag ?? 0;
      if (mag <= 0) {
        window.LiminalInteract?.showToast?.('弹匣空了 · 按 R 装填');
        state.cooldown = 0.25;
        return null;
      }
      // 单机立即扣弹匣；联机由服务端权威扣减后快照回写。
      // 注意：TEST_AUTO_REFILL_CONSUMABLES 只管仓库/弹药堆，不得跳过弹匣消耗。
      if (!online) {
        const next = held.hands.updateSlot?.(held.index, { mag: mag - 1 });
        if (next) held.stack = next;
        else stack.mag = mag - 1;
        window.LpInventory?.persistAndRender?.();
      }
    }

    const weaponId = options.weaponId || Catalog.getWeaponId?.(item.id) || item.id;
    state.weaponId = weaponId;

    const facing = options.facing >= 0 ? 1 : -1;
    let dir = normalizeDir(options.dirX ?? facing, options.dirY ?? 0, facing);
    const baseDeg = item.spreadBaseDeg ?? 0.6;
    const bloomDeg = item.spreadBloomDeg ?? 6;
    const pressureScale = window.LpPressure?.getAccuracySpreadScale?.() ?? 1;
    const spreadRad =
      ((baseDeg + state.recoil * bloomDeg) * Math.PI) / 180 * pressureScale;
    dir = rotateDir(dir, (Math.random() * 2 - 1) * spreadRad);

    const moving = Math.abs(options.moveSpeed || 0) > 28;
    const kick = item.recoilKick ?? 0.18;
    const moveMul = moving ? item.moveRecoilMul ?? 1.4 : 1;
    state.recoil = Math.min(1, state.recoil + kick * moveMul);
    syncCrosshairBloom();

    const muzzleX = options.originX ?? options.x ?? 0;
    const muzzleY = options.originY ?? options.y ?? 0;
    const payload = spawnProjectile({
      ...options,
      originX: muzzleX,
      originY: muzzleY,
      dirX: dir.x,
      dirY: dir.y,
      weaponId,
      item,
      style: item.projectileStyle,
      facing,
      flash: true,
    });
    if (!payload) return null;

    const ejectX = options.ejectX ?? muzzleX - dir.x * 14;
    const ejectY = options.ejectY ?? muzzleY - dir.y * 14;
    spawnShellCasing(ejectX, ejectY, dir.x, dir.y, item);
    state.cooldown = getCooldown(item);
    playFireSfxAt(item, muzzleX, muzzleY);
    window.dispatchEvent(
      new CustomEvent('lp:weapon-fired', {
        detail: { ...payload, handIndex: held.index },
      })
    );
    return payload;
  }

  /**
   * 用背包/手中的对应弹药装填当前武器（带动画；弹药在插入关键帧入匣）。
   * 换弹 SFX 对齐入匣关键帧（top_mag ≈478ms / default ≈408ms），不在抬枪起手；
   * 无动画回退时与 commit 同步；无人机 R 不走本函数。
   */
  function tryReload() {
    if (window.LpReloadAction?.isBusy?.()) return false;
    const held = getHeldWeaponSlot();
    if (!held) {
      window.LiminalInteract?.showToast?.('没有手持武器');
      return false;
    }
    const { item, stack } = held;
    if (!item.magazineSize || !item.ammoId) {
      window.LiminalInteract?.showToast?.('该武器无需装填');
      return false;
    }
    const need = item.magazineSize - (stack.mag ?? 0);
    if (need <= 0) {
      window.LiminalInteract?.showToast?.('弹匣已满');
      return false;
    }
    const have =
      (window.LpInventory?.getPlayerInventory?.()?.countItem?.(item.ammoId) ?? 0) +
      (window.LpInventory?.getHandsInventory?.()?.countItem?.(item.ammoId) ?? 0);
    if (have <= 0) {
      const ammoName = Catalog.getItem(item.ammoId)?.name || '弹药';
      window.LiminalInteract?.showToast?.(`没有${ammoName}`);
      return false;
    }

    const started = window.LpReloadAction?.begin?.({
      item,
      onCommit: () => {
        const ok = commitReloadAmmo();
        if (ok) playReloadSfx();
        return ok;
      },
    });
    if (!started) {
      const ok = commitReloadAmmo();
      if (ok) playReloadSfx();
      return ok;
    }
    window.LiminalInteract?.showToast?.('装填中…');
    return true;
  }

  /** 实际扣除备弹并写入弹匣（换弹关键帧或无动画回退）。 */
  function commitReloadAmmo() {
    const held = getHeldWeaponSlot();
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
      window.LiminalInteract?.showToast?.('装填中…');
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
    window.LiminalInteract?.showToast?.(
      `装填 ${removed} 发（${(next || stack).mag}/${item.magazineSize}）`
    );
    return true;
  }

  /**
   * 解析弹道最大射程：显式 range > 物品 maxRange > 弹种 maxRange > 全局兜底。
   * 远端回放只带 weaponId 时，经 style 仍能与本机一致。
   */
  function resolveProjectileRange(options, style) {
    if (options.range != null && Number.isFinite(options.range)) {
      return Math.max(0, options.range);
    }
    const itemRange = options.item?.maxRange;
    if (itemRange != null && Number.isFinite(itemRange)) {
      return Math.max(0, itemRange);
    }
    if (style?.maxRange != null && Number.isFinite(style.maxRange)) {
      return Math.max(0, style.maxRange);
    }
    return DEFAULT_MAX_RANGE;
  }

  /**
   * 解析武装弹种（AP / T）；未知或缺省回退 null（用手持/默认 shell 外观）。
   * @param {object} options
   */
  function resolveAmmoType(options = {}) {
    const raw = String(options.ammoType || options.ammo || '').trim().toLowerCase();
    if (!raw) return null;
    if (raw === 'tracer') return 't';
    if (raw === 'ap' || raw === 't') return raw;
    const fromCatalog = window.LpArmedAmmo?.getType?.(raw);
    return fromCatalog?.id || null;
  }

  /**
   * 取弹种外观覆盖（体色 / 拖尾）；无弹种时 null。
   * @param {string | null} ammoType
   */
  function ammoVisual(ammoType) {
    if (!ammoType) return null;
    return window.LpArmedAmmo?.getType?.(ammoType) || null;
  }

  /**
   * 解析单发对小怪伤害：options.damage → item.damage → 弹种样式默认。
   * @param {object} options
   * @param {object} style
   */
  function resolveShotDamage(options, style) {
    if (options.damage != null && Number.isFinite(Number(options.damage))) {
      return Math.max(0, Number(options.damage));
    }
    const itemDmg = options.item?.damage;
    if (itemDmg != null && Number.isFinite(Number(itemDmg))) {
      return Math.max(0, Number(itemDmg));
    }
    const styleDmg = style?.damage;
    if (styleDmg != null && Number.isFinite(Number(styleDmg))) {
      return Math.max(0, Number(styleDmg));
    }
    return 6;
  }

  /**
   * 命中点在本帧线段上的参数 t（0=prev，1=当前位置）。
   * @returns {number}
   */
  function segmentParamAt(x0, y0, x1, y1, hx, hy) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-10) return 0;
    return ((hx - x0) * dx + (hy - y0) * dy) / len2;
  }

  /**
   * 本帧弹道尝试命中小怪（LpMobs）；成功则扣血并可选销毁弹体。
   * @returns {boolean} 是否应移除弹实体
   */
  function applyHostileImpact(shot) {
    const probe = window.LpMobs?.probeSegmentHit;
    const damageFn = window.LpMobs?.damageMob;
    if (!probe || !damageFn) return false;
    const hit = probe(shot.prevX, shot.prevY, shot.x, shot.y);
    if (!hit) return false;
    if (!shot.hitIds) shot.hitIds = new Set();
    if (shot.hitIds.has(hit.id)) return false;

    const occluder = firstOccluderHit(shot.prevX, shot.prevY, shot.x, shot.y);
    if (occluder) {
      const st =
        Number.isFinite(occluder.t)
          ? occluder.t
          : segmentParamAt(
              shot.prevX,
              shot.prevY,
              shot.x,
              shot.y,
              occluder.x,
              occluder.y
            );
      if (st + 1e-6 < hit.t) return false;
    }

    shot.hitIds.add(hit.id);
    damageFn(hit.id, shot.damage);
    window.LpImpactFx?.spawnDust?.(hit.x, hit.y, {
      surface: 'hostile',
      dirX: shot.dirX,
      dirY: shot.dirY,
      scale: 0.55,
    });
    return !shot.penetrates;
  }

  /** 生成飞行弹实体（本地或远端回放；不占用冷却、不检查持枪）。
   * 卫士机炮弹在停靠/月台场景下丢弃，避免列车弹道渗入月台。
   */
  function spawnProjectile(options = {}) {
    const facing = options.facing >= 0 ? 1 : -1;
    const originX = options.originX ?? options.x ?? 0;
    const originY = options.originY ?? options.y ?? 0;
    const dir = normalizeDir(options.dirX ?? facing, options.dirY ?? 0, facing);
    const weaponId = options.weaponId || state.weaponId;
    if (
      weaponId === 'guard_turret' &&
      window.LpGuardTurret?.isTrainWeaponSuppressed?.()
    ) {
      return null;
    }
    const styleKey = resolveProjectileStyleKey({ ...options, weaponId });
    const style = PROJECTILE_STYLE[styleKey] || PROJECTILE_STYLE.bullet;
    const range = resolveProjectileRange(options, style);
    const speed = options.speed ?? style.speed;
    const ammoType = resolveAmmoType(options);
    const visual = ammoVisual(ammoType);
    const trailCfg = visual?.trail || null;
    const shot = {
      x: originX,
      y: originY,
      prevX: originX,
      prevY: originY,
      vx: dir.x * speed,
      vy: dir.y * speed,
      dirX: dir.x,
      dirY: dir.y,
      distLeft: range,
      age: 0,
      maxAge: range / speed + 0.2,
      weaponId,
      style: styleKey,
      ammoType,
      damage: resolveShotDamage(options, style),
      penetrates: Boolean(visual?.penetrates),
      /** 拖尾采样点（世界坐标，队首为最新）。 */
      trail: trailCfg ? [{ x: originX, y: originY }] : null,
      trailMax: trailCfg?.length ?? 0,
      muzzleFlash: Boolean(options.flash),
      muzzleFlashLife: options.flash ? MUZZLE_FLASH_LIFE : 0,
      muzzleFlashMax: options.flash ? MUZZLE_FLASH_LIFE : 0,
      muzzleJitter: Math.random() * Math.PI,
      originX,
      originY,
    };
    while (state.shots.length >= MAX_SHOTS) {
      removeShotAt(0);
    }
    state.shots.push(shot);
    return {
      originX,
      originY,
      dirX: dir.x,
      dirY: dir.y,
      weaponId,
      range,
      style: styleKey,
      ammoType,
      facing,
    };
  }

  /** @deprecated 用 spawnProjectile；保留别名兼容会话/炮塔。 */
  function spawnTracer(options) {
    return spawnProjectile(options);
  }

  /**
   * 月台地牢墙对弹道线段的最近碰撞；非小型地牢返回 null。
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   */
  function dungeonWallHit(x0, y0, x1, y1) {
    if (window.LpPlatform?.getScene?.() !== 'platform') return null;
    if (window.LpPlatform?.getPlatformKind?.() !== 'small') return null;
    const dungeon = window.LpPlatform?.getDungeon?.();
    return window.LpDungeon?.hitProjectileWall?.(dungeon, x0, y0, x1, y1) || null;
  }

  /**
   * 车底/轨面与地牢墙中更近的遮挡点。
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   */
  function firstOccluderHit(x0, y0, x1, y1) {
    const surface = window.LiminalCarriageSpec?.hitProjectileSurfaces?.(x0, y0, x1, y1) || null;
    const wall = dungeonWallHit(x0, y0, x1, y1);
    if (!surface) return wall;
    if (!wall) return surface;
    const st = segmentParamAt(x0, y0, x1, y1, surface.x, surface.y);
    const wt = Number.isFinite(wall.t)
      ? wall.t
      : segmentParamAt(x0, y0, x1, y1, wall.x, wall.y);
    return wt < st ? wall : surface;
  }

  /** 弹体命中车底 / 轨道 / 地牢墙时生成尘土并销毁弹实体。 */
  function applySurfaceImpact(shot) {
    const hit = firstOccluderHit(shot.prevX, shot.prevY, shot.x, shot.y);
    if (!hit) return false;
    const style = PROJECTILE_STYLE[shot.style] || PROJECTILE_STYLE.bullet;
    if (style.impactDust) {
      window.LpImpactFx?.spawnDust?.(hit.x, hit.y, {
        surface: hit.surface || 'wall',
        dirX: shot.dirX,
        dirY: shot.dirY,
        scale: style.impactDustScale ?? 1,
      });
    }
    return true;
  }

  /**
   * 弹体销毁时把 T 曳光采样点移交滞空池，短时渐隐；超上限丢最旧条。
   * @param {object} shot
   */
  function releaseLingeringTrail(shot) {
    const pts = shot.trail;
    if (!pts || pts.length < 2) return;
    const visual = ammoVisual(shot.ammoType);
    const trailCfg = visual?.trail;
    if (!trailCfg) return;
    const life = Number(trailCfg.linger) > 0 ? Number(trailCfg.linger) : TRAIL_LINGER_LIFE;
    while (state.lingeringTrails.length >= MAX_LINGERING_TRAILS) {
      state.lingeringTrails.shift();
    }
    state.lingeringTrails.push({
      pts,
      life,
      maxLife: life,
      color: trailCfg.color,
      glow: trailCfg.glow,
      width: trailCfg.width ?? 3,
    });
    shot.trail = null;
  }

  /** 销毁弹实体并把曳光尾迹移交滞空池（若有）。 */
  function removeShotAt(index) {
    const shot = state.shots[index];
    if (!shot) return;
    releaseLingeringTrail(shot);
    state.shots.splice(index, 1);
  }

  /**
   * 清空飞行弹 / 弹壳 / 滞空尾迹（月台进出等场景切换时调用，避免跨场景残留涨内存）。
   */
  function clearWorldFx() {
    state.shots.length = 0;
    state.casings.length = 0;
    state.lingeringTrails.length = 0;
  }

  /** 推进冷却、后坐衰减、弹实体飞行、滞空尾迹与弹壳物理。 */
  function tick(dt, options = {}) {
    if (state.cooldown > 0) state.cooldown = Math.max(0, state.cooldown - dt);

    const held = getHeldWeaponItem();
    const decay = held?.recoilDecay ?? 2.0;
    const moving = Math.abs(options.moveSpeed || 0) > 28;
    const decayMul = moving ? 0.55 : 1;
    if (state.recoil > 0) {
      state.recoil = Math.max(0, state.recoil - decay * decayMul * dt);
      syncCrosshairBloom();
    }

    for (let i = state.shots.length - 1; i >= 0; i -= 1) {
      const shot = state.shots[i];
      shot.prevX = shot.x;
      shot.prevY = shot.y;
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      const step = Math.hypot(shot.vx, shot.vy) * dt;
      shot.distLeft -= step;
      shot.age += dt;
      if (shot.trail && shot.trailMax > 0) {
        shot.trail.unshift({ x: shot.x, y: shot.y });
        if (shot.trail.length > shot.trailMax) shot.trail.length = shot.trailMax;
      }
      if (shot.muzzleFlashLife > 0) {
        shot.muzzleFlashLife = Math.max(0, shot.muzzleFlashLife - dt);
      }
      if (applyHostileImpact(shot)) {
        removeShotAt(i);
        continue;
      }
      if (applySurfaceImpact(shot)) {
        removeShotAt(i);
        continue;
      }
      if (shot.distLeft <= 0 || shot.age >= shot.maxAge) {
        removeShotAt(i);
      }
    }

    for (let i = state.lingeringTrails.length - 1; i >= 0; i -= 1) {
      const ribbon = state.lingeringTrails[i];
      ribbon.life -= dt;
      if (ribbon.life <= 0) state.lingeringTrails.splice(i, 1);
    }

    for (let i = state.casings.length - 1; i >= 0; i -= 1) {
      const c = state.casings[i];
      /* 车外/轨面弹壳：与轨枕同相平移（车厢固定、轨卷动）。 */
      if (c.trackFrame) {
        window.LpTrack?.applyTrackScroll?.(c);
      }
      if (c.resting) {
        c.restLife -= dt;
        if (c.restLife <= 0) state.casings.splice(i, 1);
        continue;
      }
      c.vy += GRAVITY * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.omega * dt;
      c.vx *= Math.exp(-1.2 * dt);
      const land = casingLandSurface(c.x, options);
      if (land) {
        c.trackFrame = land.onTrack;
      }
      if (land && c.y >= land.y - 2) {
        c.y = land.y - 2;
        c.trackFrame = land.onTrack;
        if (Math.abs(c.vy) < 60 && Math.abs(c.vx) < 40) {
          c.vx = 0;
          c.vy = 0;
          c.omega *= 0.2;
          c.resting = true;
        } else {
          c.vy *= -0.28;
          c.vx *= 0.55;
          c.omega *= -0.4;
        }
      }
    }
  }

  /**
   * 绘制枪口火光：additive 环境照亮 + Kenney 调色精灵（未就绪时回退程序化焰舌）。
   * opts.t 为剩余寿命比例 1→0；lightR 照亮周围半径；flashR 星爆尺度。
   */
  function drawMuzzleFlash(ctx, opts) {
    const t = Math.max(0, Math.min(1, Number(opts.t) || 0));
    if (t <= 0.001) return;
    const age = 1 - t;
    const scale = opts.scale ?? 1;
    const lightR = (opts.lightR ?? 72) * scale;
    const flashR = (opts.flashR ?? 16) * scale;
    const punch = Math.max(0, 1 - age / 0.3);
    const ambient = Math.pow(t, 0.5) * (0.55 + 0.45 * Math.min(1, punch + 0.35));
    const tongue = Math.pow(t, 0.8);
    const coreFade = punch * 0.55 + t * t * 0.45;
    const jitter = opts.jitter || 0;
    const useSprites = window.LpMuzzleFlash?.isReady?.();

    ctx.save();
    ctx.translate(opts.x, opts.y);
    ctx.globalCompositeOperation = 'lighter';

    /* 大半径暖光软晕：短暂照亮甲板 / 炮管（与精灵叠加） */
    const glowR = lightR * (0.9 + 0.22 * (1 - punch));
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
    glow.addColorStop(0, `rgba(255, 236, 190, ${0.52 * ambient})`);
    glow.addColorStop(0.2, `rgba(255, 175, 70, ${0.34 * ambient})`);
    glow.addColorStop(0.48, `rgba(210, 90, 25, ${0.15 * ambient})`);
    glow.addColorStop(1, 'rgba(40, 10, 0, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, glowR, 0, Math.PI * 2);
    ctx.fill();

    if (useSprites) {
      window.LpMuzzleFlash.drawSprites(ctx, {
        angle: opts.angle || 0,
        t,
        flashR,
        jitter,
        scale: 1,
      });
      ctx.restore();
      return;
    }

    /* 精灵未加载：程序化橙晕星爆 + 焰舌（与旧版一致） */
    ctx.rotate(opts.angle || 0);
    const r = flashR * (0.72 + 0.42 * punch + 0.22 * t);

    const bloom = ctx.createRadialGradient(r * 0.15, 0, 0, r * 0.15, 0, r * 1.45);
    bloom.addColorStop(0, `rgba(255, 252, 235, ${0.95 * coreFade})`);
    bloom.addColorStop(0.28, `rgba(255, 190, 70, ${0.82 * tongue})`);
    bloom.addColorStop(0.58, `rgba(251, 110, 28, ${0.48 * tongue})`);
    bloom.addColorStop(1, 'rgba(160, 30, 0, 0)');
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.ellipse(r * 0.28, 0, r * 1.5, r * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(jitter * 0.1);
    ctx.fillStyle = `rgba(255, 245, 200, ${0.92 * tongue})`;
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.lineTo(r * 1.65, -r * 0.24);
    ctx.lineTo(r * 1.2, 0);
    ctx.lineTo(r * 1.65, r * 0.24);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = `rgba(255, 175, 55, ${0.78 * tongue})`;
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.lineTo(r * 0.58, -r * 1.05);
    ctx.lineTo(r * 0.38, 0);
    ctx.lineTo(r * 0.58, r * 1.05);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = `rgba(255, 255, 248, ${0.98 * coreFade})`;
    ctx.beginPath();
    ctx.ellipse(3, 0, 5.5 + 7 * punch + 2.5 * t, 3.8 + 3.2 * punch, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * 绘制 T（曳光）绿色短拖尾：沿采样点渐隐，非激光长线。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number}[]} pts
   * @param {{color?:string,glow?:string,width?:number}} trailCfg
   * @param {number} [alphaMul=1] 整体透明度（滞空渐隐用）
   */
  function drawAmmoTrail(ctx, pts, trailCfg, alphaMul = 1) {
    if (!pts || pts.length < 2 || !trailCfg || alphaMul <= 0.001) return;
    const width = trailCfg.width ?? 3;
    const mul = Math.max(0, Math.min(1, alphaMul));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const fade = 1 - i / Math.max(1, pts.length - 1);
      ctx.strokeStyle = trailCfg.glow || trailCfg.color;
      ctx.globalAlpha = 0.35 * fade * mul;
      ctx.lineWidth = width * 2.4 * fade;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = trailCfg.color;
      ctx.globalAlpha = 0.85 * fade * mul;
      ctx.lineWidth = width * fade;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 绘制离散弹头实体（非激光线）。
   * 武装弹种可覆写体色、尺寸倍率、弹尖高光比例，并可带拖尾；不靠 alpha「藏」弹。
   */
  function drawProjectile(ctx, shot) {
    const style = PROJECTILE_STYLE[shot.style] || PROJECTILE_STYLE.bullet;
    const visual = ammoVisual(shot.ammoType);
    const ang = Math.atan2(shot.dirY, shot.dirX);
    const bodyScale = Number(visual?.bodyScale) > 0 ? Number(visual.bodyScale) : 1;
    const bodyHScale =
      Number(visual?.bodyHScale) > 0 ? Number(visual.bodyHScale) : bodyScale;
    const len = style.bodyLen * bodyScale;
    const h = style.bodyH * bodyHScale;
    const tip = style.tipLen * bodyScale;
    const tipHalf =
      h *
      (Number(visual?.tipHighlight) > 0 ? Number(visual.tipHighlight) : 0.28);
    const bodyColor = visual?.body || style.body;
    const bandColor = visual?.band || style.band;
    const tipColor = visual?.tip || style.tip;
    const flashScale =
      Number(visual?.flashScale) > 0 ? Number(visual.flashScale) : 1;

    if (visual?.trail && shot.trail) drawAmmoTrail(ctx, shot.trail, visual.trail);

    ctx.save();
    ctx.translate(shot.x, shot.y);
    ctx.rotate(ang);

    /* 弹体：尾在 -X，尖朝 +X；fill 用全不透明色 */
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.moveTo(-len * 0.45, -h * 0.5);
    ctx.lineTo(len * 0.2, -h * 0.5);
    ctx.lineTo(len * 0.2 + tip, 0);
    ctx.lineTo(len * 0.2, h * 0.5);
    ctx.lineTo(-len * 0.45, h * 0.5);
    ctx.closePath();
    ctx.fill();

    /* 弹底 / 弹带 */
    ctx.fillStyle = bandColor;
    ctx.fillRect(-len * 0.45, -h * 0.5, len * 0.18, h);

    /* 弹尖高光（窄带、低对比色；仍不透明） */
    ctx.fillStyle = tipColor;
    ctx.beginPath();
    ctx.moveTo(len * 0.12, -tipHalf);
    ctx.lineTo(len * 0.2 + tip, 0);
    ctx.lineTo(len * 0.12, tipHalf);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    if (shot.muzzleFlash && shot.muzzleFlashLife > 0) {
      const maxLife = shot.muzzleFlashMax || MUZZLE_FLASH_LIFE;
      drawMuzzleFlash(ctx, {
        x: shot.originX,
        y: shot.originY,
        angle: ang,
        t: shot.muzzleFlashLife / maxLife,
        lightR: (style.flashLightR ?? 56) * flashScale,
        flashR: style.flashR * flashScale,
        jitter: shot.muzzleJitter || 0,
      });
    }
  }

  /** 在世界坐标层绘制滞空曳光、弹实体与地上弹壳。 */
  function draw(ctx) {
    for (const ribbon of state.lingeringTrails) {
      const t = ribbon.maxLife > 0 ? ribbon.life / ribbon.maxLife : 0;
      /* 前半段保持较亮，后半段加速淡出。 */
      const alphaMul = Math.pow(Math.max(0, t), 0.65);
      drawAmmoTrail(ctx, ribbon.pts, ribbon, alphaMul);
    }

    for (const shot of state.shots) {
      drawProjectile(ctx, shot);
    }

    for (const c of state.casings) {
      const fade = c.resting ? Math.max(0.25, c.restLife / CASING_REST_LIFE) : 1;
      const s = c.scale ?? 1;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.scale(s, s);
      ctx.globalAlpha = fade;
      ctx.fillStyle = '#c4a35a';
      ctx.fillRect(-4.5, -1.6, 9, 3.2);
      ctx.fillStyle = '#8a6a2a';
      ctx.fillRect(2.2, -1.6, 2.4, 3.2);
      ctx.restore();
    }
  }

  /** 切换占位武器（后续接真实武器表）。 */
  function setWeapon(weaponId) {
    state.weaponId = weaponId || 'rifle_stub';
  }

  /** 是否可开火。 */
  function canFire() {
    return (
      Boolean(getHeldWeaponItem()) &&
      state.cooldown <= 0 &&
      !window.LpReloadAction?.isBusy?.()
    );
  }

  /** 当前手持武器是否全自动（长按连发）；无持枪为 false。 */
  function isHeldWeaponFullAuto() {
    return Boolean(Catalog?.isFullAuto?.(getHeldWeaponItem()));
  }

  /** 当前弹匣文案。 */
  function getMagReadout() {
    const held = getHeldWeaponSlot();
    if (!held?.item?.magazineSize) return null;
    return {
      mag: held.stack.mag ?? 0,
      size: held.item.magazineSize,
      name: held.item.name,
    };
  }

  syncCrosshairBloom();

  /** 敌方列表（转交 LpMobs，供传感器优先读战斗层）。 */
  function listHostiles() {
    return window.LpMobs?.listHostiles?.() || [];
  }

  /**
   * 车厢级锁定（单塔车 / 传感聚合）：仅存敌方 id；读时从 listHostiles 刷新。
   * @type {Record<string, { id: string }>}
   */
  const lockedByCar = Object.create(null);
  /**
   * 多炮塔分塔锁定：carId → turretId → { id }。
   * 卫兵左右塔各锁一敌；传感无 turretId 时聚合读任一活锁。
   * @type {Record<string, Record<string, { id: string }>>}
   */
  const lockedByTurret = Object.create(null);

  /** 规范化炮位 id；缺省返回 null（表示车厢级）。 */
  function normalizeLockTurretId(turretId) {
    if (turretId == null || turretId === '') return null;
    return turretId === 'right' ? 'right' : 'left';
  }

  /**
   * 列出某车已占用的分塔锁定敌 id（供选敌去重）。
   * @param {string} carId
   * @returns {string[]}
   */
  function listLockedHostileIds(carId) {
    if (!carId) return [];
    const map = lockedByTurret[carId];
    if (map) {
      const out = [];
      for (const entry of Object.values(map)) {
        if (entry?.id) out.push(String(entry.id));
      }
      return out;
    }
    const car = lockedByCar[carId];
    return car?.id ? [String(car.id)] : [];
  }

  /**
   * 分塔锁变更后同步车厢级聚合 id（传感 / 旧 API 可读到「有锁」）。
   * @param {string} carId
   */
  function syncCarLockFromTurrets(carId) {
    const map = lockedByTurret[carId];
    if (!map) return;
    const order = ['left', 'right', ...Object.keys(map)];
    for (const tid of order) {
      const entry = map[tid];
      if (entry?.id) {
        lockedByCar[carId] = { id: String(entry.id) };
        return;
      }
    }
    delete lockedByCar[carId];
    if (!Object.keys(map).length) delete lockedByTurret[carId];
  }

  const LOCK_TARGET_MODES = new Set([
    'nearest',
    'farthest',
    'highest_hp',
    'lowest_hp',
    'highest_armor',
    'lowest_armor',
  ]);

  /** 武装车厢用于锁定/射程计数的原点（走道中心）。 */
  function carLockOrigin(carId) {
    const Spec = window.LiminalCarriageSpec;
    const car = Spec?.carriageById?.(carId);
    if (!car || !Spec) return null;
    const mid = (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2;
    return { x: car.worldX + mid, y: Spec.FLOOR_Y };
  }

  /** 卫兵炮弹 / 绘轨锁定量程（世界像素）。 */
  function lockRangeForCar(carId) {
    if (carId === 'huigui') {
      const n = window.LpRadarScope?.getLockRangeMax?.();
      return typeof n === 'number' && Number.isFinite(n) ? n : 6000;
    }
    const shell = PROJECTILE_STYLE.shell;
    if (shell?.maxRange != null && Number.isFinite(shell.maxRange)) {
      return Math.max(0, shell.maxRange);
    }
    return 9600;
  }

  /** 炮弹速度（提前量用）；缺省 PROJECTILE_SPEED_SHELL。 */
  function shellSpeed() {
    const s = PROJECTILE_STYLE.shell?.speed;
    return typeof s === 'number' && s > 0 ? s : PROJECTILE_SPEED_SHELL;
  }

  /**
   * 射程内敌方（附 _d2）；无原点或射程时为空。
   * @param {string} carId
   */
  function hostilesInRange(carId) {
    const origin = carLockOrigin(carId);
    const range = lockRangeForCar(carId);
    if (!origin || range <= 0) return [];
    const r2 = range * range;
    const out = [];
    for (const h of listHostiles()) {
      if (h?.x == null || !Number.isFinite(Number(h.x))) continue;
      const y =
        h.y != null && Number.isFinite(Number(h.y)) ? Number(h.y) : origin.y;
      const dx = Number(h.x) - origin.x;
      const dy = y - origin.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      out.push({ ...h, y, _d2: d2 });
    }
    return out;
  }

  /** 射程内敌方数量（传感器可优先走此 API）。 */
  function countHostilesInRange(carId) {
    return hostilesInRange(carId).length;
  }

  /**
   * 世界点是否落在某节车厢走道舱内（几何兜底：无 phase/inCabin 时用）。
   * 走道 [WALK_LEFT,WALK_RIGHT] × 顶棚～地板略上；轨面车底不算舱内。
   * @param {number} x
   * @param {number} y
   */
  function isPointInsideCabin(x, y) {
    const Spec = window.LiminalCarriageSpec;
    if (!Spec?.CARRIAGES?.length) return false;
    const ceilY = Spec.FLOOR_Y - Spec.CABIN_CEIL_INSET;
    const floorSlack = Spec.scaleArt(36);
    for (const car of Spec.CARRIAGES) {
      const left = car.worldX + Spec.WALK_LEFT;
      const right = car.worldX + Spec.WALK_RIGHT;
      if (x < left || x > right) continue;
      if (y >= ceilY && y <= Spec.FLOOR_Y + floorSlack) return true;
    }
    return false;
  }

  /**
   * 敌方是否在车厢内：优先 listHostiles.inCabin / phase，否则走道几何。
   * @param {{ x?: number, y?: number, inCabin?: boolean, phase?: string }} h
   */
  function isHostileInsideCabin(h) {
    if (!h) return false;
    if (typeof h.inCabin === 'boolean') return h.inCabin;
    const p = String(h.phase || '');
    if (p === 'inside' || p === 'jump' || p === 'climb' || p === 'enter') return true;
    if (h.x == null || !Number.isFinite(Number(h.x))) return false;
    const y =
      h.y != null && Number.isFinite(Number(h.y)) ? Number(h.y) : NaN;
    if (!Number.isFinite(y)) return false;
    return isPointInsideCabin(Number(h.x), y);
  }

  /**
   * 自起点到目标的弹道是否在命中前撞车底/轨面/地牢墙（与 applyHostileImpact 同序）。
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   */
  function projectileClearsToPoint(x0, y0, x1, y1) {
    const occluder = firstOccluderHit(x0, y0, x1, y1);
    if (!occluder) return true;
    const st = Number.isFinite(occluder.t)
      ? occluder.t
      : segmentParamAt(x0, y0, x1, y1, occluder.x, occluder.y);
    return st + 1e-6 >= 1;
  }

  /**
   * 锁定交战检查用的枢轴：指定 turretId 时仅该塔；否则优先空闲自动塔，全无空闲则全部枢轴。
   * @param {string|null|undefined} [turretId]
   * @returns {Array<{ id: string, x: number, y: number }>}
   */
  function pivotsForEngageCheck(turretId) {
    const gt = window.LpGuardTurret;
    const pivots = gt?.getPivotsWorld?.() || [];
    if (!pivots.length) return [];
    const tid = normalizeLockTurretId(turretId);
    if (tid) return pivots.filter((p) => p.id === tid);
    const free = gt.getAutoEngageTurretIds?.() || [];
    if (free.length) {
      return pivots.filter((p) => free.includes(p.id));
    }
    return pivots;
  }

  /**
   * 卫兵炮塔是否能打到该点：与 canTurretEngageAim / 开火同一套门（楔+最小距+钳制命中），
   * 且弹道不被车底挡住。不要求炮管已到位；供锁定筛选。
   * @param {number} aimX
   * @param {number} aimY
   * @param {Array<{ id: string, x: number, y: number }>|null|undefined} [pivots]
   */
  function canTurretsEngagePoint(aimX, aimY, pivots) {
    const gt = window.LpGuardTurret;
    const engageAim = gt?.canTurretEngageAim || gt?.isAimInFireArc;
    if (!engageAim) return false;
    const list = Array.isArray(pivots) && pivots.length ? pivots : pivotsForEngageCheck();
    for (const pivot of list) {
      if (!engageAim.call(gt, aimX, aimY, pivot.id)) continue;
      const mx = Number(pivot.x);
      const my = Number(pivot.y);
      if (!Number.isFinite(mx) || !Number.isFinite(my)) continue;
      if (projectileClearsToPoint(mx, my, aimX, aimY)) return true;
    }
    return false;
  }

  /**
   * 卫兵炮是否能现实交战该敌：提前点在最大射程内，且 canTurretEngageAim（含过近拒绝、
   * 钳制弹道命中）与车底清通。与自动开火同一套几何门；不要求炮管已到位。
   * @param {{ x?: number, y?: number, vx?: number, vy?: number }} hostile
   * @param {string|null|undefined} [turretId] 指定则只验该塔枢轴
   */
  function canEngageHostile(hostile, turretId) {
    if (!hostile || hostile.x == null || !Number.isFinite(Number(hostile.x))) {
      return false;
    }
    const pivots = pivotsForEngageCheck(turretId);
    if (!pivots.length) return false;
    const maxRange = lockRangeForCar('guard');
    const r2 = maxRange * maxRange;
    const ty =
      hostile.y != null && Number.isFinite(Number(hostile.y))
        ? Number(hostile.y)
        : pivots[0].y;
    const target = { ...hostile, x: Number(hostile.x), y: ty };
    for (const pivot of pivots) {
      const mx = Number(pivot.x);
      const my = Number(pivot.y);
      if (!Number.isFinite(mx) || !Number.isFinite(my)) continue;
      const lead = predictLeadAim(mx, my, target);
      const ax = Number(lead?.x);
      const ay = Number(lead?.y);
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
      const dx = ax - mx;
      const dy = ay - my;
      if (dx * dx + dy * dy > r2) continue;
      if (canTurretsEngagePoint(ax, ay, [pivot])) return true;
    }
    return false;
  }

  /**
   * 锁定候选过滤。
   * 卫兵车：必须 canEngageHostile（最小距/钳制命中/楔/弹道/提前点射程）；其它车：舱外可锁，舱内仅炮可打到时保留。
   * @param {Array<object>} list
   * @param {string} carId
   * @param {{ turretId?: string|null }} [opts]
   */
  function filterLockCandidates(list, carId, opts) {
    const turretId = opts?.turretId;
    if (carId === 'guard') {
      return list.filter((h) => canEngageHostile(h, turretId));
    }
    return list.filter((h) => {
      if (!isHostileInsideCabin(h)) return true;
      return canTurretsEngagePoint(Number(h.x), Number(h.y));
    });
  }

  /**
   * 在候选列表中按模式选最优一条（nearest / farthest / hp / armor）。
   * @param {Array<object>} list
   * @param {string} mode
   */
  function pickBestFromLockList(list, mode) {
    if (!list.length) return null;
    const m = LOCK_TARGET_MODES.has(String(mode)) ? String(mode) : 'nearest';
    let best = list[0];
    for (let i = 1; i < list.length; i += 1) {
      const h = list[i];
      const armor = Number(h.armor) || 0;
      const bestArmor = Number(best.armor) || 0;
      const hp = Number(h.hp);
      const bestHp = Number(best.hp);
      switch (m) {
        case 'farthest':
          if (h._d2 > best._d2) best = h;
          break;
        case 'highest_hp':
          if (
            (Number.isFinite(hp) ? hp : -Infinity) >
            (Number.isFinite(bestHp) ? bestHp : -Infinity)
          ) {
            best = h;
          }
          break;
        case 'lowest_hp':
          if (
            (Number.isFinite(hp) ? hp : Infinity) <
            (Number.isFinite(bestHp) ? bestHp : Infinity)
          ) {
            best = h;
          }
          break;
        case 'highest_armor':
          if (armor > bestArmor) best = h;
          break;
        case 'lowest_armor':
          if (armor < bestArmor) best = h;
          break;
        default:
          if (h._d2 < best._d2) best = h;
          break;
      }
    }
    const { _d2, ...rest } = best;
    return rest;
  }

  /**
   * 按模式从射程内挑选锁定目标（nearest / farthest / hp / armor）。
   * 卫兵：仅保留该塔（或空闲塔）几何上能打到的敌；其它车舱内默认跳过除非炮可打到。
   * opts.excludeIds：尽量避开已锁敌（有其它可交战目标时）；仅一目标时仍可返回该敌。
   * @param {string} carId
   * @param {string} mode
   * @param {{ turretId?: string|null, excludeIds?: Array<string|number> }} [opts]
   */
  function pickLockTarget(carId, mode, opts) {
    const turretId = opts?.turretId ?? null;
    let list = filterLockCandidates(hostilesInRange(carId), carId, { turretId });
    if (!list.length) return null;
    const excludeRaw = opts?.excludeIds;
    if (Array.isArray(excludeRaw) && excludeRaw.length) {
      const ex = new Set(excludeRaw.map((x) => String(x)));
      const unique = list.filter((h) => h?.id == null || !ex.has(String(h.id)));
      if (unique.length) list = unique;
    }
    return pickBestFromLockList(list, mode);
  }

  /**
   * 写入锁定（按敌方 id）。传 turretId 时写入分塔锁；否则写车厢级并清空该车分塔表。
   * 无 id 则清除对应作用域。
   * @param {string} carId
   * @param {{ id?: string|number }|null|undefined} hostile
   * @param {string|null|undefined} [turretId]
   */
  function setLockedHostile(carId, hostile, turretId) {
    if (!carId) return;
    const tid = normalizeLockTurretId(turretId);
    const id = hostile?.id != null ? String(hostile.id) : '';
    if (tid) {
      if (!id) {
        if (lockedByTurret[carId]) {
          delete lockedByTurret[carId][tid];
          if (!Object.keys(lockedByTurret[carId]).length) {
            delete lockedByTurret[carId];
          }
        }
        syncCarLockFromTurrets(carId);
        return;
      }
      if (!lockedByTurret[carId]) {
        lockedByTurret[carId] = Object.create(null);
      }
      lockedByTurret[carId][tid] = { id };
      syncCarLockFromTurrets(carId);
      return;
    }
    delete lockedByTurret[carId];
    if (!id) {
      delete lockedByCar[carId];
      return;
    }
    lockedByCar[carId] = { id };
  }

  /**
   * 清除锁定。传 turretId 只清该塔；否则清整车（含全部分塔）。
   * @param {string} carId
   * @param {string|null|undefined} [turretId]
   */
  function clearLockedHostile(carId, turretId) {
    if (!carId) return;
    const tid = normalizeLockTurretId(turretId);
    if (tid) {
      setLockedHostile(carId, null, tid);
      return;
    }
    delete lockedByCar[carId];
    delete lockedByTurret[carId];
  }

  /**
   * 将条目解析为活体敌；失效或卫兵不可交战则清对应锁并返回 null。
   * @param {string} carId
   * @param {{ id: string }|null|undefined} entry
   * @param {string|null} turretId
   */
  function resolveLiveLockedHostile(carId, entry, turretId) {
    if (!entry?.id) return null;
    const live = listHostiles().find((h) => String(h?.id) === entry.id);
    if (!live) {
      if (turretId) clearLockedHostile(carId, turretId);
      else if (!lockedByTurret[carId]) delete lockedByCar[carId];
      return null;
    }
    if (carId === 'guard' && !canEngageHostile(live, turretId)) {
      if (turretId) {
        clearLockedHostile(carId, turretId);
        return null;
      }
      if (!canEngageHostile(live)) {
        clearLockedHostile(carId);
        return null;
      }
    }
    return live;
  }

  /**
   * 读取锁定敌方（活体刷新）。传 turretId 读该塔；否则优先任一分塔活锁，再回退车厢级。
   * 目标已死、不在列表、或卫兵炮已无法交战时清锁定并返回 null。
   * @param {string} carId
   * @param {string|null|undefined} [turretId]
   */
  function getLockedHostile(carId, turretId) {
    if (!carId) return null;
    const tid = normalizeLockTurretId(turretId);
    if (tid) {
      return resolveLiveLockedHostile(
        carId,
        lockedByTurret[carId]?.[tid] || null,
        tid
      );
    }
    const map = lockedByTurret[carId];
    if (map) {
      const order = ['left', 'right', ...Object.keys(map)];
      const seen = new Set();
      for (const key of order) {
        if (seen.has(key)) continue;
        seen.add(key);
        const live = resolveLiveLockedHostile(carId, map[key] || null, key);
        if (live) return live;
      }
    }
    return resolveLiveLockedHostile(carId, lockedByCar[carId] || null, null);
  }

  /**
   * 锁定分类：none|ground|air|large（供 turret_lock_kind 传感）。
   * @param {string} carId
   */
  function getLockedHostileKind(carId) {
    const h = getLockedHostile(carId);
    if (!h) return 'none';
    const raw = String(h.kind || h.targetClass || h.class || '').toLowerCase();
    if (raw === 'air' || raw.includes('air') || raw.includes('fly')) return 'air';
    if (raw.includes('large') || raw.includes('capital')) return 'large';
    if (raw === 'ground' || raw.includes('ground') || Number.isFinite(Number(h.x))) {
      return 'ground';
    }
    return 'none';
  }

  /** 锁定目标当前生命值；无锁定或无数则 null。 */
  function getLockedHostileHp(carId) {
    const h = getLockedHostile(carId);
    if (!h || h.hp == null || !Number.isFinite(Number(h.hp))) return null;
    return Number(h.hp);
  }

  /**
   * 匀速拦截提前点：解 |P+Vt−O|=St；无正解则用 dist/S 一阶提前。
   * 炮弹速度取 PROJECTILE_STYLE.shell.speed（内置，非玩家参数）。
   * @param {number} originX
   * @param {number} originY
   * @param {{ x?: number, y?: number, vx?: number, vy?: number }} target
   */
  function predictLeadAim(originX, originY, target) {
    const speed = shellSpeed();
    const maxRange = lockRangeForCar('guard');
    const px = Number(target?.x) || 0;
    const py = Number(target?.y) || 0;
    const vx = Number(target?.vx) || 0;
    const vy = Number(target?.vy) || 0;
    const rx = px - originX;
    const ry = py - originY;
    let t = Math.hypot(rx, ry) / Math.max(1, speed);
    const a = vx * vx + vy * vy - speed * speed;
    const b = 2 * (rx * vx + ry * vy);
    const c = rx * rx + ry * ry;
    if (Math.abs(a) > 1e-4) {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        const t1 = (-b - s) / (2 * a);
        const t2 = (-b + s) / (2 * a);
        const pos = [t1, t2].filter((x) => x > 1e-4);
        if (pos.length) t = Math.min(...pos);
      }
    } else if (Math.abs(b) > 1e-4) {
      const tLin = -c / b;
      if (tLin > 1e-4) t = tLin;
    }
    const maxT = maxRange / Math.max(1, speed);
    t = Math.min(Math.max(0, t), maxT);
    return { x: px + vx * t, y: py + vy * t, t, speed };
  }

  window.LpCombat = {
    tryFire,
    tryReload,
    spawnProjectile,
    spawnTracer,
    spawnShellCasing,
    playFireSfxAt,
    playReloadSfx,
    RELOAD_SFX,
    PISTOL_FIRE_SFX,
    RAPID_CANNON_FIRE_SFX,
    RAPID_CANNON_FIRE_FAR_SFX,
    AUTOCANNON_FIRE_SFX,
    ARTILLERY_FIRE_SFX,
    tick,
    draw,
    clearWorldFx,
    setWeapon,
    canFire,
    isHeldWeaponFullAuto,
    getHeldWeaponItem,
    getHeldVisibleItem,
    getHeldWeaponSlot,
    getMagReadout,
    getRecoil: () => state.recoil,
    getCrosshairGapPx,
    syncCrosshairBloom,
    getSecondaryTurretCrosshairGapPx,
    getWeaponId: () => state.weaponId,
    drawMuzzleFlash,
    listHostiles,
    countHostilesInRange,
    pickLockTarget,
    canEngageHostile,
    setLockedHostile,
    clearLockedHostile,
    getLockedHostile,
    listLockedHostileIds,
    getLockedHostileKind,
    getLockedHostileHp,
    predictLeadAim,
    projectileClearsToPoint,
    PROJECTILE_STYLE,
  };
})();
