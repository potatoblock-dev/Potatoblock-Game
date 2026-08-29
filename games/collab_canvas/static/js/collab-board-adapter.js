(function (global) {
  'use strict';

  const MAX_BATCH_SEGMENTS = 60;
  const BATCH_MS = 24;

  /** 合作画板出站批量：所有 draw 消息带 board_id。 */
  class CollabBoardAdapter {
    constructor(options) {
      const settings = options || {};
      this.send = settings.send;
      this.getBoardId = settings.getBoardId;
      this.getLayerId = settings.getLayerId || (() => 'l_default');
      this._queue = [];
      this._flushTimer = null;
    }

    sendSegment(strokeId, segment, options) {
      const immediate = Boolean(options && options.immediate);
      this._queue.push({ strokeId: String(strokeId), segment: Object.assign({}, segment) });
      if (immediate) {
        this.flushSegments();
        return true;
      }
      this._scheduleFlush();
      return true;
    }

    _scheduleFlush() {
      if (this._flushTimer != null) return;
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this.flushSegments();
      }, BATCH_MS);
    }

    flushSegments() {
      if (this._flushTimer != null) {
        clearTimeout(this._flushTimer);
        this._flushTimer = null;
      }
      if (!this._queue.length || typeof this.send !== 'function') return;
      const boardId = String(this.getBoardId() || '');
      const layerId = String(this.getLayerId() || 'l_default');
      if (!boardId) {
        this._queue = [];
        return;
      }
      const pending = this._queue;
      this._queue = [];
      const groups = [];
      const indexByStroke = new Map();
      pending.forEach(item => {
        let group = indexByStroke.get(item.strokeId);
        if (!group) {
          group = { strokeId: item.strokeId, segments: [] };
          indexByStroke.set(item.strokeId, group);
          groups.push(group);
        }
        group.segments.push(item.segment);
      });
      groups.forEach(group => {
        if (group.segments.length === 1) {
          this.send(Object.assign(
            { type: 'draw', board_id: boardId, layer_id: layerId, stroke_id: group.strokeId },
            group.segments[0]
          ));
          return;
        }
        for (let start = 0; start < group.segments.length; start += MAX_BATCH_SEGMENTS) {
          this.send({
            type: 'draw_batch',
            board_id: boardId,
            layer_id: layerId,
            stroke_id: group.strokeId,
            segments: group.segments.slice(start, start + MAX_BATCH_SEGMENTS)
          });
        }
      });
    }

    requestRepairSync() {
      this.flushSegments();
      const boardId = String(this.getBoardId() || '');
      if (!boardId) return false;
      this.send({ type: 'drawing_sync_request', board_id: boardId });
      return true;
    }

    sendHistoryAction(action) {
      if (!['undo', 'redo', 'clear'].includes(action)) return false;
      this.flushSegments();
      const boardId = String(this.getBoardId() || '');
      const layerId = String(this.getLayerId() || 'l_default');
      if (!boardId) return false;
      this.send({ type: action, board_id: boardId, layer_id: layerId });
      return true;
    }
  }

  global.CollabBoardAdapter = CollabBoardAdapter;
})(window);
