(function (global) {
  'use strict';

  const CURSOR_HZ = 15;

  /** WebSocket 连接、房间与消息分发。 */
  class CollabSession {
    constructor(options) {
      const settings = options || {};
      this.wsUrl = settings.wsUrl || '';
      this.selfId = settings.selfId || '';
      this.nickname = settings.nickname || '';
      this.getDisplayName = settings.getDisplayName || null;
      this.handlers = settings.handlers || {};
      this.ws = null;
      this.roomId = '';
      this.connected = false;
      this._pendingJoin = null;
      this._cursorTimer = 0;
      this._lastCursorSent = 0;
      this._pendingCursor = null;
      this._syncWaiters = new Map();
      this._pingWaiter = null;
      this.lastRtt = null;
      this.lastPingAt = null;
      this.lastError = '';
    }

    connect() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
      const url = this._buildWsUrl();
      this.ws = new WebSocket(url);
      this.ws.addEventListener('open', () => {
        this.connected = true;
        this._emit('open');
        if (this._pendingJoin) {
          const pending = this._pendingJoin;
          this._pendingJoin = null;
          this.joinRoom(pending.room);
        }
      });
      this.ws.addEventListener('close', () => {
        this.connected = false;
        this.ws = null;
        this._emit('close');
      });
      this.ws.addEventListener('message', event => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (_err) {
          return;
        }
        this._dispatch(data);
      });
    }

    _buildWsUrl() {
      const base = this.wsUrl || (location.origin.replace(/^http/, 'ws') + '/collab-canvas/ws');
      const params = new URLSearchParams(location.search);
      const devUser = params.get('dev_user');
      const devName = params.get('dev_name');
      if (!devUser && !devName) return base;
      const url = new URL(base);
      if (devUser) url.searchParams.set('dev_user', devUser);
      if (devName) url.searchParams.set('dev_name', devName);
      return url.toString();
    }

    /** 发送 ping 并等待 pong，返回 RTT（毫秒）。 */
    ping(timeoutMs) {
      const timeout = Number(timeoutMs) || 3000;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.lastError = 'WebSocket 未连接';
        return Promise.reject(new Error(this.lastError));
      }
      if (this._pingWaiter) {
        return Promise.reject(new Error('已有检测进行中'));
      }
      const sentAt = performance.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pingWaiter = null;
          this.lastError = '检测超时';
          reject(new Error(this.lastError));
        }, timeout);
        this._pingWaiter = {
          resolve: rtt => {
            clearTimeout(timer);
            this._pingWaiter = null;
            this.lastRtt = rtt;
            this.lastPingAt = Date.now();
            this.lastError = '';
            resolve(rtt);
          },
          reject: err => {
            clearTimeout(timer);
            this._pingWaiter = null;
            this.lastError = err.message || '检测失败';
            reject(err);
          },
          sentAt
        };
        if (!this.send({ type: 'ping' })) {
          clearTimeout(timer);
          this._pingWaiter = null;
          this.lastError = '发送 ping 失败';
          reject(new Error(this.lastError));
        }
      });
    }

    /** 返回连接状态摘要，供网络面板显示。 */
    getConnectionInfo() {
      let statusLabel = '断开';
      if (this.ws) {
        if (this.ws.readyState === WebSocket.CONNECTING) statusLabel = '连接中';
        else if (this.ws.readyState === WebSocket.OPEN) statusLabel = '已连接';
        else if (this.ws.readyState === WebSocket.CLOSING) statusLabel = '关闭中';
      }
      return {
        connected: this.connected,
        readyState: this.ws ? this.ws.readyState : WebSocket.CLOSED,
        statusLabel,
        roomId: this.roomId || '',
        lastRtt: this.lastRtt,
        lastPingAt: this.lastPingAt,
        lastError: this.lastError
      };
    }

    /** 向服务端发送 .pbcc 文档以覆盖房间画板（仅房主）。 */
    sendRoomImport(document) {
      return this.send({ type: 'room_import', document });
    }

    send(payload) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      this.ws.send(JSON.stringify(payload));
      return true;
    }

    /** 向服务端请求指定画板 strokes 快照；用于导出非当前画板。 */
    requestBoardSync(boardId, timeoutMs) {
      const id = String(boardId || '');
      const timeout = Number(timeoutMs) || 8000;
      if (!id) return Promise.reject(new Error('无效画板 ID'));
      if (this._syncWaiters.has(id)) {
        return this._syncWaiters.get(id).promise;
      }
      let resolveFn;
      let rejectFn;
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      const timer = setTimeout(() => {
        this._syncWaiters.delete(id);
        rejectFn(new Error('画板同步超时'));
      }, timeout);
      this._syncWaiters.set(id, { resolve: resolveFn, reject: rejectFn, timer, promise });
      if (!this.send({ type: 'drawing_sync_request', board_id: id })) {
        clearTimeout(timer);
        this._syncWaiters.delete(id);
        return Promise.reject(new Error('连接未就绪'));
      }
      return promise;
    }

    _resolveSyncWaiter(data) {
      const boardId = String(data && data.board_id || '');
      if (!boardId) return false;
      const waiter = this._syncWaiters.get(boardId);
      if (!waiter) return false;
      clearTimeout(waiter.timer);
      this._syncWaiters.delete(boardId);
      waiter.resolve(data);
      return true;
    }

    joinRoom(roomId) {
      this.roomId = String(roomId || '').trim().toUpperCase().slice(0, 6);
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this._pendingJoin = { room: this.roomId };
        this.connect();
        return;
      }
      const displayName = this.getDisplayName ? this.getDisplayName() : this.nickname;
      this.send({ type: 'join', room: this.roomId, name: displayName });
    }

    sendCursor(boardId, x, y, drawing, extras) {
      const extra = extras || {};
      this._pendingCursor = {
        boardId,
        x,
        y,
        drawing: Boolean(drawing),
        size: extra.size,
        label_color: extra.label_color
      };
      const now = performance.now();
      if (now - this._lastCursorSent < 1000 / CURSOR_HZ) return;
      this._flushCursor();
    }

    /** 上送联机展示偏好（他人看到的用户名与标签色）。 */
    sendPlayerStyle(style) {
      const payload = { type: 'player_style' };
      if (style && typeof style === 'object') {
        if (style.label_color != null) payload.label_color = style.label_color || '';
        if (style.display_name != null) payload.display_name = String(style.display_name || '').trim();
      } else {
        payload.label_color = style || '';
      }
      this.send(payload);
    }

    _flushCursor() {
      if (!this._pendingCursor) return;
      const c = this._pendingCursor;
      this._lastCursorSent = performance.now();
      const payload = {
        type: 'cursor_move',
        board_id: c.boardId,
        x: c.x,
        y: c.y,
        drawing: c.drawing
      };
      if (c.size != null) payload.size = c.size;
      if (c.label_color) payload.label_color = c.label_color;
      this.send(payload);
    }

    _dispatch(data) {
      const type = data && data.type;
      if (!type) return;
      if (type === 'pong' && this._pingWaiter) {
        const rtt = Math.round(performance.now() - this._pingWaiter.sentAt);
        this._pingWaiter.resolve(rtt);
        return;
      }
      if (type === 'drawing_sync') this._resolveSyncWaiter(data);
      const handler = this.handlers[type] || this.handlers['*'];
      if (handler) handler(data);
      if (type === 'room_state' && data.room_id) {
        this.roomId = data.room_id;
      }
    }

    _emit(name, payload) {
      const handler = this.handlers[name];
      if (handler) handler(payload);
    }

    disconnect() {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    }

    /** 房主：设置房客权限；target_id 省略则作用于全部房客。 */
    sendHostPermissions(patch) {
      const payload = Object.assign({ type: 'host_set_permissions' }, patch || {});
      return this.send(payload);
    }

    /** 房主：踢出指定玩家。 */
    kickPlayer(targetId) {
      return this.send({ type: 'kick_player', target_id: String(targetId || '') });
    }
  }

  global.CollabSession = CollabSession;
})(window);
