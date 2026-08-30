(function (global) {
  'use strict';

  const SF = global.SpecialFormatExport;

  function u16le(n) {
    return [n & 0xff, (n >>> 8) & 0xff];
  }

  function u32le(n) {
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  }

  /** 组装 Alias MultiLayer TIFF（Sketchbook .skt）。 */
  class SketchbookTiffBuilder {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.parts = [];
      this.len = 0;
    }

    /** 追加字节并返回起始 offset。 */
    write(bytes) {
      if (this.len % 2 === 1) {
        this.parts.push(new Uint8Array([0]));
        this.len += 1;
      }
      const offset = this.len;
      const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.parts.push(chunk);
      this.len += chunk.length;
      return offset;
    }

    /** 回填 u32。 */
    patchU32(offset, value) {
      const patch = new Uint8Array(u32le(value));
      let pos = 0;
      for (let i = 0; i < this.parts.length; i += 1) {
        const part = this.parts[i];
        if (offset >= pos && offset < pos + part.length) {
          const local = offset - pos;
          part[local] = patch[0];
          part[local + 1] = patch[1];
          part[local + 2] = patch[2];
          part[local + 3] = patch[3];
          return;
        }
        pos += part.length;
      }
    }

    toUint8() {
      const out = new Uint8Array(this.len);
      let pos = 0;
      this.parts.forEach(part => {
        out.set(part, pos);
        pos += part.length;
      });
      return out;
    }
  }

  /** 将 IFD 及其 external tag 数据写入 builder。 */
  function emitIfd(builder, tags, nextIfd) {
    const sorted = tags.slice().sort((a, b) => a.id - b.id);
    const entryCount = sorted.length;
    const entryBytes = [];
    const external = [];
    sorted.forEach(tag => {
      const row = [...u16le(tag.id), ...u16le(tag.type), ...u32le(tag.count)];
      if (tag.bytes) {
        const bytes = tag.bytes instanceof Uint8Array ? tag.bytes : new Uint8Array(tag.bytes);
        if (bytes.length <= 4) {
          const inline = new Uint8Array(4);
          inline.set(bytes);
          row.push(...inline);
        } else {
          row.push(0, 0, 0, 0);
          external.push(bytes);
        }
      } else {
        row.push(...u32le(tag.value != null ? tag.value : 0));
      }
      entryBytes.push(new Uint8Array(row));
    });
    const ifdOffset = builder.write(new Uint8Array([
      ...u16le(entryCount),
      ...entryBytes.flatMap(row => Array.from(row)),
      ...u32le(nextIfd || 0)
    ]));
    external.forEach((bytes, index) => {
      let slot = 0;
      for (let t = 0; t < sorted.length; t += 1) {
        const tag = sorted[t];
        if (!tag.bytes) continue;
        const b = tag.bytes instanceof Uint8Array ? tag.bytes : new Uint8Array(tag.bytes);
        if (b.length <= 4) continue;
        if (slot === index) {
          const dataOffset = builder.write(bytes);
          builder.patchU32(ifdOffset + 2 + t * 12 + 8, dataOffset);
          return;
        }
        slot += 1;
      }
    });
    return ifdOffset;
  }

  /** 写入带 strip 的图像 IFD（含像素块）。 */
  function writeStripIfd(builder, width, height, pixels, extraTags) {
    const raw = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    const stripOffset = builder.write(raw);
    const tags = (extraTags || []).concat([
      { id: 256, type: 4, count: 1, value: width },
      { id: 257, type: 4, count: 1, value: height },
      { id: 258, type: 3, count: 4, bytes: new Uint8Array([8, 0, 8, 0, 8, 0, 8, 0]) },
      { id: 259, type: 3, count: 1, value: 1 },
      { id: 262, type: 3, count: 1, value: 2 },
      { id: 277, type: 3, count: 1, value: 4 },
      { id: 278, type: 4, count: 1, value: height },
      { id: 279, type: 4, count: 1, value: raw.length },
      { id: 284, type: 3, count: 1, value: 1 },
      { id: 273, type: 4, count: 1, value: stripOffset }
    ]);
    return emitIfd(builder, tags, 0);
  }

  /**
   * 打包 Sketchbook Alias MultiLayer TIFF（.skt）。
   * layerPixels: [{ name, opacity, visible, locked, rgba }]
   */
  async function buildSketchbookTiffBlob(compositeRgba, width, height, layerPixels, options) {
    if (!SF) throw new Error('SpecialFormatExport 未加载');
    const layers = (layerPixels && layerPixels.length) ? layerPixels.slice() : [];
    const builder = new SketchbookTiffBuilder(width, height);
    builder.write(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]));
    const mainIfdPatch = 4;

    const thumbBlob = await SF.rgbaToThumbnailPng(compositeRgba, width, height, 128);
    const thumb = await pngBlobToRgba(thumbBlob);
    const subIfdOffsets = [];

    subIfdOffsets.push(writeStripIfd(builder, thumb.width, thumb.height, thumb.data, [
      { id: 254, type: 4, count: 1, value: 1 }
    ]));

    layers.slice().reverse().forEach((layer, index) => {
      const opacity = Math.max(0, Math.min(1, (layer.opacity != null ? layer.opacity : 255) / 255));
      const bgra = SF.flipVertical(SF.rgbaToBgraPremultiplied(layer.rgba), width, height);
      const alias = [
        opacity.toFixed(6),
        '00000000',
        layer.visible === false ? '0' : '1',
        layer.locked ? '1' : '0',
        '0',
        '0',
        '0'
      ].join(', ');
      subIfdOffsets.push(writeStripIfd(builder, width, height, bgra, [
        { id: 50784, type: 2, count: alias.length + 1, bytes: SF.asciiBytes(alias) },
        { id: 305, type: 2, count: 1, bytes: SF.asciiBytes(String(layer.name || 'Layer ' + (index + 1)).slice(0, 32)) }
      ]));
    });

    const compositeAlias = [
      String(layers.length),
      '0',
      'FFFFFFFF',
      '1'
    ].join(', ');
    const subIfdList = new Uint8Array(subIfdOffsets.flatMap(off => u32le(off)));
    const mainIfd = writeStripIfd(builder, width, height, compositeRgba, [
      { id: 305, type: 2, count: 26, bytes: SF.asciiBytes('Alias MultiLayer TIFF V1.1') },
      { id: 50784, type: 2, count: compositeAlias.length + 1, bytes: SF.asciiBytes(compositeAlias) },
      { id: 330, type: 4, count: subIfdOffsets.length, bytes: subIfdList }
    ]);
    builder.patchU32(mainIfdPatch, mainIfd);
    return new Blob([builder.toUint8()], { type: 'image/tiff' });
  }

  /** PNG Blob → RGBA 像素。 */
  async function pngBlobToRgba(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bitmap.close();
    return {
      width: canvas.width,
      height: canvas.height,
      data: new Uint8Array(imageData.data.buffer)
    };
  }

  global.SktExport = { buildSketchbookTiffBlob };
})(window);
