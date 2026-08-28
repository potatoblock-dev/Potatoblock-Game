/**
 * 阈限月台可交互物体：支持同车厢多节点（燃烧室 / 控制台等）。
 */
(() => {
  const InteractSpec = window.LiminalInteractSpec;

  let INTERACTABLES = InteractSpec.buildInteractables();
  const Catalog = window.LpItemCatalog;
  const fuel = { level: 35, max: 100 };
  let toastText = '';
  let toastUntil = 0;

  /** 显示短暂提示。 */
  function showToast(text, ms = 1800) {
    toastText = text;
    toastUntil = performance.now() + ms;
  }

  /** 仅当当前文案仍是指定内容时清除 toast（避免冲掉其它提示）。 */
  function clearToastIf(text) {
    if (toastText === text) {
      toastText = '';
      toastUntil = 0;
    }
  }

  /** 玩家是否满足交互条件（站地且靠近）。 */
  function canInteract(spot, local) {
    if (!local.onGround || local.y > 0.5) return false;
    return Math.abs(local.x - spot.worldX) <= spot.interactRadiusX;
  }

  /** 尝试对最近可交互节点执行交互。 */
  function tryInteract(local) {
    if (window.LpGuardTurret?.isManned?.()) {
      window.LpGuardTurret.exitTurret();
      return true;
    }
    if (window.LpTashaRocket?.isFireControlOpen?.()) {
      window.LpTashaRocket.closeFireControl();
      return true;
    }
    if (window.LpPlatform?.tryInteract?.(local)) return true;
    const spot = findActive(local);
    if (!spot) return false;
    return runAction(spot);
  }

  /**
   * 返回当前最近的可交互节点（含月台连接处 / 月台回车点）。
   * 同车厢多节点时按水平距离选最近。月台场景不查车厢节点（坐标空间不同）。
   */
  function findActive(local) {
    const plat = window.LpPlatform?.findActive?.(local);
    if (plat) return plat;
    if (window.LpPlatform?.getScene?.() === 'platform') return null;
    let best = null;
    let bestDist = Infinity;
    for (const spot of INTERACTABLES) {
      if (!canInteract(spot, local)) continue;
      const dist = Math.abs(local.x - spot.worldX);
      if (dist < bestDist) {
        best = spot;
        bestDist = dist;
      }
    }
    return best;
  }

  /** 列出当前范围内全部节点（调试 / 扩展用）。 */
  function findAllActive(local) {
    return INTERACTABLES.filter((spot) => canInteract(spot, local));
  }

  /**
   * 从背包扣除指定燃料并加锅炉能量。
   * @param {string} [itemId='coal'] 燃料物品 id（须在目录中声明 boilerFuel）
   */
  function addFuel(itemId = 'coal') {
    if (fuel.level >= fuel.max) {
      showToast('锅炉燃料已满');
      return false;
    }

    const energyPer = Catalog?.getBoilerFuelValue?.(itemId) ?? 0;
    const item = Catalog?.getItem?.(itemId);
    if (!energyPer || !item) {
      showToast('无法作为锅炉燃料');
      return false;
    }

    const inventory = window.LpInventory;
    const playerInv = inventory?.getPlayerInventory?.();
    const handsInv = inventory?.getHandsInventory?.();
    if (!playerInv) {
      showToast('无法读取背包');
      return false;
    }

    const have =
      (playerInv.countItem(itemId) || 0) + (handsInv?.countItem?.(itemId) || 0);
    if (have <= 0) {
      showToast(`背包没有${item.name}`);
      return false;
    }

    // 联机：只发 fuel_add，由服务端扣物品并回推快照 / fuel_changed
    if (window.LpInventoryNet?.isActive?.() || window.LiminalSession?.isConnected?.()) {
      window.LiminalSession?.notifyFuelAdd?.(energyPer, itemId);
      showToast(`投递${item.name}…`);
      return true;
    }

    const room = fuel.max - fuel.level;
    const needUnits = Math.max(1, Math.ceil(room / energyPer));
    const spend = Math.min(1, have, needUnits);
    const removed = inventory.consumeItem(itemId, spend);
    if (removed <= 0) {
      showToast(`背包没有${item.name}`);
      return false;
    }

    const gained = removed * energyPer;
    fuel.level = Math.min(fuel.max, fuel.level + gained);
    showToast(`消耗${item.name} ×${removed}（${fuel.level}/${fuel.max}）`);
    window.dispatchEvent(
      new CustomEvent('liminal:fuel-changed', {
        detail: {
          level: fuel.level,
          itemId,
          spent: removed,
          energy: gained,
          /** @deprecated 兼容旧监听；仅煤炭时有值 */
          coalSpent: itemId === 'coal' ? removed : 0,
        },
      })
    );
    window.LiminalSession?.notifyFuelAdd?.(gained, itemId);
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(fuel.level)}/100`;
    const fill = document.getElementById('lpFuelGaugeFill');
    if (fill) fill.style.height = `${Math.max(0, Math.min(100, fuel.level))}%`;
    return true;
  }

  /** 应用服务端燃料权威值。 */
  function setFuelLevel(level) {
    fuel.level = Math.max(0, Math.min(fuel.max, Number(level) || 0));
    window.dispatchEvent(
      new CustomEvent('liminal:fuel-changed', {
        detail: { level: fuel.level, coalSpent: 0 },
      })
    );
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(fuel.level)}/100`;
    const fill = document.getElementById('lpFuelGaugeFill');
    if (fill) fill.style.height = `${Math.max(0, Math.min(100, fuel.level))}%`;
  }

  /** 打开引擎控制台。 */
  function openDrivePanel() {
    window.LpBoilerPanel?.open();
    window.LpBoilerPanel?.syncFromState?.();
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(fuel.level)}/100`;
    const fill = document.getElementById('lpFuelGaugeFill');
    if (fill) fill.style.height = `${Math.max(0, Math.min(100, fuel.level))}%`;
  }

  /** 按节点 action 分发。 */
  function runAction(spot) {
    switch (spot.action) {
      case 'addFuel':
        window.LpFuelFeed?.open();
        return true;
      case 'openDrivePanel':
        openDrivePanel();
        return true;
      case 'enterTurretLeft':
        return window.LpGuardTurret?.interactTurret?.('left') ?? false;
      case 'enterTurretRight':
        return window.LpGuardTurret?.interactTurret?.('right') ?? false;
      case 'guardAmmo':
        return window.LpGuardTurret?.interactAmmoBox?.() ?? false;
      case 'guardRecycle':
        return window.LpGuardTurret?.interactRecycleBox?.() ?? false;
      case 'openTashaFireControl':
        return window.LpTashaRocket?.openFireControl?.() ?? false;
      case 'tashaAmmo':
        return window.LpTashaRocket?.interactAmmo?.() ?? false;
      case 'openRadarScope':
        window.LpRadarScope?.open();
        return Boolean(window.LpRadarScope);
      case 'openAutoConsole':
        window.LpAutoConsole?.open();
        return Boolean(window.LpAutoConsole);
      default:
        console.warn('[liminal] unknown interact action', spot.action, spot.id);
        return false;
    }
  }

  /** 尝试对最近可交互节点执行交互。 */
  function tryInteract(local) {
    if (window.LpGuardTurret?.isManned?.()) {
      window.LpGuardTurret.exitTurret();
      return true;
    }
    if (window.LpTashaRocket?.isFireControlOpen?.()) {
      window.LpTashaRocket.closeFireControl();
      return true;
    }
    if (window.LpPlatform?.tryInteract?.(local)) return true;
    const spot = findActive(local);
    if (!spot) return false;
    return runAction(spot);
  }

  /** 读取 CSS env(safe-area-inset-*)；getPropertyValue 常为空时回退 0。 */
  function readSafeInset(side) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
      `env(safe-area-inset-${side})`
    );
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * 右下角状态提示锚点（右缘 / 垂直中心）。
   * 移动端抬高避开开火/交互键；弹种栏或动作簇可见时再抬高。
   * @param {{ mobile?: boolean, stackIndex?: number, labelH?: number }} [options]
   * @returns {{ x: number, y: number }}
   */
  function cornerStatusAnchor(options = {}) {
    const { mobile = false, stackIndex = 0, labelH = 34 } = options;
    const w = window.innerWidth || 800;
    const h = window.innerHeight || 600;
    const safeRight = readSafeInset('right');
    const safeBottom = readSafeInset('bottom');
    let bottom = (mobile ? 168 : 52) + safeBottom;
    let right = 16 + safeRight;

    if (window.LpArmedAmmo?.isActive?.()) {
      const ammoEl = document.getElementById('lpArmedAmmoHud');
      const rect = ammoEl && !ammoEl.hidden ? ammoEl.getBoundingClientRect() : null;
      const clearAboveAmmo = rect
        ? h - rect.top + labelH / 2 + 12
        : mobile
          ? 240
          : 118;
      bottom = Math.max(bottom, clearAboveAmmo);
    }

    if (mobile) {
      const actions = document.querySelector('.lp-mobile-action-cluster');
      const rect = actions ? actions.getBoundingClientRect() : null;
      if (rect && rect.height > 0) {
        bottom = Math.max(bottom, h - rect.top + labelH / 2 + 12);
      }
    }

    const gap = 8;
    return {
      x: w - right,
      y: h - bottom - stackIndex * (labelH + gap),
    };
  }

  /** 绘制靠近提示（统一右下角）。 */
  function drawPrompt(ctx, spot, view, dpr, keyLabel) {
    void view;
    drawCornerStatus(ctx, dpr, `按 ${keyLabel} ${spot.actionLabel}`, {});
  }

  /**
   * 在屏幕坐标绘制浮动提示条。
   * @param {'left'|'center'|'right'} [options.align]
   */
  function drawFloatingLabel(ctx, dpr, screenX, screenY, line, options = {}) {
    const align = options.align || 'center';
    const font = options.font || '600 14px system-ui, sans-serif';
    const textColor = options.textColor || '#fef3c7';
    const labelH = options.labelH || 34;
    const padX = options.padX || 22;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';

    const labelW = ctx.measureText(line).width + padX;
    let boxX = screenX - labelW / 2;
    if (align === 'right') boxX = screenX - labelW;
    else if (align === 'left') boxX = screenX;

    ctx.fillStyle = options.bg || 'rgba(15, 23, 42, 0.86)';
    ctx.beginPath();
    ctx.roundRect(boxX, screenY - labelH / 2, labelW, labelH, 8);
    ctx.fill();

    ctx.fillStyle = textColor;
    ctx.fillText(line, screenX, screenY);
  }

  /**
   * 模式 / 键位状态条：屏幕右下角（交互、炮塔、仓储、toast 共用）。
   * Canvas 绘制；stackIndex 向上叠层，避免与另一条状态重叠。
   */
  function drawCornerStatus(ctx, dpr, line, options = {}) {
    const labelH = options.labelH || 34;
    const { x, y } = cornerStatusAnchor({ ...options, labelH });
    drawFloatingLabel(ctx, dpr, x, y, line, {
      align: 'right',
      font: options.font,
      textColor: options.textColor,
      bg: options.bg,
      labelH,
      padX: options.padX,
    });
  }

  /** @deprecated 兼容旧调用名；等同 drawCornerStatus。 */
  function drawStatusBanner(ctx, dpr, line, options = {}) {
    drawCornerStatus(ctx, dpr, line, options);
  }

  /** 仓储车厢：整节可用时在右下角提示打开物品栏。 */
  function drawStoragePrompt(ctx, local, view, dpr, inventoryKeyLabel, options = {}) {
    void view;
    const { mobile = false } = options;
    const Spec = window.LiminalCarriageSpec;
    const car = Spec?.carriageAt?.(local.x);
    if (car?.id !== 'storage') return false;
    if (!local.onGround || local.y > 0.5) return false;
    if (window.LpInventory?.isOpen?.()) return false;
    if (window.LpBoilerPanel?.isOpen?.() || window.LpFuelFeed?.isOpen?.()) return false;

    const line = mobile
      ? '点「物品」打开物品栏以管理仓库'
      : `按 ${inventoryKeyLabel} 打开物品栏以管理仓库`;
    drawCornerStatus(ctx, dpr, line, { mobile });
    return true;
  }

  /** 画布 HUD 锚点：避开 DOM 顶栏与刘海安全区。 */
  function hudAnchor() {
    const topEl = document.querySelector('.lp-hud-top');
    const topBottom = topEl ? topEl.getBoundingClientRect().bottom : 0;
    const safeLeft = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('env(safe-area-inset-left)')
    );
    /* env() 经 getPropertyValue 常为空；用 top 栏左内边距近似 */
    const padLeft = topEl
      ? Number.parseFloat(getComputedStyle(topEl).paddingLeft) || 14
      : 14;
    const barY = Math.max(56, Math.round(topBottom) + 10);
    return {
      barX: Number.isFinite(safeLeft) && safeLeft > 0 ? 14 + safeLeft : padLeft,
      barY,
    };
  }

  /**
   * 绘制动力车车厢详细信息（锅炉燃料 + 列车车速）与 toast。
   * 燃料/车速仅在玩家处于动力车厢时显示；toast 全局钉右下角；炮塔模式跳过顶栏 chrome。
   * @param {{ mobile?: boolean, statusOccupied?: boolean }} [options]
   */
  function drawHud(ctx, view, dpr, worldX, options = {}) {
    void view;
    const { mobile = false, statusOccupied = false } = options;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { barX, barY } = hudAnchor();
    const hideTopChrome = document.body.classList.contains('lp-turret-mode');
    const inPowerCar =
      window.LiminalCarriageSpec?.carriageAt?.(worldX)?.id === 'power';

    if (!hideTopChrome && inPowerCar) {
      const barW = 120;
      const barH = 8;
      const ratio = fuel.level / fuel.max;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
      ctx.fillRect(barX - 2, barY - 18, barW + 4, 30);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('锅炉燃料', barX, barY - 16);
      ctx.fillStyle = 'rgba(51, 65, 85, 0.9)';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = ratio > 0.25 ? '#f59e0b' : '#ef4444';
      ctx.fillRect(barX, barY, barW * ratio, barH);

      const drive = window.LpTrainDrive?.getState?.();
      if (drive) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
        ctx.fillRect(barX - 2, barY + 16, barW + 4, 34);
        ctx.fillStyle = '#94a3b8';
        ctx.fillText('列车', barX, barY + 18);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '600 12px system-ui, sans-serif';
        const speedText =
          Math.abs(drive.speed) < 0.08
            ? '静止'
            : `${drive.speed > 0 ? '→' : '←'}${Math.abs(drive.speed).toFixed(1)} · ${drive.throttleLabel}`;
        ctx.fillText(speedText, barX, barY + 32);
      }
    }

    if (performance.now() < toastUntil && toastText) {
      drawCornerStatus(ctx, dpr, toastText, {
        mobile,
        stackIndex: statusOccupied ? 1 : 0,
        labelH: 32,
        font: '600 13px system-ui, sans-serif',
        textColor: '#fde68a',
        bg: 'rgba(15, 23, 42, 0.82)',
        padX: 24,
      });
    }
  }

  /** 绘制最近激活节点的提示（右下角）与 HUD。 */
  function drawActivePrompt(ctx, local, view, dpr, keyLabel, options = {}) {
    const { showPrompt = true, inventoryKeyLabel = 'Tab', mobile = false } = options;
    let statusOccupied = false;
    if (window.LpGuardTurret?.isManned?.()) {
      /* 移动端仍须显示弹药/离开提示（桌面交互浮标在触控上会关掉 showPrompt） */
      if (showPrompt || mobile) {
        const ammo = window.LpGuardTurret.ammoCount?.() ?? 0;
        const line = mobile
          ? `炮塔中 · 弹药 ${ammo} · 点交互离开 · 开火键射击`
          : `炮塔中 · 弹药 ${ammo} · 按 ${keyLabel} 离开 · 左键开火`;
        drawCornerStatus(ctx, dpr, line, { mobile });
        statusOccupied = true;
      }
      drawHud(ctx, view, dpr, local.x, { mobile, statusOccupied });
      return;
    }
    const active = findActive(local);
    const panelOpen = window.LpBoilerPanel?.isOpen?.();
    if (active && showPrompt && !panelOpen) {
      drawCornerStatus(ctx, dpr, spotActionLabel(active, keyLabel), { mobile });
      statusOccupied = true;
    } else if (!active && !panelOpen) {
      statusOccupied = Boolean(
        drawStoragePrompt(ctx, local, view, dpr, inventoryKeyLabel, { mobile })
      );
    }
    drawHud(ctx, view, dpr, local.x, { mobile, statusOccupied });
  }

  /** 交互提示文案（弹药箱附带库存）。 */
  function spotActionLabel(spot, keyLabel) {
    if (spot.action === 'guardAmmo') {
      const n = window.LpGuardTurret?.ammoCount?.() ?? 0;
      return `按 ${keyLabel} ${spot.actionLabel}（箱内 ${n}）`;
    }
    if (spot.action === 'tashaAmmo') {
      const n = window.LpTashaRocket?.ammoCount?.() ?? 0;
      return `按 ${keyLabel} ${spot.actionLabel}（箱内 ${n}）`;
    }
    if (spot.action === 'guardRecycle') {
      const n = window.LpGuardTurret?.casingCount?.() ?? 0;
      return `按 ${keyLabel} ${spot.actionLabel}（${n}）`;
    }
    return `按 ${keyLabel} ${spot.actionLabel}`;
  }

  /** 编组变更后按当前 CARRIAGES 重建世界坐标交互点。 */
  function rebuildInteractables() {
    INTERACTABLES = InteractSpec.buildInteractables();
    window.LiminalInteract.INTERACTABLES = INTERACTABLES;
  }

  window.LiminalInteract = {
    findActive,
    findAllActive,
    tryInteract,
    drawActivePrompt,
    getFuelLevel: () => fuel.level,
    setFuelLevel,
    addFuel,
    addFuelFromPanel: addFuel,
    showToast,
    clearToastIf,
    rebuildInteractables,
    INTERACTABLES,
  };
})();
