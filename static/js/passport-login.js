/** 通行证登录：跳转 passport 站（新人机验证）；桌面可弹窗，移动端整页跳转。 */
(function () {
  'use strict';

  const POPUP_NAME = 'potatoblock-passport-login';
  const MESSAGE_TYPE = 'pb-login-done';
  const PASSPORT_ORIGIN = 'https://passport.potatoblock.com';

  /** 登录完成后应回到的路径（相对本站）。 */
  function defaultNextPath() {
    return window.location.pathname + window.location.search;
  }

  /** 平板/手机或 PWA 独立窗口。 */
  function isMobileLike() {
    if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) return true;
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    return 'ontouchstart' in window && window.matchMedia('(pointer: coarse)').matches;
  }

  /** 构建 passport 登录 URL（return_url 回游戏站，经 SSO 桥接写 session）。 */
  function passportLoginUrl(nextPath) {
    var next = nextPath || defaultNextPath();
    var returnUrl = window.location.origin + (next.charAt(0) === '/' ? next : '/' + next);
    return PASSPORT_ORIGIN + '/login?return_url=' + encodeURIComponent(returnUrl);
  }

  /** 等待弹窗登录完成（postMessage 或 /api/me 轮询）。 */
  function waitForLoginComplete(loginTab) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var pollTimer = null;
      var closeTimer = null;

      function cleanup() {
        window.removeEventListener('message', onMessage);
        document.removeEventListener('visibilitychange', onVisibility);
        clearInterval(pollTimer);
        clearInterval(closeTimer);
      }

      function finish(ok, data, err) {
        if (settled) return;
        settled = true;
        cleanup();
        if (ok) resolve(data || { ok: true });
        else reject(err || new Error('login cancelled'));
      }

      function onMessage(event) {
        if (event.origin !== window.location.origin) return;
        var payload = event.data || {};
        if (payload.type !== MESSAGE_TYPE) return;
        finish(!!payload.ok, payload, payload.ok ? null : new Error(payload.error || 'login failed'));
      }

      function pollMe() {
        fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' })
          .then(function (response) {
            if (!response.ok) return null;
            return response.json();
          })
          .then(function (data) {
            if (data && data.user_id) {
              finish(true, { ok: true, via: 'poll', return: defaultNextPath() });
            }
          })
          .catch(function () {});
      }

      function onVisibility() {
        if (document.visibilityState === 'visible') pollMe();
      }

      window.addEventListener('message', onMessage);
      document.addEventListener('visibilitychange', onVisibility);
      pollTimer = setInterval(pollMe, 2000);
      closeTimer = setInterval(function () {
        if (!loginTab || !loginTab.closed) return;
        pollMe();
        setTimeout(function () {
          if (!settled) finish(false, null, new Error('login tab closed'));
        }, 800);
      }, 500);
    });
  }

  /** 打开 passport 登录；移动端整页跳转。 */
  function loginPopup(nextPath) {
    var url = passportLoginUrl(nextPath);
    if (isMobileLike()) {
      window.location.assign(url);
      return new Promise(function () {});
    }
    var w = 440;
    var h = 640;
    var left = Math.max(0, (window.screen.width - w) / 2);
    var top = Math.max(0, (window.screen.height - h) / 2);
    var features = 'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top;
    var tab = window.open(url, POPUP_NAME, features);
    if (!tab) {
      window.location.assign(url);
      return new Promise(function () {});
    }
    return waitForLoginComplete(tab);
  }

  /** 登录成功后跳转到 return 路径或刷新当前页。 */
  function finishLogin(data) {
    var ret = (data && data.return) ? String(data.return) : defaultNextPath();
    if (ret.charAt(0) === '/') {
      window.location.assign(ret);
    } else {
      window.location.reload();
    }
  }

  function bindLoginButtons() {
    document.querySelectorAll('[data-passport-login]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var next = el.getAttribute('data-next') || defaultNextPath();
        loginPopup(next).then(finishLogin).catch(function () {});
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
    passportLoginUrl: passportLoginUrl,
    MESSAGE_TYPE: MESSAGE_TYPE,
    isMobileLike: isMobileLike
  };
})();
