(function (global) {
  'use strict';

  const CODE_NAMES = {
    BracketLeft: '[',
    BracketRight: ']',
    Slash: '/',
    Delete: 'Delete',
    Enter: 'Enter',
    Space: 'Space',
    Backspace: 'Backspace',
    Comma: ',',
    Minus: '-',
    Equal: '='
  };

  /** 将键盘事件规范化为 Mod+Shift+KeyX 形式。 */
  function normalizeShortcut(event) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return '';
    const parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('Mod');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(event.code || event.key);
    return parts.join('+');
  }

  /** 将规范键位格式化为可读文本。 */
  function formatShortcut(shortcut) {
    if (!shortcut) return '未绑定';
    return shortcut.split('+').map(part => {
      if (part === 'Mod') return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
      if (part === 'Shift') return 'Shift';
      if (part === 'Alt') return 'Alt';
      if (part.startsWith('Key')) return part.slice(3);
      if (part.startsWith('Digit')) return part.slice(5);
      if (part.startsWith('F') && /^F\d+$/.test(part)) return part;
      return CODE_NAMES[part] || part;
    }).join(' + ');
  }

  /** 全局快捷键：双绑、捕获、冲突检测、分发。 */
  class ShortcutManager {
    constructor(options) {
      const settings = options || {};
      this.bindings = ShortcutRegistry.loadBindings();
      this.execute = settings.execute || (() => {});
      this.isModalOpen = settings.isModalOpen || (() => false);
      this.isPopupOpen = settings.isPopupOpen || (() => false);
      this.isRoomActive = settings.isRoomActive || (() => false);
      this.capturing = null;
      this.onCaptureChange = settings.onCaptureChange || (() => {});
      this.onStatus = settings.onStatus || (() => {});
      this._onKeyDown = this._onKeyDown.bind(this);
      document.addEventListener('keydown', this._onKeyDown, true);
    }

    getBindings() {
      return this.bindings;
    }

    /** 查找占用该组合键的动作 id。 */
    findConflict(shortcut, excludeAction, excludeSlot) {
      if (!shortcut) return '';
      return Object.keys(this.bindings).find(actionId => {
        if (actionId === excludeAction) {
          const slots = this.bindings[actionId];
          return slots.some((value, index) => value === shortcut && index !== excludeSlot);
        }
        return this.bindings[actionId].some(value => value === shortcut);
      }) || '';
    }

    /** 开始捕获某动作的主/副键位。 */
    startCapture(actionId, slotIndex) {
      this.capturing = { actionId, slotIndex };
      this.onCaptureChange(this.capturing);
    }

    cancelCapture() {
      this.capturing = null;
      this.onCaptureChange(null);
    }

    /** 写入键位；冲突时返回 false。 */
    assignBinding(actionId, slotIndex, shortcut) {
      if (!this.bindings[actionId]) return false;
      const conflict = this.findConflict(shortcut, actionId, slotIndex);
      if (conflict) {
        const label = ShortcutRegistry.ACTION_DEFS[conflict].label;
        this.onStatus('该键位已用于「' + label + '」');
        return false;
      }
      this.bindings[actionId][slotIndex] = shortcut || '';
      ShortcutRegistry.saveBindings(this.bindings);
      this.onStatus(shortcut ? '快捷键已保存' : '已清除绑定');
      return true;
    }

    clearBinding(actionId, slotIndex) {
      return this.assignBinding(actionId, slotIndex, '');
    }

    resetDefaults() {
      this.bindings = ShortcutRegistry.defaultBindings();
      ShortcutRegistry.saveBindings(this.bindings);
      this.onStatus('已恢复默认快捷键');
    }

    /** 根据按下的组合键查找动作。 */
    resolveAction(event) {
      const pressed = normalizeShortcut(event);
      if (!pressed) return '';
      return Object.keys(this.bindings).find(actionId =>
        this.bindings[actionId].some(value => value && value === pressed)
      ) || '';
    }

    _onKeyDown(event) {
      if (this.capturing) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          this.cancelCapture();
          this.onStatus('已取消设置');
          return;
        }
        const next = normalizeShortcut(event);
        if (!next) return;
        const ok = this.assignBinding(
          this.capturing.actionId,
          this.capturing.slotIndex,
          next
        );
        if (ok) this.cancelCapture();
        return;
      }

      if (this.isModalOpen() || this.isPopupOpen()) {
        if (event.key === 'Escape') return;
        return;
      }

      if (!this.isRoomActive()) return;
      const target = event.target;
      if (target && target.matches('input, textarea, select, [contenteditable="true"]')) return;

      const actionId = this.resolveAction(event);
      if (!actionId) return;
      event.preventDefault();
      event.stopPropagation();
      this.execute(actionId);
    }
  }

  global.ShortcutManager = ShortcutManager;
  global.normalizeShortcut = normalizeShortcut;
  global.formatShortcut = formatShortcut;
})(window);
