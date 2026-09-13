/** 通行证登录入口：本站认证已统一为 Passport OAuth2/OIDC（Authorization Code + PKCE）。
 *
 * 浏览器只负责跳到 /login，state / PKCE code_verifier / nonce 全部由服务端生成并暂存，
 * 不再使用 JWT 桥接、弹窗 postMessage 或前端换票。
 */
(function () {
  'use strict';

  /** 登录完成后应回到的路径（相对本站）。 */
  function defaultNextPath() {
    return window.location.pathname + window.location.search;
  }

  /** 跳转服务端登录入口（会 302 到 Passport 授权页）。 */
  function loginPopup(nextPath) {
    var next = nextPath && nextPath.charAt(0) === '/' ? nextPath : defaultNextPath();
    window.location.assign('/login?next=' + encodeURIComponent(next));
    return new Promise(function () {});
  }

  function bindLoginButtons() {
    document.querySelectorAll('[data-passport-login]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        loginPopup(el.getAttribute('data-next') || defaultNextPath());
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
    loginUrl: function (nextPath) {
      var next = nextPath && nextPath.charAt(0) === '/' ? nextPath : defaultNextPath();
      return '/login?next=' + encodeURIComponent(next);
    }
  };
})();
