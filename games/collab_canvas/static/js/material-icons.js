(function (global) {
  'use strict';

  /** 创建 Material Symbols Outlined 图标节点。 */
  function createIcon(name, className) {
    const span = document.createElement('span');
    span.className = 'material-symbols-outlined' + (className ? ' ' + className : '');
    span.setAttribute('aria-hidden', 'true');
    span.textContent = name;
    return span;
  }

  /** 返回图标 HTML 字符串（静态模板用）。 */
  function iconHtml(name, className) {
    const cls = 'material-symbols-outlined' + (className ? ' ' + className : '');
    return '<span class="' + cls + '" aria-hidden="true">' + name + '</span>';
  }

  global.MaterialIcons = { createIcon, iconHtml };
})(window);
