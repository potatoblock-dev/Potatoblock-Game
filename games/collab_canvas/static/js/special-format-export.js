(function (global) {
  'use strict';

  /** 特殊绘画软件导出共用工具（PNG / UUID / 像素变换）。 */
  const SpecialFormatExport = {
    /** 生成 RFC4122 风格 UUID（带或不带花括号）。 */
    randomUuid(braces) {
      if (global.crypto && crypto.randomUUID) {
        const id = crypto.randomUUID();
        return braces ? '{' + id + '}' : id;
      }
      const hex = 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      return braces ? '{' + hex + '}' : hex;
    },

    /** RGBA ImageData 转 PNG Blob。 */
    rgbaToPngBlob(rgba, width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(rgba);
      ctx.putImageData(imageData, 0, 0);
      return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    },

    /** 生成缩略图 PNG（长边 ≤ maxSide）。 */
    async rgbaToThumbnailPng(rgba, width, height, maxSide) {
      const limit = Number(maxSide) || 256;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, limit / Math.max(width, height, 1));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      const src = document.createElement('canvas');
      src.width = width;
      src.height = height;
      const sctx = src.getContext('2d');
      const imageData = sctx.createImageData(width, height);
      imageData.data.set(rgba);
      sctx.putImageData(imageData, 0, 0);
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    },

    /** 预乘 alpha 并转为 BGRA（Sketchbook 图层像素序）。 */
    rgbaToBgraPremultiplied(rgba) {
      const out = new Uint8Array(rgba.length);
      for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3] / 255;
        out[i] = Math.round(rgba[i + 2] * a);
        out[i + 1] = Math.round(rgba[i + 1] * a);
        out[i + 2] = Math.round(rgba[i] * a);
        out[i + 3] = rgba[i + 3];
      }
      return out;
    },

    /** 垂直翻转 RGBA/BGRA 像素。 */
    flipVertical(rgba, width, height) {
      const stride = width * 4;
      const out = new Uint8Array(rgba.length);
      for (let y = 0; y < height; y += 1) {
        out.set(rgba.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
      }
      return out;
    },

    /** Procreate 图层块：预乘 RGBA 原始字节。 */
    rgbaToProcreateChunk(rgba) {
      const out = new Uint8Array(rgba.length);
      for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3] / 255;
        out[i] = Math.round(rgba[i] * a);
        out[i + 1] = Math.round(rgba[i + 1] * a);
        out[i + 2] = Math.round(rgba[i + 2] * a);
        out[i + 3] = rgba[i + 3];
      }
      return out;
    },

    /** C 风格 ASCII 字符串（含结尾 NUL）。 */
    asciiBytes(text) {
      const str = String(text || '') + '\u0000';
      return new TextEncoder().encode(str);
    }
  };

  global.SpecialFormatExport = SpecialFormatExport;
})(window);
