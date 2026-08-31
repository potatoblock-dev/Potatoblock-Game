(function (global) {
  'use strict';

  /** 大端写入工具。 */
  function u16(n) {
    return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
  }

  function u32(n) {
    return new Uint8Array([
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff
    ]);
  }

  function i16(n) {
    return u16(n < 0 ? 0x10000 + n : n);
  }

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    parts.forEach(part => {
      out.set(part, pos);
      pos += part.length;
    });
    return out;
  }

  /** RGBA 拆成 R/G/B/A 平面（每通道 width×height）。 */
  function rgbaToPlanes(rgba, width, height) {
    const size = width * height;
    const r = new Uint8Array(size);
    const g = new Uint8Array(size);
    const b = new Uint8Array(size);
    const a = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      const off = i * 4;
      r[i] = rgba[off];
      g[i] = rgba[off + 1];
      b[i] = rgba[off + 2];
      a[i] = rgba[off + 3];
    }
    return { r, g, b, a };
  }

  /** 原始压缩通道块（2 字节 compression=0 + 像素）。 */
  function rawChannelBlock(plane) {
    const out = new Uint8Array(2 + plane.length);
    out[0] = 0;
    out[1] = 0;
    out.set(plane, 2);
    return out;
  }

  /** Pascal 图层名（Extra Data 内，4 字节对齐）。 */
  function pascalLayerName(name) {
    const text = String(name || 'Layer').slice(0, 255);
    const enc = new TextEncoder().encode(text);
    const len = Math.min(enc.length, 255);
    const body = new Uint8Array(1 + len);
    body[0] = len;
    body.set(enc.subarray(0, len), 1);
    const pad = (4 - (body.length % 4)) % 4;
    if (!pad) return body;
    const out = new Uint8Array(body.length + pad);
    out.set(body);
    return out;
  }

  /** 8BIM 附加信息块（key 四字符 + 4 字节对齐数据）。 */
  function bimBlock(key, data) {
    const keyArr = new Uint8Array(4);
    for (let i = 0; i < 4; i += 1) {
      keyArr[i] = (key.charCodeAt(i) || 32) & 0xff;
    }
    const pad = (4 - (data.length % 4)) % 4;
    const padded = pad ? concat([data, new Uint8Array(pad)]) : data;
    return concat([
      new Uint8Array([0x38, 0x42, 0x49, 0x4d]),
      keyArr,
      u32(padded.length),
      padded
    ]);
  }

  /** Unicode 图层名（8BIM luni，Photoshop / ag-psd 兼容）。 */
  function unicodeLayerNameBlock(name) {
    const text = String(name || 'Layer').slice(0, 255);
    const chars = text.length + 1;
    const utf16 = new Uint8Array(chars * 2);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      utf16[i * 2] = (code >> 8) & 0xff;
      utf16[i * 2 + 1] = code & 0xff;
    }
    return bimBlock('luni', concat([u32(chars), utf16]));
  }

  /** 构建单层 Layer record（channel length 稍后回填）。 */
  function buildLayerRecord(width, height, opacity, name, patchTargets) {
    const top = 0;
    const left = 0;
    const bottom = height;
    const right = width;
    const channelIds = [0, 1, 2, -1];
    const parts = [
      u32(top),
      u32(left),
      u32(bottom),
      u32(right),
      u16(channelIds.length)
    ];
    channelIds.forEach(id => {
      parts.push(i16(id));
      const placeholder = new Uint8Array(4);
      patchTargets.push(placeholder);
      parts.push(placeholder);
    });
    parts.push(
      new Uint8Array([0x38, 0x42, 0x49, 0x4d]),
      new Uint8Array([0x6e, 0x6f, 0x72, 0x6d]),
      new Uint8Array([Math.max(0, Math.min(255, opacity))]),
      new Uint8Array([0]),
      new Uint8Array([0]),
      new Uint8Array([0])
    );
    const extra = concat([
      u32(0),
      u32(0),
      pascalLayerName(name),
      unicodeLayerNameBlock(name)
    ]);
    parts.push(u32(extra.length), extra);
    return concat(parts);
  }

  /** 合成图 Image Data Section（RGB 三通道 raw）。 */
  function buildCompositeImageData(rgba, width, height) {
    const planes = rgbaToPlanes(rgba, width, height);
    return concat([
      u16(0),
      rawChannelBlock(planes.r),
      rawChannelBlock(planes.g),
      rawChannelBlock(planes.b)
    ]);
  }

  /**
   * 打包分层 PSD（RGB 8-bit，带 Alpha 通道）。
   * layerPixels 顺序：底 → 顶。
   */
  function buildPsdBlob(compositeRgba, width, height, layerPixels, options) {
    const opts = options || {};
    const layers = (layerPixels && layerPixels.length)
      ? layerPixels.slice()
      : [{ name: opts.title || 'Layer 1', opacity: 255, rgba: compositeRgba }];
    const w = width | 0;
    const h = height | 0;
    if (w <= 0 || h <= 0) throw new Error('无效画布尺寸');

    const layerRecords = [];
    const channelBlocks = [];
    const lengthPatches = [];

    layers.forEach(layer => {
      const rgba = layer.rgba instanceof Uint8Array ? layer.rgba : new Uint8Array(layer.rgba);
      const planes = rgbaToPlanes(rgba, w, h);
      const blocks = [
        rawChannelBlock(planes.r),
        rawChannelBlock(planes.g),
        rawChannelBlock(planes.b),
        rawChannelBlock(planes.a)
      ];
      const patchTargets = [];
      layerRecords.push(buildLayerRecord(
        w,
        h,
        layer.opacity != null ? layer.opacity : 255,
        layer.name,
        patchTargets
      ));
      blocks.forEach((block, index) => {
        channelBlocks.push(block);
        if (patchTargets[index]) {
          lengthPatches.push({ target: patchTargets[index], length: block.length });
        }
      });
    });

    const layerRecordsBody = concat([
      i16(layers.length),
      ...layerRecords,
      ...channelBlocks
    ]);
    lengthPatches.forEach(patch => {
      patch.target.set(u32(patch.length));
    });

    const layerInfoBody = concat([
      u32(layerRecordsBody.length),
      layerRecordsBody
    ]);
    const layerAndMask = concat([
      u32(layerInfoBody.length + 4),
      layerInfoBody,
      u32(0)
    ]);
    const composite = buildCompositeImageData(compositeRgba, w, h);
    const header = concat([
      new Uint8Array([0x38, 0x42, 0x50, 0x53]),
      u16(1),
      new Uint8Array(6),
      u16(4),
      u32(h),
      u32(w),
      u16(8),
      u16(3)
    ]);

    const file = concat([
      header,
      u32(0),
      u32(0),
      layerAndMask,
      composite
    ]);
    return new Blob([file], { type: 'application/octet-stream' });
  }

  global.PsdExport = { buildPsdBlob };
})(window);
