(function (global) {
  'use strict';

  /** 右下画板列表面板。 */
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
      this.activeBoardId = '';
      this.boards = [];
      if (this.addBtn) this.addBtn.addEventListener('click', () => this.onCreate());
    }

    setBoards(boards, boardOrder, activeBoardId) {
      this.boards = boards || [];
      this.activeBoardId = activeBoardId || '';
      this._render(boardOrder || []);
    }

    setActive(boardId) {
      this.activeBoardId = boardId;
      if (!this.listEl) return;
      this.listEl.querySelectorAll('[data-board-id]').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.boardId === boardId);
      });
    }

    _render(boardOrder) {
      if (!this.listEl) return;
      this.listEl.innerHTML = '';
      const order = boardOrder.length ? boardOrder : this.boards.map(b => b.board_id);
      order.forEach(boardId => {
        const meta = this.boards.find(b => b.board_id === boardId);
        if (!meta) return;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'board-row' + (boardId === this.activeBoardId ? ' is-active' : '');
        row.dataset.boardId = boardId;
        row.innerHTML = '<span class="board-row-name"></span>';
        row.querySelector('.board-row-name').textContent = meta.title || boardId;
        row.addEventListener('click', () => {
          if (boardId !== this.activeBoardId) this.onSwitch(boardId);
        });
        row.addEventListener('dblclick', () => {
          const next = prompt('重命名画板', meta.title || '');
          if (next != null && next.trim()) this.onRename(boardId, next.trim());
        });
        if (boardId !== 'b_default') {
          row.addEventListener('contextmenu', event => {
            event.preventDefault();
            if (confirm('删除此画板？（需无内容）')) this.onDelete(boardId);
          });
        }
        this.listEl.appendChild(row);
      });
    }
  }

  global.BoardPanel = BoardPanel;
})(window);
