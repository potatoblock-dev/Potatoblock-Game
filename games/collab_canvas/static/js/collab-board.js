(function (global) {
  'use strict';

  const BRUSH_MIN = 1;
  const BRUSH_MAX = 128;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 笔刷粗细：保留两位小数并限制在合法区间。 */
  const roundBrushSize = value => {
    const n = Math.round(Number(value) * 100) / 100;
    if (!Number.isFinite(n)) return 8;
    return clamp(n, BRUSH_MIN, BRUSH_MAX);
  };

  /** 数字框展示：整数不带小数，否则最多两位。 */
  const formatBrushSizeDisplay = value => {
    const n = roundBrushSize(value);
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  };
  const PALETTE = [
    '#111827', '#ef4444', '#f97316', '#eab308', '#22c55e',
    '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff'
  ];
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
      this.strokeSmoother = settings.strokeSmoother || null;
      this.onlinePrefs = settings.onlinePrefs || null;
      this.onRoomChange = settings.onRoomChange || (() => {});

      this.drawingBoard = new DrawingBoard(this.canvas, { width: 1920, height: 1080 });
      this.adapter = new CollabBoardAdapter({
        send: payload => this.session.send(payload),
        getBoardId: () => this.activeBoardId,
        getLayerId: () => this.drawLayerId()
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
      this._boardCreateCooldownUntil = 0;
      this._pendingSelectionCopy = null;
      this._pendingLayerCreateId = '';
      this._pbccAutoSaveTimer = null;
      this._pbccSaveBusy = false;
      this._pbccRestorePending = false;
      this._pbccRestoreBoardCount = 0;

      this.toolController = new ToolController();
      this.toolController.attachBoard(this);
      this.canvasOverlay = new CanvasOverlay(null, this.drawingBoard);
      if (this.stage) {
        const surface = this.stage.querySelector('.canvas-stage-surface') || document.getElementById('canvasStageSurface');
        if (surface) this.canvasOverlay.attachToSurface(surface);
      }
      this.selectionManager = new SelectionManager(this, this.canvasOverlay);
      this.selectionActionsBar = new SelectionActionsBar(this, this.selectionManager);
      this._lastPointerClientX = null;
      this._lastPointerClientY = null;
      if (this.viewport) {
        this.viewport.onTransformChange = () => {
          if (this.selectionActionsBar) this.selectionActionsBar.sync();
          if (this.brushPreview && this._lastPointerClientX != null && this._lastPointerClientY != null) {
            this.brushPreview.update(this._lastPointerClientX, this._lastPointerClientY);
          }
        };
      }
      if (typeof registerCollabTools === 'function') {
        registerCollabTools(this.toolController, this);
      }

      const cursorLayer = document.getElementById('cursorLayer');
      this.brushPreview = new BrushPreview(this.stage || cursorLayer, {
        getStage: () => this.stage,
        getViewportScale: () => (this.viewport ? this.viewport.scale : 1),
        getCanvas: () => this.canvas,
        getLogicalWidth: () => this.drawingBoard.logicalWidth,
        getBrushSize: () => this.currentSize,
        getTool: () => this.currentTool,
        isVisible: () => !this.isDrawing || BRUSH_TOOLS.has(this.currentTool)
      });
      this.brushSizeDockPreview = new BrushSizeDockPreview(
        document.getElementById('brushSizePreview'),
        {
          getBrushSize: () => this.currentSize,
          getTool: () => this.currentTool
        }
      );

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
        this._updateBrushSizeDockPreview();
        if (this.selectionActionsBar) this.selectionActionsBar.sync();
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
      if (this.layerPanel && this.layerPanel.refreshThumbnails) {
        this.layerPanel.refreshThumbnails();
      }
    }

    _activeLayerLocked() {
      return this._isLayerLocked(this.drawLayerId());
    }

    /** 指定图层或其任意父组是否锁定。 */
    _isLayerLocked(layerId) {
      let current = this.layersMeta.find(l => l.layer_id === layerId);
      while (current) {
        if (current.locked) return true;
        const parentId = current.parent_id || '';
        if (!parentId) break;
        current = this.layersMeta.find(l => l.layer_id === parentId);
      }
      return false;
    }

    /** 合并图层 visible/opacity/locked 补丁到 layersMeta。 */
    _applyLayerPatch(layerId, patch) {
      const layer = this.layersMeta.find(l => l.layer_id === layerId);
      if (!layer || !patch) return false;
      if ('visible' in patch) layer.visible = Boolean(patch.visible);
      if ('opacity' in patch) layer.opacity = Number(patch.opacity);
      if ('locked' in patch) layer.locked = Boolean(patch.locked);
      return true;
    }

    /** 图层元数据变更后刷新列表与画布。 */
    _syncLayerUi() {
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
      if (this.selectionActionsBar) this.selectionActionsBar.sync();
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
          if (this._activeLayerLocked()) return;
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
        case 'toolMove':
          this._setTool('move');
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
        case 'debounceBoost':
          if (this.strokeSmoother) this.strokeSmoother.setBoost(!this.strokeSmoother.boost);
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
          if (this.activeLayerId && this.canDeleteLayer(this.activeLayerId) && confirm('删除当前图层？')) {
            this.deleteLayer(this.activeLayerId);
          } else if (this.activeLayerId && !this.canDeleteLayer(this.activeLayerId)) {
            this._layerUiMessage('至少保留一个图层');
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
        case 'layerRename':
          if (this.layerPanel && this.activeLayerId) {
            this.layerPanel.startRename(this.activeLayerId);
          }
          return;
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
        case 'exportSkt':
          if (!this.canSave) return;
          this.exportAllBoards('skt');
          return;
        case 'exportHsj':
          if (!this.canSave) return;
          this.exportAllBoards('hsj');
          return;
        case 'exportProcreate':
          if (!this.canSave) return;
          this.exportAllBoards('procreate');
          return;
        case 'exportPsd':
          if (!this.canSave) return;
          this.exportAllBoards('psd');
          return;
        case 'exportPbcc':
          if (!this.canSave) return;
          this.exportAllBoards('pbcc');
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
      this._updateBrushSizeDockPreview();
      if (this.selectionManager && (String(resolved).startsWith('select') || resolved === 'magicWand')) {
        this.selectionManager.setMode(resolved);
      } else if (this.selectionManager && prev !== resolved && resolved !== 'move') {
        this.selectionManager.clear();
      }
      if (this.selectionActionsBar) this.selectionActionsBar.sync();
    }

    /** 返回当前工具应对应的 CSS 光标。 */
    _toolCursor(toolId) {
      const id = String(toolId || '');
      const map = {
        hand: 'grab',
        move: 'move',
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
      this._setBrushSize(this.currentSize + delta);
    }

    /** 同步滑块、数字框与 currentSize。 */
    _setBrushSize(value) {
      this.currentSize = roundBrushSize(value);
      const sizeSlider = document.getElementById('brushSize');
      const sizeNumber = document.getElementById('brushSizeNumber');
      if (sizeSlider) sizeSlider.value = String(this.currentSize);
      if (sizeNumber) sizeNumber.value = formatBrushSizeDisplay(this.currentSize);
      this._updateBrushSizeDockPreview();
    }

    /** 刷新右栏粗细滑块旁的空心圆预览。 */
    _updateBrushSizeDockPreview() {
      if (this.brushSizeDockPreview) this.brushSizeDockPreview.update();
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

    isHost() {
      return Boolean(this.selfId && this.ownerId && this.selfId === this.ownerId);
    }

    /** 房客新建画板冷却剩余毫秒（房主无冷却）。 */
    boardCreateCooldownRemaining() {
      if (this.isHost()) return 0;
      return Math.max(0, this._boardCreateCooldownUntil - Date.now());
    }

    /** 同步画板面板列表与联机上下文。 */
    _syncBoardPanel() {
      if (!this.boardPanel) return;
      this.boardPanel.setRoomContext({
        isOwner: () => this.isHost(),
        getCreateCooldownMs: () => this.boardCreateCooldownRemaining()
      });
      this.boardPanel.setBoards(this.boardsMeta, this.boardOrder, this.activeBoardId);
    }

    handleRoomState(data) {
      this.selfId = data.self_id || this.selfId;
      this.ownerId = data.owner_id || '';
      this._applySelfPermissions(data.players, data.self_id);
      this.activeBoardId = data.active_board_id || 'b_default';
      this.activeLayerId = data.active_layer_id || 'l_default';
      this.layersMeta = this._coerceLayers(data.layers);
      this.boardsMeta = data.boards || [];
      this.boardOrder = data.board_order || this.boardsMeta.map(b => b.board_id);
      this.strokes = DrawingBoard.cloneStrokes(data.strokes || []);
      if (this.layerPanel) {
        this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      }
      this._refitCanvas();
      this._redraw();
      if (!this.isHost() && data.last_board_create_at) {
        const cooldownMs = global.BOARD_CREATE_COOLDOWN_MS || 60000;
        const until = Math.floor(Number(data.last_board_create_at) * 1000) + cooldownMs;
        if (until > Date.now()) {
          this._boardCreateCooldownUntil = until;
        }
      }
      this._syncBoardPanel();
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
      if (!this.canDraw && this.brushPreview) this.brushPreview.hide();
      if (this.selectionActionsBar) this.selectionActionsBar.sync();
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
        this.layersMeta = this._coerceLayers(data.layers);
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
      this._clearPendingLayerCreate();
      if (data.layer) {
        const layer = this._normalizeLayerMeta(Object.assign({}, data.layer));
        if (!this.layersMeta.some(item => item.layer_id === layer.layer_id)) {
          this.layersMeta.push(layer);
        }
      }
      this.layersMeta.sort((a, b) => (a.order || 0) - (b.order || 0));
      if (data.created_by === this.selfId && data.layer) {
        this.activeLayerId = data.layer.layer_id;
        if (this._pendingSelectionCopy) {
          this._applyPendingSelectionCopy(data.layer.layer_id);
        }
      }
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
      this._layerUiMessage('');
    }

    /** 将 pending 选区复制像素写入新建图层。 */
    _applyPendingSelectionCopy(layerId) {
      const pending = this._pendingSelectionCopy;
      if (!pending || !layerId) return;
      const db = this.drawingBoard;
      const bbox = pending.bbox;
      const segment = {
        tool: 'localRaster',
        x: bbox.x / db.logicalWidth,
        y: bbox.y / db.logicalHeight,
        w: bbox.w / db.logicalWidth,
        h: bbox.h / db.logicalHeight,
        pixels: pending.pixels,
        punch: false
      };
      const strokeId = crypto.randomUUID();
      db.appendSegment(this.strokes, this.selfId, strokeId, segment, layerId);
      this._pendingSelectionCopy = null;
      this._redraw();
      if (this.selectionActionsBar) this.selectionActionsBar.sync();
    }

    /** 图层副本：合并新 layer 与克隆 strokes 并刷新。 */
    handleLayerDuplicated(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      if (data.layer) {
        const exists = this.layersMeta.some(l => l.layer_id === data.layer.layer_id);
        if (!exists) this.layersMeta.push(data.layer);
        this.layersMeta.sort((a, b) => (a.order || 0) - (b.order || 0));
      }
      (data.strokes || []).forEach(stroke => {
        const copy = DrawingBoard.cloneStrokes([stroke])[0];
        if (copy) this.strokes.push(copy);
      });
      if (data.created_by === this.selfId && data.layer) {
        this.activeLayerId = data.layer.layer_id;
      }
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
    }

    handleLayerRemoved(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const removed = this.layersMeta.find(l => l.layer_id === data.layer_id);
      if (removed && this._isGroupLayer(removed)) {
        this._reparentLayerChildren(data.layer_id, removed.parent_id || '');
      }
      this.layersMeta = this.layersMeta.filter(l => l.layer_id !== data.layer_id);
      this.strokes = this.strokes.filter(s => String(s.layer_id || 'l_default') !== data.layer_id);
      if (this.activeLayerId === data.layer_id || !this.layersMeta.some(l => l.layer_id === this.activeLayerId)) {
        this.activeLayerId = this._topPaintLayerId();
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
      if (data.layers) {
        this.layersMeta = data.layers.map(layer => this._normalizeLayerMeta(Object.assign({}, layer)));
      }
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
    }

    handleLayerUpdated(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const patch = {};
      if ('visible' in data) patch.visible = data.visible;
      if ('opacity' in data) patch.opacity = data.opacity;
      if ('locked' in data) patch.locked = data.locked;
      if (!this._applyLayerPatch(data.layer_id, patch)) return;
      this._syncLayerUi();
    }

    switchLayer(layerId) {
      if (layerId === this.activeLayerId) return;
      this.activeLayerId = layerId;
      this.session.send({ type: 'layer_switch', board_id: this.activeBoardId, layer_id: layerId });
      if (this.layerPanel) this.layerPanel.setActive(layerId);
    }

    /** 是否为图层组。 */
    _isGroupLayer(layer) {
      return Boolean(layer && layer.kind === 'group');
    }

    /** 规范化图层元数据（kind / parent_id）。 */
    _normalizeLayerMeta(layer) {
      if (!layer) return layer;
      if (!layer.kind) layer.kind = 'paint';
      if (layer.parent_id == null) layer.parent_id = '';
      return layer;
    }

    /** 将 parent_id 指向不存在图层的项提升到根（与服务端 repair_orphan_layers 一致）。 */
    _repairOrphanLayers(layers) {
      const idSet = new Set((layers || []).map(layer => layer.layer_id));
      return (layers || []).map(layer => {
        const copy = this._normalizeLayerMeta(Object.assign({}, layer));
        const parentId = copy.parent_id || '';
        if (parentId && !idSet.has(parentId)) copy.parent_id = '';
        return copy;
      });
    }

    /** 保证至少有一层可绘制「图层 1」（空列表时含背景 + 图层 1）。 */
    _coerceLayers(layers) {
      const fallback = [
        {
          layer_id: 'l_background',
          name: '背景',
          kind: 'paint',
          parent_id: '',
          visible: true,
          opacity: 255,
          locked: false,
          order: 0
        },
        {
          layer_id: 'l_default',
          name: '图层 1',
          kind: 'paint',
          parent_id: '',
          visible: true,
          opacity: 255,
          locked: false,
          order: 1
        }
      ];
      let source = !Array.isArray(layers) || layers.length === 0
        ? fallback.slice()
        : layers.map(layer => this._normalizeLayerMeta(Object.assign({}, layer)));
      source = this._repairOrphanLayers(source);
      const userPaints = source.filter(
        layer => !this._isGroupLayer(layer) && layer.layer_id !== 'l_background'
      );
      if (!userPaints.length) {
        const maxOrder = source.reduce((max, layer) => Math.max(max, layer.order || 0), 0);
        const ids = new Set(source.map(layer => layer.layer_id));
        source.push({
          layer_id: ids.has('l_default') ? ('l_' + Date.now().toString(36)) : 'l_default',
          name: '图层 1',
          kind: 'paint',
          parent_id: '',
          visible: true,
          opacity: 255,
          locked: false,
          order: maxOrder + 1
        });
      }
      return source;
    }

    /** 将被删组/层的子图层挂到新 parent（空串为根）。 */
    _reparentLayerChildren(removedLayerId, newParentId) {
      const parentId = newParentId || '';
      this.layersMeta.forEach(layer => {
        if ((layer.parent_id || '') === removedLayerId) {
          layer.parent_id = parentId;
        }
      });
    }

    /** 返回 order 最高的绘画图层 id。 */
    _topPaintLayerId() {
      const paints = this.layersMeta.filter(l => !this._isGroupLayer(l));
      if (!paints.length) return 'l_default';
      paints.sort((a, b) => (a.order || 0) - (b.order || 0));
      return paints[paints.length - 1].layer_id;
    }

    /** 新建图层时默认 parent：选中组则入组，否则与当前层同级（无效 parent 视为根）。 */
    _resolveNewLayerParentId() {
      const active = this.layersMeta.find(l => l.layer_id === this.activeLayerId);
      if (!active) return '';
      if (this._isGroupLayer(active)) return active.layer_id;
      const parentId = active.parent_id || '';
      if (!parentId) return '';
      const parent = this.layersMeta.find(l => l.layer_id === parentId);
      if (parent && this._isGroupLayer(parent)) return parentId;
      return '';
    }

    /** 当前可绘制目标图层（选中组时落到组内顶层绘画层）。 */
    drawLayerId() {
      const active = this.layersMeta.find(l => l.layer_id === this.activeLayerId);
      if (active && this._isGroupLayer(active)) {
        const children = this.layersMeta
          .filter(l => !this._isGroupLayer(l) && (l.parent_id || '') === active.layer_id)
          .sort((a, b) => (a.order || 0) - (b.order || 0));
        if (children.length) return children[children.length - 1].layer_id;
        return this._topPaintLayerId();
      }
      return this.activeLayerId;
    }

    /** 在状态栏提示图层相关错误。 */
    _layerUiMessage(message) {
      if (this._roomActions.setStatus) this._roomActions.setStatus(message);
    }

    /** 移除乐观占位图层。 */
    _clearPendingLayerCreate() {
      if (!this._pendingLayerCreateId) return;
      this.layersMeta = this.layersMeta.filter(l => l.layer_id !== this._pendingLayerCreateId);
      if (this.activeLayerId === this._pendingLayerCreateId) {
        this.activeLayerId = this._topPaintLayerId();
      }
      this._pendingLayerCreateId = '';
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
    }

    /** 新建图层/组：本地先占位，等服务端 layer_added 替换。 */
    createLayer(options) {
      const opts = options || {};
      const kind = opts.kind || 'paint';
      let parentId = opts.parentId != null ? opts.parentId : this._resolveNewLayerParentId();
      if (parentId) {
        const parent = this.layersMeta.find(l => l.layer_id === parentId);
        if (!parent || !this._isGroupLayer(parent)) parentId = '';
      }
      const maxOrder = this.layersMeta.reduce((max, layer) => Math.max(max, layer.order || 0), 0);
      const paintCount = this.layersMeta.filter(l => !this._isGroupLayer(l)).length;
      const groupCount = this.layersMeta.filter(l => this._isGroupLayer(l)).length;
      const pendingId = 'l_pending_' + Date.now().toString(36);
      const pendingLayer = this._normalizeLayerMeta({
        layer_id: pendingId,
        name: opts.name || (kind === 'group' ? `组 ${groupCount + 1}` : `图层 ${paintCount + 1}`),
        kind,
        parent_id: parentId || '',
        visible: true,
        opacity: 255,
        locked: false,
        order: maxOrder + 1
      });
      this._clearPendingLayerCreate();
      this._pendingLayerCreateId = pendingId;
      this.layersMeta.push(pendingLayer);
      this.activeLayerId = pendingId;
      this._syncLayerUi();

      const payload = {
        type: 'layer_create',
        board_id: this.activeBoardId,
        kind
      };
      if (parentId) payload.parent_id = parentId;
      if (opts.name) payload.name = opts.name;
      if (!this.session.send(payload)) {
        this._clearPendingLayerCreate();
        this._syncLayerUi();
        this._layerUiMessage('连接未就绪，无法新建图层');
        return false;
      }
      return true;
    }

    /** 新建空图层组。 */
    createLayerGroup() {
      return this.createLayer({ kind: 'group' });
    }

    /** 复制图层为副本（含该层 strokes，WS layer_duplicate）。 */
    duplicateLayer(layerId) {
      const sourceId = layerId || this.activeLayerId;
      if (!sourceId) return;
      const source = this.layersMeta.find(l => l.layer_id === sourceId);
      if (source && this._isGroupLayer(source)) return;
      this.session.send({
        type: 'layer_duplicate',
        board_id: this.activeBoardId,
        source_layer_id: sourceId
      });
    }

    /** 是否允许删除该画板（房间至少保留一个）。 */
    canDeleteBoard(boardId) {
      if (!boardId || this.boardsMeta.length <= 1) return false;
      if (boardId === 'b_default') return false;
      return true;
    }

    /** 是否允许删除该图层（画板至少保留一个）。 */
    canDeleteLayer(layerId) {
      if (!layerId) return false;
      return this.layersMeta.length > 1;
    }

    deleteLayer(layerId) {
      if (!layerId) return;
      if (!this.canDeleteLayer(layerId)) {
        this._layerUiMessage('至少保留一个图层');
        return;
      }
      this.session.send({ type: 'layer_delete', board_id: this.activeBoardId, layer_id: layerId });
    }

    renameLayer(layerId, name) {
      this.session.send({ type: 'layer_rename', board_id: this.activeBoardId, layer_id: layerId, name });
    }

    reorderLayers(layerIds) {
      this.session.send({ type: 'layer_reorder', board_id: this.activeBoardId, layer_ids: layerIds });
    }

    updateLayer(layerId, patch) {
      if (!this._applyLayerPatch(layerId, patch)) return;
      this._syncLayerUi();
      this.session.send(Object.assign(
        { type: 'layer_update', board_id: this.activeBoardId, layer_id: layerId },
        patch
      ));
    }

    handleBoardAdded(data) {
      this.boardsMeta.push({
        board_id: data.board_id,
        title: data.title,
        canvas: data.canvas
      });
      this.boardOrder.push(data.board_id);
      if (data.created_by === this.selfId && !this.isHost()) {
        this._boardCreateCooldownUntil = Date.now() + (global.BOARD_CREATE_COOLDOWN_MS || 60000);
        if (this.boardPanel) this.boardPanel.notifyBoardCreated(false);
      }
      this._syncBoardPanel();
    }

    handleBoardRemoved(data) {
      this.boardsMeta = this.boardsMeta.filter(b => b.board_id !== data.board_id);
      this.boardOrder = this.boardOrder.filter(id => id !== data.board_id);
      if (this.activeBoardId === data.board_id) {
        this.activeBoardId = 'b_default';
        this.session.send({ type: 'board_switch', board_id: this.activeBoardId });
      }
      this._syncBoardPanel();
    }

    handleBoardRenamed(data) {
      const board = this.boardsMeta.find(b => b.board_id === data.board_id);
      if (board) board.title = data.title;
      this._syncBoardPanel();
    }

    switchBoard(boardId) {
      if (boardId === this.activeBoardId) return;
      this.adapter.flushSegments();
      this.activeBoardId = boardId;
      const players = this.getPlayersSnapshot().slice();
      const selfIdx = players.findIndex(p => p.uid === this.selfId);
      if (selfIdx >= 0) {
        players[selfIdx] = Object.assign({}, players[selfIdx], { active_board_id: boardId });
        this.setPlayersSnapshot(players);
      }
      this.strokes = [];
      this.layersMeta = [];
      if (this.layerPanel) this.layerPanel.setLayers([], this.activeLayerId);
      this._redraw();
      this.session.send({ type: 'board_switch', board_id: boardId });
      if (this.boardPanel) this.boardPanel.setActive(boardId);
    }

    createBoard() {
      if (this.boardCreateCooldownRemaining() > 0) return;
      this.session.send({ type: 'board_create' });
    }

    renameBoard(boardId, title) {
      this.session.send({ type: 'board_rename', board_id: boardId, title });
    }

    deleteBoard(boardId) {
      if (!this.canDeleteBoard(boardId)) {
        if (this._roomActions.setStatus) {
          this._roomActions.setStatus(
            this.boardsMeta.length <= 1 ? '至少保留一个画板' : '默认画板不能删除'
          );
        }
        return;
      }
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

    /** 收集全部画板 strokes/layers 快照（导出与本机保存共用）。 */
    async collectBoardsForExport() {
      this.adapter.flushSegments();
      const order = this.boardOrder.length
        ? this.boardOrder.slice()
        : this.boardsMeta.map(b => b.board_id);
      const boards = [];
      for (let i = 0; i < order.length; i += 1) {
        const boardId = order[i];
        const meta = this.boardsMeta.find(b => b.board_id === boardId);
        if (!meta) continue;
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
            created_at: meta.created_at,
            created_by: meta.created_by,
            exportOptions: this.canSave ? {} : {
              watermarkText: `${this.session.roomId || 'room'} · 预览`
            }
          },
          strokes
        });
      }
      return boards;
    }

    /** 房主将当前房间写入本机 IndexedDB（.pbcc 文档）。 */
    async saveLocalPbccSnapshot() {
      if (!this.isHost() || this._pbccSaveBusy || !global.PbccLocalStore) return false;
      if (!this.session || !this.session.roomId) return false;
      this._pbccSaveBusy = true;
      try {
        const boards = await this.collectBoardsForExport();
        if (!boards.length) return false;
        const document = this.exportRegistry.buildPbccDocument(boards, {
          roomId: this.session.roomId,
          boardOrder: this.boardOrder,
          exportedByUid: this.selfId,
          exportedByName: this.session.getDisplayName
            ? this.session.getDisplayName()
            : ''
        });
        await PbccLocalStore.save(this.selfId, this.session.roomId, document);
        return true;
      } catch (_err) {
        return false;
      } finally {
        this._pbccSaveBusy = false;
      }
    }

    /** 房主进房后尝试从本机或指定文档恢复画板；返回 sent|none|failed。 */
    async tryRestoreLocalPbcc(options) {
      const opts = options || {};
      if (!this.isHost() || !global.PbccFormat || !this.session) return 'none';
      let document = opts.document || null;
      if (!document && opts.fromLocal && global.PbccLocalStore) {
        document = await PbccLocalStore.load(this.selfId, this.session.roomId);
      }
      if (!document) return 'none';
      const setStatus = this._roomActions.setStatus || (() => {});
      setStatus('正在恢复上次画板…');
      if (!this.session.sendRoomImport(document)) {
        setStatus('连接未就绪，无法恢复画板');
        return 'failed';
      }
      this._pbccRestorePending = true;
      this._pbccRestoreBoardCount = Array.isArray(document.boards) ? document.boards.length : 0;
      return 'sent';
    }

    /** room_import 成功后第二次 room_state 时更新状态栏。 */
    finishPbccRestoreIfPending() {
      if (!this._pbccRestorePending) return false;
      this._pbccRestorePending = false;
      const setStatus = this._roomActions.setStatus || (() => {});
      const n = this._pbccRestoreBoardCount || this.boardOrder.length || 1;
      setStatus(`已恢复 ${n} 个画板`);
      window.setTimeout(() => setStatus(''), 4000);
      return true;
    }

    /** 服务端 error 时清除恢复中状态。 */
    cancelPbccRestorePending(message) {
      if (!this._pbccRestorePending) return;
      this._pbccRestorePending = false;
      const setStatus = this._roomActions.setStatus || (() => {});
      setStatus(message || '恢复画板失败');
    }

    /** 启动房主本机自动保存（离开/定时）。 */
    schedulePbccAutoSave() {
      this.stopPbccAutoSave();
      if (!this.isHost()) return;
      this._pbccAutoSaveTimer = window.setInterval(() => {
        this.saveLocalPbccSnapshot();
      }, 90000);
    }

    /** 停止本机自动保存定时器。 */
    stopPbccAutoSave() {
      if (this._pbccAutoSaveTimer) {
        clearInterval(this._pbccAutoSaveTimer);
        this._pbccAutoSaveTimer = null;
      }
    }

    /** 判断 room_state 是否已含用户绘制内容。 */
    static roomStateHasUserContent(data) {
      const strokes = (data && data.strokes) || [];
      return strokes.some(stroke => {
        if (stroke.owner_id === '__system__') return false;
        return (stroke.segments || []).some(seg => seg && seg.tool !== 'background');
      });
    }

    /** 收集全部画板 strokes 并批量导出（pbcc 为单文件）。 */
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
      const format = this.exportRegistry.get(formatId);
      const isPbcc = format && format.multiBoardSingleFile;
      try {
        setStatus('正在准备导出…');
        const boards = await this.collectBoardsForExport();
        if (!boards.length) throw new Error('没有可导出的画板');
        setStatus(isPbcc ? '正在导出 .pbcc…' : `正在导出 ${boards.length} 个文件…`);
        await this.exportRegistry.exportBoards(formatId, boards, {
          roomId: this.session.roomId || 'room',
          delayMs: 150,
          exportedByUid: this.selfId,
          exportedByName: this.session.getDisplayName ? this.session.getDisplayName() : ''
        });
        if (isPbcc && this.isHost()) {
          await this.saveLocalPbccSnapshot();
        }
        setStatus(isPbcc ? '已导出 .pbcc 文件' : `已导出 ${boards.length} 个文件`);
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
      if (segment.tool !== 'localRaster' && this._activeLayerLocked()) return;
      this.drawingBoard.appendSegment(this.strokes, this.selfId, strokeId, segment, this.drawLayerId());
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
      this._lastPointerClientX = event.clientX;
      this._lastPointerClientY = event.clientY;
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
      const sizeSlider = document.getElementById('brushSize');
      const sizeNumber = document.getElementById('brushSizeNumber');
      if (sizeSlider) {
        sizeSlider.addEventListener('input', () => this._setBrushSize(sizeSlider.value));
      }
      if (sizeNumber) {
        sizeNumber.addEventListener('input', () => this._setBrushSize(sizeNumber.value));
        sizeNumber.addEventListener('change', () => this._setBrushSize(sizeNumber.value));
      }
      if (sizeSlider || sizeNumber) {
        this._setBrushSize(sizeSlider ? sizeSlider.value : (sizeNumber ? sizeNumber.value : 8));
      }
      const undoBtn = document.getElementById('undoBtn');
      const redoBtn = document.getElementById('redoBtn');
      const exportMenu = document.getElementById('exportMenu');
      const exportToggle = document.getElementById('exportToggleBtn');
      const exportPanel = document.getElementById('exportMenuPanel');
      if (exportToggle && exportPanel) {
        exportToggle.addEventListener('click', event => {
          event.stopPropagation();
          exportPanel.classList.toggle('hidden');
          const settingsModal = document.getElementById('settingsModal');
          if (settingsModal) settingsModal.classList.add('hidden');
        });
        document.addEventListener('click', event => {
          if (!exportMenu || exportMenu.contains(event.target)) return;
          exportPanel.classList.add('hidden');
        });
      }
      const exportSpecialToggle = document.getElementById('exportSpecialToggle');
      const exportSpecialPanel = document.getElementById('exportSpecialPanel');
      if (exportSpecialToggle && exportSpecialPanel) {
        exportSpecialToggle.addEventListener('click', event => {
          event.stopPropagation();
          const open = exportSpecialPanel.classList.toggle('hidden');
          exportSpecialToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
        });
      }
      document.querySelectorAll('[data-export]').forEach(btn => {
        btn.addEventListener('click', event => {
          event.stopPropagation();
          const formatId = btn.dataset.export || 'png';
          if (exportPanel) exportPanel.classList.add('hidden');
          if (exportSpecialPanel) exportSpecialPanel.classList.add('hidden');
          if (exportSpecialToggle) exportSpecialToggle.setAttribute('aria-expanded', 'false');
          this.exportAllBoards(formatId);
        });
      });
      if (undoBtn) undoBtn.addEventListener('click', () => this.executeAction('undo'));
      if (redoBtn) redoBtn.addEventListener('click', () => this.executeAction('redo'));
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
