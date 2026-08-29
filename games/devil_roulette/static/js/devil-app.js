(function () {
  'use strict';

  const SPRITE_BASE = '/static/games/devil-roulette/sprites';
  const ITEM_LABELS = {
    auto: '自动击锤',
    split: '子弹分裂器',
    detector: '检测器',
    accelerater: '加速环',
  };
  /** split 图标在 gun 图集第 5 帧（灰色方块）。 */
  const SPLIT_GUN_FRAME_INDEX = 4;

  const selfId = window.__DEVIL_ROULETTE_USER_ID || '';
  const nickname = window.__DEVIL_ROULETTE_NICKNAME || '玩家';
  const initialRoom = window.__DEVIL_ROULETTE_INITIAL_ROOM || '';

  let phase = 'join';
  let roomId = '';
  let isHost = false;
  let gameState = null;
  let addAtlas = null;
  let gunAtlas = null;
  let gunRenderer = null;

  const els = {
    joinScreen: document.getElementById('joinScreen'),
    lobbyScreen: document.getElementById('lobbyScreen'),
    gameScreen: document.getElementById('gameScreen'),
    roomInput: document.getElementById('roomInput'),
    joinBtn: document.getElementById('joinBtn'),
    randomRoomBtn: document.getElementById('randomRoomBtn'),
    joinError: document.getElementById('joinError'),
    roomCode: document.getElementById('roomCode'),
    playerList: document.getElementById('playerList'),
    startBtn: document.getElementById('startBtn'),
    leaveBtn: document.getElementById('leaveBtn'),
    copyLinkBtn: document.getElementById('copyLinkBtn'),
    statusText: document.getElementById('gameStatusText'),
    gunCanvas: document.getElementById('gunCanvas'),
    hpPanel: document.getElementById('hpPanel'),
    chamberInfo: document.getElementById('chamberInfo'),
    turnInfo: document.getElementById('turnInfo'),
    itemBar: document.getElementById('itemBar'),
    shootPanel: document.getElementById('shootPanel'),
    detectorToast: document.getElementById('detectorToast'),
    gameOverBanner: document.getElementById('gameOverBanner'),
  };

  const session = new DevilSession({
    selfId,
    nickname,
    handlers: {
      open: () => { els.joinError.textContent = ''; },
      close: () => { setStatus('连接已断开'); },
      room_state: onRoomState,
      game_state: onGameState,
      player_join: () => setStatus('有玩家加入'),
      player_leave: data => setStatus(data.message || '玩家离开'),
      turn_changed: data => setTurn(data.current_turn),
      shot_fired: onShotFired,
      reload: data => setStatus(`重新装填：实弹 ${data.chamber_live} / 空弹 ${data.chamber_blank}`),
      detector_result: data => showDetector(data.bullet),
      player_eliminated: data => setStatus(`${data.name} 出局了`),
      game_over: onGameOver,
      error: data => setStatus(data.message || '出错'),
      room_removed: data => {
        setStatus(data.message);
        showJoin();
      },
    },
  });

  /** 初始化贴图与 UI 事件。 */
  async function init() {
    addAtlas = await new SpriteAtlas(SPRITE_BASE).load('add.json');
    gunAtlas = await new SpriteAtlas(SPRITE_BASE).load('gun.json');
    gunRenderer = new GunRenderer(els.gunCanvas, gunAtlas);
    gunRenderer.drawIdle();

    els.joinBtn.addEventListener('click', () => joinFromInput());
    els.randomRoomBtn.addEventListener('click', fetchRandomRoom);
    els.startBtn.addEventListener('click', () => session.startGame());
    els.leaveBtn.addEventListener('click', () => { session.leaveRoom(); showJoin(); });
    els.copyLinkBtn.addEventListener('click', copyRoomLink);
    els.roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinFromInput(); });

    if (initialRoom) {
      joinRoom(initialRoom);
    }
  }

  function joinFromInput() {
    const room = els.roomInput.value.trim();
    if (!room) { els.joinError.textContent = '请输入房间号'; return; }
    joinRoom(room);
  }

  function joinRoom(room) {
    roomId = room;
    session.connect();
    session.joinRoom(room, nickname);
  }

  async function fetchRandomRoom() {
    try {
      const res = await fetch('/devil-roulette/random-room');
      const data = await res.json();
      els.roomInput.value = data.room_id;
      joinRoom(data.room_id);
    } catch (_e) {
      els.joinError.textContent = '随机加入失败';
    }
  }

  function onRoomState(data) {
    roomId = data.room_id;
    isHost = data.owner_id === selfId;
    phase = data.phase || 'lobby';
    els.roomCode.textContent = roomId;
    renderPlayerList(data.players || []);
    if (phase === 'lobby') {
      showLobby();
      els.startBtn.classList.toggle('hidden', !isHost);
      setStatus(isHost ? '你是房主，等人齐后开始' : '等待房主开始');
    } else {
      showGame();
      if (data.game) onGameState({ game: data.game });
    }
  }

  function onGameState(data) {
    gameState = data.game;
    if (!gameState) return;
    renderHpPanel();
    renderChamber();
    renderItems();
    renderShootButtons();
    setTurn(gameState.current_turn);
  }

  async function onShotFired(data) {
    if (gunRenderer) await gunRenderer.playShot(data.animation);
    const shooter = data.shooter === selfId ? '你' : '对手';
    const bullet = data.bullet === 'live' ? '实弹' : '空弹';
    setStatus(`${shooter} 开火：${bullet}，伤害 ${data.damage}`);
  }

  function onGameOver(data) {
    const names = (data.winner_names || []).join('、') || '无人';
    els.gameOverBanner.textContent = `游戏结束！胜者：${names}`;
    els.gameOverBanner.classList.remove('hidden');
    setStatus('对局结束');
  }

  function showDetector(bullet) {
    const text = bullet === 'live' ? '实弹' : '空弹';
    els.detectorToast.textContent = `检测器：下一发是 ${text}`;
    els.detectorToast.classList.remove('hidden');
    window.setTimeout(() => els.detectorToast.classList.add('hidden'), 3000);
  }

  function renderPlayerList(players) {
    els.playerList.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      li.textContent = `${p.name}${p.is_host ? '（房主）' : ''}${p.connected ? '' : ' [离线]'}`;
      if (p.uid === selfId) li.classList.add('is-self');
      els.playerList.appendChild(li);
    });
  }

  function renderHpPanel() {
    els.hpPanel.innerHTML = '';
    (gameState.players || []).forEach(p => {
      const row = document.createElement('div');
      row.className = 'hp-row' + (p.uid === selfId ? ' is-self' : '');
      const name = document.createElement('span');
      name.className = 'hp-name';
      name.textContent = p.name;
      const candles = document.createElement('span');
      candles.className = 'hp-candles';
      for (let i = 0; i < 4; i += 1) {
        const c = document.createElement('span');
        c.className = 'candle' + (i < p.hp ? ' lit' : '');
        candles.appendChild(c);
      }
      row.append(name, candles);
      if (!p.alive) row.classList.add('eliminated');
      els.hpPanel.appendChild(row);
    });
  }

  function renderChamber() {
    els.chamberInfo.textContent = `实弹 ${gameState.chamber_live} · 空弹 ${gameState.chamber_blank} · 第 ${gameState.round_number} 轮`;
  }

  function renderItems() {
    els.itemBar.innerHTML = '';
    const me = (gameState.players || []).find(p => p.uid === selfId);
    if (!me || !me.inventory) return;
    const isMyTurn = gameState.current_turn === selfId && gameState.phase === 'playing';
    me.inventory.forEach(itemId => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item-btn';
      btn.disabled = !isMyTurn;
      btn.title = ITEM_LABELS[itemId] || itemId;
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (itemId === 'split') {
        addAtlas.drawFrameByIndex(ctx, SPLIT_GUN_FRAME_INDEX, 32, 8, 2.5, gunAtlas);
      } else {
        addAtlas.drawFrame(ctx, itemId, 0, 0, 0.5);
      }
      btn.appendChild(canvas);
      btn.addEventListener('click', () => session.useItem(itemId));
      els.itemBar.appendChild(btn);
    });
  }

  function renderShootButtons() {
    els.shootPanel.innerHTML = '';
    const isMyTurn = gameState.current_turn === selfId && gameState.phase === 'playing';
    const selfBtn = document.createElement('button');
    selfBtn.type = 'button';
    selfBtn.className = 'shoot-btn self';
    selfBtn.textContent = '射自己';
    selfBtn.disabled = !isMyTurn;
    selfBtn.addEventListener('click', () => session.shoot('self'));
    els.shootPanel.appendChild(selfBtn);

    (gameState.players || []).forEach(p => {
      if (p.uid === selfId || !p.alive) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shoot-btn';
      btn.textContent = `射 ${p.name}`;
      btn.disabled = !isMyTurn;
      btn.addEventListener('click', () => session.shoot(p.uid));
      els.shootPanel.appendChild(btn);
    });
  }

  function setTurn(currentTurn) {
    if (!currentTurn) return;
    const me = (gameState?.players || []).find(p => p.uid === currentTurn);
    const label = currentTurn === selfId ? '轮到你了' : `轮到 ${me?.name || '玩家'}`;
    els.turnInfo.textContent = label;
  }

  function setStatus(text) {
    els.statusText.textContent = text;
  }

  function showJoin() {
    els.joinScreen.classList.remove('hidden');
    els.lobbyScreen.classList.add('hidden');
    els.gameScreen.classList.add('hidden');
    phase = 'join';
  }

  function showLobby() {
    els.joinScreen.classList.add('hidden');
    els.lobbyScreen.classList.remove('hidden');
    els.gameScreen.classList.add('hidden');
  }

  function showGame() {
    els.joinScreen.classList.add('hidden');
    els.lobbyScreen.classList.add('hidden');
    els.gameScreen.classList.remove('hidden');
    els.gameOverBanner.classList.add('hidden');
  }

  async function copyRoomLink() {
    const url = `${location.origin}/devil-roulette/${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setStatus('链接已复制');
    } catch (_e) {
      setStatus(url);
    }
  }

  init();
})();
