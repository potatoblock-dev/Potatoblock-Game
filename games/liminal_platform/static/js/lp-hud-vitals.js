/**
 * 左上生命/压力 HUD：本机 + 队友条、皮套头像裁剪。
 * 桌面：昵称常显，HP/压力数字仅悬停显示；触屏：点按行切换数字显隐。
 * 队友 HP/压力来自 pose 透传字段（_lpHp / _lpPressure）；缺省时条为空态。
 */
(() => {
  const HEAD_SIZE = 36;
  const TEAMMATE_HEAD = 36;
  const MAX_TEAMMATES = 8;

  let rootEl = null;
  let selfRow = null;
  let teammatesEl = null;
  let valuesVisibleTouch = false;
  let lastHeadKeys = new Map();

  /** 是否粗指针 / 无悬停（触屏）。 */
  function isTouchUi() {
    return (
      typeof matchMedia === 'function' &&
      matchMedia('(hover: none), (pointer: coarse)').matches
    );
  }

  /** 确保 vitals 容器存在（替换旧单条 HP 结构）。 */
  function ensureDom() {
    if (rootEl && rootEl.isConnected) return rootEl;
    const titleBlock = document.querySelector('.lp-title-block');
    if (!titleBlock) return null;

    let existing = document.getElementById('lpVitals');
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'lpVitals';
      existing.className = 'lp-vitals';
      existing.setAttribute('aria-label', '生命与压力');
      const oldHp = document.getElementById('lpHpBar');
      if (oldHp) oldHp.remove();
      titleBlock.appendChild(existing);
    }
    rootEl = existing;

    if (!rootEl.querySelector('[data-vital="self"]')) {
      rootEl.innerHTML = `
        <div class="lp-vital-row lp-vital-row--self" data-vital="self" tabindex="0">
          <canvas class="lp-vital-head" width="${HEAD_SIZE}" height="${HEAD_SIZE}" aria-hidden="true"></canvas>
          <div class="lp-vital-cols">
            <div class="lp-vital-name" data-role="name"></div>
            <div class="lp-hp-bar" id="lpHpBar" aria-label="生命值">
              <span class="lp-hp-fill" id="lpHpFill"></span>
              <span class="lp-hp-label" id="lpHpLabel">100</span>
            </div>
            <div class="lp-pressure-bar" id="lpPressureBar" aria-label="压力">
              <span class="lp-pressure-fill" id="lpPressureFill"></span>
              <span class="lp-pressure-label" id="lpPressureLabel">0</span>
            </div>
          </div>
        </div>
        <div class="lp-vitals-teammates" id="lpVitalsTeammates"></div>
      `;
    }
    selfRow = rootEl.querySelector('[data-vital="self"]');
    teammatesEl = rootEl.querySelector('#lpVitalsTeammates');
    bindTouchToggle(rootEl);
    return rootEl;
  }

  /** 触屏：点按 vitals 行切换数值显隐。 */
  function bindTouchToggle(root) {
    if (root.dataset.lpVitalsBound) return;
    root.dataset.lpVitalsBound = '1';
    root.addEventListener(
      'pointerup',
      (event) => {
        if (!isTouchUi()) return;
        const row = event.target?.closest?.('.lp-vital-row');
        if (!row || !root.contains(row)) return;
        valuesVisibleTouch = !valuesVisibleTouch;
        root.classList.toggle('is-values-on', valuesVisibleTouch);
      },
      { passive: true }
    );
  }

  /**
   * 从实体皮套图集裁剪头部到 canvas（圆形裁切）；无图则剪影。
   * @param {HTMLCanvasElement} canvas
   * @param {object|null} entity
   */
  function paintHead(canvas, entity) {
    if (!canvas) return;
    const size = canvas.width || HEAD_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2);
    ctx.clip();

    const atlas = entity?.uvAtlas;
    const texture = entity?.texture;
    if (atlas && window.UVLayout?.resolveParts) {
      const parts = window.UVLayout.resolveParts(atlas);
      const rect = parts?.head?.rect || [0, 0, atlas.width, atlas.height];
      const [sx, sy, sw, sh] = rect;
      const zoom = 1.12;
      const scale = Math.max(size / sw, size / sh) * zoom;
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(atlas, sx, sy, sw, sh, (size - dw) / 2, (size - dh) / 2, dw, dh);
    } else if (texture) {
      const tw = texture.width || 1;
      const th = texture.height || 1;
      const crop = Math.min(tw, th) * 0.42;
      const cx = (tw - crop) / 2;
      const cy = th * 0.06;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(texture, cx, cy, crop, crop, 0, 0, size, size);
    } else {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#64748b';
      ctx.beginPath();
      ctx.arc(size / 2, size * 0.4, size * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(size / 2, size * 0.78, size * 0.28, size * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(248,250,252,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * 仅在 appearanceKey 变化时重绘头像。
   * @param {HTMLCanvasElement} canvas
   * @param {object|null} entity
   * @param {string} cacheKey
   */
  function paintHeadIfNeeded(canvas, entity, cacheKey) {
    const key = `${cacheKey}:${entity?.appearanceKey || ''}:${entity?.uvAtlas ? 'uv' : entity?.texture ? 'tex' : 'none'}`;
    if (lastHeadKeys.get(canvas) === key) return;
    lastHeadKeys.set(canvas, key);
    paintHead(canvas, entity);
  }

  /** 刷新本机昵称 / 头像 / 压力条（HP 仍可由 syncHp 写）。 */
  function syncSelf() {
    ensureDom();
    if (!selfRow) return;
    const avatar = window.LpGame?.getLocalAvatar?.();
    const name = selfRow.querySelector('[data-role="name"]');
    if (name) {
      name.textContent =
        avatar?.nickname ||
        document.body?.dataset?.nickname ||
        '旅人';
    }
    const head = selfRow.querySelector('.lp-vital-head');
    paintHeadIfNeeded(head, avatar, 'self');

    const p = window.LpPressure?.getPressure?.() ?? 0;
    const maxP = window.LpPressure?.getEffectiveMax?.() ?? 200;
    syncPressureBar(p, maxP);
  }

  /**
   * 更新本机压力条填充（渐变按满条宽度固定，避免 scale 拉伸色带）。
   * @param {number} value
   * @param {number} maxP
   */
  function syncPressureBar(value, maxP) {
    ensureDom();
    const fill = document.getElementById('lpPressureFill');
    const label = document.getElementById('lpPressureLabel');
    const bar = document.getElementById('lpPressureBar');
    const max = Math.max(1, Number(maxP) || 200);
    const pct = Math.max(0, Math.min(1, (Number(value) || 0) / max));
    if (fill && bar) {
      const fullW = bar.clientWidth || 160;
      fill.style.width = `${pct * 100}%`;
      fill.style.backgroundSize = `${fullW}px 100%`;
    }
    if (label) label.textContent = `${Math.round(Number(value) || 0)}`;
  }

  /**
   * 供 LpPressure / LpGame 调用的本机压力 HUD 同步。
   * @param {number} value
   * @param {number} maxP
   */
  function syncLocalPressure(value, maxP) {
    syncPressureBar(value, maxP);
  }

  /**
   * 刷新本机 HP 条（替代 liminal-platform 内联实现）。
   * @param {number} hp
   * @param {number} maxHp
   */
  function syncHp(hp, maxHp) {
    ensureDom();
    const bar = document.getElementById('lpHpBar');
    const fill = document.getElementById('lpHpFill');
    const label = document.getElementById('lpHpLabel');
    if (bar) bar.classList.remove('is-downed-countdown');
    const max = Math.max(1, Number(maxHp) || 100);
    const pct = Math.max(0, Math.min(1, (Number(hp) || 0) / max));
    if (fill) {
      fill.style.transform = `scaleX(${pct})`;
      fill.style.background = '';
    }
    if (label) label.textContent = `${Math.round(Number(hp) || 0)}`;
    syncSelf();
  }

  /**
   * 濒死：HP 条改白色倒计时填充（remain/duration）。
   * @param {number} remain
   * @param {number} duration
   */
  function syncDownedCountdown(remain, duration) {
    ensureDom();
    const bar = document.getElementById('lpHpBar');
    const fill = document.getElementById('lpHpFill');
    const label = document.getElementById('lpHpLabel');
    const dur = Math.max(0.001, Number(duration) || 10);
    const rem = Math.max(0, Number(remain) || 0);
    const pct = Math.max(0, Math.min(1, rem / dur));
    if (bar) bar.classList.add('is-downed-countdown');
    if (fill) {
      fill.style.transform = `scaleX(${pct})`;
      fill.style.background = '#f8fafc';
    }
    if (label) label.textContent = `${Math.ceil(rem)}`;
  }

  /** 清除濒死倒计时样式（恢复普通 HP 条外观）。 */
  function clearDownedCountdown() {
    ensureDom();
    const bar = document.getElementById('lpHpBar');
    const fill = document.getElementById('lpHpFill');
    if (bar) bar.classList.remove('is-downed-countdown');
    if (fill) fill.style.background = '';
  }

  /**
   * 构建或更新一名队友行。
   * @param {HTMLElement} row
   * @param {{ id: string, nickname: string, entity: object, hp: number|null, maxHp: number, pressure: number|null, maxPressure: number, lifeState?: string, downedRemain?: number|null, downedDuration?: number|null }} data
   */
  function fillTeammateRow(row, data) {
    row.dataset.playerId = data.id;
    const name = row.querySelector('[data-role="name"]');
    if (name) name.textContent = data.nickname || '旅人';
    const head = row.querySelector('.lp-vital-head');
    paintHeadIfNeeded(head, data.entity, data.id);

    const hpFill = row.querySelector('[data-role="hp-fill"]');
    const hpLabel = row.querySelector('[data-role="hp-label"]');
    const hpBar = row.querySelector('.lp-hp-bar');
    const prFill = row.querySelector('[data-role="pr-fill"]');
    const prLabel = row.querySelector('[data-role="pr-label"]');
    const prBar = row.querySelector('.lp-pressure-bar');

    const downed = data.lifeState === 'downed';
    if (hpBar) hpBar.classList.toggle('is-downed-countdown', downed);

    if (downed) {
      row.classList.remove('is-hp-unknown');
      const dur = Math.max(
        0.001,
        Number(data.downedDuration) ||
          Number(data.entity?._lpDownedDuration) ||
          10
      );
      const rem = Math.max(0, Number(data.downedRemain) || 0);
      const pct = Math.max(0, Math.min(1, rem / dur));
      if (hpFill) {
        hpFill.style.transform = `scaleX(${pct})`;
        hpFill.style.background = '#f8fafc';
      }
      if (hpLabel) hpLabel.textContent = `${Math.ceil(rem)}`;
    } else if (data.hp == null || !Number.isFinite(data.hp)) {
      row.classList.add('is-hp-unknown');
      if (hpFill) {
        hpFill.style.transform = 'scaleX(0)';
        hpFill.style.background = '';
      }
      if (hpLabel) hpLabel.textContent = '···';
    } else {
      row.classList.remove('is-hp-unknown');
      const pct = Math.max(0, Math.min(1, data.hp / Math.max(1, data.maxHp)));
      if (hpFill) {
        hpFill.style.transform = `scaleX(${pct})`;
        hpFill.style.background = '';
      }
      if (hpLabel) hpLabel.textContent = `${Math.round(data.hp)}`;
    }

    if (data.pressure == null || !Number.isFinite(data.pressure)) {
      row.classList.add('is-pressure-unknown');
      if (prFill) prFill.style.width = '0%';
      if (prLabel) prLabel.textContent = '···';
    } else {
      row.classList.remove('is-pressure-unknown');
      const maxPr = Math.max(1, Number(data.maxPressure) || 200);
      const pct = Math.max(0, Math.min(1, data.pressure / maxPr));
      if (prFill && prBar) {
        const fullW = prBar.clientWidth || 120;
        prFill.style.width = `${pct * 100}%`;
        prFill.style.backgroundSize = `${fullW}px 100%`;
      }
      if (prLabel) prLabel.textContent = `${Math.round(data.pressure)}`;
    }
  }

  /** 创建队友行 DOM。 */
  function createTeammateRow() {
    const row = document.createElement('div');
    row.className = 'lp-vital-row lp-vital-row--mate';
    row.tabIndex = 0;
    row.innerHTML = `
      <canvas class="lp-vital-head" width="${TEAMMATE_HEAD}" height="${TEAMMATE_HEAD}" aria-hidden="true"></canvas>
      <div class="lp-vital-cols">
        <div class="lp-vital-name" data-role="name"></div>
        <div class="lp-hp-bar lp-hp-bar--mate" aria-label="生命值">
          <span class="lp-hp-fill" data-role="hp-fill"></span>
          <span class="lp-hp-label" data-role="hp-label">···</span>
        </div>
        <div class="lp-pressure-bar lp-pressure-bar--mate" aria-label="压力">
          <span class="lp-pressure-fill" data-role="pr-fill"></span>
          <span class="lp-pressure-label" data-role="pr-label">···</span>
        </div>
      </div>
    `;
    return row;
  }

  /** 根据远端 Map 刷新队友条。 */
  function syncTeammates() {
    ensureDom();
    if (!teammatesEl) return;
    const remotes = window.LiminalSession?.remotes?.();
    const list = [];
    if (remotes) {
      for (const [id, ent] of remotes) {
        if (!ent || ent._lpDisconnected) continue;
        list.push({
          id: String(id),
          nickname: ent.nickname || '旅人',
          entity: ent,
          hp: ent._lpHp != null && Number.isFinite(ent._lpHp) ? Number(ent._lpHp) : null,
          maxHp: ent._lpMaxHp != null ? Number(ent._lpMaxHp) : 100,
          pressure:
            ent._lpPressure != null && Number.isFinite(ent._lpPressure)
              ? Number(ent._lpPressure)
              : null,
          maxPressure:
            ent._lpPressureMax != null ? Number(ent._lpPressureMax) : 200,
          lifeState: ent._lpLifeState || 'alive',
          downedRemain:
            ent._lpDownedRemain != null && Number.isFinite(ent._lpDownedRemain)
              ? Number(ent._lpDownedRemain)
              : null,
          downedDuration:
            ent._lpDownedDuration != null && Number.isFinite(ent._lpDownedDuration)
              ? Number(ent._lpDownedDuration)
              : null,
        });
      }
    }
    list.sort((a, b) => a.nickname.localeCompare(b.nickname, 'zh'));
    const shown = list.slice(0, MAX_TEAMMATES);

    while (teammatesEl.children.length > shown.length) {
      teammatesEl.removeChild(teammatesEl.lastChild);
    }
    for (let i = 0; i < shown.length; i += 1) {
      let row = teammatesEl.children[i];
      if (!row) {
        row = createTeammateRow();
        teammatesEl.appendChild(row);
      }
      fillTeammateRow(row, shown[i]);
    }
  }

  /** 每帧轻量刷新（头像加载晚到 / 远端进出）。 */
  function tick() {
    ensureDom();
    syncSelf();
    syncTeammates();
  }

  window.LpHudVitals = {
    ensureDom,
    syncHp,
    syncDownedCountdown,
    clearDownedCountdown,
    syncLocalPressure,
    syncTeammates,
    syncSelf,
    tick,
    paintHead,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ensureDom());
  } else {
    ensureDom();
  }
})();
