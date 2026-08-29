(function (global) {
  'use strict';

  /** 将指针事件委派给当前工具 handler。 */
  class ToolController {
    constructor() {
      this._handlers = new Map();
      this._board = null;
    }

    /** 绑定画板控制器供 handler 使用。 */
    attachBoard(board) {
      this._board = board;
    }

    /** 注册工具 handler：{ onPointerDown, onPointerMove, onPointerUp, cursor? }。 */
    register(toolId, handler) {
      this._handlers.set(toolId, handler || {});
    }

    getHandler(toolId) {
      return this._handlers.get(toolId) || null;
    }

    /** 返回当前工具 handler，未注册则 null。 */
    current() {
      if (!this._board) return null;
      return this.getHandler(this._board.currentTool);
    }

    _ctx(event) {
      return { board: this._board, event };
    }

    onPointerDown(event) {
      const handler = this.current();
      if (!handler || !handler.onPointerDown) return false;
      return handler.onPointerDown(this._ctx(event)) !== false;
    }

    onPointerMove(event) {
      const handler = this.current();
      if (!handler || !handler.onPointerMove) return false;
      return handler.onPointerMove(this._ctx(event)) !== false;
    }

    onPointerUp(event) {
      const handler = this.current();
      if (!handler || !handler.onPointerUp) return false;
      return handler.onPointerUp(this._ctx(event)) !== false;
    }
  }

  global.ToolController = ToolController;
})(window);
