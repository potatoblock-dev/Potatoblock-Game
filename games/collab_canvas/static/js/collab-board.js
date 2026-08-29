(function (global) {
  'use strict';

  const BRUSH_MIN = 1;
  const BRUSH_MAX = 64;
  const PALETTE = [
    '#111827', '#ef4444', '#f97316', '#eab308', '#22c55e',
    '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff'
  ];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const BRUSH_TOOLS = new Set(['brush', 'eraser']);

  /** 画板绘制生命周期：本地优先 + 联机同步。 */
  class CollabBoardController {
    constructor(options) {
      const settings = options || {};
      this.canvas = settings.canvas;
      this.stage = settings.stage;
      this.viewport = settings.viewport;
      this.session = settings.session;
      this.cursorOverlay = settings.cursorOverlay;
      this.boardPanel = settings.boardPanel;
      this.layerPanel = settings.layerPanel;
      this.toolRail = settings.toolRail;
      this.colorPicker = settings.colorPicker;
      this.colorPair = settings.colorPair || null;
      this.popupPalette = settings.popupPalette || null;
      this.recentColors = settings.recentColors || null;
      this.penInput = settings.penInput;
      this.onlinePrefs = settings.onlinePrefs || null;
      this.onRoomChange = settings.onRoomChange || (() => {});

      this.drawingBoard = new DrawingBoard(this.canvas, { width: 960, height: 540 });
      this.adapter = new CollabBoardAdapter({
        send: payload => this.session.send(payload),
        getBoardId: () => this.activeBoardId,
        getLayerId: () => this.activeLayerId
      });

      this.selfId = settings.selfId || '';
      this.strokes = [];
      this.layersMeta = [];
      this.activeBoardId = 'b_default';
      this.activeLayerId = 'l_default';
      this.boardsMeta = [];
      this.boardOrder = [];
      this.ownerId = '';
      this.canDraw = true;
      this.canSave = true;
      this.isDrawing = false;
      this.activeStrokeId = '';
      this.activeStrokeTool = null;
      this.lastPoint = null;
      this.activeDrawPointerId = null;
      this.currentTool = 'brush';
      this.currentColor = this.colorPair ? this.colorPair.foreground : '#111827';
      this.currentSize = 8;
      this.wandTolerance = 20;
      this.exportRegistry = new CollabExportRegistry();
      this._exportBusy = false;
      this._roomActions = settings.roomActions || {};
      this._spaceToolPrev = null;
      this._handPanning = false;
      this._handLast = null;

      this.toolController = new ToolController();
      this.toolController.attachBoard(this);
      this.canvasOverlay = new CanvasOverlay(null, this.drawingBoard);
      if (this.stage) {
        const surface = this.stage.querySelector('.canvas-stage-surface') || document.getElementById('canvasStageSurface');
        if (surface) this.canvasOverlay.attachToSurface(surface);
      }
      this.selectionManager = new SelectionManager(this, this.canvasOverlay);
      if (typeof registerCollabTools === 'function') {
        registerCollabTools(this.toolController, this);
      }

      const cursorLayer = document.getElementById('cursorLayer');
      this.brushPreview = new BrushPreview(cursorLayer, {
        getCanvas: () => this.canvas,
        getLogicalWidth: () => this.drawingBoard.logicalWidth,
        getBrushSize: () => this.currentSize,
        getTool: () => this.currentTool,
        isVisible: () => !this.isDrawing || BRUSH_TOOLS.has(this.currentTool)
      });

      const stageSurface = this.stage && (
        this.stage.querySelector('.canvas-stage-surface') || document.getElementById('canvasStageSurface')
      );
      this.canvasWatermark = stageSurface ? new CanvasWatermark(stageSurface, {
        getText: () => {
          const room = this.session && this.session.roomId ? this.session.roomId : '';
          return (room ? room + ' · ' : '') + '预览 · 禁止保存';
        }
      }) : null;

      this._bindPointer();
      this._bindToolbar();
      this._bindVisibility();
      this._bindStageResize();
      this._bindToolKeys();
    }

    /** 舞台尺寸变化时重新 fit，保证视口灰色 letterbox 正确。 */
    _bindStageResize() {
      this._refitCanvas = () => {
        if (this.stage) this.drawingBoard.fitToStage(this.stage);
        this._refreshBrushSizePreview();
      };
      window.addEventListener('resize', this._refitCanvas);
      if (this.stage && typeof ResizeObserver !== 'undefined') {
        this._stageResizeObserver = new ResizeObserver(() => this._refitCanvas());
        this._stageResizeObserver.observe(this.stage);
      }
    }

    setSelfId(id) {
      this.selfId = String(id || '');
      if (this.cursorOverlay) this.cursorOverlay.setSelfId(this.selfId);
    }

    _redraw() {
      this.drawingBoard.redraw(this.strokes, this.layersMeta);
    }

    _activeLayerLocked() {
      const layer = this.layersMeta.find(l => l.layer_id === this.activeLayerId);
      return Boolean(layer && layer.locked);
    }

    /** 设置房间级动作回调（复制链接、离开、打开设置）。 */
    setRoomActions(handlers) {
      this._roomActions = handlers || {};
    }

    /** 快捷键 / 按钮统一动作入口。 */
    executeAction(actionId) {
      const id = String(actionId || '');
      switch (id) {
        case 'undo':
          if (!this.canDraw) return;
          this.adapter.sendHistoryAction('undo');
          return;
        case 'redo':
          if (!this.canDraw) return;
          this.adapter.sendHistoryAction('redo');
          return;
        case 'clearLayer':
          if (!this.canDraw) return;
          if (confirm('清空当前图层？')) this.adapter.sendHistoryAction('clear');
          return;
        case 'toolBrush':
          this._setTool('brush');
          return;
        case 'toolEraser':
          this._setTool('eraser');
          return;
        case 'toolZoom':
          this._setTool('zoom');
          return;
        case 'toolFill':
          this._setTool('fillBucket');
          return;
        case 'toolLine':
          this._setTool('line');
          return;
        case 'toolEyedropper':
          this._setTool('eyedropper');
          return;
        case 'toolHand':
          this._setTool('hand');
          return;
        case 'selectionDelete':
          if (this.selectionManager) this.selectionManager.deleteSelection();
          return;
        case 'selectionFill':
          if (this.selectionManager) this.selectionManager.fillSelection(this.currentColor);
          return;
        case 'brushSizeUp':
          this._adjustBrushSize(1);
          return;
        case 'brushSizeDown':
          this._adjustBrushSize(-1);
          return;
        case 'zoomIn':
          this._zoomAtCenter(true);
          return;
        case 'zoomOut':
          this._zoomAtCenter(false);
          return;
        case 'resetView':
          if (this.viewport) this.viewport.resetView();
          return;
        case 'layerNew':
          this.createLayer();
          return;
        case 'layerDelete':
          if (this.activeLayerId && confirm('删除当前图层？')) {
            this.deleteLayer(this.activeLayerId);
          }
          return;
        case 'layerUp':
          this._moveActiveLayer(-1);
          return;
        case 'layerDown':
          this._moveActiveLayer(1);
          return;
        case 'layerToggleVisible': {
          const layer = this.layersMeta.find(l => l.layer_id === this.activeLayerId);
          if (layer) this.updateLayer(layer.layer_id, { visible: layer.visible === false });
          return;
        }
        case 'layerToggleLock': {
          const lockedLayer = this.layersMeta.find(l => l.layer_id === this.activeLayerId);
          if (lockedLayer) this.updateLayer(lockedLayer.layer_id, { locked: !lockedLayer.locked });
          return;
        }
        case 'layerRename': {
          const renameLayer = this.layersMeta.find(l => l.layer_id === this.activeLayerId);
          if (!renameLayer) return;
          const next = prompt('重命名图层', renameLayer.name || '');
          if (next != null && next.trim()) this.renameLayer(renameLayer.layer_id, next.trim());
          return;
        }
        case 'boardNew':
          this.createBoard();
          return;
        case 'boardPrev':
          this._stepBoard(-1);
          return;
        case 'boardNext':
          this._stepBoard(1);
          return;
        case 'exportPng':
          if (!this.canSave) return;
          this.exportAllBoards('png');
          return;
        case 'exportJpeg':
          if (!this.canSave) return;
          this.exportAllBoards('jpeg');
          return;
        case 'exportKra':
          if (!this.canSave) return;
          this.exportAllBoards('kra');
          return;
        case 'copyLink':
          if (this._roomActions.copyLink) this._roomActions.copyLink();
          return;
        case 'leaveRoom':
          if (this._roomActions.leaveRoom) this._roomActions.leaveRoom();
          return;
        case 'openSettings':
          if (this._roomActions.openSettings) this._roomActions.openSettings();
          return;
        case 'swapColors':
          if (this.colorPair) {
            this.colorPair.swap();
            this.currentColor = this.colorPair.foreground;
            if (this.colorPicker) this.colorPicker.setColor(this.currentColor);
            if (this.popupPalette) this.popupPalette.refresh();
          }
          return;
        default:
          return;
      }
    }

    _setTool(toolId) {
      const resolved = ToolRegistry.resolveTool(toolId, this.toolRail ? this.toolRail.variantStore : null);
      const prev = this.currentTool;
      this.currentTool = resolved;
      if (this.toolRail) this.toolRail.setTool(resolved, { silent: true });
      if (this.stage) {
        this.stage.dataset.tool = resolved;
        this._applyToolCursor(resolved);
      }
      if (this.brushPreview && !BRUSH_TOOLS.has(resolved)) this.brushPreview.hide();
      if (this.selectionManager && (String(resolved).startsWith('select') || resolved === 'magicWand')) {
        this.selectionManager.setMode(resolved);
      } else if (this.selectionManager && prev !== resolved) {
        this.selectionManager.clear();
      }
    }

    /** 返回当前工具应对应的 CSS 光标。 */
    _toolCursor(toolId) {
      const id = String(toolId || '');
      const map = {
        hand: 'grab',
        eyedropper: 'crosshair',
        fillBucket: 'cell',
        fillGradient: 'crosshair',
        zoom: 'zoom-in',
        line: 'crosshair',
        brush: 'none',
        eraser: 'none'
      };
      if (map[id]) return map[id];
      if (id.startsWith('select') || id === 'magicWand') return 'crosshair';
      if (id.startsWith('rect') || id.startsWith('ellipse')) return 'crosshair';
      return 'default';
    }

    /** 按当前工具设置舞台与画布光标。 */
    _applyToolCursor(toolId) {
      const cursor = this._toolCursor(toolId);
      if (this.stage) this.stage.style.cursor = cursor === 'none' ? '' : cursor;
      if (this.canvas) this.canvas.style.cursor = cursor;
    }

    /** Space 按住临时抓手；Delete 清除选区。 */
    _bindToolKeys() {
      document.addEventListener('keydown', event => {
        if (event.target && event.target.matches('input, textarea, select, [contenteditable="true"]')) return;
        if (event.code === 'Space' && !event.repeat && this._spaceToolPrev == null) {
          event.preventDefault();
          this._spaceToolPrev = this.currentTool;
          this._setTool('hand');
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          if (this.selectionManager && this.selectionManager.isActive()) {
            event.preventDefault();
            this.selectionManager.deleteSelection();
          }
        }
        if (event.key === 'Escape') {
          if (this.selectionManager) this.selectionManager.clear();
          if (this.canvasOverlay) this.canvasOverlay.clear();
        }
      });
      document.addEventListener('keyup', event => {
        if (event.code === 'Space' && this._spaceToolPrev != null) {
          event.preventDefault();
          const prev = this._spaceToolPrev;
          this._spaceToolPrev = null;
          this._setTool(prev);
        }
      });
    }

    _adjustBrushSize(delta) {
      const sizeInput = document.getElementById('brushSize');
      const next = clamp(this.currentSize + delta, BRUSH_MIN, BRUSH_MAX);
      this.currentSize = next;
      if (sizeInput) sizeInput.value = String(next);
      if (this.brushPreview) {
        this.brushPreview.showAtCenter();
        clearTimeout(this._brushPreviewHideTimer);
        this._brushPreviewHideTimer = setTimeout(() => this._hideBrushSizePreview(), 700);
      }
    }

    /** 滑块拖动时在画布中心刷新笔刷空心圆。 */
    _refreshBrushSizePreview() {
      const sizeInput = document.getElementById('brushSize');
      if (sizeInput && document.activeElement === sizeInput && this.brushPreview) {
        this.brushPreview.showAtCenter({ pinned: true });
      }
    }

    _hideBrushSizePreview() {
      if (this.brushPreview) this.brushPreview.hide();
    }

    _zoomAtCenter(zoomIn) {
      if (!this.viewport || !this.stage) return;
      const rect = this.stage.getBoundingClientRect();
      this.viewport.zoomStepAt(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        zoomIn
      );
    }

    _moveActiveLayer(delta) {
      const order = this.layersMeta
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(l => l.layer_id);
      const idx = order.indexOf(this.activeLayerId);
      if (idx < 0) return;
      const next = idx + delta;
      if (next < 0 || next >= order.length) return;
      order.splice(idx, 1);
      order.splice(next, 0, this.activeLayerId);
      this.reorderLayers(order);
    }

    _stepBoard(delta) {
      const order = this.boardOrder.length
        ? this.boardOrder.slice()
        : this.boardsMeta.map(b => b.board_id);
      const idx = order.indexOf(this.activeBoardId);
      if (idx < 0) return;
      const next = idx + delta;
      if (next < 0 || next >= order.length) return;
      this.switchBoard(order[next]);
    }

    handleRoomState(data) {
      this.selfId = data.self_id || this.selfId;
      this.ownerId = data.owner_id || '';
      this._applySelfPermissions(data.players, data.self_id);
      this.activeBoardId = data.active_board_id || 'b_default';
      this.activeLayerId = data.active_layer_id || 'l_default';
      this.layersMeta = data.layers || [{ layer_id: 'l_default', name: '图层 1', visible: true, opacity: 255, locked: false, order: 0 }];
      this.boardsMeta = data.boards || [];
      this.boardOrder = data.board_order || this.boardsMeta.map(b => b.board_id);
      this.strokes = DrawingBoard.cloneStrokes(data.strokes || []);
      this._refitCanvas();
      this._redraw();
      if (this.boardPanel) {
        this.boardPanel.setBoards(this.boardsMeta, this.boardOrder, this.activeBoardId);
      }
      if (this.layerPanel) {
        this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      }
      this.onRoomChange(data);
      this._updateMemberCount(data.players);
      this.setPlayersSnapshot(data.players);
    }

    /** 从 players 列表同步本客户端绘画/保存权限并更新 UI。 */
    _applySelfPermissions(players, selfId) {
      const id = selfId || this.selfId;
      const row = (players || []).find(p => p.uid === id);
      const isHost = id && this.ownerId && id === this.ownerId;
      this.canDraw = isHost || row == null || row.can_draw !== false;
      this.canSave = isHost || row == null || row.can_save !== false;
      this._syncPermissionUi();
    }

    handlePlayerPermissions(data) {
      const list = this.getPlayersSnapshot().slice();
      const idx = list.findIndex(p => p.uid === data.player_id);
      if (idx >= 0) {
        list[idx] = Object.assign({}, list[idx], {
          can_draw: data.can_draw,
          can_save: data.can_save
        });
        this.setPlayersSnapshot(list);
      }
      if (data.player_id === this.selfId) {
        if (data.can_draw != null) this.canDraw = !!data.can_draw;
        if (data.can_save != null) this.canSave = !!data.can_save;
        this._syncPermissionUi();
      }
    }

    /** 禁用/启用水印、导出与绘制相关控件。 */
    _syncPermissionUi() {
      if (this.canvasWatermark) this.canvasWatermark.setActive(this.canSave);
      if (this.stage) {
        this.stage.classList.toggle('is-readonly', !this.canDraw);
        this.stage.classList.toggle('is-save-blocked', !this.canSave);
      }
      const exportToggle = document.getElementById('exportToggleBtn');
      if (exportToggle) exportToggle.disabled = !this.canSave;
      const clearBtn = document.getElementById('clearBtn');
      if (clearBtn) clearBtn.disabled = !this.canDraw;
      if (!this.canDraw && this.brushPreview) this.brushPreview.hide();
    }

    /** 供 RoomPanel 读取最新成员列表。 */
    getPlayersSnapshot() {
      return this._playersSnapshot || [];
    }

    setPlayersSnapshot(players) {
      this._playersSnapshot = Array.isArray(players) ? players.slice() : [];
    }

    handleDrawingSync(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      if (data.layers) {
        this.layersMeta = data.layers;
        const sorted = this.layersMeta.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
        if (sorted.length) this.activeLayerId = sorted[sorted.length - 1].layer_id;
      }
      this.applyServerSnapshot(data.strokes || [], true);
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
    }

    handleDrawMessage(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const segment = this._segmentFromMessage(data);
      if (!segment) return;
      this._appendRemoteSegment(data.owner_id, data.stroke_id, segment, data.layer_id);
    }

    handleDrawBatch(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      (data.segments || []).forEach(segment => {
        this._appendRemoteSegment(data.owner_id, data.stroke_id, segment, data.layer_id);
      });
    }

    handleStrokeVisibility(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const stroke = DrawingBoard.findStroke(this.strokes, data.owner_id, data.stroke_id);
      if (!stroke) return;
      stroke.active = Boolean(data.visible);
      if (!this.isDrawing) this._redraw();
    }

    handleClear(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const layerId = data.layer_id || this.activeLayerId;
      this.strokes = this.strokes.filter(s =>
        String(s.layer_id || 'l_default') !== layerId
      );
      this._redraw();
    }

    handleLayerAdded(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      if (data.layer) this.layersMeta.push(data.layer);
      this.layersMeta.sort((a, b) => (a.order || 0) - (b.order || 0));
      if (data.created_by === this.selfId) {
        this.activeLayerId = data.layer.layer_id;
      }
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
    }

    handleLayerRemoved(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      this.layersMeta = this.layersMeta.filter(l => l.layer_id !== data.layer_id);
      this.strokes = this.strokes.filter(s => String(s.layer_id || 'l_default') !== data.layer_id);
      if (this.activeLayerId === data.layer_id) {
        this.activeLayerId = this.layersMeta.length
          ? this.layersMeta[this.layersMeta.length - 1].layer_id
          : 'l_default';
      }
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
    }

    handleLayerRenamed(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const layer = this.layersMeta.find(l => l.layer_id === data.layer_id);
      if (layer) layer.name = data.name;
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
    }

    handleLayerReordered(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      if (data.layers) this.layersMeta = data.layers;
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
    }

    handleLayerUpdated(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const layer = this.layersMeta.find(l => l.layer_id === data.layer_id);
      if (!layer) return;
      if ('visible' in data) layer.visible = Boolean(data.visible);
      if ('opacity' in data) layer.opacity = Number(data.opacity);
      if ('locked' in data) layer.locked = Boolean(data.locked);
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
    }

    switchLayer(layerId) {
      if (layerId === this.activeLayerId) return;
      this.activeLayerId = layerId;
      this.session.send({ type: 'layer_switch', board_id: this.activeBoardId, layer_id: layerId });
      if (this.layerPanel) this.layerPanel.setActive(layerId);
    }

    createLayer() {
      this.session.send({ type: 'layer_create', board_id: this.activeBoardId });
    }

    deleteLayer(layerId) {
      if (!layerId) return;
      this.session.send({ type: 'layer_delete', board_id: this.activeBoardId, layer_id: layerId });
    }

    renameLayer(layerId, name) {
      this.session.send({ type: 'layer_rename', board_id: this.activeBoardId, layer_id: layerId, name });
    }

    reorderLayers(layerIds) {
      this.session.send({ type: 'layer_reorder', board_id: this.activeBoardId, layer_ids: layerIds });
    }

    updateLayer(layerId, patch) {
      this.session.send(Object.assign({ type: 'layer_update', board_id: this.activeBoardId, layer_id: layerId }, patch));
    }

    handleBoardAdded(data) {
      this.boardsMeta.push({
        board_id: data.board_id,
        title: data.title,
        canvas: data.canvas
      });
      this.boardOrder.push(data.board_id);
      if (this.boardPanel) {
        this.boardPanel.setBoards(this.boardsMeta, this.boardOrder, this.activeBoardId);
      }
    }

    handleBoardRemoved(data) {
      this.boardsMeta = this.boardsMeta.filter(b => b.board_id !== data.board_id);
      this.boardOrder = this.boardOrder.filter(id => id !== data.board_id);
      if (this.activeBoardId === data.board_id) {
        this.activeBoardId = 'b_default';
        this.session.send({ type: 'board_switch', board_id: this.activeBoardId });
      }
      if (this.boardPanel) {
        this.boardPanel.setBoards(this.boardsMeta, this.boardOrder, this.activeBoardId);
      }
    }

    handleBoardRenamed(data) {
      const board = this.boardsMeta.find(b => b.board_id === data.board_id);
      if (board) board.title = data.title;
      if (this.boardPanel) {
        this.boardPanel.setBoards(this.boardsMeta, this.boardOrder, this.activeBoardId);
      }
    }

    switchBoard(boardId) {
      if (boardId === this.activeBoardId) return;
      this.adapter.flushSegments();
      this.activeBoardId = boardId;
      this.strokes = [];
      this.layersMeta = [];
      this._redraw();
      this.session.send({ type: 'board_switch', board_id: boardId });
      if (this.boardPanel) this.boardPanel.setActive(boardId);
    }

    createBoard() {
      this.session.send({ type: 'board_create' });
    }

    renameBoard(boardId, title) {
      this.session.send({ type: 'board_rename', board_id: boardId, title });
    }

    deleteBoard(boardId) {
      this.session.send({ type: 'board_delete', board_id: boardId });
    }

    applyServerSnapshot(serverStrokes, preserveActiveStroke) {
      const shouldPreserve = Boolean(
        this.activeStrokeId && (preserveActiveStroke || this.isDrawing)
      );
      this.strokes = this.drawingBoard.mergeServerSnapshot(
        serverStrokes,
        this.strokes,
        {
          preserveOwnerId: this.selfId,
          preserveStrokeId: shouldPreserve ? this.activeStrokeId : ''
        }
      );
      if (!this.isDrawing) this._redraw();
    }

    /** 收集全部画板 strokes 并批量导出（每画板一个文件）。 */
    async exportAllBoards(formatId) {
      if (this._exportBusy) return;
      if (!this.canSave) {
        const statusEl = document.getElementById('statusText');
        if (statusEl) statusEl.textContent = '房主已关闭你的保存权限';
        return;
      }
      this._exportBusy = true;
      const statusEl = document.getElementById('statusText');
      const setStatus = text => { if (statusEl) statusEl.textContent = text || ''; };
      try {
        this.adapter.flushSegments();
        const order = this.boardOrder.length
          ? this.boardOrder.slice()
          : this.boardsMeta.map(b => b.board_id);
        const boards = [];
        setStatus('正在准备导出…');
        for (let i = 0; i < order.length; i += 1) {
          const boardId = order[i];
          const meta = this.boardsMeta.find(b => b.board_id === boardId);
          if (!meta) continue;
          setStatus(`同步画板 ${i + 1}/${order.length}…`);
          let strokes;
          let layers;
          let canvas = meta.canvas;
          if (boardId === this.activeBoardId) {
            strokes = DrawingBoard.cloneStrokes(this.strokes);
            layers = this.layersMeta.slice();
          } else {
            const sync = await this.session.requestBoardSync(boardId);
            strokes = sync.strokes || [];
            layers = sync.layers || [];
            canvas = sync.canvas || canvas;
          }
          boards.push({
            meta: {
              board_id: boardId,
              title: meta.title,
              canvas,
              layers,
              exportOptions: this.canSave ? {} : {
                watermarkText: `${this.session.roomId || 'room'} · 预览`
              }
            },
            strokes
          });
        }
        if (!boards.length) throw new Error('没有可导出的画板');
        setStatus(`正在导出 ${boards.length} 个文件…`);
        await this.exportRegistry.exportBoards(formatId, boards, {
          roomId: this.session.roomId || 'room',
          delayMs: 150,
          watermarkText: this.canSave ? null : `${this.session.roomId || 'room'} · 预览`
        });
        setStatus(`已导出 ${boards.length} 个文件`);
      } catch (err) {
        setStatus(err.message || '导出失败');
      } finally {
        this._exportBusy = false;
      }
    }

    _segmentFromMessage(data) {
      const tool = data.tool || 'brush';
      if (tool === 'background') return { tool, color: data.color };
      if (tool === 'fill') return { tool, color: data.color, x: data.x, y: data.y };
      if (tool === 'gradient') {
        return {
          tool,
          x1: data.x1, y1: data.y1, x2: data.x2, y2: data.y2,
          color: data.color, color2: data.color2
        };
      }
      if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
        const segment = {
          x1: data.x1, y1: data.y1, x2: data.x2, y2: data.y2,
          color: data.color, size: data.size, tool
        };
        if (tool === 'rect' || tool === 'ellipse') segment.filled = !!data.filled;
        return segment;
      }
      return {
        x1: data.x1, y1: data.y1, x2: data.x2, y2: data.y2,
        color: data.color, size: data.size, tool
      };
    }

    _appendRemoteSegment(ownerId, strokeId, segment, layerId) {
      this.drawingBoard.appendSegment(this.strokes, ownerId, strokeId, segment, layerId);
      if (!this.isDrawing) this._redraw();
      else this.drawingBoard.drawSegment(segment);
    }

    _appendLocalSegment(strokeId, segment) {
      if (!this.canDraw && segment.tool !== 'localRaster') return;
      this.drawingBoard.appendSegment(this.strokes, this.selfId, strokeId, segment, this.activeLayerId);
      this.drawingBoard.drawSegment(segment);
      if (segment.tool !== 'localRaster') {
        this.adapter.sendSegment(strokeId, segment);
      }
    }

    /** 构造 cursor_move 附加字段（笔刷大小与标签色）。 */
    _cursorExtras() {
      const extras = {};
      if (BRUSH_TOOLS.has(this.currentTool) || this.isDrawing) {
        extras.size = this.currentSize;
      }
      if (this.onlinePrefs) extras.label_color = this.onlinePrefs.getWireLabelColor();
      return extras;
    }

    _sendCursor(boardId, x, y, drawing) {
      this.session.sendCursor(boardId, x, y, drawing, this._cursorExtras());
    }

    normalizedPoint(event) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      return {
        x: clamp(x, 0, 1),
        y: clamp(y, 0, 1)
      };
    }

    _bindPointer() {
      const down = event => this._onPointerDown(event);
      const move = event => this._onPointerMove(event);
      const up = event => this._onPointerUp(event);
      this.canvas.addEventListener('pointerdown', down);
      this.canvas.addEventListener('pointermove', move);
      this.canvas.addEventListener('pointerup', up);
      this.canvas.addEventListener('pointercancel', up);
      this.canvas.addEventListener('pointerleave', event => {
        if (this.isDrawing && event.pointerId === this.activeDrawPointerId) return;
        if (this.brushPreview) this.brushPreview.hide();
        this._sendCursor(this.activeBoardId, 0, 0, false);
      });
    }

    _onPointerDown(event) {
      if (this.popupPalette && this.popupPalette.isOpen()) this.popupPalette.close();
      if (event.button === 1 || event.button === 2) return;
      if (event.button !== 0 && !this.penInput.isPenEraser(event)) return;
      if (this.viewport && this.viewport.isPanning()) return;
      if (this.penInput.shouldIgnorePointer(event, this.activeDrawPointerId)) return;
      if (this.toolController && this.toolController.onPointerDown(event)) return;
    }

    _onPointerMove(event) {
      if (this.viewport && this.viewport.isPanning()) return;
      const pt = this.normalizedPoint(event);
      if (this.brushPreview) this.brushPreview.update(event.clientX, event.clientY);
      if (BRUSH_TOOLS.has(this.currentTool) || this.isDrawing) {
        this._sendCursor(this.activeBoardId, pt.x, pt.y, this.isDrawing);
      } else if (this.currentTool !== 'zoom' && this.currentTool !== 'hand') {
        this._sendCursor(this.activeBoardId, pt.x, pt.y, false);
      }
      if (this.toolController && this.toolController.onPointerMove(event)) return;
    }

    _onPointerUp(event) {
      if (this.toolController && this.toolController.onPointerUp(event)) return;
    }

    _bindToolbar() {
      if (this.toolRail) {
        this.toolRail.onChange = toolId => this._setTool(toolId);
      }
      if (this.colorPicker) {
        this.colorPicker.onChange = color => { this.currentColor = color; };
        this.currentColor = this.colorPicker.getColor();
      }
      const sizeInput = document.getElementById('brushSize');
      if (sizeInput) {
        const showCenterPreview = () => {
          if (this.brushPreview) this.brushPreview.showAtCenter({ pinned: true });
        };
        const hideCenterPreview = () => this._hideBrushSizePreview();
        sizeInput.addEventListener('pointerdown', showCenterPreview);
        sizeInput.addEventListener('input', () => {
          this.currentSize = clamp(Number(sizeInput.value) || 8, BRUSH_MIN, BRUSH_MAX);
          showCenterPreview();
        });
        sizeInput.addEventListener('pointerup', hideCenterPreview);
        sizeInput.addEventListener('change', hideCenterPreview);
        sizeInput.addEventListener('blur', hideCenterPreview);
        this.currentSize = clamp(Number(sizeInput.value) || 8, BRUSH_MIN, BRUSH_MAX);
      }
      const undoBtn = document.getElementById('undoBtn');
      const redoBtn = document.getElementById('redoBtn');
      const clearBtn = document.getElementById('clearBtn');
      const exportMenu = document.getElementById('exportMenu');
      const exportToggle = document.getElementById('exportToggleBtn');
      const exportPanel = document.getElementById('exportMenuPanel');
      if (exportToggle && exportPanel) {
        exportToggle.addEventListener('click', () => {
          exportPanel.classList.toggle('hidden');
          const settingsModal = document.getElementById('settingsModal');
          if (settingsModal) settingsModal.classList.add('hidden');
        });
        document.addEventListener('click', event => {
          if (!exportMenu || exportMenu.contains(event.target)) return;
          exportPanel.classList.add('hidden');
        });
      }
      document.querySelectorAll('[data-export]').forEach(btn => {
        btn.addEventListener('click', () => {
          const formatId = btn.dataset.export || 'png';
          if (exportPanel) exportPanel.classList.add('hidden');
          this.exportAllBoards(formatId);
        });
      });
      if (undoBtn) undoBtn.addEventListener('click', () => this.executeAction('undo'));
      if (redoBtn) redoBtn.addEventListener('click', () => this.executeAction('redo'));
      if (clearBtn) clearBtn.addEventListener('click', () => this.executeAction('clearLayer'));
    }

    _bindVisibility() {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.adapter.requestRepairSync();
        }
      });
    }

    _updateMemberCount(players) {
      const el = document.getElementById('memberCount');
      if (!el || !Array.isArray(players)) return;
      const online = players.filter(p => p.connected).length;
      el.textContent = `${online}/${players.length}`;
    }
  }

  global.CollabBoardController = CollabBoardController;
  global.COLLAB_PALETTE = PALETTE;
})(window);
