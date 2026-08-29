(function (global) {
  'use strict';

  /** CRC-32（ZIP 用）。 */
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(n) {
    return [n & 0xff, (n >>> 8) & 0xff];
  }

  function u32(n) {
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  }

  /** 仅 STORE 压缩的 ZIP 打包器（满足 Krita mimetype 首项要求）。 */
  class ZipStoreBuilder {
    constructor() {
      this._entries = [];
      this._parts = [];
      this._offset = 0;
    }

    /** 追加文件；first=true 时插在队列最前（用于 mimetype）。 */
    add(name, data, options) {
      const opts = options || {};
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
      this._entries.push({ name: String(name), bytes, first: Boolean(opts.first) });
      return this;
    }

    build() {
      const ordered = this._entries.slice().sort((a, b) => {
        if (a.first === b.first) return 0;
        return a.first ? -1 : 1;
      });
      const locals = [];
      const central = [];
      let offset = 0;
      ordered.forEach(entry => {
        const nameBytes = new TextEncoder().encode(entry.name);
        const size = entry.bytes.length;
        const checksum = crc32(entry.bytes);
        const local = [];
        local.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0));
        local.push(...u16(0), ...u16(0), ...u32(checksum), ...u32(size), ...u32(size));
        local.push(...u16(nameBytes.length), ...u16(0));
        local.push(...nameBytes, ...entry.bytes);
        const localArr = new Uint8Array(local);
        locals.push(localArr);
        const centralHead = [];
        centralHead.push(...u32(0x02014b50), ...u16(20), ...u16(20));
        centralHead.push(...u16(0), ...u16(0), ...u16(0), ...u16(0));
        centralHead.push(...u32(checksum), ...u32(size), ...u32(size));
        centralHead.push(...u16(nameBytes.length), ...u16(0), ...u16(0));
        centralHead.push(...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes);
        central.push(new Uint8Array(centralHead));
        offset += localArr.length;
      });
      const centralSize = central.reduce((sum, part) => sum + part.length, 0);
      const end = [];
      end.push(...u32(0x06054b50), ...u16(0), ...u16(0));
      end.push(...u16(ordered.length), ...u16(ordered.length));
      end.push(...u32(centralSize), ...u32(offset), ...u16(0));
      const endArr = new Uint8Array(end);
      const total = offset + centralSize + endArr.length;
      const out = new Uint8Array(total);
      let pos = 0;
      locals.forEach(part => { out.set(part, pos); pos += part.length; });
      central.forEach(part => { out.set(part, pos); pos += part.length; });
      out.set(endArr, pos);
      return new Blob([out], { type: 'application/x-krita' });
    }
  }

  global.ZipStoreBuilder = ZipStoreBuilder;
  global.ZipStoreCrc32 = crc32;
})(window);
