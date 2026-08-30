(function (global) {
  'use strict';

  const PIN_STORAGE_KEY = 'collab-selection-bar-pinned-v1';
  const BAR_OFFSET_Y = 8;

  const ACTIONS = [
    { id: 'selectAll', icon: 'select_all', label: '选择全部' },
    { id: 'invert', icon: 'invert_colors', label: '反向选择' },
    { id: 'clear', icon: 'highlight_off', label: '取消选择' },
    { id: 'fill', icon: 'format_color_fill', label: '填充选区' },
    { id: 'delete', icon: 'ink_eraser', label: '清除选区' },
    { id: 'copy', icon: 'filter_none', label: '复制到新图层' },
    { id: 'pin', icon: 'push_pin', label: '固定选区工具栏', sepBefore: true }
  ];

  /** Krita 式选区编辑浮动栏：选区确立后显示在 bbox 下方。 */
  class SelectionActionsBar {
    constructor(board, selectionManager) {
      this.board = board;
      this.selectionManager = selectionManager;
      this.root = document.createElement('div');
      this.root.className = 'selection-actions-bar hidden';
      this.root.setAttribute('role', 'toolbar');
      this.root.setAttribute('aria-label', '选区编辑');
      this._pinned = false;
      this._pinPos = null;
      this._btnById = {};
      this._loadPinPref();
      this._buildDom();
      document.body.appendChild(this.root);
      this._onResize = () => this.sync();
      window.addEventListener('resize', this._onResize);
    }

    /** 从 localStorage 恢复 Pin 状态。 */
    _loadPinPref() {
      try {
        const raw = localStorage.getItem(PIN_STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        this._pinned = Boolean(data.pinned);
        if (data.left != null && data.top != null) {
          this._pinPos = { left: Number(data.left), top: Number(data.top) };
        }
      } catch (_err) {}
    }

    /** 持久化 Pin 状态与固定坐标。 */
    _savePinPref() {
      try {
        const payload = { pinned: this._pinned };
        if (this._pinPos) {
          payload.left = this._pinPos.left;
          payload.top = this._pinPos.top;
        }
        localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(payload));
      } catch (_err) {}
    }

    _buildDom() {
      ACTIONS.forEach(spec => {
        if (spec.sepBefore) {
          const sep = document.createElement('span');
          sep.className = 'selection-actions-sep';
          sep.setAttribute('aria-hidden', 'true');
          this.root.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'selection-actions-btn';
        btn.dataset.action = spec.id;
        btn.setAttribute('data-tooltip', spec.label);
        btn.setAttribute('aria-label', spec.label);
        btn.appendChild(MaterialIcons.createIcon(spec.icon, 'selection-actions-icon'));
        btn.addEventListener('click', event => {
          event.stopPropagation();
          event.preventDefault();
          this._onAction(spec.id, btn);
        });
        btn.addEventListener('pointerdown', event => event.stopPropagation());
        this._btnById[spec.id] = btn;
        this.root.appendChild(btn);
      });
      this._syncPinUi();
    }

    /** 刷新按钮禁用态（锁定层 / 无绘制权限）。 */
    _updateDisabledState() {
      const locked = this.board._activeLayerLocked();
      const canEdit = this.board.canDraw && !locked;
      ['fill', 'delete', 'copy'].forEach(id => {
        const btn = this._btnById[id];
        if (btn) btn.disabled = !canEdit;
      });
    }

    _onAction(actionId, pinBtn) {
      const sm = this.selectionManager;
      if (!sm) return;
      switch (actionId) {
        case 'selectAll':
          sm.selectAll();
          return;
        case 'invert':
          sm.invertSelection();
          return;
        case 'clear':
          sm.clear();
          return;
        case 'fill':
          if (pinBtn && pinBtn.disabled) return;
          sm.fillSelection(this.board.currentColor);
          return;
        case 'delete':
          if (pinBtn && pinBtn.disabled) return;
          sm.deleteSelection();
          return;
        case 'copy':
          if (pinBtn && pinBtn.disabled) return;
          sm.copyToNewLayer();
          return;
        case 'pin':
          this._togglePin();
          return;
        default:
      }
    }

    _togglePin() {
      if (!this._pinned) {
        const pos = this._computePosition();
        if (pos) this._pinPos = pos;
        this._pinned = true;
      } else {
        this._pinned = false;
      }
      this._syncPinUi();
      this._savePinPref();
      this.sync();
    }

    _syncPinUi() {
      const btn = this._btnById.pin;
      if (!btn) return;
      btn.classList.toggle('is-pinned', this._pinned);
      btn.setAttribute(
        'data-tooltip',
        this._pinned ? '取消固定选区工具栏' : '固定选区工具栏'
      );
      btn.setAttribute(
        'aria-label',
        this._pinned ? '取消固定选区工具栏' : '固定选区工具栏'
      );
    }

    /** 将选区 bbox 底边映射到视口坐标。 */
    _computePosition() {
      const bbox = this.selectionManager && this.selectionManager.bbox;
      const canvas = this.board && this.board.canvas;
      if (!bbox || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const db = this.board.drawingBoard;
      const lw = db.logicalWidth;
      const lh = db.logicalHeight;
      if (!lw || !lh || !rect.width || !rect.height) return null;
      const scaleX = rect.width / lw;
      const scaleY = rect.height / lh;
      const barRect = this.root.getBoundingClientRect();
      const barW = barRect.width || this.root.offsetWidth || 200;
      const barH = barRect.height || this.root.offsetHeight || 28;
      let left = rect.left + (bbox.x + bbox.w / 2) * scaleX - barW / 2;
      let top = rect.top + (bbox.y + bbox.h) * scaleY + BAR_OFFSET_Y;
      left = Math.max(4, Math.min(left, window.innerWidth - barW - 4));
      top = Math.max(4, Math.min(top, window.innerHeight - barH - 4));
      return { left: Math.round(left), top: Math.round(top) };
    }

    /** 显示/隐藏并更新浮动栏位置。 */
    sync() {
      if (!this.root || !this.selectionManager) return;
      this._updateDisabledState();
      if (!this.selectionManager.isActive()) {
        this.root.classList.add('hidden');
        return;
      }
      this.root.classList.remove('hidden');
      if (this._pinned && this._pinPos) {
        this.root.style.left = this._pinPos.left + 'px';
        this.root.style.top = this._pinPos.top + 'px';
        return;
      }
      const pos = this._computePosition();
      if (!pos) return;
      this.root.style.left = pos.left + 'px';
      this.root.style.top = pos.top + 'px';
    }
  }

  global.SelectionActionsBar = SelectionActionsBar;
})(window);
