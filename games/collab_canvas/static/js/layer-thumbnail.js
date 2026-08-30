(function (global) {
  'use strict';

  const THUMB_SIZE = 36;

  /** 将单图层笔迹渲染为小缩略图（白底 + 内容）。 */
  const LayerThumbnail = {
    THUMB_SIZE,

    /** 在目标 canvas 上绘制白色背景。 */
    _paintBackground(ctx, size) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
    },

    /** 将指定图层绘制到离屏 canvas。 */
    _renderLayerSurface(drawingBoard, strokes, layer) {
      const w = drawingBoard.logicalWidth;
      const h = drawingBoard.logicalHeight;
      const layerId = String(layer.layer_id || 'l_default');
      const surface = document.createElement('canvas');
      surface.width = w;
      surface.height = h;
      const ctx = surface.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      const opacity = Math.max(0, Math.min(255, Number(layer.opacity != null ? layer.opacity : 255))) / 255;
      const prev = drawingBoard.context;
      drawingBoard.context = ctx;
      ctx.save();
      ctx.globalAlpha = opacity;
      (strokes || []).forEach(stroke => {
        if (stroke.active === false) return;
        if (String(stroke.layer_id || 'l_default') !== layerId) return;
        (stroke.segments || []).forEach(segment => {
          if ((segment.tool || 'brush') === 'background') return;
          drawingBoard.drawSegment(segment);
        });
      });
      ctx.restore();
      drawingBoard.context = prev;
      return surface;
    },

    /** 绘制图层缩略图到 canvas 元素。 */
    paint(targetCanvas, drawingBoard, strokes, layer) {
      if (!targetCanvas || !drawingBoard) return;
      const size = THUMB_SIZE;
      targetCanvas.width = size;
      targetCanvas.height = size;
      const ctx = targetCanvas.getContext('2d');
      if (!ctx) return;
      LayerThumbnail._paintBackground(ctx, size);
      if (layer.visible === false) {
        ctx.fillStyle = 'rgb(0 0 0 / .45)';
        ctx.fillRect(0, 0, size, size);
      }
      const surface = LayerThumbnail._renderLayerSurface(drawingBoard, strokes, layer);
      const w = drawingBoard.logicalWidth;
      const h = drawingBoard.logicalHeight;
      if (w > 0 && h > 0) {
        ctx.drawImage(surface, 0, 0, w, h, 0, 0, size, size);
      }
      if (layer.visible === false) {
        ctx.fillStyle = 'rgb(0 0 0 / .35)';
        ctx.fillRect(0, 0, size, size);
      }
    }
  };

  global.LayerThumbnail = LayerThumbnail;
})(window);
