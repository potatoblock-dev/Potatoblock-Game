/**
 * 车厢可交互节点规格（与贴图对齐，同一车厢可挂多个）。
 * 动力车：燃烧室 / 引擎控制台；卫兵防御车：炮塔 / 弹药箱 / 回收箱；
 * 塔莎火箭弹：火控（左）/ 弹药箱（右）；绘轨：雷达；枢机：自动化。
 * centerX / promptAnchorY 为贴图像素，构建时经 Spec.scaleArt 进世界。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;

  /** 节点表：carId + 车厢内 centerX（贴图像素）。 */
  const INTERACT_SPOTS = [
    {
      id: 'power-firebox',
      carId: 'power',
      label: '燃烧室',
      centerX: 886,
      promptAnchorY: 817,
      interactRadiusX: 120,
      action: 'addFuel',
      actionLabel: '添加燃料',
    },
    {
      id: 'power-controls',
      carId: 'power',
      label: '引擎控制',
      centerX: 1353,
      promptAnchorY: 800,
      interactRadiusX: 140,
      action: 'openDrivePanel',
      actionLabel: '打开驾驶台',
    },
    {
      id: 'guard-turret-left',
      carId: 'guard',
      /** 左站红钮挂板（guard-car 质心）；非穹顶。 */
      label: '左侧炮塔',
      centerX: 568,
      promptAnchorY: 870,
      interactRadiusX: 130,
      action: 'enterTurretLeft',
      actionLabel: '进入左侧炮塔',
    },
    {
      id: 'guard-turret-right',
      carId: 'guard',
      /** 右站红钮挂板（与左侧对称）。 */
      label: '右侧炮塔',
      centerX: 1581,
      promptAnchorY: 870,
      interactRadiusX: 130,
      action: 'enterTurretRight',
      actionLabel: '进入右侧炮塔',
    },
    {
      id: 'guard-ammo',
      carId: 'guard',
      label: '弹药箱',
      centerX: 965,
      promptAnchorY: 860,
      interactRadiusX: 100,
      action: 'guardAmmo',
      actionLabel: '存取弹药',
    },
    {
      id: 'guard-recycle',
      carId: 'guard',
      label: '回收箱',
      centerX: 1316,
      promptAnchorY: 880,
      interactRadiusX: 90,
      action: 'guardRecycle',
      actionLabel: '存取弹壳',
    },
    {
      id: 'tasha-fire-control',
      carId: 'tasha',
      label: '火控台',
      /** 左侧控制台 / 绿屏质心附近（预览采样）。 */
      centerX: 620,
      promptAnchorY: 860,
      interactRadiusX: 130,
      action: 'openTashaFireControl',
      actionLabel: '打开火控台',
    },
    {
      id: 'tasha-ammo',
      carId: 'tasha',
      label: '火箭弹药箱',
      /** 右侧橄榄绿弹药堆。 */
      centerX: 1560,
      promptAnchorY: 860,
      interactRadiusX: 120,
      action: 'tashaAmmo',
      actionLabel: '存取火箭弹',
    },
    {
      id: 'huigui-radar',
      carId: 'huigui',
      label: '绘轨示波器',
      /** 绿屏质心采样自 huigui-car.png */
      centerX: 1125,
      promptAnchorY: 850,
      interactRadiusX: 150,
      action: 'openRadarScope',
      actionLabel: '打开雷达示波器',
    },
    {
      id: 'shuji-console',
      carId: 'shuji',
      label: '枢机核心',
      /** 中央亮核采样自 shuji-car.png */
      centerX: 1125,
      promptAnchorY: 840,
      interactRadiusX: 160,
      action: 'openAutoConsole',
      actionLabel: '打开自动化控制台',
    },
  ];

  /** 返回带世界坐标的交互点列表（跳过当前编组中不存在的车厢）。 */
  function buildInteractables() {
    const scale = Spec.scaleArt || ((v) => v);
    const carById = Object.fromEntries(Spec.CARRIAGES.map((car) => [car.id, car]));
    return INTERACT_SPOTS.filter((spot) => carById[spot.carId]).map((spot) => {
      const car = carById[spot.carId];
      return {
        ...spot,
        centerX: scale(spot.centerX),
        promptAnchorY: scale(spot.promptAnchorY),
        interactRadiusX: scale(spot.interactRadiusX),
        worldX: (car?.worldX ?? 0) + scale(spot.centerX),
      };
    });
  }

  window.LiminalInteractSpec = {
    INTERACT_SPOTS,
    buildInteractables,
  };
})();
