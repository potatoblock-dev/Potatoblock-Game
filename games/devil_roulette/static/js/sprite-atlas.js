(function (global) {
  'use strict';

  /** 解析 Aseprite JSON 并加载精灵图集。 */
  class SpriteAtlas {
    constructor(baseUrl) {
      this.baseUrl = baseUrl.replace(/\/$/, '');
      this.image = null;
      this.frames = {};
      this.tags = [];
    }

    /** 加载 JSON 与 PNG。 */
    async load(jsonFile) {
      const res = await fetch(`${this.baseUrl}/${jsonFile}`);
      const data = await res.json();
      this.frames = data.frames || {};
      this.tags = data.meta?.frameTags || [];
      const img = new Image();
      img.src = `${this.baseUrl}/${data.meta.image}`;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      this.image = img;
      return this;
    }

    /** 按帧名或图层后缀查找帧矩形。 */
    getFrame(name) {
      if (this.frames[name]) return this.frames[name];
      const key = Object.keys(this.frames).find(k => k.includes(`(${name})`));
      return key ? this.frames[key] : null;
    }

    /** 在 Canvas 上绘制指定帧；scale 可选。 */
    drawFrame(ctx, name, dx, dy, scale, atlas) {
      const source = atlas || this;
      const entry = source.getFrame(name);
      if (!entry || !source.image) return false;
      const f = entry.frame;
      const s = scale || 1;
      const dw = f.w * s;
      const dh = f.h * s;
      ctx.drawImage(source.image, f.x, f.y, f.w, f.h, dx, dy, dw, dh);
      return true;
    }

    /** 按索引绘制帧（用于 gun 图集道具图标）。 */
    drawFrameByIndex(ctx, index, dx, dy, scale, atlas) {
      const source = atlas || this;
      const keys = Object.keys(source.frames);
      if (index < 0 || index >= keys.length) return false;
      const entry = source.frames[keys[index]];
      const f = entry.frame;
      const s = scale || 1;
      ctx.drawImage(source.image, f.x, f.y, f.w, f.h, dx, dy, f.w * s, f.h * s);
      return true;
    }

    /** 按 tag 名返回帧名列表。 */
    getTagFrames(tagName) {
      const tag = this.tags.find(t => t.name === tagName);
      if (!tag) return [];
      const keys = Object.keys(this.frames);
      return keys.slice(tag.from, tag.to + 1);
    }
  }

  global.SpriteAtlas = SpriteAtlas;
})(typeof window !== 'undefined' ? window : globalThis);
