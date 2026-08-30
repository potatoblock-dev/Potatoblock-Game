/** 通行证登录：OAuth2 + PKCE（与 Passport OIDC 对齐；桌面弹窗 / 移动端整页）。 */
(function () {
  'use strict';

  const POPUP_NAME = 'potatoblock-passport-login';
  const MESSAGE_TYPE = 'pb-login-done';
  const PKCE_STORAGE = 'pb_oauth_pkce';
  const PASSPORT_ORIGIN = 'https://passport.potatoblock.com';
  const OAUTH_CLIENT_ID = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'potatoblock-game-dev'
    : 'potatoblock-game';

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

  /** Base64url 编码（PKCE / state）。 */
  function base64UrlEncode(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** 生成 URL-safe 随机串。 */
  function randomUrlSafe(byteLen) {
    var arr = new Uint8Array(byteLen);
    crypto.getRandomValues(arr);
    return base64UrlEncode(arr);
  }

  /** 创建 PKCE 上下文并写入 storage（平板整页跳转兜底 localStorage）。 */
  function createPkceContext(nextPath) {
    var verifier = randomUrlSafe(32);
    var state = randomUrlSafe(16);
    var nonce = randomUrlSafe(16);
    var next = nextPath || defaultNextPath();
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (hash) {
      var challenge = base64UrlEncode(new Uint8Array(hash));
      var ctx = {
        verifier: verifier,
        challenge: challenge,
        state: state,
        nonce: nonce,
        return: next,
        at: Date.now()
      };
      sessionStorage.setItem(PKCE_STORAGE, JSON.stringify(ctx));
      try { localStorage.setItem(PKCE_STORAGE, JSON.stringify(ctx)); } catch (_err) {}
      return ctx;
    });
  }

  /** 构建 Passport OAuth authorize URL。 */
  function buildAuthorizeUrl(ctx) {
    var redirectUri = location.origin + '/pwa/login-done';
    var params = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state: ctx.state,
      code_challenge: ctx.challenge,
      code_challenge_method: 'S256',
      nonce: ctx.nonce
    });
    return PASSPORT_ORIGIN + '/oauth/authorize?' + params.toString();
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

  /** 启动 OAuth 登录；移动端整页跳转，桌面优先弹窗。 */
  function loginPopup(nextPath) {
    return createPkceContext(nextPath).then(function (ctx) {
      var url = buildAuthorizeUrl(ctx);
      if (!isMobileLike()) {
        var w = 440;
        var h = 720;
        var left = Math.max(0, (window.screen.width - w) / 2);
        var top = Math.max(0, (window.screen.height - h) / 2);
        var features = 'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top;
        var tab = window.open(url, POPUP_NAME, features);
        if (tab) return waitForLoginComplete(tab);
      }
      window.location.assign(url);
      return new Promise(function () {});
    });
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
    MESSAGE_TYPE: MESSAGE_TYPE,
    isMobileLike: isMobileLike
  };
})();
