(function (global) {
  'use strict';

  /** Canvas 枪械动画播放器。 */
  class GunRenderer {
    constructor(canvas, atlas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.atlas = atlas;
      this.playing = false;
      this._raf = 0;
    }

    /** 播放指定 tag 动画序列。 */
    playTag(tagName, fps) {
      if (this.playing) return Promise.resolve();
      const frameKeys = this.atlas.getTagFrames(tagName);
      if (!frameKeys.length) {
        this.drawIdle();
        return Promise.resolve();
      }
      const rate = fps || 12;
      const interval = 1000 / rate;
      let idx = 0;
      this.playing = true;
      return new Promise(resolve => {
        const tick = () => {
          if (idx >= frameKeys.length) {
            this.playing = false;
            this.drawIdle();
            resolve();
            return;
          }
          this._drawFrameKey(frameKeys[idx]);
          idx += 1;
          this._raf = window.setTimeout(tick, interval);
        };
        tick();
      });
    }

    /** 绘制 idle 帧。 */
    drawIdle() {
      this._clear();
      const keys = this.atlas.getTagFrames('idle');
      if (keys.length) {
        this._drawFrameKey(keys[0]);
        return;
      }
      this.atlas.drawFrame(this.ctx, '2', 0, 0, 2);
    }

    /** 根据 shot 事件播放动画。 */
    async playShot(animation) {
      if (animation === 'blank_smoke') {
        await this.playTag('smoke', 8);
      } else {
        await this.playTag('fire', 12);
        await this.playTag('idle', 1);
      }
    }

    _drawFrameKey(key) {
      this._clear();
      const entry = this.atlas.frames[key];
      if (!entry) return;
      const f = entry.frame;
      const scale = Math.min(this.canvas.width / f.w, this.canvas.height / f.h) * 0.9;
      const dw = f.w * scale;
      const dh = f.h * scale;
      const dx = (this.canvas.width - dw) / 2;
      const dy = (this.canvas.height - dh) / 2;
      this.ctx.drawImage(this.atlas.image, f.x, f.y, f.w, f.h, dx, dy, dw, dh);
    }

    _clear() {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    destroy() {
      window.clearTimeout(this._raf);
      this.playing = false;
    }
  }

  global.GunRenderer = GunRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
