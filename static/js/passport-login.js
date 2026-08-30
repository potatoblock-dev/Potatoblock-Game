/** 通行证 OAuth2/OIDC 登录：新标签页 authorize + PKCE；原页等待 login-done。 */
(function () {
  'use strict';

  const TAB_NAME = 'potatoblock-passport-login';
  const MESSAGE_TYPE = 'pb-login-done';
  const CHANNEL_NAME = 'potatoblock-passport-login';
  const PASSPORT_ORIGIN = 'https://passport.potatoblock.com';
  const OAUTH_SCOPE = 'openid profile';
  const PKCE_STORAGE = 'pb_oauth_pkce';
  const CLIENT_ID_PROD = 'potatoblock-game';
  const CLIENT_ID_DEV = 'potatoblock-game-dev';

  /** 登录完成后应回到的路径（相对本站）。 */
  function defaultNextPath() {
    return window.location.pathname + window.location.search;
  }

  /** 按环境选择 OAuth client_id。 */
  function oauthClientId() {
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return CLIENT_ID_DEV;
    }
    return CLIENT_ID_PROD;
  }

  /** OAuth redirect_uri，须与 Passport 注册一致。 */
  function oauthRedirectUri() {
    return window.location.origin + '/pwa/login-done';
  }

  /** 平板/手机：整页跳转 OAuth，避免弹窗被拦后丢失回跳上下文。 */
  function isMobileLike() {
    if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) return true;
    return 'ontouchstart' in window && window.matchMedia('(pointer: coarse)').matches;
  }

  /** 生成 PKCE verifier/challenge 与 state/nonce。 */
  function randomString(bytes) {
    var arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode.apply(null, arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256Base64Url(input) {
    var data = new TextEncoder().encode(input);
    var hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** 创建并 sessionStorage 保存 PKCE 上下文。 */
  async function createPkceContext(returnPath) {
    var verifier = randomString(32);
    var challenge = await sha256Base64Url(verifier);
    var ctx = {
      verifier: verifier,
      state: randomString(16),
      nonce: randomString(16),
      return: returnPath || defaultNextPath()
    };
    sessionStorage.setItem(PKCE_STORAGE, JSON.stringify(ctx));
    try { localStorage.setItem(PKCE_STORAGE, JSON.stringify(ctx)); } catch (e) {}
    return { ctx: ctx, challenge: challenge };
  }

  /** 构建 OAuth authorize URL。 */
  async function oauthAuthorizeUrl(nextPath) {
    var built = await createPkceContext(nextPath);
    var params = new URLSearchParams({
      client_id: oauthClientId(),
      redirect_uri: oauthRedirectUri(),
      response_type: 'code',
      scope: OAUTH_SCOPE,
      state: built.ctx.state,
      code_challenge: built.challenge,
      code_challenge_method: 'S256',
      nonce: built.ctx.nonce
    });
    return PASSPORT_ORIGIN + '/oauth/authorize?' + params.toString();
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

  /** 原标签页等待 login-done 通知。 */
  function waitForLoginComplete(loginTab) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var channel = null;
      var pollTimer = null;
      var closeTimer = null;

      function cleanup() {
        window.removeEventListener('message', onMessage);
        document.removeEventListener('visibilitychange', onVisibility);
        if (channel) {
          try { channel.close(); } catch (err) {}
        }
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

      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = function (event) {
          var payload = event.data || {};
          if (payload.type !== MESSAGE_TYPE) return;
          finish(!!payload.ok, payload, payload.ok ? null : new Error(payload.error || 'login failed'));
        };
      }

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

  /** 新标签页打开 OAuth authorize；移动端直接整页跳转。 */
  function openLoginTab(nextPath) {
    return oauthAuthorizeUrl(nextPath).then(function (url) {
      if (isMobileLike()) {
        window.location.assign(url);
        return new Promise(function () {});
      }
      var tab = window.open(url, TAB_NAME);
      if (!tab) {
        window.location.assign(url);
        return new Promise(function () {});
      }
      return waitForLoginComplete(tab);
    });
  }

  function loginPopup(nextPath) {
    return openLoginTab(nextPath);
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

  /** 登录页带 next 或 auto_oauth 时在移动端自动发起 OAuth。 */
  (function maybeAutoStartLogin() {
    var params = new URLSearchParams(location.search);
    if (location.pathname !== '/login') return;
    var next = params.get('next') || '/';
    var shouldAuto = params.get('auto_oauth') === '1' ||
      (isMobileLike() && params.has('next'));
    if (!shouldAuto) return;
    loginPopup(next).then(finishLogin).catch(function () {});
  })();

  window.PotatoblockPassportLogin = {
    loginPopup: loginPopup,
    MESSAGE_TYPE: MESSAGE_TYPE,
    oauthAuthorizeUrl: oauthAuthorizeUrl,
    oauthRedirectUri: oauthRedirectUri,
    PKCE_STORAGE: PKCE_STORAGE,
    isMobileLike: isMobileLike
  };
})();
