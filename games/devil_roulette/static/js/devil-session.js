(function (global) {
  'use strict';

  /** WebSocket 连接、房间与消息分发。 */
  class DevilSession {
    constructor(options) {
      const settings = options || {};
      this.wsUrl = settings.wsUrl || '';
      this.selfId = settings.selfId || '';
      this.nickname = settings.nickname || '';
      this.handlers = settings.handlers || {};
      this.ws = null;
      this.roomId = '';
      this.connected = false;
      this._pendingJoin = null;
    }

    connect() {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      this.ws = new WebSocket(this._buildWsUrl());
      this.ws.addEventListener('open', () => {
        this.connected = true;
        this._emit('open');
        if (this._pendingJoin) {
          const pending = this._pendingJoin;
          this._pendingJoin = null;
          this.joinRoom(pending.room, pending.name);
        }
      });
      this.ws.addEventListener('close', () => {
        this.connected = false;
        this.ws = null;
        this._emit('close');
      });
      this.ws.addEventListener('message', event => {
        let data;
        try { data = JSON.parse(event.data); } catch (_e) { return; }
        this._dispatch(data);
      });
    }

    _buildWsUrl() {
      const base = this.wsUrl || (location.origin.replace(/^http/, 'ws') + '/devil-roulette/ws');
      const params = new URLSearchParams(location.search);
      const devUser = params.get('dev_user');
      const devName = params.get('dev_name');
      const qs = new URLSearchParams();
      if (devUser) qs.set('dev_user', devUser);
      if (devName) qs.set('dev_name', devName);
      const q = qs.toString();
      return q ? `${base}?${q}` : base;
    }

    joinRoom(room, name) {
      const roomId = String(room || '').trim();
      if (!roomId) return;
      this.roomId = roomId;
      if (!this.connected) {
        this._pendingJoin = { room: roomId, name: name || this.nickname };
        this.connect();
        return;
      }
      this.send({ type: 'join', room: roomId, name: name || this.nickname });
    }

    leaveRoom() {
      this.send({ type: 'leave' });
      this.roomId = '';
    }

    startGame() {
      this.send({ type: 'start_game' });
    }

    useItem(itemId) {
      this.send({ type: 'use_item', item_id: itemId });
    }

    shoot(target) {
      this.send({ type: 'shoot', target });
    }

    send(payload) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify(payload));
    }

    on(event, handler) {
      this.handlers[event] = handler;
    }

    _emit(event, data) {
      const fn = this.handlers[event];
      if (typeof fn === 'function') fn(data);
    }

    _dispatch(data) {
      const type = data?.type;
      if (!type) return;
      this._emit(type, data);
      this._emit('message', data);
    }
  }

  global.DevilSession = DevilSession;
})(typeof window !== 'undefined' ? window : globalThis);
