(function (global) {
  'use strict';

  const MODE_KEY = 'collab-color-picker-mode';
  const MODES = ['hsv', 'wheel', 'rgb', 'hsl'];

  /** 读取用户偏好的取色模式。 */
  function loadMode(defaultMode) {
    const fallback = MODES.includes(defaultMode) ? defaultMode : 'hsv';
    try {
      const saved = localStorage.getItem(MODE_KEY);
      return MODES.includes(saved) ? saved : fallback;
    } catch (_err) {
      return fallback;
    }
  }

  /** 持久化取色模式选择。 */
  function saveMode(mode) {
    if (!MODES.includes(mode)) return;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch (_err) {}
  }

  global.ColorSettings = { MODE_KEY, MODES, loadMode, saveMode };
})(window);
