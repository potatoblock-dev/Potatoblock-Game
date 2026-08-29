(function (global) {
  'use strict';

  const TILE = 64;
  const SRGB_ICC_B64 = 'AAACTGxjbXMEMAAAbW50clJHQiBYWVogB+UADAAQAAwAGAANYWNzcEFQUEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hhZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAgZ1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMAAAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPcAADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcAALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAAVHsAAEzNAACZmgAAJmYAAA9c';

  function decodeBase64(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  function randomUuid() {
    if (global.crypto && crypto.randomUUID) return '{' + crypto.randomUUID() + '}';
    return '{00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0') + '}';
  }

  function escapeXml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 将 RGBA 像素拆成 Krita 图层 tile 所需的平面字节序（B→G→R→A）。 */
  function tilePlanarBytes(rgba, width, height, left, top) {
    const planeB = new Uint8Array(TILE * TILE);
    const planeG = new Uint8Array(TILE * TILE);
    const planeR = new Uint8Array(TILE * TILE);
    const planeA = new Uint8Array(TILE * TILE);
    let idx = 0;
    for (let ty = 0; ty < TILE; ty += 1) {
      for (let tx = 0; tx < TILE; tx += 1) {
        const sx = left + tx;
        const sy = top + ty;
        let r = 0; let g = 0; let b = 0; let a = 0;
        if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
          const off = (sy * width + sx) * 4;
          r = rgba[off]; g = rgba[off + 1]; b = rgba[off + 2]; a = rgba[off + 3];
        }
        planeB[idx] = b;
        planeG[idx] = g;
        planeR[idx] = r;
        planeA[idx] = a;
        idx += 1;
      }
    }
    const merged = new Uint8Array(TILE * TILE * 4);
    merged.set(planeB, 0);
    merged.set(planeG, TILE * TILE);
    merged.set(planeR, TILE * TILE * 2);
    merged.set(planeA, TILE * TILE * 3);
    return merged;
  }

  /** 构建 Krita 二进制 paint layer（VERSION 2 / 64×64 tiles）。 */
  function buildPaintLayerBinary(rgba, width, height) {
    const tiles = [];
    for (let top = 0; top < height; top += TILE) {
      for (let left = 0; left < width; left += TILE) {
        tiles.push({ left, top, data: tilePlanarBytes(rgba, width, height, left, top) });
      }
    }
    const header = new TextEncoder().encode(
      `VERSION 2\nTILEWIDTH ${TILE}\nTILEHEIGHT ${TILE}\nPIXELSIZE 4\nDATA ${tiles.length}\n`
    );
    let bodySize = 0;
    tiles.forEach(tile => { bodySize += tile.data.length + 32; });
    const body = new Uint8Array(bodySize);
    let pos = 0;
    tiles.forEach(tile => {
      const line = new TextEncoder().encode(`${tile.left},${tile.top},0,${tile.data.length},0\n`);
      body.set(line, pos); pos += line.length;
      body.set(tile.data, pos); pos += tile.data.length;
    });
    const out = new Uint8Array(header.length + body.length);
    out.set(header, 0);
    out.set(body, header.length);
    return out;
  }

  function buildDocumentInfo(title) {
    const safe = escapeXml(title);
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE document-info PUBLIC '-//KDE//DTD document-info 1.1//EN' 'http://www.calligra.org/DTD/document-info-1.1.dtd'>
<document-info xmlns="http://www.calligra.org/DTD/document-info">
 <about>
  <title>${safe}</title>
  <description>Exported from Potatoblock Collab Canvas</description>
  <initial-creator>Potatoblock</initial-creator>
 </about>
</document-info>`;
  }

  function buildMaindocMulti(width, height, docName, layerEntries) {
    const layerXml = layerEntries.map((entry, index) => {
      const uid = randomUuid();
      const opacity = Math.max(0, Math.min(255, Number(entry.opacity != null ? entry.opacity : 255)));
      return `   <layer uuid="${uid}" visible="1" colorlabel="0" name="${escapeXml(entry.name)}" compositeop="normal" collapsed="0" channelflags="" x="0" filename="layer${index + 2}" colorspacename="RGBA" opacity="${opacity}" intimeline="1" y="0" nodetype="paintlayer" channellockflags="1111" onionskin="0" locked="0"/>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DOC PUBLIC '-//KDE//DTD krita 2.0//EN' 'http://www.calligra.org/DTD/krita-2.0.dtd'>
<DOC xmlns="http://www.calligra.org/DTD/krita" editor="Krita" kritaVersion="5.2.0" syntaxVersion="2">
 <IMAGE width="${width}" height="${height}" name="${escapeXml(docName)}" mime="application/x-krita" profile="sRGB built-in" colorspacename="RGBA" x-res="72" y-res="72" description="">
  <layers>
${layerXml}
  </layers>
  <ProjectionBackgroundColor ColorData="ffffff"/>
 </IMAGE>
</DOC>`;
  }

  function buildMaindoc(width, height, docName, layerName) {
    return buildMaindocMulti(width, height, docName, [{ name: layerName, opacity: 255 }]);
  }

  /** 将 RGBA ImageData 写入 PNG Blob。 */
  function rgbaToPngBlob(rgba, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  /** 生成缩略图 preview.png（长边 ≤256）。 */
  async function buildPreviewPng(rgba, width, height) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 256 / Math.max(width, height));
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
  }

  async function buildKraBlobMulti(compositeRgba, width, height, layerPixels, options) {
    const opts = options || {};
    const title = String(opts.title || 'collab_export').slice(0, 40);
    const docName = String(opts.docName || 'collab_export').replace(/[^\w-]+/g, '_').slice(0, 32) || 'collab_export';
    const entries = (layerPixels && layerPixels.length)
      ? layerPixels
      : [{ name: 'Drawing', opacity: 255, rgba: compositeRgba }];
    const mergedBlob = await rgbaToPngBlob(compositeRgba, width, height);
    const previewBlob = await buildPreviewPng(compositeRgba, width, height);
    const merged = new Uint8Array(await mergedBlob.arrayBuffer());
    const preview = new Uint8Array(await previewBlob.arrayBuffer());
    const icc = decodeBase64(SRGB_ICC_B64);
    const zip = new ZipStoreBuilder();
    zip.add('mimetype', 'application/x-krita', { first: true });
    zip.add('maindoc.xml', buildMaindocMulti(width, height, docName, entries));
    zip.add('documentinfo.xml', buildDocumentInfo(title));
    zip.add('preview.png', preview);
    zip.add('mergedimage.png', merged);
    entries.forEach((entry, index) => {
      const fileName = `layer${index + 2}`;
      zip.add(`${docName}/layers/${fileName}`, buildPaintLayerBinary(entry.rgba, width, height));
      zip.add(`${docName}/layers/${fileName}.defaultpixel`, new Uint8Array(4));
      zip.add(`${docName}/layers/${fileName}.icc`, icc);
    });
    return zip.build();
  }

  /**
   * 从 RGBA 像素打包 .kra（单层 paintlayer + mergedimage）。
   * 格式参考 Krita 官方说明与本地模板验证。
   */
  async function buildKraBlob(rgba, width, height, options) {
    const opts = options || {};
    const layerName = String(opts.layerName || 'Drawing').slice(0, 40);
    return buildKraBlobMulti(rgba, width, height, [{ name: layerName, opacity: 255, rgba }], opts);
  }

  global.KraExport = { buildKraBlob, buildKraBlobMulti, buildPaintLayerBinary };
})(window);
