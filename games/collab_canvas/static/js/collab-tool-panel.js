(function (global) {
  'use strict';

  /**
   * 合作工具侧栏：列出合作工具分类（当前含批注工具）。
   * 选中某工具后收起；放置类工具在画布操作后自动收起。
   */
  class CollabToolPanel {
    constructor(options) {
      const settings = options || {};
      this.onSelect = settings.onSelect || (() => {});
      this.onClose = settings.onClose || (() => {});
      this._el = null;
      this._anchor = null;
    }

    get isOpen() { return Boolean(this._el); }

    open(anchorEl) {
      this.close();
      this._anchor = anchorEl || null;
      this._el = document.createElement('div');
      this._el.className = 'collab-tool-panel';
      this._el.setAttribute('role', 'menu');
      this._el.setAttribute('aria-label', '合作工具');
      this._el.innerHTML = this._template();
      document.body.appendChild(this._el);
      this._bind();
      this._position();
      this._onDocPointer = event => {
        if (!this._el) return;
        if (this._el.contains(event.target)) return;
        if (this._anchor && this._anchor.contains(event.target)) return;
        this.close();
      };
      document.addEventListener('pointerdown', this._onDocPointer, true);
      this._onDocKey = event => { if (event.key === 'Escape') this.close(); };
      document.addEventListener('keydown', this._onDocKey, true);
      this._onResize = () => this._position();
      window.addEventListener('resize', this._onResize);
    }

    close() {
      if (!this._el) return;
      if (this._onDocPointer) document.removeEventListener('pointerdown', this._onDocPointer, true);
      if (this._onDocKey) document.removeEventListener('keydown', this._onDocKey, true);
      if (this._onResize) window.removeEventListener('resize', this._onResize);
      if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
      this._el = null;
      this._anchor = null;
      this.onClose();
    }

    _template() {
      return ''
        + '<div class="collab-tool-header">'
        +   '<span class="collab-tool-title">合作工具</span>'
        +   '<button type="button" class="collab-tool-close" data-collab-close title="关闭">'
        +     svgHtml('M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z')
        +   '</button>'
        + '</div>'
        + '<div class="collab-tool-body">'
        +   '<button type="button" class="collab-tool-item" data-collab-tool="annotation" title="在画布点一下放置批注圆圈">'
        +     '<span class="collab-tool-icon">' + svgHtml('M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2Z') + '</span>'
        +     '<span class="collab-tool-item-label">批注</span>'
        +     '<span class="collab-tool-item-hint">点击画布放置</span>'
        +   '</button>'
        + '</div>';
    }

    _bind() {
      const closeBtn = this._el.querySelector('[data-collab-close]');
      if (closeBtn) closeBtn.addEventListener('click', () => this.close());
      this._el.querySelectorAll('[data-collab-tool]').forEach(item => {
        item.addEventListener('click', event => {
          event.stopPropagation();
          this.onSelect(item.dataset.collabTool);
          this.close();
        });
      });
    }

    _position() {
      if (!this._el || !this._anchor) return;
      const rect = this._anchor.getBoundingClientRect();
      const elRect = this._el.getBoundingClientRect();
      this._el.style.position = 'fixed';
      const swapped = document.getElementById('collabWorkspace')?.classList.contains('is-sides-swapped');
      if (swapped) {
        this._el.style.left = Math.max(8, Math.round(rect.left - elRect.width - 8)) + 'px';
      } else {
        this._el.style.left = Math.min(window.innerWidth - elRect.width - 8, Math.round(rect.right + 8)) + 'px';
      }
      this._el.style.top = Math.max(8, Math.round(rect.top + (rect.height - elRect.height) / 2)) + 'px';
      this._el.style.zIndex = '2100';
    }
  }

  global.CollabToolPanel = CollabToolPanel;

  /** 内联 SVG 图标字符串（不依赖 Material Symbols 字体）。 */
  function svgHtml(d) {
    return '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">'
      + '<path d="' + d + '" fill="currentColor"></path></svg>';
  }
})(window);
