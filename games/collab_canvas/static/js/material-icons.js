(function (global) {
  'use strict';

  /** 创建 Material Symbols Outlined 图标节点。 */
  function createIcon(name, className, options) {
    const settings = options || {};
    const span = document.createElement('span');
    span.className = 'material-symbols-outlined' + (className ? ' ' + className : '');
    if (settings.filled) span.classList.add('material-symbols--filled');
    span.setAttribute('aria-hidden', 'true');
    span.textContent = name;
    return span;
  }

  /** 创建空心/实心几何形状 SVG 图标（矩形、圆形工具变体）。 */
  function createShapeIcon(shape, filled, className) {
    const span = document.createElement('span');
    span.className = 'tool-shape-icon' + (className ? ' ' + className : '');
    span.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('aria-hidden', 'true');

    if (shape === 'rect') {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '5');
      rect.setAttribute('y', '5');
      rect.setAttribute('width', '14');
      rect.setAttribute('height', '14');
      if (filled) {
        rect.setAttribute('fill', 'currentColor');
      } else {
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', 'currentColor');
        rect.setAttribute('stroke-width', '2');
      }
      svg.appendChild(rect);
    } else if (shape === 'ellipse') {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '7');
      if (filled) {
        circle.setAttribute('fill', 'currentColor');
      } else {
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', 'currentColor');
        circle.setAttribute('stroke-width', '2');
      }
      svg.appendChild(circle);
    }

    span.appendChild(svg);
    return span;
  }

  /** 按工具元数据创建图标（Material 或自定义形状）。 */
  function createToolIcon(meta, className) {
    const spec = meta || {};
    if (spec.shapeIcon) {
      return createShapeIcon(spec.shapeIcon, !!spec.filled, className);
    }
    return createIcon(spec.icon || 'help', className, { filled: !!spec.filled });
  }

  /** 返回图标 HTML 字符串（静态模板用）。 */
  function iconHtml(name, className) {
    const cls = 'material-symbols-outlined' + (className ? ' ' + className : '');
    return '<span class="' + cls + '" aria-hidden="true">' + name + '</span>';
  }

  global.MaterialIcons = { createIcon, createShapeIcon, createToolIcon, iconHtml };
})(window);
