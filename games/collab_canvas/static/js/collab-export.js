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

  /** 从 strokes 按图层合成渲染 RGBA 像素。 */
  async function strokesToRgba(strokes, canvasSpec, layersMeta) {
    const spec = canvasSpec || {};
    const width = Number(spec.width) || 960;
    const height = Number(spec.height) || 540;
    const offscreen = document.createElement('canvas');
    const board = new DrawingBoard(offscreen, {
      width,
      height,
      background: '#ffffff'
    });
    const layers = layersMeta && layersMeta.length
      ? layersMeta
      : [{ layer_id: 'l_default', name: '图层 1', visible: true, opacity: 255, order: 0 }];
    board.redraw(DrawingBoard.cloneStrokes(strokes || []), layers);
    const ctx = board.canvas.getContext('2d');
    return {
      rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data),
      width,
      height,
      layers
    };
  }

  /** 按图层拆分 strokes 并分别渲染（用于分层 KRA）。 */
  async function layersToRgbaList(strokes, canvasSpec, layersMeta) {
    const spec = canvasSpec || {};
    const width = Number(spec.width) || 960;
    const height = Number(spec.height) || 540;
    const layers = (layersMeta || [{ layer_id: 'l_default', name: '图层 1', visible: true, opacity: 255, order: 0 }])
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
      async encode(_rgba, width, height, meta) {
        const pack = await layersToRgbaList(meta.strokes, meta.canvas, meta.layers);
        const composite = await strokesToRgba(meta.strokes, meta.canvas, meta.layers);
        return KraExport.buildKraBlobMulti(composite.rgba, width, height, pack.layerPixels, {
          title: meta && meta.title,
          docName: meta && meta.docName
        });
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
      if (formatId === 'kra') {
        const { rgba, width, height } = await strokesToRgba(strokes, spec, layers);
        return format.encode(rgba, width, height, {
          title,
          docName: sanitizeFilename(title),
          strokes,
          canvas: spec,
          layers
        });
      }
      const { rgba, width, height } = await strokesToRgba(strokes, spec, layers);
      return format.encode(rgba, width, height, {
        title,
        docName: sanitizeFilename(title),
        layerName: title
      });
    }

    /** 批量导出多个画板，每个画板一个文件。 */
    async exportBoards(formatId, boards, options) {
      const opts = options || {};
      const roomId = sanitizeFilename(opts.roomId || 'room');
      const delayMs = Number(opts.delayMs) || 120;
      const format = this.get(formatId);
      if (!format) throw new Error('不支持的导出格式');
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
  }

  global.CollabExportRegistry = CollabExportRegistry;
  global.CollabExportFormats = FORMATS;
  global.CollabExportUtils = { sanitizeFilename, downloadBlob, strokesToRgba };
})(window);
