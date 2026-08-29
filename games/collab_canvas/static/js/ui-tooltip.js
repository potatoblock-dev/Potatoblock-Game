(function (global) {
  'use strict';

  const SHOW_DELAY_MS = 500;

  /** 为带 data-tooltip 的元素绑定延迟浮字提示。 */
  function initUiTooltips(root) {
    const scope = root || document.getElementById('roomScreen');
    if (!scope) return;

    let tip = document.getElementById('wsTooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'wsTooltip';
      tip.className = 'ws-tooltip hidden';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }

    let timer = null;
    let pendingEl = null;
    let visibleEl = null;

    function clearTimer() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function hide() {
      clearTimer();
      pendingEl = null;
      visibleEl = null;
      tip.classList.add('hidden');
    }

    /** 根据锚点元素位置放置浮字（左栏向右，其余向下）。 */
    function place(el) {
      const rect = el.getBoundingClientRect();
      tip.classList.remove('hidden');
      const tipRect = tip.getBoundingClientRect();
      let left;
      let top;
      if (el.closest('#dockLeft')) {
        left = rect.right + 8;
        top = rect.top + (rect.height - tipRect.height) / 2;
      } else {
        left = rect.left + (rect.width - tipRect.width) / 2;
        top = rect.bottom + 6;
        if (top + tipRect.height > window.innerHeight - 4) {
          top = rect.top - tipRect.height - 6;
        }
      }
      left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
      top = Math.max(4, Math.min(top, window.innerHeight - tipRect.height - 4));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }

    function show(el) {
      const text = el.getAttribute('data-tooltip');
      if (!text) return;
      visibleEl = el;
      tip.textContent = text;
      place(el);
    }

    scope.addEventListener('mouseover', event => {
      const el = event.target.closest('[data-tooltip]');
      if (!el || !scope.contains(el)) return;
      if (pendingEl === el || visibleEl === el) return;
      hide();
      pendingEl = el;
      timer = setTimeout(() => {
        if (pendingEl === el) show(el);
      }, SHOW_DELAY_MS);
    });

    scope.addEventListener('mouseout', event => {
      const el = event.target.closest('[data-tooltip]');
      if (!el) return;
      const to = event.relatedTarget;
      if (to && el.contains(to)) return;
      hide();
    });

    scope.addEventListener('mousedown', hide);
    scope.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
  }

  global.initUiTooltips = initUiTooltips;
})(window);
