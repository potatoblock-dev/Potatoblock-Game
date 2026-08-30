(function (global) {
  'use strict';

  const SF = global.SpecialFormatExport;

  /**
   * 打包画世界 Pro 草稿包（.hsj，ZIP：draft.json + 分层 PNG）。
   * 画世界 Pro 原生 .hsj 为闭源格式；本导出为可导入的分层草稿包。
   */
  async function buildHsjBlob(compositeRgba, width, height, layerPixels, options) {
    if (!SF || !global.ZipStoreBuilder) throw new Error('HSJ 导出模块未加载');
    const opts = options || {};
    const layers = (layerPixels && layerPixels.length) ? layerPixels : [];
    const zip = new ZipStoreBuilder();
    const previewBlob = await SF.rgbaToPngBlob(compositeRgba, width, height);
    const preview = new Uint8Array(await previewBlob.arrayBuffer());
    const layerEntries = [];
    for (let i = 0; i < layers.length; i += 1) {
      const layer = layers[i];
      const pngBlob = await SF.rgbaToPngBlob(layer.rgba, width, height);
      const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
      const fileName = 'layers/' + String(i).padStart(3, '0') + '.png';
      zip.add(fileName, pngBytes);
      layerEntries.push({
        index: i,
        name: String(layer.name || 'Layer ' + (i + 1)).slice(0, 40),
        opacity: layer.opacity != null ? layer.opacity : 255,
        visible: layer.visible !== false,
        locked: Boolean(layer.locked),
        file: fileName
      });
    }
    const draft = {
      format: 'hsj',
      version: 1,
      exporter: 'potatoblock-collab-canvas',
      title: String(opts.title || 'collab_export').slice(0, 80),
      canvas: { width, height, dpi: 72 },
      exportedAt: new Date().toISOString(),
      layers: layerEntries
    };
    zip.add('draft.json', JSON.stringify(draft, null, 2));
    zip.add('preview.png', preview);
    const blob = await zip.build();
    return new Blob([await blob.arrayBuffer()], { type: 'application/octet-stream' });
  }

  global.HsjExport = { buildHsjBlob };
})(window);
