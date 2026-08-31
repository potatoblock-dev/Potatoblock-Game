(function (global) {
  'use strict';

  /** 将标题转成安全文件名片段。 */
  function sanitizeFilename(text) {
    return String(text || 'board')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 48) || 'board';
  }

  /** 触发浏览器下载 Blob。 */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** 在 RGBA 像素上绘制重复水印文字。 */
  function applyWatermark(rgba, width, height, text) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#111827';
    ctx.font = 'bold ' + Math.max(14, Math.round(width / 48)) + 'px sans-serif';
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-Math.PI / 6);
    const label = String(text || '预览');
    const stepY = Math.max(48, Math.round(height / 8));
    const stepX = Math.max(120, Math.round(width / 5));
    for (let y = -height; y < height; y += stepY) {
      for (let x = -width; x < width; x += stepX) {
        ctx.fillText(label, x, y);
      }
    }
    ctx.restore();
    return new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data);
  }

  /** 默认双层：底白背景 + 顶绘画层。 */
  function defaultLayerStack() {
    return [
      { layer_id: 'l_background', name: '背景', visible: true, opacity: 255, order: 0 },
      { layer_id: 'l_default', name: '图层 1', visible: true, opacity: 255, order: 1 }
    ];
  }

  /** 从 strokes 按图层合成渲染 RGBA 像素。 */
  async function strokesToRgba(strokes, canvasSpec, layersMeta, options) {
    const opts = options || {};
    const spec = canvasSpec || {};
    const width = Number(spec.width) || 1920;
    const height = Number(spec.height) || 1080;
    const offscreen = document.createElement('canvas');
    const board = new DrawingBoard(offscreen, {
      width,
      height,
      background: '#ffffff'
    });
    const layers = layersMeta && layersMeta.length
      ? layersMeta
      : defaultLayerStack();
    board.redraw(DrawingBoard.cloneStrokes(strokes || []), layers);
    const ctx = board.canvas.getContext('2d');
    let rgba = new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data);
    if (opts.watermarkText) {
      rgba = applyWatermark(rgba, width, height, opts.watermarkText);
    }
    return {
      rgba,
      width,
      height,
      layers
    };
  }

  /** 按图层拆分 strokes 并分别渲染（用于分层 KRA）。 */
  async function layersToRgbaList(strokes, canvasSpec, layersMeta) {
    const spec = canvasSpec || {};
    const width = Number(spec.width) || 1920;
    const height = Number(spec.height) || 1080;
    const layers = (layersMeta && layersMeta.length ? layersMeta : defaultLayerStack())
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const list = strokes || [];
    const out = [];
    for (let i = 0; i < layers.length; i += 1) {
      const layer = layers[i];
      if (layer.visible === false) continue;
      const layerStrokes = list.filter(s => String(s.layer_id || 'l_default') === layer.layer_id);
      if (!layerStrokes.length) continue;
      const offscreen = document.createElement('canvas');
      const board = new DrawingBoard(offscreen, { width, height, background: '#ffffff' });
      board.redraw(DrawingBoard.cloneStrokes(layerStrokes), [layer]);
      const ctx = board.canvas.getContext('2d');
      out.push({
        name: layer.name || layer.layer_id,
        opacity: layer.opacity != null ? layer.opacity : 255,
        rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data)
      });
    }
    return { width, height, layerPixels: out };
  }

  const FORMATS = {
    png: {
      id: 'png',
      label: 'PNG',
      extension: 'png',
      mime: 'image/png',
      async encode(rgba, width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        imageData.data.set(rgba);
        ctx.putImageData(imageData, 0, 0);
        return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      }
    },
    jpeg: {
      id: 'jpeg',
      label: 'JPEG',
      extension: 'jpg',
      mime: 'image/jpeg',
      async encode(rgba, width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        const imageData = ctx.createImageData(width, height);
        imageData.data.set(rgba);
        ctx.putImageData(imageData, 0, 0);
        return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      }
    },
    kra: {
      id: 'kra',
      label: 'Krita (.kra)',
      extension: 'kra',
      category: 'special',
      async encode(_rgba, width, height, meta) {
        const pack = await layersToRgbaList(meta.strokes, meta.canvas, meta.layers);
        const composite = await strokesToRgba(meta.strokes, meta.canvas, meta.layers);
        return KraExport.buildKraBlobMulti(composite.rgba, width, height, pack.layerPixels, {
          title: meta && meta.title,
          docName: meta && meta.docName
        });
      }
    },
    skt: {
      id: 'skt',
      label: 'Sketchbook (.skt)',
      extension: 'skt',
      category: 'special',
      async encode(_rgba, width, height, meta) {
        const pack = await layersToRgbaList(meta.strokes, meta.canvas, meta.layers);
        const composite = await strokesToRgba(meta.strokes, meta.canvas, meta.layers);
        if (!global.SktExport) throw new Error('Sketchbook 导出模块未加载');
        return SktExport.buildSketchbookTiffBlob(composite.rgba, width, height, pack.layerPixels, {
          title: meta && meta.title
        });
      }
    },
    hsj: {
      id: 'hsj',
      label: '画世界 Pro (.hsj)',
      extension: 'hsj',
      category: 'special',
      async encode(_rgba, width, height, meta) {
        const pack = await layersToRgbaList(meta.strokes, meta.canvas, meta.layers);
        const composite = await strokesToRgba(meta.strokes, meta.canvas, meta.layers);
        if (!global.HsjExport) throw new Error('画世界 Pro 导出模块未加载');
        return HsjExport.buildHsjBlob(composite.rgba, width, height, pack.layerPixels, {
          title: meta && meta.title
        });
      }
    },
    procreate: {
      id: 'procreate',
      label: 'Procreate (.procreate)',
      extension: 'procreate',
      category: 'special',
      async encode(_rgba, width, height, meta) {
        const pack = await layersToRgbaList(meta.strokes, meta.canvas, meta.layers);
        const composite = await strokesToRgba(meta.strokes, meta.canvas, meta.layers);
        if (!global.ProcreateExport) throw new Error('Procreate 导出模块未加载');
        return ProcreateExport.buildProcreateBlob(composite.rgba, width, height, pack.layerPixels, {
          title: meta && meta.title
        });
      }
    },
    psd: {
      id: 'psd',
      label: 'Photoshop (.psd)',
      extension: 'psd',
      category: 'special',
      async encode(_rgba, width, height, meta) {
        const pack = await layersToRgbaList(meta.strokes, meta.canvas, meta.layers);
        const composite = await strokesToRgba(meta.strokes, meta.canvas, meta.layers);
        if (!global.PsdExport) throw new Error('Photoshop 导出模块未加载');
        const layerPixels = pack.layerPixels.length
          ? pack.layerPixels
          : [{ name: meta && meta.title ? meta.title : 'Merged', opacity: 255, rgba: composite.rgba }];
        return PsdExport.buildPsdBlob(composite.rgba, width, height, layerPixels, {
          title: meta && meta.title
        });
      }
    },
    pbcc: {
      id: 'pbcc',
      label: '合作画板 (.pbcc)',
      extension: 'pbcc',
      mime: 'application/vnd.potatoblock.collab-canvas+json',
      multiBoardSingleFile: true,
      async encode(_rgba, _width, _height, meta) {
        if (!global.PbccFormat) throw new Error('PBCC 模块未加载');
        const document = PbccFormat.buildDocument({
          roomId: meta.roomId,
          boardOrder: meta.boardOrder,
          boards: meta.boards,
          exportedByUid: meta.exportedByUid,
          exportedByName: meta.exportedByName
        });
        return PbccFormat.encodeBlob(document);
      }
    }
  };

  /** 可扩展导出注册表；后续 PSD / ORA 等在此 register。 */
  class CollabExportRegistry {
    constructor() {
      this._formats = Object.create(null);
      Object.keys(FORMATS).forEach(id => this.register(FORMATS[id]));
    }

    /** 注册新导出格式 handler：{ id, label, extension, encode(rgba,w,h,meta) } */
    register(format) {
      if (!format || !format.id || typeof format.encode !== 'function') return;
      this._formats[format.id] = format;
    }

    list() {
      return Object.values(this._formats);
    }

    get(id) {
      return this._formats[id] || null;
    }

    /** 导出单个画板为 Blob。 */
    async exportBoard(formatId, boardMeta, strokes) {
      const format = this.get(formatId);
      if (!format) throw new Error('不支持的导出格式');
      const spec = (boardMeta && boardMeta.canvas) || {};
      const layers = (boardMeta && boardMeta.layers) || [];
      const title = (boardMeta && boardMeta.title) || '画板';
      const exportOpts = (boardMeta && boardMeta.exportOptions) || {};
      const layeredFormats = { kra: 1, skt: 1, hsj: 1, procreate: 1, psd: 1 };
      if (layeredFormats[formatId]) {
        const { rgba, width, height } = await strokesToRgba(strokes, spec, layers, exportOpts);
        return format.encode(rgba, width, height, {
          title,
          docName: sanitizeFilename(title),
          strokes,
          canvas: spec,
          layers
        });
      }
      const { rgba, width, height } = await strokesToRgba(strokes, spec, layers, exportOpts);
      return format.encode(rgba, width, height, {
        title,
        docName: sanitizeFilename(title),
        layerName: title
      });
    }

    /** 批量导出多个画板；pbcc 为单文件打包全部画板。 */
    async exportBoards(formatId, boards, options) {
      const opts = options || {};
      const roomId = sanitizeFilename(opts.roomId || 'room');
      const delayMs = Number(opts.delayMs) || 120;
      const format = this.get(formatId);
      if (!format) throw new Error('不支持的导出格式');
      if (format.multiBoardSingleFile) {
        const blob = await format.encode(null, 0, 0, {
          roomId: opts.roomId || roomId,
          boardOrder: boards.map(b => b.meta && b.meta.board_id).filter(Boolean),
          boards,
          exportedByUid: opts.exportedByUid || '',
          exportedByName: opts.exportedByName || ''
        });
        downloadBlob(blob, `${roomId}_room.${format.extension}`);
        return;
      }
      for (let i = 0; i < boards.length; i += 1) {
        const board = boards[i];
        const blob = await this.exportBoard(formatId, board.meta, board.strokes);
        const base = `${roomId}_${sanitizeFilename(board.meta.title)}_${sanitizeFilename(board.meta.board_id)}`;
        downloadBlob(blob, `${base}.${format.extension}`);
        if (i < boards.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    /** 构建 .pbcc 文档对象（不下载）。 */
    buildPbccDocument(boards, options) {
      if (!global.PbccFormat) throw new Error('PBCC 模块未加载');
      const opts = options || {};
      return PbccFormat.buildDocument({
        roomId: opts.roomId,
        boardOrder: opts.boardOrder,
        boards,
        exportedByUid: opts.exportedByUid,
        exportedByName: opts.exportedByName
      });
    }
  }

  global.CollabExportRegistry = CollabExportRegistry;
  global.CollabExportFormats = FORMATS;
  global.CollabExportUtils = { sanitizeFilename, downloadBlob, strokesToRgba };
})(window);
