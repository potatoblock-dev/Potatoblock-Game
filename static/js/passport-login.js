/** 通行证登录：桌面弹窗；移动端/PWA 跳转 passport 站（带人机验证）。 */
(function () {
  'use strict';

  const POPUP_NAME = 'potatoblock-passport-login';
  const MESSAGE_TYPE = 'pb-login-done';
  const PASSPORT_ORIGIN = 'https://passport.potatoblock.com';

  function isMobileLike() {
    return window.matchMedia('(max-width: 767px)').matches
      || window.matchMedia('(pointer: coarse)').matches
      || navigator.maxTouchPoints > 1
      || window.matchMedia('(display-mode: standalone)').matches;
  }

  function passportLoginUrl(returnPath) {
    const next = returnPath || window.location.pathname + window.location.search;
    const returnUrl = window.location.origin + next;
    return PASSPORT_ORIGIN + '/login?return_url=' + encodeURIComponent(returnUrl);
  }

  /** 移动端/PWA：整页跳转 passport；返回 pending，避免 then 里 reload 打断导航。 */
  function redirectToPassport(nextPath) {
    window.location.assign(passportLoginUrl(nextPath));
    return new Promise(function () {});
  }

  function loginPopup(nextPath) {
    if (isMobileLike()) {
      return redirectToPassport(nextPath);
    }

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
    return new Promise((resolve, reject) => {
      function onMessage(event) {
        if (event.origin !== window.location.origin) return;
        const data = event.data || {};
        if (data.type !== MESSAGE_TYPE) return;
        window.removeEventListener('message', onMessage);
        if (data.ok) {
          resolve(data);
        } else {
          reject(new Error(data.error || 'login failed'));
        }
      }
      window.addEventListener('message', onMessage);
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          window.removeEventListener('message', onMessage);
          reject(new Error('popup closed'));
        }
      }, 500);
    });
  }

  function bindLoginButtons() {
    document.querySelectorAll('[data-passport-login]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const next = el.getAttribute('data-next') || '/';
        loginPopup(next).then(() => {
          window.location.reload();
        }).catch(() => {});
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindLoginButtons);
  } else {
    bindLoginButtons();
  }

  window.PotatoblockPassportLogin = { loginPopup, MESSAGE_TYPE, passportLoginUrl };
})();
