(function (global) {
  'use strict';

  const SF = global.SpecialFormatExport;

  /**
   * 打包 Procreate 文档（.procreate，ZIP：QuickLook + 图层 chunk）。
   * 完整 Procreate 需 NSKeyedArchive Document.archive；此处为分层像素包（实验性）。
   */
  async function buildProcreateBlob(compositeRgba, width, height, layerPixels, options) {
    if (!SF || !global.ZipStoreBuilder) throw new Error('Procreate 导出模块未加载');
    const opts = options || {};
    const layers = (layerPixels && layerPixels.length) ? layerPixels : [
      { name: 'Drawing', opacity: 255, rgba: compositeRgba }
    ];
    const zip = new ZipStoreBuilder();
    const thumbBlob = await SF.rgbaToThumbnailPng(compositeRgba, width, height, 512);
    const thumb = new Uint8Array(await thumbBlob.arrayBuffer());
    zip.add('QuickLook/Thumbnail.png', thumb);

    const layerMeta = [];
    for (let i = 0; i < layers.length; i += 1) {
      const layer = layers[i];
      const layerId = SF.randomUuid();
      const chunk = SF.rgbaToProcreateChunk(layer.rgba);
      zip.add(layerId + '/0~0.chunk', chunk);
      layerMeta.push({
        uuid: layerId,
        name: String(layer.name || 'Layer ' + (i + 1)).slice(0, 40),
        opacity: layer.opacity != null ? layer.opacity : 255,
        visible: layer.visible !== false
      });
    }

    const manifest = {
      format: 'procreate-interchange',
      version: 1,
      exporter: 'potatoblock-collab-canvas',
      title: String(opts.title || 'collab_export').slice(0, 80),
      canvas: { width, height, tileSize: Math.max(width, height) },
      exportedAt: new Date().toISOString(),
      layers: layerMeta,
      note: 'Experimental export; open in Procreate may require future Document.archive support.'
    };
    zip.add('potatoblock-manifest.json', JSON.stringify(manifest, null, 2));
    const blob = await zip.build();
    return new Blob([await blob.arrayBuffer()], { type: 'application/octet-stream' });
  }

  global.ProcreateExport = { buildProcreateBlob };
})(window);
