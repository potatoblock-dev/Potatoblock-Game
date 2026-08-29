(function () {
  'use strict';

  const boot = window.COLLAB_BOOT || {};
  const selfId = boot.userId || '';
  const nickname = boot.nickname || '';

  const joinScreen = document.getElementById('joinScreen');
  const roomScreen = document.getElementById('roomScreen');
  const roomCodeEl = document.getElementById('roomCode');
  const statusEl = document.getElementById('statusText');
  const joinErrorEl = document.getElementById('joinError');
  const roomInput = document.getElementById('roomInput');

  const RESERVED = { 'random-room': 1, ws: 1 };
  const ROOM_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,5}$/;
  const ROOM_ID_MAX_LEN = 6;

  function setJoinError(text) {
    if (joinErrorEl) joinErrorEl.textContent = text || '';
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  function roomIdFromPath() {
    const match = String(location.pathname || '').match(/^\/collab-canvas\/([^/]+)\/?$/i);
    if (!match) return '';
    let id = '';
    try {
      id = decodeURIComponent(match[1]).trim().toUpperCase();
    } catch (_err) {
      return '';
    }
    if (!id || RESERVED[id.toLowerCase()]) return '';
    if (!ROOM_ID_PATTERN.test(id)) return '';
    return id;
  }

  function roomShareUrl(roomId) {
    const id = String(roomId || '').trim();
    if (!id) return '';
    return location.origin + '/collab-canvas/' + encodeURIComponent(id);
  }

  function syncRoomDeepLink(roomId) {
    const id = String(roomId || '').trim().toUpperCase();
    if (!id) return;
    const target = '/collab-canvas/' + encodeURIComponent(id);
    if (location.pathname === target) return;
    try {
      history.replaceState(null, '', target);
    } catch (_err) {}
  }

  function showJoinScreen(message) {
    if (joinScreen) joinScreen.classList.remove('hidden');
    if (roomScreen) roomScreen.classList.add('hidden');
    setJoinError(message || '');
    setStatus('');
    try {
      history.replaceState(null, '', '/collab-canvas');
    } catch (_err) {}
  }

  function showRoomScreen(roomId) {
    if (joinScreen) joinScreen.classList.add('hidden');
    if (roomScreen) roomScreen.classList.remove('hidden');
    if (roomCodeEl) roomCodeEl.textContent = roomId;
    syncRoomDeepLink(roomId);
    setJoinError('');
  }

  function cursorColor(playerId) {
    let hash = 0;
    const text = String(playerId || '');
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return `hsl(${hash % 360} 75% 55%)`;
  }

  const canvas = document.getElementById('drawCanvas');
  const stage = document.getElementById('canvasStage');
  const stageSurface = document.getElementById('canvasStageSurface');
  const cursorLayer = document.getElementById('cursorLayer');
  const zoomBadge = document.getElementById('canvasZoomBadge');

  disableCollabBrowserZoom(roomScreen);
  initUiTooltips(roomScreen);

  const canvasViewport = new CanvasViewport({
    stage,
    surface: stageSurface,
    badge: zoomBadge
  });

  const workspaceLayout = new WorkspaceLayout({
    root: document.getElementById('collabWorkspace'),
    rightDock: document.getElementById('dockRight'),
    splitter: document.getElementById('dockSplitter'),
    rightTop: document.getElementById('dockRightTop'),
    rightBottom: document.getElementById('dockRightBottom')
  });

  let boardController = null;
  let settingsPanel = null;
  let popupPalette = null;

  const colorPair = new ColorPairState({
    onChange: snap => {
      if (boardController) boardController.currentColor = snap.foreground;
      if (popupPalette && popupPalette.isOpen()) popupPalette.refresh();
    }
  });

  const recentColors = new RecentColors({
    onChange: () => {
      if (popupPalette && popupPalette.isOpen()) popupPalette.refresh();
    }
  });

  const penInput = new PenInput({
    getBaseSize: () => (boardController ? boardController.currentSize : 8),
    onActivity: active => stage && stage.classList.toggle('stylus-ready', active)
  });

  const cursorOverlay = new CursorOverlay(cursorLayer, {
    selfId,
    colorFor: cursorColor
  });

  const toolRail = new ToolRail(document.getElementById('dockLeft'), {
    initialTool: 'brush',
    onChange: toolId => {
      if (boardController) boardController.currentTool = toolId;
      if (stage) stage.dataset.tool = toolId;
    }
  });

  const colorPicker = new ColorPicker(document.getElementById('colorPickerMount'), {
    initialColor: colorPair.foreground,
    onChange: color => {
      colorPair.setColor('fg', color);
      if (boardController) boardController.currentColor = color;
    },
    onCommit: color => {
      recentColors.push(color);
    },
    onModeChange: () => {
      if (popupPalette && popupPalette.isOpen()) popupPalette.refresh();
    }
  });

  SettingsPanel.fillModeOptions(document.getElementById('settingsColorMode'));

  const boardPanel = new BoardPanel(document.getElementById('boardPanelPane'), {
    onSwitch: boardId => boardController && boardController.switchBoard(boardId),
    onCreate: () => boardController && boardController.createBoard(),
    onRename: (id, title) => boardController && boardController.renameBoard(id, title),
    onDelete: id => boardController && boardController.deleteBoard(id)
  });

  const layerPanel = new LayerPanel(document.getElementById('layerPanelPane'), {
    onSwitch: layerId => boardController && boardController.switchLayer(layerId),
    onCreate: () => boardController && boardController.createLayer(),
    onDelete: layerId => boardController && boardController.deleteLayer(layerId),
    onRename: (id, name) => boardController && boardController.renameLayer(id, name),
    onReorder: order => boardController && boardController.reorderLayers(order),
    onUpdate: (id, patch) => boardController && boardController.updateLayer(id, patch)
  });

  workspaceLayout.registry.register({ id: 'colorPicker', title: '调色', slot: 'rightTop', mountNode: document.getElementById('colorPickerMount') });
  workspaceLayout.registry.register({ id: 'layerPanel', title: '图层', slot: 'rightBottom', mountNode: document.getElementById('layerPanelPane') });
  workspaceLayout.registry.register({ id: 'boardPanel', title: '画板', slot: 'rightBottom', mountNode: document.getElementById('boardPanelPane') });

  function copyRoomLink() {
    const roomId = session.roomId || (roomCodeEl && roomCodeEl.textContent);
    const link = roomShareUrl(roomId);
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => setStatus('链接已复制'));
  }

  function leaveRoom() {
    session.disconnect();
    cursorOverlay.clear();
    showJoinScreen('');
  }

  const session = new CollabSession({
    selfId,
    nickname,
    handlers: {
      close: () => setStatus('连接已断开，请刷新页面'),
      error: data => {
        const msg = data.message || '发生错误';
        if (roomScreen && roomScreen.classList.contains('hidden')) {
          setJoinError(msg);
        } else {
          setStatus(msg);
        }
      },
      room_removed: data => {
        session.disconnect();
        cursorOverlay.clear();
        showJoinScreen(data.message || '已离开房间');
      },
      room_state: data => {
        showRoomScreen(data.room_id);
        boardController.setSelfId(data.self_id);
        cursorOverlay.setSelfId(data.self_id);
        boardController.handleRoomState(data);
        setStatus('');
        const copyBtn = document.getElementById('copyLinkBtn');
        if (copyBtn) copyBtn.onclick = () => copyRoomLink();
      },
      drawing_sync: data => boardController.handleDrawingSync(data),
      draw: data => boardController.handleDrawMessage(data),
      draw_batch: data => boardController.handleDrawBatch(data),
      stroke_visibility: data => boardController.handleStrokeVisibility(data),
      clear: data => boardController.handleClear(data),
      board_added: data => boardController.handleBoardAdded(data),
      board_removed: data => boardController.handleBoardRemoved(data),
      board_renamed: data => boardController.handleBoardRenamed(data),
      layer_added: data => boardController.handleLayerAdded(data),
      layer_removed: data => boardController.handleLayerRemoved(data),
      layer_renamed: data => boardController.handleLayerRenamed(data),
      layer_reordered: data => boardController.handleLayerReordered(data),
      layer_updated: data => boardController.handleLayerUpdated(data),
      cursor_update: data => cursorOverlay.update(data.player_id, data),
      player_join: data => setStatus(`${data.name} 加入了房间`),
      player_leave: data => {
        if (!data.temporary) cursorOverlay.remove(data.player_id);
        if (data.message) setStatus(data.message);
      }
    }
  });

  const shortcutManager = new ShortcutManager({
    execute: actionId => {
      if (boardController) boardController.executeAction(actionId);
    },
    isModalOpen: () => settingsPanel && settingsPanel.isOpen(),
    isPopupOpen: () => popupPalette && popupPalette.isOpen(),
    isRoomActive: () => roomScreen && !roomScreen.classList.contains('hidden')
  });

  const networkMonitor = new NetworkMonitor({
    session,
    root: document.querySelector('[data-settings-pane="network"]')
  });

  settingsPanel = new SettingsPanel({
    colorPicker,
    penInput,
    viewport: canvasViewport,
    shortcutManager,
    networkMonitor,
    recentColors,
    getBrushSize: () => (boardController ? boardController.currentSize : 8),
    getBrushColor: () => (colorPair ? colorPair.foreground : '#111827'),
    onOpen: () => {
      const exportPanel = document.getElementById('exportMenuPanel');
      if (exportPanel) exportPanel.classList.add('hidden');
      if (popupPalette) popupPalette.close();
    }
  });

  boardController = new CollabBoardController({
    canvas,
    stage,
    viewport: canvasViewport,
    session,
    cursorOverlay,
    boardPanel,
    layerPanel,
    toolRail,
    colorPicker,
    colorPair,
    penInput,
    recentColors,
    selfId,
    onRoomChange: () => {}
  });

  popupPalette = new PopupPalette({
    colorPicker,
    toolRail,
    colorPair,
    recentColors,
    isDrawing: () => boardController && boardController.isDrawing,
    isPanning: () => canvasViewport.isPanning(),
    isModalOpen: () => settingsPanel && settingsPanel.isOpen(),
    onColorApplied: snap => {
      boardController.currentColor = snap.foreground;
    }
  });
  boardController.popupPalette = popupPalette;

  if (stage) stage.dataset.tool = toolRail.getTool();

  boardController.setRoomActions({
    copyLink: copyRoomLink,
    leaveRoom,
    openSettings: () => settingsPanel.open()
  });

  function enterRoom(roomId) {
    const id = String(roomId || '').trim().toUpperCase().slice(0, ROOM_ID_MAX_LEN);
    if (!id) {
      setJoinError('请输入房间号');
      return;
    }
    if (!ROOM_ID_PATTERN.test(id)) {
      setJoinError('房间号须为 2–6 位字母或数字');
      return;
    }
    setJoinError('');
    showRoomScreen(id);
    session.joinRoom(id);
  }

  document.getElementById('joinBtn').addEventListener('click', () => {
    enterRoom(roomInput.value);
  });

  document.getElementById('randomRoomBtn').addEventListener('click', async () => {
    try {
      const response = await fetch('/collab-canvas/random-room', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('获取随机房间号失败');
      const data = await response.json();
      if (data.room_id) roomInput.value = data.room_id;
    } catch (err) {
      setJoinError(err.message || '获取随机房间号失败');
    }
  });

  document.getElementById('leaveRoomBtn').addEventListener('click', () => leaveRoom());

  roomInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') enterRoom(roomInput.value);
  });

  const pathRoom = roomIdFromPath() || (boot.initialRoom || '').trim().toUpperCase();
  if (pathRoom && roomInput) roomInput.value = pathRoom;

  if (pathRoom) {
    showRoomScreen(pathRoom);
    session.joinRoom(pathRoom);
  }
})();
