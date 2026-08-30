/** 通行证登录：桌面/PWA 弹窗；手机浏览器整页跳转 passport（带人机验证）。 */
(function () {
  'use strict';

  const POPUP_NAME = 'potatoblock-passport-login';
  const MESSAGE_TYPE = 'pb-login-done';
  const PASSPORT_ORIGIN = 'https://passport.potatoblock.com';

  function isStandalonePwa() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  }

  /** 手机浏览器（非主屏幕 PWA）仍整页跳转，避免小窗体验过差。 */
  function isMobileBrowser() {
    if (isStandalonePwa()) return false;
    return window.matchMedia('(max-width: 767px)').matches
      || window.matchMedia('(pointer: coarse)').matches
      || navigator.maxTouchPoints > 1;
  }

  function passportLoginUrl(returnPath) {
    const next = returnPath || window.location.pathname + window.location.search;
    const returnUrl = window.location.origin + next;
    return PASSPORT_ORIGIN + '/login?return_url=' + encodeURIComponent(returnUrl);
  }

  /** 弹窗完成后的 return 地址：先落到 login-done，再 postMessage 父页。 */
  function passportPopupUrl(nextPath) {
    const next = nextPath || window.location.pathname + window.location.search;
    const done = '/pwa/login-done?return=' + encodeURIComponent(next);
    const returnUrl = window.location.origin + done;
    return PASSPORT_ORIGIN + '/login?return_url=' + encodeURIComponent(returnUrl);
  }

  /** 整页跳转 passport；返回 pending，避免 then 里 reload 打断导航。 */
  function redirectToPassport(nextPath) {
    window.location.assign(passportLoginUrl(nextPath));
    return new Promise(function () {});
  }

  /** 监听弹窗内 login-done 的 postMessage，或弹窗被关闭。 */
  function waitForLoginPopup(popup) {
    return new Promise(function (resolve, reject) {
      function cleanup() {
        window.removeEventListener('message', onMessage);
        clearInterval(timer);
      }

      function onMessage(event) {
        if (event.origin !== window.location.origin) return;
        const data = event.data || {};
        if (data.type !== MESSAGE_TYPE) return;
        cleanup();
        try { popup.close(); } catch (err) {}
        if (data.ok) resolve(data);
        else reject(new Error(data.error || 'login failed'));
      }

      window.addEventListener('message', onMessage);
      const timer = setInterval(function () {
        if (!popup || popup.closed) {
          cleanup();
          reject(new Error('popup closed'));
        }
      }, 500);
    });
  }

  /** 打开通行证登录弹窗；blocked 时回退整页跳转。 */
  function openPassportPopup(nextPath) {
    const url = passportPopupUrl(nextPath);
    const w = Math.min(window.screen.width - 16, 440);
    const h = Math.min(window.screen.height - 24, isStandalonePwa() ? 680 : 560);
    const left = Math.max(0, (window.screen.width - w) / 2);
    const top = Math.max(0, (window.screen.height - h) / 2);
    const features = 'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top;
    const popup = window.open(url, POPUP_NAME, features);
    if (!popup) {
      return redirectToPassport(nextPath);
    }
    return waitForLoginPopup(popup);
  }

  /** 桌面浏览器：游戏站 login 弹窗（与原有网页版一致）。 */
  function openGameLoginPopup(nextPath) {
    const next = nextPath || window.location.pathname + window.location.search;
    const done = '/pwa/login-done?return=' + encodeURIComponent(next);
    const url = '/login?popup=1&next=' + encodeURIComponent(done);
    const w = 420;
    const h = 560;
    const left = Math.max(0, (window.screen.width - w) / 2);
    const top = Math.max(0, (window.screen.height - h) / 2);
    const features = 'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top;
    const popup = window.open(url, POPUP_NAME, features);
    if (!popup) {
      return redirectToPassport(nextPath);
    }
    return waitForLoginPopup(popup);
  }

  function loginPopup(nextPath) {
    if (isStandalonePwa()) {
      return openPassportPopup(nextPath);
    }
    if (isMobileBrowser()) {
      return redirectToPassport(nextPath);
    }
    return openGameLoginPopup(nextPath);
  }

  function bindLoginButtons() {
    document.querySelectorAll('[data-passport-login]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        const next = el.getAttribute('data-next') || '/';
        loginPopup(next).then(function () {
          window.location.reload();
        }).catch(function () {});
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindLoginButtons);
  } else {
    bindLoginButtons();
  }

  window.PotatoblockPassportLogin = {
    loginPopup: loginPopup,
    MESSAGE_TYPE: MESSAGE_TYPE,
    passportLoginUrl: passportLoginUrl,
    isStandalonePwa: isStandalonePwa,
  };
})();
