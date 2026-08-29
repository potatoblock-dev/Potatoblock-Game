(function (global) {
  'use strict';

  const AUTO_PING_MS = 30000;

  /** 设置弹窗「网络」Tab：连接状态与 RTT 检测。 */
  class NetworkMonitor {
    constructor(options) {
      const settings = options || {};
      this.session = settings.session;
      this.root = settings.root;
      this.statusEl = this.root && this.root.querySelector('[data-net-status]');
      this.roomEl = this.root && this.root.querySelector('[data-net-room]');
      this.rttEl = this.root && this.root.querySelector('[data-net-rtt]');
      this.timeEl = this.root && this.root.querySelector('[data-net-time]');
      this.errorEl = this.root && this.root.querySelector('[data-net-error]');
      this.testBtn = this.root && this.root.querySelector('[data-net-test]');
      this._timer = null;
      this._active = false;
      if (this.testBtn) {
        this.testBtn.addEventListener('click', () => this.runTest(true));
      }
    }

    /** Tab 激活时开始刷新；离开时停止。 */
    setActive(active) {
      this._active = Boolean(active);
      if (this._active) {
        this.refresh();
        this.runTest(false);
        this._timer = setInterval(() => {
          if (this._active) this.runTest(false);
        }, AUTO_PING_MS);
      } else if (this._timer != null) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }

    /** 刷新静态连接信息。 */
    refresh() {
      const info = this.session ? this.session.getConnectionInfo() : {};
      if (this.statusEl) this.statusEl.textContent = info.statusLabel || '未知';
      if (this.roomEl) this.roomEl.textContent = info.roomId || '—';
      if (this.rttEl) {
        this.rttEl.textContent = info.lastRtt != null ? info.lastRtt + ' ms' : '—';
      }
      if (this.timeEl) {
        this.timeEl.textContent = info.lastPingAt
          ? new Date(info.lastPingAt).toLocaleTimeString()
          : '—';
      }
      if (this.errorEl) this.errorEl.textContent = info.lastError || '';
    }

    /** 执行 ping 检测并更新 UI。 */
    async runTest(showBusy) {
      if (!this.session) return;
      if (showBusy && this.testBtn) {
        this.testBtn.disabled = true;
        this.testBtn.textContent = '检测中…';
      }
      if (this.errorEl && showBusy) this.errorEl.textContent = '';
      try {
        await this.session.ping();
        if (this.errorEl) this.errorEl.textContent = '';
      } catch (err) {
        if (this.errorEl) this.errorEl.textContent = err.message || '检测失败';
      } finally {
        this.refresh();
        if (this.testBtn) {
          this.testBtn.disabled = false;
          this.testBtn.textContent = '检测连接';
        }
      }
    }
  }

  global.NetworkMonitor = NetworkMonitor;
})(window);
