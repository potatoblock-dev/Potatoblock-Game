/**
 * 阈限月台物品目录（占位图标用色块 + 缩写，后续可换贴图）。
 * w/h：背包/仓库占格；手部栏无视占格。
 * equipSlot：head | chest | legs | accessory | backpack | 缺省不可装备。
 */
(() => {
  const TYPE_LABELS = {
    fuel: '燃料',
    material: '材料',
    metal: '金属',
    tool: '工具',
    medical: '医疗',
    weapon: '武器',
    ammo: '弹药',
    apparel: '服装',
    accessory: '配件',
    facility: '设施',
  };

  const EQUIP_SLOT_LABELS = {
    head: '头部',
    chest: '胸部',
    legs: '腿部',
    accessory: '配件',
    backpack: '背包',
  };

  const ITEMS = {
    coal: {
      id: 'coal',
      name: '煤炭',
      short: '煤',
      type: 'fuel',
      /** 投入锅炉时每单位提供的燃料值；未来其它燃料同样声明此字段即可。 */
      boilerFuel: 18,
      use: '从古至今，煤炭都是最要紧的能源之一。丢进锅炉，列车才肯往前走。',
      color: '#1f2937',
      accent: '#475569',
      maxStack: 100,
      w: 1,
      h: 1,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/coal-icon.png?v=2',
    },
    lumber: {
      id: 'lumber',
      name: '木料',
      short: '木',
      type: 'material',
      use: '基础建材，可用于维修车厢或制作简易零件。',
      color: '#78350f',
      accent: '#b45309',
      maxStack: 100,
      w: 1,
      h: 1,
      canHoldInHand: true,
    },
    iron_ingot: {
      id: 'iron_ingot',
      name: '铁板',
      short: '铁',
      type: 'metal',
      use: '压扁的铁板，厚实可靠，加固车厢、锻造零件都靠它。',
      color: '#475569',
      accent: '#94a3b8',
      maxStack: 50,
      w: 1,
      h: 1,
      canHoldInHand: true,
    },
    scrap: {
      id: 'scrap',
      name: '废料',
      short: '废',
      type: 'material',
      use: '各种材料糅合在一起，也许会有人愿意回收它们。',
      color: '#334155',
      accent: '#64748b',
      maxStack: 50,
      w: 1,
      h: 1,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/scrap-icon.png?v=1',
    },
    wrench: {
      id: 'wrench',
      name: '扳手',
      short: '扳',
      type: 'tool',
      use: '用于日常检修设备，不过真正的工程师，可不会只用它来修东西。',
      color: '#854d0e',
      accent: '#ca8a04',
      maxStack: 1,
      w: 2,
      h: 1,
      canHoldInHand: true,
      /** 选中手槽时在角色手上绘制（复用 icon，无单独 holdSprite）。 */
      drawHeld: true,
      /** 背包 rot=90 时贴图跟着转（细长工具，直立会与足迹不符）。 */
      iconFollowsRot: true,
      /** 竖放时逆时针 90°（头朝上）；默认顺时针会头朝下。 */
      iconRotDeg: -90,
      icon: '/static/games/liminal-platform/img/items/wrench-icon.png?v=1',
      gripOffset: { x: 20, y: -18 },
      /* 256×96 贴图；握把在左侧，头朝右沿 facing */
      holdDrawW: 52,
      holdDrawH: 20,
      holdPivotX: 12,
      holdPivotY: 11,
    },
    turret_ammo: {
      id: 'turret_ammo',
      name: '机炮弹药',
      short: '弹',
      type: 'ammo',
      use: '通用的机炮弹药，这种规格的弹药刚好足够把敌人撕碎。',
      color: '#14532d',
      accent: '#4ade80',
      maxStack: 100,
      w: 1,
      h: 2,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/turret-ammo-icon.png?v=1',
    },
    rocket_ammo: {
      id: 'rocket_ammo',
      name: '塔莎火箭弹',
      short: '火箭',
      type: 'ammo',
      use: '塔莎火箭弹车厢专用弹药。需雷达持续照射目标后方可发射。',
      color: '#9a3412',
      accent: '#fb923c',
      maxStack: 20,
      w: 2,
      h: 1,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/cars/tasha-rocket/tasha-rocket.png?v=1',
    },
    shell_casing: {
      id: 'shell_casing',
      name: '机炮弹壳',
      short: '壳',
      type: 'material',
      use: '机炮开火后回收的弹壳，可以回收利用成新的弹药',
      color: '#a16207',
      accent: '#facc15',
      maxStack: 100,
      w: 1,
      h: 2,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/turret-casing-icon.png?v=1',
      /** 卫士抛壳 FX：沿枪管外抛 + 上抛 + 小侧向散布。 */
      shellEjectSpeed: { forward: 340, up: 110, side: 48 },
      shellCasingScale: 1.2,
    },
    small_caliber_ammo: {
      id: 'small_caliber_ammo',
      name: '小口径子弹',
      short: '9mm',
      type: 'ammo',
      use: '用于冲锋枪和手枪的弹药，威力勉强够用。主要用于GUR-65等武器上。',
      color: '#713f12',
      accent: '#fbbf24',
      maxStack: 240,
      w: 1,
      h: 1,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/small-caliber-ammo-icon.png?v=2',
    },
    gur65: {
      id: 'gur65',
      name: 'GUR-65冲锋枪',
      short: 'G65',
      type: 'weapon',
      weaponId: 'gur65',
      /**
       * 机炮/冲锋枪类别：长按连发（见 isFullAuto）。
       * 未来机炮武器设 weaponClass: 'machine_gun'（或 fullAuto / fireMode:'auto'）即可。
       */
      weaponClass: 'machine_gun',
      fullAuto: true,
      use: '制式武器，采用 6.5mm 弹药与顶部供弹，小巧轻便，对刚登上列车的新人来说，性能再合适不过。',
      color: '#1f2937',
      accent: '#9ca3af',
      maxStack: 1,
      w: 3,
      h: 2,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/weapons/gur-65-icon.png?v=3',
      holdSprite: '/static/games/liminal-platform/img/weapons/gur-65.png?v=3',
      gripOffset: { x: 28, y: -28 },
      muzzleLength: 56,
      muzzleOffsetY: -4,
      ejectLocal: { x: 16, y: -11 },
      /* 手持放大约 +36%（相对躯干更像冲锋枪）；holdPose 由 ?debugHold=1 调参写回 */
      holdDrawW: 76,
      holdDrawH: 30,
      holdPivotX: 37,
      holdPivotY: 20,
      /** 双附着：握把 back/红（胸口布局）+ 护木 front/橙（相对握把沿枪管） */
      holdPose: {
        chestX: -11.5,
        chestY: -12,
        gripAlong: 25.5,
        gripBelow: 3.5,
        gunForendX: 19,
        gunForendY: 2,
        forendAlong: 16,
        forendBelow: 6,
        gripLimb: 'back',
        forendLimb: 'front',
        gripElbowSign: -1,
        forendElbowSign: -1,
        shoulderX: 11,
        shoulderY: -13,
        upperLen: 13,
        lowerLen: 16.5,
        shoulderMin: -2.9,
        shoulderMax: 1.85,
        elbowMin: -2.75,
        elbowMax: 2.75,
      },
      magazineSize: 27,
      ammoId: 'small_caliber_ammo',
      /** 顶部供弹换弹动作。 */
      reloadStyle: 'top_mag',
      reloadDuration: 0.92,
      fireCooldown: 0.085,
      /** 单发后坐抬升（0–1 散布标度）。 */
      recoilKick: 0.22,
      /** 移动时后坐倍率（中）。 */
      moveRecoilMul: 1.45,
      recoilDecay: 1.8,
      spreadBaseDeg: 1.2,
      spreadBloomDeg: 7.5,
      /** 抛壳初速：沿枪管 forward + 世界向上 up + 法向 side（世界单位/秒近似）。 */
      shellEjectSpeed: { forward: 30, up: 70, side: 145 },
      /** 弹壳绘制缩放（小口径）。 */
      shellCasingScale: 0.42,
      /** 飞行弹种：离散子弹实体（非激光）。 */
      projectileStyle: 'bullet',
      /** 单发对小怪伤害（地面 18 / 空中 10）。 */
      damage: 6,
      /**
       * 最大飞行距离（世界像素）；缺省用 PROJECTILE_STYLE[projectileStyle].maxRange。
       * bullet 默认 1600；shell（机炮）默认 6400。
       */
      maxRange: 1600,
      /** 单发音效（CC0：ak47 shooting.wav）。 */
      fireSound: '/static/games/liminal-platform/audio/weapons/gur-65-shot.wav?v=1',
      fireSoundVolume: 0.62,
    },
    work_cap: {
      id: 'work_cap',
      name: '工装帽',
      short: '帽',
      type: 'apparel',
      use: '遮灰挡屑的简易头帽。',
      color: '#334155',
      accent: '#94a3b8',
      maxStack: 1,
      w: 1,
      h: 1,
      canHoldInHand: true,
      equipSlot: 'head',
    },
    work_vest: {
      id: 'work_vest',
      name: '工装背心',
      short: '背心',
      type: 'apparel',
      use: '防护胸腹的厚织背心。',
      color: '#1e3a5f',
      accent: '#38bdf8',
      maxStack: 1,
      w: 2,
      h: 2,
      canHoldInHand: false,
      equipSlot: 'chest',
    },
    work_pants: {
      id: 'work_pants',
      name: '工装裤',
      short: '裤',
      type: 'apparel',
      use: '耐磨长裤，适合在车厢间走动。',
      color: '#3f3f46',
      accent: '#a1a1aa',
      maxStack: 1,
      w: 2,
      h: 2,
      canHoldInHand: false,
      equipSlot: 'legs',
    },
    signal_lamp: {
      id: 'signal_lamp',
      name: '信号灯',
      short: '灯',
      type: 'accessory',
      use: '挂在腰侧的小型信号灯，便于昏暗车厢辨位。',
      color: '#854d0e',
      accent: '#fbbf24',
      maxStack: 1,
      w: 1,
      h: 1,
      canHoldInHand: true,
      equipSlot: 'accessory',
    },
    work_satchel: {
      id: 'work_satchel',
      name: '帆布挎包',
      short: '包',
      type: 'apparel',
      use: '装杂物的帆布挎包。装备到背包槽后，物品栏扩大为宽 6 × 高 4。',
      color: '#57534e',
      accent: '#a8a29e',
      maxStack: 1,
      w: 2,
      h: 2,
      canHoldInHand: false,
      equipSlot: 'backpack',
      bagCols: 6,
      bagRows: 4,
    },
    /**
     * 蜂鸟护卫无人机：手部主手槽（0/1）装备即本地伴飞自动点射。
     * 足迹高 2 × 宽 3；弹匣 stack.mag（上限 120），弹药小口径子弹。
     * 战斗逻辑见 lp-hummingbird-drone.js（非玩家手持开火）。
     */
    hummingbird_drone: {
      id: 'hummingbird_drone',
      name: '蜂鸟护卫无人机',
      short: '蜂鸟',
      type: 'weapon',
      weaponId: 'hummingbird_drone',
      weaponClass: 'companion_drone',
      companion: true,
      use: '基础款便携护卫无人机，放入手部栏即伴飞并自动消灭潜在的威胁。使用小口径弹药，备弹量高达120发。',
      color: '#3f5f4a',
      accent: '#9ec9b0',
      maxStack: 1,
      w: 3,
      h: 2,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/hummingbird-drone-icon.png?v=2',
      bodySprite: '/static/games/liminal-platform/img/drone/hummingbird-body.png?v=2',
      barrelSprite: '/static/games/liminal-platform/img/drone/hummingbird-barrel.png?v=2',
      bodyDrawW: 56,
      bodyDrawH: 24,
      /** 326×38 原图像素等比缩到宽 34（高 ≈4）。 */
      barrelDrawW: 34,
      barrelDrawH: 4,
      /**
       * 挂点：机身灰柱底端中心（原生约 y=192 → 绘制局部 y≈10.2）。
       * 枢轴：炮管绿座顶心（与灰柱相接；原生 ≈(88.5,4) → 绘制 (9.2,0.45)）。
       * 旧值 mount(0,9) pivot(5,2.5) H=5 muzzle=30。
       */
      barrelMount: { x: 0, y: 10.2 },
      barrelPivotX: 9.2,
      barrelPivotY: 0.45,
      muzzleLength: 34,
      magazineSize: 120,
      ammoId: 'small_caliber_ammo',
      burstCount: 3,
      burstShotGap: 0.075,
      burstCooldown: 0.55,
      hoverOffsetX: 36,
      hoverOffsetY: -78,
      leashRadius: 110,
      bobAmp: 5.5,
      bobHz: 1.1,
      projectileStyle: 'bullet',
      damage: 5,
      maxRange: 1400,
      spreadBaseDeg: 1.5,
      spreadBloomDeg: 4,
      fireSound: '/static/games/liminal-platform/audio/weapons/gur-65-shot.wav?v=1',
      fireSoundVolume: 0.4,
    },
    /**
     * 医疗箱：手部 3 号槽持有；对准自己或近距队友按开火键持续治疗（回血）。
     * 足迹宽 1 × 高 2；耐久存 stack.dur。不用于濒死复活。
     */
    medkit: {
      id: 'medkit',
      name: '医疗箱',
      short: '医',
      type: 'medical',
      use: '标准的伤口处理医疗箱，能够处理简单创伤。给队友包扎会更顺手。',
      icon: '/static/games/liminal-platform/img/items/medkit-icon.png?v=3',
      color: '#7f1d1d',
      accent: '#fca5a5',
      maxStack: 1,
      w: 1,
      h: 2,
      canHoldInHand: true,
      handSlot: 2,
      maxDurability: 40,
      selfHealPerSec: 12,
      allyHealPerSec: 28,
      durCostPerSec: 8,
      allyRange: 150,
      selfAimRadius: 72,
      allyAimRadius: 88,
      /** 持续治疗用；不可整箱复活。 */
      canHeal: true,
      canRevive: false,
      /** 移动端准星吸附：仅友方。 */
      aimTargetClass: 'ally',
    },
    /**
     * 急救箱：手部 3 号槽持有；对准濒死队友开火消耗整箱复活。
     * 足迹宽 2 × 高 2。不提供持续回血。
     */
    first_aid_kit: {
      id: 'first_aid_kit',
      name: '急救箱',
      short: '救',
      type: 'medical',
      use: '命悬一线时的最后手段。器械更大更复杂，无法处理简单创伤。',
      icon: '/static/games/liminal-platform/img/items/first-aid-kit-icon.png?v=1',
      color: '#991b1b',
      accent: '#fde047',
      maxStack: 3,
      w: 2,
      h: 2,
      canHoldInHand: true,
      handSlot: 2,
      allyRange: 150,
      selfAimRadius: 72,
      allyAimRadius: 88,
      canHeal: false,
      canRevive: true,
      /** 移动端准星吸附：仅友方（含濒死）。 */
      aimTargetClass: 'ally',
    },
    /**
     * 手提灭火器：可装入手部 1/2/3 任一槽；弹药 stack.ammo（0–100，HUD 进度条）。
     * 满罐连续喷射约 15 秒；不可普通换弹，须靠近灭火器站按 R 补满。
     */
    fire_extinguisher: {
      id: 'fire_extinguisher',
      name: '灭火器',
      short: '灭',
      type: 'tool',
      use: '手提式干粉灭火器。对准火源长按开火喷射，满罐约可喷十五秒。耗尽后不能自行装填，须靠近灭火器站按装填键补充。',
      color: '#b91c1c',
      accent: '#fecaca',
      maxStack: 1,
      w: 1,
      h: 2,
      canHoldInHand: true,
      canHoldAnyHandSlot: true,
      drawHeld: true,
      /** 对准火源，不吸附实体。 */
      aimTargetClass: 'none',
      icon: '/static/games/liminal-platform/img/items/fire-extinguisher-icon.png?v=2',
      holdSprite: '/static/games/liminal-platform/img/items/fire-extinguisher.png?v=2',
      gripOffset: { x: 18, y: -24 },
      holdDrawW: 20,
      holdDrawH: 46,
      holdPivotX: 10,
      holdPivotY: 38,
      muzzleLength: 28,
      muzzleOffsetY: -18,
      maxAmmo: 100,
      sprayDurationSec: 15,
    },
    /**
     * 可摆放设施：存于仓储，P 编辑模式下拖到舱内格子。
     * facilityW/H = 舱内占格；背包 w/h 与之对齐。
     */
    facility_crate: {
      id: 'facility_crate',
      name: '储物箱',
      short: '箱',
      type: 'facility',
      placeable: true,
      facilityW: 1,
      facilityH: 1,
      use: '简易储物箱，可摆进可编辑车厢的舱内格子。',
      color: '#78350f',
      accent: '#fbbf24',
      maxStack: 20,
      w: 1,
      h: 1,
      canHoldInHand: false,
    },
    facility_workbench: {
      id: 'facility_workbench',
      name: '工作台',
      short: '台',
      type: 'facility',
      placeable: true,
      facilityW: 2,
      facilityH: 1,
      use: '检修与装配用的矮工作台，占两格宽。',
      color: '#44403c',
      accent: '#a8a29e',
      maxStack: 10,
      w: 2,
      h: 1,
      canHoldInHand: false,
    },
    facility_shelf: {
      id: 'facility_shelf',
      name: '货架',
      short: '架',
      type: 'facility',
      placeable: true,
      facilityW: 1,
      facilityH: 2,
      use: '靠墙货架，占两格高。',
      color: '#57534e',
      accent: '#d6d3d1',
      maxStack: 10,
      w: 1,
      h: 2,
      canHoldInHand: false,
    },
    facility_locker: {
      id: 'facility_locker',
      name: '储物柜',
      short: '柜',
      type: 'facility',
      placeable: true,
      facilityW: 1,
      facilityH: 2,
      use: '立式储物柜，占两格高。',
      color: '#1e3a5f',
      accent: '#93c5fd',
      maxStack: 10,
      w: 1,
      h: 2,
      canHoldInHand: false,
    },
    facility_fire_extinguisher_station: {
      id: 'facility_fire_extinguisher_station',
      name: '灭火器站',
      short: '灭站',
      type: 'facility',
      placeable: true,
      facilityW: 2,
      facilityH: 3,
      use: '固定灭火器补给架，占两格宽、三格高。靠近后手持灭火器按装填键即可补满。',
      color: '#4b5563',
      accent: '#ef4444',
      maxStack: 8,
      w: 2,
      h: 3,
      canHoldInHand: false,
      icon: '/static/games/liminal-platform/img/facilities/fire-extinguisher-station.png?v=5',
    },
  };

  /* 旧存档 id 兼容 */
  ITEMS.gur77 = ITEMS.gur65;

  /** 按 id 取物品定义。 */
  function getItem(itemId) {
    return ITEMS[itemId] || null;
  }

  /** 物品在网格中的宽高（格）。 */
  function getItemSize(itemId) {
    const item = getItem(itemId);
    if (!item) return { w: 1, h: 1 };
    return {
      w: Math.max(1, item.w || 1),
      h: Math.max(1, item.h || 1),
    };
  }

  /** 是否允许放入手部槽。 */
  function canHoldInHand(itemId) {
    const item = getItem(itemId);
    if (!item) return false;
    return item.canHoldInHand !== false;
  }

  /**
   * 是否可装入任意手部槽（含武器槽 1/2）；灭火器等。
   * 默认武器仅 0/1、工具仅 2；本标记绕过该限制。
   */
  function canHoldAnyHandSlot(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    return Boolean(item && item.canHoldAnyHandSlot === true);
  }

  /** 是否为手提灭火器。 */
  function isFireExtinguisher(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    return Boolean(item && item.id === 'fire_extinguisher');
  }

  /** 是否可装入指定装备槽位键。 */
  function canEquipInSlot(itemId, slotKey) {
    const item = getItem(itemId);
    if (!item?.equipSlot || !slotKey) return false;
    return item.equipSlot === slotKey;
  }

  /** 装备槽中文名。 */
  function equipSlotLabel(slotKey) {
    return EQUIP_SLOT_LABELS[slotKey] || slotKey || '···';
  }

  /** 类型中文名。 */
  function typeLabel(type) {
    return TYPE_LABELS[type] || type || '未知';
  }

  /** 是否可作为锅炉燃料（type=fuel 且 boilerFuel>0）。 */
  function isBoilerFuel(itemId) {
    const item = getItem(itemId);
    return Boolean(item && item.type === 'fuel' && Number(item.boilerFuel) > 0);
  }

  /** 单份燃料对锅炉的贡献值。 */
  function getBoilerFuelValue(itemId) {
    if (!isBoilerFuel(itemId)) return 0;
    return Number(getItem(itemId).boilerFuel) || 0;
  }

  /** 全部可投入锅炉的燃料定义（按 id 稳定排序）。 */
  function listBoilerFuels() {
    return Object.values(ITEMS)
      .filter((item) => item.type === 'fuel' && Number(item.boilerFuel) > 0)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  /**
   * 是否为可开火武器。
   * 标记方式：type === 'weapon'，或声明 weaponId（战斗层占位 id）。
   */
  function isWeapon(itemId) {
    const item = getItem(itemId);
    return Boolean(item && (item.type === 'weapon' || item.weaponId));
  }

  /**
   * 选中手槽时是否在角色身上绘制手持贴图（武器或 drawHeld 工具等）。
   * 伴飞无人机占槽但不画在手上。
   * @param {string|object|null|undefined} itemOrId
   */
  function showsHeldSprite(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    if (!item) return false;
    if (isCompanionDrone(item)) return false;
    if (item.drawHeld === true) return true;
    return isWeapon(item.id);
  }

  /**
   * 是否为护卫伴飞无人机（仍占手部武器槽，但不走玩家手持 tryFire）。
   * companion === true，或 weaponClass === 'companion_drone'。
   */
  function isCompanionDrone(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    if (!item) return false;
    if (item.companion === true) return true;
    return item.weaponClass === 'companion_drone';
  }

  /**
   * 是否为可装备件（有 equipSlot：头/胸/腿/配件/背包等）。
   * 与 canEquipInSlot 同源，不依赖 type 文案。
   */
  function isEquipment(itemId) {
    const item = getItem(itemId);
    return Boolean(item?.equipSlot);
  }

  /**
   * 背包 rot 时图标是否跟着转：武器、装备，或 item.iconFollowsRot === true（如扳手）。
   * 弹药/材料/燃料等足迹仍可换向，贴图默认 upright。
   */
  function iconFollowsRot(itemId) {
    const item = getItem(itemId);
    if (!item) return false;
    if (item.iconFollowsRot === true) return true;
    if (item.iconFollowsRot === false) return false;
    return isWeapon(itemId) || isEquipment(itemId);
  }

  /**
   * rot=90 跟转时的 CSS rotate 角度（度）。默认 90（顺时针）；item.iconRotDeg 可覆盖（扳手 -90）。
   */
  function iconRotCssDeg(itemId) {
    const item = getItem(itemId);
    const deg = Number(item?.iconRotDeg);
    return Number.isFinite(deg) ? deg : 90;
  }

  /**
   * 切换 is-rotated，并写入/清除 --lp-icon-rot（供 CSS var 使用）。
   */
  function applyIconRotationClass(iconEl, shouldRotate, itemId) {
    if (!iconEl) return;
    iconEl.classList.toggle('is-rotated', Boolean(shouldRotate));
    if (shouldRotate) {
      iconEl.style.setProperty('--lp-icon-rot', `${iconRotCssDeg(itemId)}deg`);
      return;
    }
    iconEl.style.removeProperty('--lp-icon-rot');
  }

  /**
   * 将图鉴图标应用到槽位/详情 DOM：写入 --lp-item-icon 与 has-image。
   * CSS 须直接用 var(--lp-item-icon)（勿套进另一自定义属性，否则图标变 none）。
   * 无 icon 时回退 short 文字；item 为空则清空。
   */
  function applyItemIcon(el, item) {
    if (!el) return;
    if (!item) {
      el.classList.remove('has-image');
      el.style.removeProperty('--lp-item-icon');
      el.style.removeProperty('--item-color');
      el.style.removeProperty('--item-accent');
      el.style.backgroundImage = '';
      el.textContent = '';
      return;
    }
    el.style.setProperty('--item-color', item.color);
    el.style.setProperty('--item-accent', item.accent);
    if (item.icon) {
      el.classList.add('has-image');
      el.style.setProperty('--lp-item-icon', `url("${item.icon}")`);
      el.style.backgroundImage = '';
      el.textContent = '';
      return;
    }
    el.classList.remove('has-image');
    el.style.removeProperty('--lp-item-icon');
    el.style.backgroundImage = '';
    el.textContent = item.short || '';
  }

  /**
   * 是否全自动（长按连发）。
   * 判定：fullAuto === true，或 fireMode === 'auto'，或 weaponClass === 'machine_gun'。
   * 半自动/单发武器不要设这些字段。
   */
  function isFullAuto(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    if (!item) return false;
    if (item.fullAuto === true) return true;
    if (item.fireMode === 'auto') return true;
    return item.weaponClass === 'machine_gun';
  }

  /** 测试阶段：燃料/弹药堆与仓储种子物资自动补满；炮塔箱同。不含手持弹匣。TEST_ONLY — remove after playtest。 */
  const TEST_AUTO_REFILL_CONSUMABLES = true;

  function isConsumableItem(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    return Boolean(item && (item.type === 'fuel' || item.type === 'ammo'));
  }

  /** 战斗用武器 id；非武器返回 null。 */
  function getWeaponId(itemId) {
    const item = getItem(itemId);
    if (!item || !isWeapon(itemId)) return null;
    return item.weaponId || item.id;
  }

  /** 共享物资仓库库存 id（与 Inventory.id === 'storage' 对齐）。 */
  const STORAGE_BAG_ID = 'storage';
  /** 设施专用仓库库存 id（与 Inventory.id === 'storage_facility' 对齐）。 */
  const FACILITY_STORAGE_BAG_ID = 'storage_facility';
  /** 两类仓储均可用 STORAGE_MAX_STACK。 */
  const STORAGE_BAG_IDS = new Set([STORAGE_BAG_ID, FACILITY_STORAGE_BAG_ID]);
  /** 仓储可叠加物品叠加上限；背包/手部等仍用物品自身 maxStack。 */
  const STORAGE_MAX_STACK = 9999;

  /**
   * 按库存返回叠加上限：物资/设施仓储对可叠加物用 STORAGE_MAX_STACK，其它用图鉴 maxStack。
   * @param {string|null|undefined} bagId
   * @param {string|object|null|undefined} itemOrId
   */
  function maxStackIn(bagId, itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    const base = Math.max(1, Number(item?.maxStack) || 1);
    if (base <= 1) return base;
    if (STORAGE_BAG_IDS.has(bagId)) return STORAGE_MAX_STACK;
    return base;
  }

  /**
   * 弹药类型判定（catalog type === 'ammo'）。
   * @param {string|object|null|undefined} itemOrId
   */
  function isAmmo(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    return Boolean(item && item.type === 'ammo');
  }

  /** 是否为医疗箱（持续回血）。 */
  function isMedkit(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    return Boolean(item && item.id === 'medkit');
  }

  /** 是否为急救箱（濒死整箱复活）。 */
  function isFirstAidKit(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    return Boolean(item && item.id === 'first_aid_kit');
  }

  /** 手部医疗类工具（医疗箱或急救箱）。 */
  function isMedicalTool(itemOrId) {
    return isMedkit(itemOrId) || isFirstAidKit(itemOrId);
  }

  /**
   * 移动端准星吸附的有效目标类。
   * 显式 aimTargetClass 优先；否则医疗→ally、武器→enemy、灭火器→none；空手默认 enemy。
   * @param {string|object|null|undefined} itemOrId
   * @returns {'enemy'|'ally'|'any'|'none'}
   */
  function getAimTargetClass(itemOrId) {
    if (itemOrId == null || itemOrId === '') return 'enemy';
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    if (!item) return 'enemy';
    const raw = String(item.aimTargetClass || '').toLowerCase();
    if (raw === 'enemy' || raw === 'ally' || raw === 'any' || raw === 'none') {
      return raw;
    }
    if (isMedicalTool(item)) return 'ally';
    if (isFireExtinguisher(item)) return 'none';
    if (isWeapon(item.id) && !isCompanionDrone(item)) return 'enemy';
    return 'none';
  }

  /**
   * 武器是否接受该弹药：须有 magazineSize，且 ammoId 与弹药 id 一致。
   * 机炮弹等无 ammoId 武器返回 false（不走背包拖装填）。
   */
  function weaponAcceptsAmmo(weaponItemOrId, ammoItemId) {
    const weapon =
      typeof weaponItemOrId === 'string' ? getItem(weaponItemOrId) : weaponItemOrId;
    if (!weapon || !ammoItemId) return false;
    if (!isWeapon(weapon.id || weaponItemOrId)) return false;
    if (weapon.magazineSize == null || !weapon.ammoId) return false;
    return weapon.ammoId === ammoItemId;
  }

  /** 是否为舱内可摆放设施。 */
  function isPlaceableFacility(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    return Boolean(item && (item.placeable === true || item.type === 'facility'));
  }

  /** 设施在舱内网格的占格（缺省回落背包 w/h）。 */
  function getFacilitySize(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    if (!item) return { w: 1, h: 1 };
    return {
      w: Math.max(1, item.facilityW || item.w || 1),
      h: Math.max(1, item.facilityH || item.h || 1),
    };
  }

  /** 列出全部可摆放设施定义。 */
  function listPlaceableFacilities() {
    return Object.values(ITEMS).filter((item) => isPlaceableFacility(item));
  }

  window.LpItemCatalog = {
    ITEMS,
    TYPE_LABELS,
    EQUIP_SLOT_LABELS,
    STORAGE_BAG_ID,
    FACILITY_STORAGE_BAG_ID,
    STORAGE_MAX_STACK,
    TEST_AUTO_REFILL_CONSUMABLES,
    isConsumableItem,
    getItem,
    getItemSize,
    maxStackIn,
    canHoldInHand,
    canHoldAnyHandSlot,
    isFireExtinguisher,
    canEquipInSlot,
    equipSlotLabel,
    typeLabel,
    isBoilerFuel,
    getBoilerFuelValue,
    listBoilerFuels,
    isWeapon,
    showsHeldSprite,
    isCompanionDrone,
    isEquipment,
    iconFollowsRot,
    iconRotCssDeg,
    applyIconRotationClass,
    applyItemIcon,
    isAmmo,
    isMedkit,
    isFirstAidKit,
    isMedicalTool,
    getAimTargetClass,
    isFullAuto,
    getWeaponId,
    weaponAcceptsAmmo,
    isPlaceableFacility,
    getFacilitySize,
    listPlaceableFacilities,
  };
})();
