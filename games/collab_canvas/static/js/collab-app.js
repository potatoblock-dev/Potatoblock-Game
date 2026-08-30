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
  const restoreCheckbox = document.getElementById('restoreLastBoard');
  const openPbccBtn = document.getElementById('openPbccBtn');
  const openPbccInput = document.getElementById('openPbccInput');
  const openPbccHint = document.getElementById('openPbccHint');

  let pendingPbccDocument = null;
  let pendingRestoreLocal = false;
  let restoreAttempted = false;

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
    setCollabRoomScrollLock(false);
    setJoinError(message || '');
    setStatus('');
    try {
      history.replaceState(null, '', '/collab-canvas');
    } catch (_err) {}
  }

  function showRoomScreen(roomId) {
    if (joinScreen) joinScreen.classList.add('hidden');
    if (roomScreen) roomScreen.classList.remove('hidden');
    setCollabRoomScrollLock(true);
    if (roomCodeEl) roomCodeEl.textContent = roomId;
    syncRoomDeepLink(roomId);
    setJoinError('');
  }

  const onlinePrefs = new OnlinePrefs();
  let session = null;
  onlinePrefs.onChange = () => {
    const displayName = onlinePrefs.resolveDisplayName(nickname);
    if (session && session.connected) {
      session.sendPlayerStyle({
        label_color: onlinePrefs.getWireLabelColor(),
        display_name: displayName
      });
    }
    if (boardController && roomPanel) {
      const list = boardController.getPlayersSnapshot().slice();
      const idx = list.findIndex(p => p.uid === boardController.selfId);
      if (idx >= 0) {
        list[idx] = Object.assign({}, list[idx], { name: displayName });
        boardController.setPlayersSnapshot(list);
        roomPanel.setPlayers(list);
      }
    }
  };

  const canvas = document.getElementById('drawCanvas');
  const stage = document.getElementById('canvasStage');
  const stageSurface = document.getElementById('canvasStageSurface');
  const cursorLayer = document.getElementById('cursorLayer');
  const zoomBadge = document.getElementById('canvasZoomBadge');

  disableCollabBrowserZoom(roomScreen);
  lockCollabPageScroll(roomScreen);
  if (roomScreen && !roomScreen.classList.contains('hidden')) {
    setCollabRoomScrollLock(true);
  }
  initUiTooltips(roomScreen);

  const uiPrefs = new UiPrefs();
  const collabWorkspaceEl = document.getElementById('collabWorkspace');
  uiPrefs.applyToWorkspace(collabWorkspaceEl);

  const canvasViewport = new CanvasViewport({
    stage,
    surface: stageSurface,
    badge: zoomBadge
  });

  const workspaceLayout = new WorkspaceLayout({
    root: document.getElementById('collabWorkspace'),
    rightDock: document.getElementById('dockRight'),
    splitter: document.getElementById('dockSplitter'),
    gutterLeft: document.getElementById('dockGutterLeft'),
    gutterRight: document.getElementById('dockGutterRight'),
    rightTop: document.getElementById('dockRightTop'),
    rightBottom: document.getElementById('dockRightBottom')
  });

  let boardController = null;
  let settingsPanel = null;
  let popupPalette = null;
  let roomPanel = null;

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
    resolveLabelColor: (playerId, wireColor) => onlinePrefs.resolveLabelColor(playerId, wireColor),
    getLogicalWidth: () => (boardController ? boardController.drawingBoard.logicalWidth : 960),
    getCanvas: () => canvas
  });

  const toolRail = new ToolRail(document.getElementById('dockLeft'), {
    initialTool: 'brush',
    onChange: toolId => {
      if (boardController) boardController.currentTool = toolId;
      if (stage) stage.dataset.tool = toolId;
    }
  });

  uiPrefs.onChange(() => {
    uiPrefs.applyToWorkspace(collabWorkspaceEl);
    toolRail.repositionOpenFlyout();
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
    onDelete: id => boardController && boardController.deleteBoard(id),
    canDeleteBoard: id => boardController && boardController.canDeleteBoard(id),
    getPlayersForBoard: boardId => {
      if (!boardController) return [];
      const target = String(boardId || 'b_default');
      return boardController.getPlayersSnapshot()
        .filter(p => p.connected && String(p.active_board_id || 'b_default') === target)
        .sort((a, b) => {
          if (a.is_host && !b.is_host) return -1;
          if (!a.is_host && b.is_host) return 1;
          return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
        });
    },
    getSelfId: () => (boardController ? boardController.selfId : '')
  });

  const layerPanel = new LayerPanel(document.getElementById('layerPanelPane'), {
    onSwitch: layerId => boardController && boardController.switchLayer(layerId),
    onCreate: () => boardController && boardController.createLayer(),
    onCreateGroup: () => boardController && boardController.createLayerGroup(),
    onDuplicate: layerId => boardController && boardController.duplicateLayer(layerId),
    onDelete: layerId => boardController && boardController.deleteLayer(layerId),
    canDeleteLayer: layerId => boardController && boardController.canDeleteLayer(layerId),
    onRename: (id, name) => boardController && boardController.renameLayer(id, name),
    onReorder: order => boardController && boardController.reorderLayers(order),
    onUpdate: (id, patch) => boardController && boardController.updateLayer(id, patch),
    getBoardState: () => (boardController ? {
      drawingBoard: boardController.drawingBoard,
      strokes: boardController.strokes
    } : null)
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
    if (boardController) {
      boardController.stopPbccAutoSave();
      if (boardController.isHost()) {
        boardController.saveLocalPbccSnapshot();
      }
    }
    session.disconnect();
    cursorOverlay.clear();
    showJoinScreen('');
  }

  /** 房主进房后尝试从 .pbcc 文件或本机记忆恢复。 */
  async function maybeRestorePbccAfterJoin(data) {
    if (restoreAttempted || !boardController) return;
    restoreAttempted = true;
    const isHost = data.self_id && data.self_id === data.owner_id;
    if (!isHost) return;
    let restoreResult = 'none';
    if (pendingPbccDocument) {
      restoreResult = await boardController.tryRestoreLocalPbcc({ document: pendingPbccDocument });
      pendingPbccDocument = null;
      if (openPbccHint) openPbccHint.textContent = '';
    } else if (pendingRestoreLocal) {
      restoreResult = await boardController.tryRestoreLocalPbcc({ fromLocal: true });
      if (restoreResult === 'none') {
        setStatus('未找到本机保存的画板');
        window.setTimeout(() => setStatus(''), 3000);
      }
    }
    boardController.schedulePbccAutoSave();
  }

  session = new CollabSession({
    selfId,
    nickname,
    getDisplayName: () => onlinePrefs.resolveDisplayName(nickname),
    handlers: {
      close: () => setStatus('连接已断开，请刷新页面'),
      error: data => {
        const msg = data.message || '发生错误';
        if (boardController) {
          boardController._clearPendingLayerCreate();
          boardController.cancelPbccRestorePending(msg);
        }
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
        session.sendPlayerStyle({
          label_color: onlinePrefs.getWireLabelColor(),
          display_name: onlinePrefs.resolveDisplayName(nickname)
        });
        if (roomPanel) roomPanel.setPlayers(data.players || []);
        if (Array.isArray(data.players)) {
          data.players.forEach(player => {
            if (player.uid === data.self_id) return;
            cursorOverlay.setPlayerStyle(player.uid, {
              label_color: player.label_color,
              nickname: player.name
            });
          });
        }
        if (boardController && boardController.finishPbccRestoreIfPending()) {
          /* 恢复成功提示已由 finishPbccRestoreIfPending 设置 */
        } else if (!boardController || !boardController._pbccRestorePending) {
          setStatus('');
        }
        const copyBtn = document.getElementById('copyLinkBtn');
        if (copyBtn) copyBtn.onclick = () => copyRoomLink();
        maybeRestorePbccAfterJoin(data);
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
      layer_duplicated: data => boardController.handleLayerDuplicated(data),
      layer_removed: data => boardController.handleLayerRemoved(data),
      layer_renamed: data => boardController.handleLayerRenamed(data),
      layer_reordered: data => boardController.handleLayerReordered(data),
      layer_updated: data => boardController.handleLayerUpdated(data),
      cursor_update: data => cursorOverlay.update(data.player_id, data),
      player_style: data => {
        cursorOverlay.setPlayerStyle(data.player_id, data);
        if (boardController && data.name) {
          const list = boardController.getPlayersSnapshot().slice();
          const idx = list.findIndex(p => p.uid === data.player_id);
          if (idx >= 0) {
            list[idx] = Object.assign({}, list[idx], { name: data.name });
            boardController.setPlayersSnapshot(list);
            if (roomPanel) roomPanel.setPlayers(list);
          }
        }
        if (boardPanel) boardPanel.refreshOccupantTree();
      },
      player_board: data => {
        if (!boardController) return;
        const list = boardController.getPlayersSnapshot().slice();
        const idx = list.findIndex(p => p.uid === data.player_id);
        if (idx >= 0) {
          list[idx] = Object.assign({}, list[idx], {
            active_board_id: data.board_id,
            name: data.name || list[idx].name
          });
        }
        boardController.setPlayersSnapshot(list);
        if (boardPanel) boardPanel.refreshOccupantTree();
      },
      player_permissions: data => {
        boardController.handlePlayerPermissions(data);
        if (roomPanel) {
          roomPanel.updatePlayerPermissions(data.player_id, {
            can_draw: data.can_draw,
            can_save: data.can_save
          });
        }
      },
      player_join: data => {
        cursorOverlay.setPlayerStyle(data.player_id, data);
        if (roomPanel) {
          const list = boardController.getPlayersSnapshot().slice();
          const idx = list.findIndex(p => p.uid === data.player_id);
          const row = {
            uid: data.player_id,
            name: data.name,
            connected: true,
            is_host: !!data.is_host,
            label_color: data.label_color || '',
            can_draw: data.can_draw !== false,
            can_save: data.can_save !== false,
            active_board_id: 'b_default'
          };
          if (idx >= 0) list[idx] = Object.assign({}, list[idx], row);
          else list.push(row);
          boardController.setPlayersSnapshot(list);
          roomPanel.setPlayers(list);
        }
        if (boardPanel) boardPanel.refreshOccupantTree();
        setStatus(`${data.name} 加入了房间`);
      },
      player_leave: data => {
        if (!data.temporary) cursorOverlay.remove(data.player_id);
        if (roomPanel) {
          const list = boardController.getPlayersSnapshot().slice();
          if (data.temporary) {
            const next = list.map(p => (
              p.uid === data.player_id ? Object.assign({}, p, { connected: false }) : p
            ));
            boardController.setPlayersSnapshot(next);
            roomPanel.setPlayers(next);
          } else {
            const next = list.filter(p => p.uid !== data.player_id);
            boardController.setPlayersSnapshot(next);
            roomPanel.setPlayers(next);
          }
        }
        if (boardPanel) boardPanel.refreshOccupantTree();
        if (data.message) setStatus(data.message);
      }
    }
  });

  const shortcutManager = new ShortcutManager({
    execute: actionId => {
      if (boardController) boardController.executeAction(actionId);
    },
    isModalOpen: () => (settingsPanel && settingsPanel.isOpen()) || (roomPanel && roomPanel.isOpen()),
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
    getDrawingBoard: () => (boardController ? boardController.drawingBoard : null),
    getBoardController: () => boardController,
    onlinePrefs,
    uiPrefs,
    session,
    getNickname: () => nickname,
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
    onlinePrefs,
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
    isModalOpen: () => (settingsPanel && settingsPanel.isOpen()) || (roomPanel && roomPanel.isOpen()),
    onColorApplied: snap => {
      boardController.currentColor = snap.foreground;
    }
  });
  boardController.popupPalette = popupPalette;

  roomPanel = new RoomPanel({
    session,
    getSelfId: () => boardController.selfId,
    getOwnerId: () => boardController.ownerId,
    onKick: targetId => session.kickPlayer(targetId),
    onSetPermissions: patch => session.sendHostPermissions(patch)
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!roomScreen || roomScreen.classList.contains('hidden')) return;
    const target = event.target;
    if (target && target.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (settingsPanel && settingsPanel.isOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    roomPanel.toggle();
  }, true);

  if (stage) {
    stage.dataset.tool = toolRail.getTool();
    if (boardController) boardController._applyToolCursor(toolRail.getTool());
  }

  boardController.setRoomActions({
    copyLink: copyRoomLink,
    leaveRoom,
    openSettings: () => settingsPanel.open(),
    setStatus
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
    pendingRestoreLocal = Boolean(restoreCheckbox && restoreCheckbox.checked);
    if (global.PbccLocalStore) {
      PbccLocalStore.setRestorePref(pendingRestoreLocal);
    }
    restoreAttempted = false;
    showRoomScreen(id);
    session.joinRoom(id);
  }

  if (restoreCheckbox && global.PbccLocalStore) {
    restoreCheckbox.checked = PbccLocalStore.getRestorePref();
    restoreCheckbox.addEventListener('change', () => {
      PbccLocalStore.setRestorePref(restoreCheckbox.checked);
    });
  }

  if (openPbccBtn && openPbccInput) {
    openPbccBtn.addEventListener('click', () => openPbccInput.click());
    openPbccInput.addEventListener('change', async () => {
      const file = openPbccInput.files && openPbccInput.files[0];
      openPbccInput.value = '';
      if (!file || !global.PbccFormat) return;
      try {
        pendingPbccDocument = await PbccFormat.readFile(file);
        if (openPbccHint) openPbccHint.textContent = file.name;
        setJoinError('');
      } catch (err) {
        pendingPbccDocument = null;
        if (openPbccHint) openPbccHint.textContent = '';
        setJoinError(err.message || '无法读取 .pbcc 文件');
      }
    });
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
    pendingRestoreLocal = Boolean(restoreCheckbox && restoreCheckbox.checked);
    restoreAttempted = false;
    showRoomScreen(pathRoom);
    session.joinRoom(pathRoom);
  }

  if (typeof createCollabFullscreen === 'function') {
    createCollabFullscreen();
  }
})();
