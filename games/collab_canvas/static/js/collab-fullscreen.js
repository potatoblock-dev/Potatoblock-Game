(function (global) {
  'use strict';

  const SHORTCUT_CODE = 'F11';
  const PSEUDO_CLASS = 'is-collab-pseudo-fullscreen';

  let instance = null;

  /** 电脑端全屏：优先 Fullscreen API，失败时回退为 CSS 伪全屏。 */
  function createCollabFullscreen(options) {
    if (instance) return instance;

    const settings = options || {};
    const button = settings.button || document.getElementById('collabFullscreenBtn');
    let pseudoActive = false;

    /** 当前原生全屏元素（含 webkit 前缀）。 */
    function nativeFullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    /** 是否处于原生全屏。 */
    function isNativeFullscreen() {
      return Boolean(nativeFullscreenElement());
    }

    /** 是否处于任意全屏（原生或伪全屏）。 */
    function isFullscreen() {
      return isNativeFullscreen() || pseudoActive;
    }

    /** 对单个元素请求全屏（含常见前缀）。 */
    function requestOnElement(element) {
      if (!element) return Promise.reject(new Error('no element'));
      if (typeof element.requestFullscreen === 'function') {
        return element.requestFullscreen();
      }
      if (typeof element.webkitRequestFullscreen === 'function') {
        return Promise.resolve(element.webkitRequestFullscreen());
      }
      if (typeof element.mozRequestFullScreen === 'function') {
        return Promise.resolve(element.mozRequestFullScreen());
      }
      if (typeof element.msRequestFullscreen === 'function') {
        return Promise.resolve(element.msRequestFullscreen());
      }
      return Promise.reject(new Error('Fullscreen API unavailable'));
    }

    /** 依次尝试根节点与工作区容器进入原生全屏。 */
    function enterNative() {
      const targets = [
        document.documentElement,
        document.body,
        document.querySelector('.collab-main'),
        document.getElementById('roomScreen')
      ].filter(Boolean);
      return targets.reduce((chain, element) => {
        return chain.catch(() => requestOnElement(element));
      }, Promise.reject(new Error('Fullscreen API unavailable')));
    }

    /** 退出原生全屏。 */
    function exitNative() {
      if (typeof document.exitFullscreen === 'function') {
        return document.exitFullscreen();
      }
      if (typeof document.webkitExitFullscreen === 'function') {
        return Promise.resolve(document.webkitExitFullscreen());
      }
      if (typeof document.mozCancelFullScreen === 'function') {
        return Promise.resolve(document.mozCancelFullScreen());
      }
      if (typeof document.msExitFullscreen === 'function') {
        return Promise.resolve(document.msExitFullscreen());
      }
      return Promise.reject(new Error('Fullscreen API unavailable'));
    }

    /** 进入 CSS 伪全屏（API 不可用时的回退）。 */
    function enterPseudo() {
      pseudoActive = true;
      document.documentElement.classList.add(PSEUDO_CLASS);
      syncButton();
    }

    /** 退出 CSS 伪全屏。 */
    function exitPseudo() {
      pseudoActive = false;
      document.documentElement.classList.remove(PSEUDO_CLASS);
      syncButton();
    }

    /** 进入全屏：原生优先，失败则伪全屏。 */
    function enter() {
      return enterNative().catch(() => {
        enterPseudo();
      });
    }

    /** 退出全屏（原生 + 伪全屏一并清理）。 */
    function exit() {
      if (pseudoActive) {
        exitPseudo();
      }
      if (!isNativeFullscreen()) {
        return Promise.resolve();
      }
      return exitNative().catch(() => {});
    }

    /** 切换全屏。 */
    function toggle() {
      return isFullscreen() ? exit() : enter();
    }

    /** 在状态栏短暂提示（伪全屏回退时告知用户）。 */
    function notifyStatus(text) {
      if (typeof settings.onStatus === 'function') {
        settings.onStatus(text);
        return;
      }
      const el = document.getElementById('statusText');
      if (!el || !text) return;
      el.textContent = text;
      window.setTimeout(() => {
        if (el.textContent === text) el.textContent = '';
      }, 2600);
    }

    /** 按全屏状态刷新按钮文案、tooltip 与视觉状态。 */
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

    /** 用户手势触发切换；原生失败时自动伪全屏。 */
    function onToggleGesture() {
      const wasActive = isFullscreen();
      toggle().then(() => {
        if (!wasActive && pseudoActive && !isNativeFullscreen()) {
          notifyStatus('浏览器限制全屏，已切换为页面铺满模式（Esc 退出）');
        }
      }).catch(() => {});
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

    function onNativeFullscreenChange() {
      if (!isNativeFullscreen() && pseudoActive) {
        exitPseudo();
      }
      syncButton();
    }

    document.addEventListener('fullscreenchange', onNativeFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onNativeFullscreenChange);

    window.addEventListener('keydown', event => {
      if (event.code === SHORTCUT_CODE && !event.repeat) {
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        onToggleGesture();
        return;
      }
      if (event.key === 'Escape' && pseudoActive && !isNativeFullscreen()) {
        exitPseudo();
      }
    });

    syncButton();

    instance = {
      isFullscreen,
      isNativeFullscreen,
      isPseudoFullscreen: () => pseudoActive,
      enter,
      exit,
      toggle,
      syncButton
    };
    global.CollabFullscreen = instance;
    return instance;
  }

  global.createCollabFullscreen = createCollabFullscreen;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => createCollabFullscreen());
  } else {
    createCollabFullscreen();
  }
})(window);
