(function (global) {
  'use strict';

  const SHORTCUT_CODE = 'F11';

  /** 电脑端无边框全屏：Fullscreen API 进入/退出，并同步顶栏按钮与 F11 快捷键。 */
  function createCollabFullscreen(options) {
    const settings = options || {};
    const button = settings.button || document.getElementById('collabFullscreenBtn');

    /** 当前全屏元素（含 webkit 前缀）。 */
    function fullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    /** 是否处于文档全屏。 */
    function isFullscreen() {
      return Boolean(fullscreenElement());
    }

    /** 请求根元素进入全屏。 */
    function enter() {
      const root = document.documentElement;
      if (typeof root.requestFullscreen === 'function') {
        return root.requestFullscreen();
      }
      if (typeof root.webkitRequestFullscreen === 'function') {
        return Promise.resolve(root.webkitRequestFullscreen());
      }
      return Promise.reject(new Error('Fullscreen API unavailable'));
    }

    /** 退出文档全屏。 */
    function exit() {
      if (typeof document.exitFullscreen === 'function') {
        return document.exitFullscreen();
      }
      if (typeof document.webkitExitFullscreen === 'function') {
        return Promise.resolve(document.webkitExitFullscreen());
      }
      return Promise.reject(new Error('Fullscreen API unavailable'));
    }

    /** 切换全屏；已全屏则退出。 */
    function toggle() {
      return isFullscreen() ? exit() : enter();
    }

    /** 按 fullscreenchange 刷新按钮文案、tooltip 与视觉状态。 */
    function syncButton() {
      if (!button) return;
      const active = isFullscreen();
      button.classList.toggle('is-fullscreen', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute('aria-label', active ? '退出全屏' : '全屏');
      button.title = active ? '退出全屏 (Esc / F11)' : '全屏 (F11)';
      button.setAttribute('data-tooltip', active ? '退出全屏' : '全屏');
      const icon = button.querySelector('#collabFullscreenIcon');
      if (icon) icon.textContent = active ? 'fullscreen_exit' : 'fullscreen';
    }

    /** 用户手势触发切换；忽略浏览器拒绝。 */
    function onToggleGesture() {
      toggle().catch(() => {});
    }

    /** 是否应忽略快捷键（输入框 / 可编辑区 / 弹窗输入）。 */
    function isTypingTarget(target) {
      if (!(target instanceof Element)) return false;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
      if (target instanceof HTMLSelectElement) return true;
      if (target.isContentEditable) return true;
      return Boolean(target.closest('[contenteditable="true"]'));
    }

    if (button) {
      button.addEventListener('click', event => {
        event.preventDefault();
        onToggleGesture();
      });
    }

    document.addEventListener('fullscreenchange', syncButton);
    document.addEventListener('webkitfullscreenchange', syncButton);

    window.addEventListener('keydown', event => {
      if (event.code !== SHORTCUT_CODE || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      onToggleGesture();
    });

    syncButton();

    return { isFullscreen, enter, exit, toggle, syncButton };
  }

  global.createCollabFullscreen = createCollabFullscreen;
})(window);
