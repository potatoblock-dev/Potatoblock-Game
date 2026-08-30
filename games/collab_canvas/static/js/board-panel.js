(function (global) {
  'use strict';

  const DEFAULT_BOARD_ID = 'b_default';
  const BOARD_CREATE_COOLDOWN_MS = 60000;
  const LONG_PRESS_MS = 450;

  /** 右下画板列表面板（复用图层行布局）。 */
  class BoardPanel {
    constructor(root, options) {
      const settings = options || {};
      this.root = root;
      this.listEl = root && root.querySelector('[data-board-list]');
      this.addBtn = root && root.querySelector('[data-board-add]');
      this.onSwitch = settings.onSwitch || (() => {});
      this.onCreate = settings.onCreate || (() => {});
      this.onRename = settings.onRename || (() => {});
      this.onDelete = settings.onDelete || (() => {});
      this.isOwner = settings.isOwner || (() => false);
      this.getCreateCooldownMs = settings.getCreateCooldownMs || (() => 0);
      this.getPlayersForBoard = settings.getPlayersForBoard || (() => []);
      this.getSelfId = settings.getSelfId || (() => '');
      this.activeBoardId = '';
      this.boards = [];
      this._cooldownTimer = null;
      this._openMenu = null;
      this._occupantTree = null;
      this._occupantAnchor = null;
      this._occupantBoardId = '';
      this._occupantHideTimer = null;
      this._longPressTimer = null;
      this._longPressTriggered = false;
      this._supportsHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      if (this.addBtn) {
        this.addBtn.addEventListener('click', () => {
          if (this.addBtn.disabled) return;
          this.onCreate();
        });
      }
      this._onDocPointer = this._onDocPointer.bind(this);
      this._onDocKey = this._onDocKey.bind(this);
      document.addEventListener('pointerdown', this._onDocPointer, true);
      document.addEventListener('keydown', this._onDocKey, true);
    }

    /** 更新房主身份与创建冷却查询（联机状态变化时调用）。 */
    setRoomContext(ctx) {
      const settings = ctx || {};
      if (settings.isOwner) this.isOwner = settings.isOwner;
      if (settings.getCreateCooldownMs) this.getCreateCooldownMs = settings.getCreateCooldownMs;
      this._updateAddButton();
    }

    /** 本机创建画板成功后启动 1 分钟冷却倒计时（房客）。 */
    notifyBoardCreated(isOwner) {
      if (isOwner) return;
      this._updateAddButton();
      this._startCooldownTimer();
    }

    setBoards(boards, boardOrder, activeBoardId) {
      this.boards = boards || [];
      this.activeBoardId = activeBoardId || '';
      this._render(boardOrder || []);
      this._updateAddButton();
    }

    setActive(boardId) {
      this.activeBoardId = boardId;
      if (!this.listEl) return;
      this.listEl.querySelectorAll('.board-row').forEach(row => {
        const active = row.dataset.boardId === boardId;
        row.classList.toggle('is-active', active);
        const check = row.querySelector('.layer-row-check');
        if (check) {
          check.classList.toggle('is-checked', active);
          check.textContent = '';
          if (active) {
            check.appendChild(MaterialIcons.createIcon('check', 'layer-row-check-icon'));
          }
        }
      });
    }

    /** 成员画板变更时刷新已展开的在场用户树。 */
    refreshOccupantTree() {
      if (!this._occupantTree || !this._occupantAnchor) return;
      this._renderOccupantTreeContent(this._occupantTree, this._occupantBoardId);
      this._positionOccupantTree(this._occupantAnchor, this._occupantTree);
    }

    _startCooldownTimer() {
      if (this._cooldownTimer) return;
      this._cooldownTimer = setInterval(() => {
        this._updateAddButton();
        if (this.getCreateCooldownMs() <= 0) {
          clearInterval(this._cooldownTimer);
          this._cooldownTimer = null;
        }
      }, 1000);
    }

    /** 刷新新建按钮禁用态与冷却提示。 */
    _updateAddButton() {
      if (!this.addBtn) return;
      const owner = this.isOwner();
      const remain = owner ? 0 : this.getCreateCooldownMs();
      if (owner || remain <= 0) {
        this.addBtn.disabled = false;
        this.addBtn.setAttribute('data-tooltip', '新建画板');
        return;
      }
      this.addBtn.disabled = true;
      const sec = Math.ceil(remain / 1000);
      this.addBtn.setAttribute('data-tooltip', '创建冷却 ' + sec + ' 秒');
      this._startCooldownTimer();
    }

    _createRowIconBtn(icon, label, options) {
      const settings = options || {};
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'layer-row-icon-btn' + (settings.extraClass ? ' ' + settings.extraClass : '');
      btn.setAttribute('data-tooltip', label);
      btn.setAttribute('aria-label', label);
      if (settings.disabled) btn.disabled = true;
      btn.appendChild(MaterialIcons.createIcon(icon, 'layer-row-icon'));
      return btn;
    }

    _closeMenu() {
      if (this._openMenu && this._openMenu.parentNode) {
        this._openMenu.parentNode.removeChild(this._openMenu);
      }
      this._openMenu = null;
    }

    _clearLongPressTimer() {
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = null;
      }
    }

    _cancelHideOccupantTree() {
      if (this._occupantHideTimer) {
        clearTimeout(this._occupantHideTimer);
        this._occupantHideTimer = null;
      }
    }

    /** 关闭画板在场用户树形浮层。 */
    _hideOccupantTree() {
      this._cancelHideOccupantTree();
      if (this._occupantAnchor) {
        this._occupantAnchor.classList.remove('is-occupant-open');
      }
      if (this._occupantTree && this._occupantTree.parentNode) {
        this._occupantTree.parentNode.removeChild(this._occupantTree);
      }
      this._occupantTree = null;
      this._occupantAnchor = null;
      this._occupantBoardId = '';
    }

    _scheduleHideOccupantTree() {
      this._cancelHideOccupantTree();
      this._occupantHideTimer = setTimeout(() => this._hideOccupantTree(), 140);
    }

    /** 填充树形用户名列表。 */
    _renderOccupantTreeContent(treeEl, boardId) {
      const namesEl = treeEl.querySelector('[data-board-occupant-names]');
      if (!namesEl) return;
      namesEl.innerHTML = '';
      const players = this.getPlayersForBoard(boardId);
      const selfId = this.getSelfId();
      if (!players.length) {
        const empty = document.createElement('div');
        empty.className = 'board-occupant-item is-empty';
        empty.textContent = '暂无在线用户';
        namesEl.appendChild(empty);
        return;
      }
      players.forEach(player => {
        const item = document.createElement('div');
        item.className = 'board-occupant-item';
        const dot = document.createElement('span');
        dot.className = 'board-occupant-dot';
        if (player.label_color) dot.style.backgroundColor = player.label_color;
        const label = document.createElement('span');
        label.className = 'board-occupant-label';
        label.textContent = String(player.name || '玩家') + (player.uid === selfId ? '（你）' : '');
        if (player.is_host) {
          const badge = document.createElement('span');
          badge.className = 'board-occupant-host';
          badge.textContent = '房主';
          label.appendChild(badge);
        }
        item.appendChild(dot);
        item.appendChild(label);
        namesEl.appendChild(item);
      });
    }

    /** 将树形浮层定位到画板行左侧，连接线对齐行高中点。 */
    _positionOccupantTree(anchorRow, treeEl) {
      if (!anchorRow || !treeEl) return;
      const rect = anchorRow.getBoundingClientRect();
      treeEl.style.position = 'fixed';
      treeEl.style.zIndex = '2100';
      const treeRect = treeEl.getBoundingClientRect();
      const armWidth = 14;
      let left = rect.left - treeRect.width - armWidth;
      if (left < 4) left = 4;
      let top = rect.top + rect.height / 2 - treeRect.height / 2;
      top = Math.max(4, Math.min(top, window.innerHeight - treeRect.height - 4));
      treeEl.style.left = Math.round(left) + 'px';
      treeEl.style.top = Math.round(top) + 'px';
    }

    /** 展示指定画板当前在线用户（树形侧栏）。 */
    _showOccupantTree(anchorRow, boardId) {
      if (!anchorRow) return;
      if (this._occupantTree && this._occupantAnchor === anchorRow) {
        this._cancelHideOccupantTree();
        return;
      }
      this._hideOccupantTree();
      this._closeMenu();

      const tree = document.createElement('div');
      tree.className = 'board-occupant-tree';
      tree.setAttribute('role', 'tooltip');
      tree.dataset.boardId = boardId;

      const names = document.createElement('div');
      names.className = 'board-occupant-names';
      names.setAttribute('data-board-occupant-names', '');

      const spine = document.createElement('div');
      spine.className = 'board-occupant-spine';
      spine.setAttribute('aria-hidden', 'true');
      spine.innerHTML = '<span class="board-occupant-spine-trunk"></span><span class="board-occupant-spine-arm"></span>';

      tree.appendChild(names);
      tree.appendChild(spine);
      this._renderOccupantTreeContent(tree, boardId);
      document.body.appendChild(tree);

      this._occupantTree = tree;
      this._occupantAnchor = anchorRow;
      this._occupantBoardId = boardId;
      anchorRow.classList.add('is-occupant-open');
      this._positionOccupantTree(anchorRow, tree);

      tree.addEventListener('mouseenter', () => this._cancelHideOccupantTree());
      tree.addEventListener('mouseleave', () => this._scheduleHideOccupantTree());
    }

    /** 绑定桌面悬停与移动端长按。 */
    _bindOccupantTriggers(row, boardId) {
      if (this._supportsHover) {
        row.addEventListener('mouseenter', () => {
          this._cancelHideOccupantTree();
          this._showOccupantTree(row, boardId);
        });
        row.addEventListener('mouseleave', () => this._scheduleHideOccupantTree());
      }

      row.addEventListener('pointerdown', event => {
        if (this._supportsHover && event.pointerType === 'mouse') return;
        this._longPressTriggered = false;
        this._clearLongPressTimer();
        this._longPressTimer = setTimeout(() => {
          this._longPressTriggered = true;
          this._showOccupantTree(row, boardId);
        }, LONG_PRESS_MS);
      });
      row.addEventListener('pointerup', () => this._clearLongPressTimer());
      row.addEventListener('pointercancel', () => this._clearLongPressTimer());
      row.addEventListener('pointerleave', () => this._clearLongPressTimer());

      row.addEventListener('click', event => {
        if (!this._longPressTriggered) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this._longPressTriggered = false;
      }, true);
    }

    _showContextMenu(board, clientX, clientY) {
      if (!this.isOwner() || board.board_id === DEFAULT_BOARD_ID) return;
      this._hideOccupantTree();
      this._closeMenu();
      const menu = document.createElement('div');
      menu.className = 'layer-context-menu';
      menu.setAttribute('role', 'menu');
      const delItem = document.createElement('button');
      delItem.type = 'button';
      delItem.className = 'layer-context-menu-item is-danger';
      delItem.textContent = '删除画板';
      delItem.setAttribute('role', 'menuitem');
      delItem.addEventListener('click', event => {
        event.stopPropagation();
        this._closeMenu();
        const title = board.title || board.board_id;
        if (confirm('删除画板「' + title + '」？（需无笔迹内容）')) {
          this.onDelete(board.board_id);
        }
      });
      menu.appendChild(delItem);
      document.body.appendChild(menu);
      this._openMenu = menu;
      menu.style.position = 'fixed';
      menu.style.left = Math.round(clientX) + 'px';
      menu.style.top = Math.round(clientY) + 'px';
      menu.style.zIndex = '2100';
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth - 4) {
        menu.style.left = Math.round(window.innerWidth - rect.width - 4) + 'px';
      }
      if (rect.bottom > window.innerHeight - 4) {
        menu.style.top = Math.round(window.innerHeight - rect.height - 4) + 'px';
      }
    }

    _onDocPointer(event) {
      if (this._openMenu && !this._openMenu.contains(event.target)) {
        this._closeMenu();
      }
      if (this._occupantTree) {
        const onRow = this._occupantAnchor && this._occupantAnchor.contains(event.target);
        const onTree = this._occupantTree.contains(event.target);
        if (!onRow && !onTree) this._hideOccupantTree();
      }
    }

    _onDocKey(event) {
      if (event.key === 'Escape') {
        this._closeMenu();
        this._hideOccupantTree();
      }
    }

    _render(boardOrder) {
      if (!this.listEl) return;
      this._hideOccupantTree();
      this.listEl.innerHTML = '';
      const order = boardOrder.length ? boardOrder : this.boards.map(b => b.board_id);
      const owner = this.isOwner();
      order.forEach(boardId => {
        const meta = this.boards.find(b => b.board_id === boardId);
        if (!meta) return;
        const isActive = boardId === this.activeBoardId;
        const row = document.createElement('div');
        row.className = 'layer-row board-row' + (isActive ? ' is-active' : '');
        row.dataset.boardId = boardId;

        const grip = document.createElement('span');
        grip.className = 'layer-row-grip';
        grip.setAttribute('aria-hidden', 'true');
        grip.appendChild(MaterialIcons.createIcon('drag_indicator', 'layer-row-grip-icon'));

        const check = document.createElement('span');
        check.className = 'layer-row-check' + (isActive ? ' is-checked' : '');
        check.setAttribute('aria-hidden', 'true');
        if (isActive) {
          check.appendChild(MaterialIcons.createIcon('check', 'layer-row-check-icon'));
        }

        const typeIcon = document.createElement('span');
        typeIcon.className = 'layer-row-type board-row-type';
        typeIcon.setAttribute('data-tooltip', '画板');
        typeIcon.appendChild(MaterialIcons.createIcon('grid_view', 'layer-row-type-icon'));

        const name = document.createElement('span');
        name.className = 'layer-row-name';
        name.textContent = meta.title || boardId;
        name.addEventListener('dblclick', event => {
          event.stopPropagation();
          const next = prompt('重命名画板', meta.title || '');
          if (next != null && next.trim()) this.onRename(boardId, next.trim());
        });

        const actions = document.createElement('div');
        actions.className = 'layer-row-actions';
        if (owner && boardId !== DEFAULT_BOARD_ID) {
          const delBtn = this._createRowIconBtn('delete', '删除画板');
          delBtn.addEventListener('click', event => {
            event.stopPropagation();
            const title = meta.title || boardId;
            if (confirm('删除画板「' + title + '」？（需无笔迹内容）')) {
              this.onDelete(boardId);
            }
          });
          actions.appendChild(delBtn);
        }

        row.appendChild(grip);
        row.appendChild(check);
        row.appendChild(typeIcon);
        row.appendChild(name);
        row.appendChild(actions);

        this._bindOccupantTriggers(row, boardId);

        row.addEventListener('click', () => {
          if (boardId !== this.activeBoardId) this.onSwitch(boardId);
        });
        row.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          this._showContextMenu(meta, event.clientX, event.clientY);
        });
        this.listEl.appendChild(row);
      });
    }
  }

  global.BoardPanel = BoardPanel;
  global.BOARD_CREATE_COOLDOWN_MS = BOARD_CREATE_COOLDOWN_MS;
})(window);
