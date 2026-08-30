(function (global) {
  'use strict';
  const VALID_TOOLS = new Set(['brush', 'eraser', 'fill', 'background', 'line', 'rect', 'ellipse', 'gradient']);
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const unitNumber = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError('Drawing coordinates must be finite numbers');
    return clamp(number, 0, 1);
  };
  const isHexColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const hexToRgb = value => {
    const color = isHexColor(value) ? value : '#111827';
    return { r: parseInt(color.slice(1, 3), 16), g: parseInt(color.slice(3, 5), 16), b: parseInt(color.slice(5, 7), 16) };
  };
  const rgbToHex = (red, green, blue) => {
    const channel = value => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
    return '#' + channel(red) + channel(green) + channel(blue);
  };
  const cloneStrokes = strokes => (Array.isArray(strokes) ? strokes : []).map(stroke => ({
    stroke_id: String(stroke.stroke_id || ''), owner_id: String(stroke.owner_id || ''),
    layer_id: String(stroke.layer_id || 'l_default'),
    active: stroke.active !== false,
    segments: (Array.isArray(stroke.segments) ? stroke.segments : []).map(segment => Object.assign({}, segment))
  }));

  class DrawingBoard {
    constructor(canvas, options) {
      if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('DrawingBoard requires a canvas element');
      const settings = options || {};
      this.canvas = canvas;
      this.context = canvas.getContext('2d', { willReadFrequently: true });
      this.logicalWidth = Number(settings.width) || 960;
      this.logicalHeight = Number(settings.height) || 540;
      this._buffer = document.createElement('canvas');
      this._buffer.width = this.logicalWidth;
      this._buffer.height = this.logicalHeight;
      this._bufferCtx = this._buffer.getContext('2d');
      this.defaultBackground = isHexColor(settings.background) ? settings.background.toLowerCase() : '#ffffff';
      this.backgroundColor = this.defaultBackground;
      this.fillTolerance = clamp(Number(settings.fillTolerance) || 20, 0, 64);
      this.maxFillOperations = Number(settings.maxFillOperations) || this.logicalWidth * this.logicalHeight * 6;
      this.onError = typeof settings.onError === 'function' ? settings.onError : function () {};
      this.pixelMode = false;
      this.strokes = [];
      this.layersMeta = [];
      canvas.width = this.logicalWidth;
      canvas.height = this.logicalHeight;
      canvas.style.backgroundColor = this.defaultBackground;
      this.applySmoothing();
    }

    /** 开关最近邻采样，像素画板关闭平滑以免格子发糊。 */
    applySmoothing() {
      const smooth = !this.pixelMode;
      this.context.imageSmoothingEnabled = smooth;
      this._bufferCtx.imageSmoothingEnabled = smooth;
    }

    /**
     * 切换矢量/像素画板并重设逻辑分辨率。
     * 像素模式下宽高等于格子数，笔触按整格绘制。
     */
    setCanvasMode(mode, width, height) {
      this.pixelMode = mode === 'pixel';
      if (this.pixelMode) {
        this.logicalWidth = clamp(Math.round(Number(width) || 32), 2, 128);
        this.logicalHeight = clamp(Math.round(Number(height) || 32), 2, 128);
      } else {
        this.logicalWidth = 960;
        this.logicalHeight = 540;
      }
      this.maxFillOperations = this.logicalWidth * this.logicalHeight * 6;
      this.canvas.width = this.logicalWidth;
      this.canvas.height = this.logicalHeight;
      this.ensureBufferSize();
      this.applySmoothing();
    }

    /** 返回当前画布模式，供工具栏和联机同步使用。 */
    canvasSpec() {
      return {
        mode: this.pixelMode ? 'pixel' : 'vector',
        width: this.logicalWidth,
        height: this.logicalHeight
      };
    }

    /**
     * 按舞台可用区域等比放大画布，尽量铺满中央视口（contain），多余边缘为灰色。
     */
    fitToStage(stage) {
      if (!stage) return;
      const stageW = stage.clientWidth;
      const stageH = stage.clientHeight;
      if (stageW <= 0 || stageH <= 0) return;
      const scale = Math.min(stageW / this.logicalWidth, stageH / this.logicalHeight);
      const displayW = Math.max(1, Math.floor(this.logicalWidth * scale));
      const displayH = Math.max(1, Math.floor(this.logicalHeight * scale));
      this.canvas.style.width = displayW + 'px';
      this.canvas.style.height = displayH + 'px';
      const surface = this.canvas.parentElement;
      if (surface && surface.classList.contains('canvas-stage-surface')) {
        surface.style.width = displayW + 'px';
        surface.style.height = displayH + 'px';
      }
    }

    /** 把归一化坐标落到像素中心，保证格子对齐。 */
    snapPoint(x, y) {
      if (!this.pixelMode) return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
      const pixelX = clamp(Math.floor(x * this.logicalWidth), 0, this.logicalWidth - 1);
      const pixelY = clamp(Math.floor(y * this.logicalHeight), 0, this.logicalHeight - 1);
      return {
        x: (pixelX + 0.5) / this.logicalWidth,
        y: (pixelY + 0.5) / this.logicalHeight
      };
    }

    /** 在像素画板上沿线段盖一整格方形笔刷。 */
    stampPixelStroke(context, x1, y1, x2, y2, size, color, eraser) {
      const width = this.logicalWidth;
      const height = this.logicalHeight;
      const brush = clamp(Math.round(Number(size) || 1), 1, 64);
      const half = Math.floor((brush - 1) / 2);
      let col1 = clamp(Math.floor(x1 * width), 0, width - 1);
      let row1 = clamp(Math.floor(y1 * height), 0, height - 1);
      const col2 = clamp(Math.floor(x2 * width), 0, width - 1);
      const row2 = clamp(Math.floor(y2 * height), 0, height - 1);
      const deltaCol = Math.abs(col2 - col1);
      const deltaRow = Math.abs(row2 - row1);
      const stepCol = col1 < col2 ? 1 : -1;
      const stepRow = row1 < row2 ? 1 : -1;
      let error = deltaCol - deltaRow;
      context.save();
      context.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
      context.fillStyle = color;
      const stamp = (col, row) => {
        const left = clamp(col - half, 0, width - 1);
        const top = clamp(row - half, 0, height - 1);
        const right = clamp(col - half + brush, 0, width);
        const bottom = clamp(row - half + brush, 0, height);
        context.fillRect(left, top, right - left, bottom - top);
      };
      while (true) {
        stamp(col1, row1);
        if (col1 === col2 && row1 === row2) break;
        const doubled = error * 2;
        if (doubled > -deltaRow) { error -= deltaRow; col1 += stepCol; }
        if (doubled < deltaCol) { error += deltaCol; row1 += stepRow; }
      }
      context.restore();
    }

    /**
     * 在归一化坐标处绘制本地笔刷预览（单点方形笔刷，仅悬停层，不写主画布）。
     * 画笔为半透明填色，橡皮为描边镂空。
     */
    drawPixelBrushPreview(context, x, y, size, color, eraser) {
      if (!this.pixelMode || !context) return;
      const width = this.logicalWidth;
      const height = this.logicalHeight;
      const brush = clamp(Math.round(Number(size) || 1), 1, 64);
      const half = Math.floor((brush - 1) / 2);
      const col = clamp(Math.floor(unitNumber(x) * width), 0, width - 1);
      const row = clamp(Math.floor(unitNumber(y) * height), 0, height - 1);
      const left = clamp(col - half, 0, width - 1);
      const top = clamp(row - half, 0, height - 1);
      const right = clamp(col - half + brush, 0, width);
      const bottom = clamp(row - half + brush, 0, height);
      const stampW = right - left;
      const stampH = bottom - top;
      if (stampW <= 0 || stampH <= 0) return;
      context.save();
      context.imageSmoothingEnabled = false;
      if (eraser) {
        context.globalCompositeOperation = 'source-over';
        context.fillStyle = 'rgb(255 255 255 / .28)';
        context.fillRect(left, top, stampW, stampH);
        context.strokeStyle = 'rgb(15 23 42 / .78)';
        context.lineWidth = 1;
        context.strokeRect(left + 0.5, top + 0.5, Math.max(0, stampW - 1), Math.max(0, stampH - 1));
      } else {
        const strokeStyle = isHexColor(color) ? color : '#111827';
        context.globalCompositeOperation = 'source-over';
        context.globalAlpha = 0.58;
        context.fillStyle = strokeStyle;
        context.fillRect(left, top, stampW, stampH);
      }
      context.restore();
    }

    setStrokes(strokes, redraw) {
      this.strokes = cloneStrokes(strokes);
      if (redraw !== false) this.redraw();
    }
    getStrokes() { return cloneStrokes(this.strokes); }
    setBackground(color) {
      this.backgroundColor = isHexColor(color) ? color.toLowerCase() : this.defaultBackground;
      this.canvas.style.backgroundColor = this.backgroundColor;
    }
    normalizePoint(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const point = {
        x: clamp((clientX - rect.left) / rect.width, 0, 1),
        y: clamp((clientY - rect.top) / rect.height, 0, 1)
      };
      return this.pixelMode ? this.snapPoint(point.x, point.y) : point;
    }
    sampleColor(x, y) {
      const pixelX = clamp(Math.floor(x * this.logicalWidth), 0, this.logicalWidth - 1);
      const pixelY = clamp(Math.floor(y * this.logicalHeight), 0, this.logicalHeight - 1);
      const pixel = this.context.getImageData(pixelX, pixelY, 1, 1).data;
      const alpha = pixel[3] / 255;
      const background = hexToRgb(this.backgroundColor);
      return rgbToHex(pixel[0] * alpha + background.r * (1 - alpha), pixel[1] * alpha + background.g * (1 - alpha), pixel[2] * alpha + background.b * (1 - alpha));
    }
    drawSegment(segment) {
      if (segment && segment.tool === 'localRaster') return this.drawLocalRaster(segment);
      if (!segment || !VALID_TOOLS.has(segment.tool || 'brush')) return false;
      const tool = segment.tool || 'brush';
      if (tool === 'background') { this.setBackground(segment.color); return true; }
      if (tool === 'fill') return this.floodFill(segment).changed;
      if (tool === 'gradient') return this.drawGradient(segment);
      const strokeStyle = isHexColor(segment.color) ? segment.color : '#111827';
      if (this.pixelMode && (tool === 'brush' || tool === 'eraser')) {
        this.stampPixelStroke(
          this.context,
          unitNumber(segment.x1),
          unitNumber(segment.y1),
          unitNumber(segment.x2),
          unitNumber(segment.y2),
          segment.size,
          strokeStyle,
          tool === 'eraser'
        );
        return true;
      }
      const x1 = unitNumber(segment.x1) * this.logicalWidth;
      const y1 = unitNumber(segment.y1) * this.logicalHeight;
      const x2 = unitNumber(segment.x2) * this.logicalWidth;
      const y2 = unitNumber(segment.y2) * this.logicalHeight;
      const lineWidth = clamp(Number(segment.size) || 5, 1, 64) * (this.logicalWidth / 640);
      const composite = tool === 'eraser' ? 'destination-out' : 'source-over';
      const paint = context => {
        context.save();
        context.globalCompositeOperation = composite;
        context.strokeStyle = strokeStyle;
        context.fillStyle = strokeStyle;
        context.lineWidth = lineWidth;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        if (tool === 'line') {
          context.beginPath();
          context.moveTo(x1, y1);
          context.lineTo(x2, y2);
          context.stroke();
        } else if (tool === 'rect') {
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const rw = Math.abs(x2 - x1);
          const rh = Math.abs(y2 - y1);
          if (segment.filled) context.fillRect(left, top, rw, rh);
          else context.strokeRect(left, top, rw, rh);
        } else if (tool === 'ellipse') {
          const cx = (x1 + x2) / 2;
          const cy = (y1 + y2) / 2;
          const rx = Math.abs(x2 - x1) / 2;
          const ry = Math.abs(y2 - y1) / 2;
          context.beginPath();
          context.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
          if (segment.filled) context.fill();
          else context.stroke();
        } else {
          context.beginPath();
          context.moveTo(x1, y1);
          context.lineTo(x2, y2);
          context.stroke();
        }
        context.restore();
      };
      paint(this.context);
      return true;
    }

    /** 绘制仅本地的像素块（选区操作结果，不参与联机同步）。 */
    drawLocalRaster(segment) {
      const x = Math.floor(unitNumber(segment.x) * this.logicalWidth);
      const y = Math.floor(unitNumber(segment.y) * this.logicalHeight);
      const w = Math.max(1, Math.floor(unitNumber(segment.w) * this.logicalWidth));
      const h = Math.max(1, Math.floor(unitNumber(segment.h) * this.logicalHeight));
      const raw = segment.pixels;
      if (!raw || !raw.length) return false;
      const ctx = this.context;
      ctx.save();
      for (let row = 0; row < h; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const i = (row * w + col) * 4;
          const alpha = raw[i + 3];
          if (segment.punch && alpha === 0) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = '#000';
            ctx.fillRect(x + col, y + row, 1, 1);
          } else if (alpha > 0) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = 'rgba(' + raw[i] + ',' + raw[i + 1] + ',' + raw[i + 2] + ',' + (alpha / 255) + ')';
            ctx.fillRect(x + col, y + row, 1, 1);
          }
        }
      }
      ctx.restore();
      return true;
    }

    /** 在 segment 两点间 bounding box 内绘制线性渐变。 */
    drawGradient(segment) {
      const x1 = unitNumber(segment.x1) * this.logicalWidth;
      const y1 = unitNumber(segment.y1) * this.logicalHeight;
      const x2 = unitNumber(segment.x2) * this.logicalWidth;
      const y2 = unitNumber(segment.y2) * this.logicalHeight;
      const left = clamp(Math.min(x1, x2), 0, this.logicalWidth);
      const top = clamp(Math.min(y1, y2), 0, this.logicalHeight);
      const right = clamp(Math.max(x1, x2), 0, this.logicalWidth);
      const bottom = clamp(Math.max(y1, y2), 0, this.logicalHeight);
      const rw = Math.max(1, right - left);
      const rh = Math.max(1, bottom - top);
      const c1 = isHexColor(segment.color) ? segment.color : '#111827';
      const c2 = isHexColor(segment.color2) ? segment.color2 : this.backgroundColor;
      const ctx = this.context;
      ctx.save();
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);
      ctx.fillStyle = grad;
      ctx.fillRect(left, top, rw, rh);
      ctx.restore();
      return true;
    }
    ensureBufferSize() {
      if (this._buffer.width !== this.logicalWidth || this._buffer.height !== this.logicalHeight) {
        this._buffer.width = this.logicalWidth;
        this._buffer.height = this.logicalHeight;
      }
    }
    redraw(strokes, layersMeta) {
      if (layersMeta) this.layersMeta = (layersMeta || []).slice();
      if (strokes) this.strokes = cloneStrokes(strokes);
      if (this.layersMeta && this.layersMeta.length) {
        this.redrawLayers(this.layersMeta, this.strokes);
        return;
      }
      this._redrawFlat(this.strokes);
    }

    /** 图层模式下清空离屏缓冲为白底；无图层时沿用旧版纯色底。 */
    _clearDrawBuffer(useLayerMode) {
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      if (useLayerMode) {
        this.context.fillStyle = this.defaultBackground;
        this.context.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
        this.backgroundColor = this.defaultBackground;
        this.canvas.style.backgroundColor = this.defaultBackground;
        return;
      }
      let fillColor = this.defaultBackground;
      this.strokes.forEach(stroke => {
        if (stroke.active === false) return;
        (stroke.segments || []).forEach(segment => {
          if ((segment.tool || 'brush') === 'background' && isHexColor(segment.color)) {
            fillColor = segment.color.toLowerCase();
          }
        });
      });
      this.context.fillStyle = fillColor;
      this.context.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
      this.backgroundColor = fillColor;
      this.canvas.style.backgroundColor = fillColor;
    }

    /** 按图层顺序与透明度合成绘制；组不含笔迹，继承父组可见性。 */
    redrawLayers(layersMeta, strokes) {
      if (layersMeta) this.layersMeta = (layersMeta || []).slice();
      if (strokes) this.strokes = cloneStrokes(strokes);
      this.ensureBufferSize();
      this.applySmoothing();
      const sorted = this.layersMeta.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      const layerById = new Map(sorted.map(layer => [String(layer.layer_id || 'l_default'), layer]));
      const isVisible = layer => {
        if (!layer || layer.visible === false) return false;
        let parentId = layer.parent_id || '';
        while (parentId) {
          const parent = layerById.get(String(parentId));
          if (!parent || parent.visible === false) return false;
          parentId = parent.parent_id || '';
        }
        return true;
      };
      const main = this.context;
      this.context = this._bufferCtx;
      this._clearDrawBuffer(true);
      sorted.forEach(layer => {
        if (layer.kind === 'group') return;
        if (!isVisible(layer)) return;
        const opacity = clamp(Number(layer.opacity != null ? layer.opacity : 255), 0, 255) / 255;
        if (opacity <= 0) return;
        const layerId = String(layer.layer_id || 'l_default');
        this.context.save();
        this.context.globalAlpha = opacity;
        this.strokes.filter(stroke => stroke.active !== false && String(stroke.layer_id || 'l_default') === layerId)
          .forEach(stroke => {
            (stroke.segments || []).forEach(segment => {
              if ((segment.tool || 'brush') === 'background') return;
              this.drawSegment(segment);
            });
          });
        this.context.restore();
      });
      this.context = main;
      main.setTransform(1, 0, 0, 1, 0, 0);
      main.save();
      main.globalCompositeOperation = 'copy';
      main.drawImage(this._buffer, 0, 0);
      main.restore();
    }

    _redrawFlat(strokes) {
      this.ensureBufferSize();
      this.applySmoothing();
      const main = this.context;
      this.context = this._bufferCtx;
      this._clearDrawBuffer(false);
      this.strokes.filter(stroke => stroke.active !== false).forEach(stroke => stroke.segments.forEach(segment => {
        if ((segment.tool || 'brush') === 'background') return;
        this.drawSegment(segment);
      }));
      this.context = main;
      main.setTransform(1, 0, 0, 1, 0, 0);
      // Present buffer in one copy op — avoid clearRect (causes visible white flash).
      main.save();
      main.globalCompositeOperation = 'copy';
      main.drawImage(this._buffer, 0, 0);
      main.restore();
    }
    compositedPixel(pixels, index, background) {
      const alpha = pixels[index + 3] / 255;
      return [Math.round(pixels[index] * alpha + background.r * (1 - alpha)), Math.round(pixels[index + 1] * alpha + background.g * (1 - alpha)), Math.round(pixels[index + 2] * alpha + background.b * (1 - alpha))];
    }
    floodFill(segment) {
      const width = this.logicalWidth, height = this.logicalHeight;
      const seedX = Math.floor(unitNumber(segment.x) * (width - 1)), seedY = Math.floor(unitNumber(segment.y) * (height - 1));
      const image = this.context.getImageData(0, 0, width, height), pixels = image.data;
      const replacement = hexToRgb(segment.color), background = hexToRgb(this.backgroundColor);
      const target = this.compositedPixel(pixels, (seedY * width + seedX) * 4, background), tolerance = this.pixelMode ? 0 : this.fillTolerance;
      if (Math.abs(target[0] - replacement.r) <= tolerance && Math.abs(target[1] - replacement.g) <= tolerance && Math.abs(target[2] - replacement.b) <= tolerance) return { changed: false, reason: 'same-color' };
      let operations = 0, painted = 0;
      const matches = (x, y) => {
        operations += 1;
        if (operations > this.maxFillOperations) return false;
        const color = this.compositedPixel(pixels, (y * width + x) * 4, background);
        return Math.abs(color[0] - target[0]) <= tolerance && Math.abs(color[1] - target[1]) <= tolerance && Math.abs(color[2] - target[2]) <= tolerance;
      };
      const paint = (x, y) => { const index = (y * width + x) * 4; pixels[index] = replacement.r; pixels[index + 1] = replacement.g; pixels[index + 2] = replacement.b; pixels[index + 3] = 255; };
      const stack = [seedX, seedY];
      while (stack.length && operations <= this.maxFillOperations) {
        const y = stack.pop(), x = stack.pop(); let left = x;
        while (left >= 0 && matches(left, y)) left -= 1;
        left += 1; let spanUp = false, spanDown = false;
        for (let scanX = left; scanX < width && matches(scanX, y); scanX += 1) {
          paint(scanX, y); painted += 1;
          if (y > 0) { const matchUp = matches(scanX, y - 1); if (matchUp && !spanUp) stack.push(scanX, y - 1); spanUp = matchUp; }
          if (y < height - 1) { const matchDown = matches(scanX, y + 1); if (matchDown && !spanDown) stack.push(scanX, y + 1); spanDown = matchDown; }
        }
      }
      if (operations > this.maxFillOperations) { this.onError('填充区域过大，请缩小封闭区域后重试'); return { changed: false, reason: 'work-limit' }; }
      if (!painted) return { changed: false, reason: 'empty' };
      this.context.putImageData(image, 0, 0);
      return { changed: true, painted };
    }
    mergeServerSnapshot(serverStrokes, localStrokes, options) {
      const snapshot = cloneStrokes(serverStrokes);
      const settings = options || {};
      if (!settings.preserveStrokeId) return snapshot;
      const localStroke = DrawingBoard.findStroke(
        localStrokes,
        settings.preserveOwnerId,
        settings.preserveStrokeId
      );
      if (!localStroke) return snapshot;
      const localCopy = cloneStrokes([localStroke])[0];
      const index = snapshot.findIndex(stroke =>
        stroke.owner_id === settings.preserveOwnerId
        && stroke.stroke_id === settings.preserveStrokeId
      );
      if (index >= 0) snapshot[index] = localCopy;
      else snapshot.push(localCopy);
      return snapshot;
    }
    appendSegment(collection, ownerId, strokeId, segment, layerId) {
      let stroke = DrawingBoard.findStroke(collection, ownerId, strokeId);
      if (!stroke) {
        stroke = {
          stroke_id: strokeId,
          owner_id: ownerId,
          layer_id: String(layerId || 'l_default'),
          active: true,
          segments: []
        };
        collection.push(stroke);
      }
      stroke.active = true;
      if (layerId) stroke.layer_id = String(layerId);
      stroke.segments.push(Object.assign({}, segment));
      return stroke;
    }
    undoLatest(collection, redoStack, ownerId) {
      for (let index = collection.length - 1; index >= 0; index -= 1) {
        const stroke = collection[index];
        if (stroke.active === false || (ownerId && stroke.owner_id !== ownerId)) continue;
        stroke.active = false;
        redoStack.push(stroke);
        return stroke;
      }
      return null;
    }
    redoLatest(redoStack) {
      const stroke = redoStack.pop();
      if (!stroke) return null;
      stroke.active = true;
      return stroke;
    }

    async exportStrokesBlob(strokes, maxWidth, mimeType, quality) {
      this.ensureBufferSize();
      const main = this.context;
      const previous = this.strokes;
      const previousBackground = this.backgroundColor;
      const list = cloneStrokes(strokes || []);
      let fillColor = this.defaultBackground;
      list.forEach(stroke => {
        if (stroke.active === false) return;
        (stroke.segments || []).forEach(segment => {
          if ((segment.tool || 'brush') === 'background' && isHexColor(segment.color)) fillColor = segment.color.toLowerCase();
        });
      });
      this.context = this._bufferCtx;
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      this.context.fillStyle = fillColor;
      this.context.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
      this.backgroundColor = fillColor;
      list.filter(stroke => stroke.active !== false).forEach(stroke => stroke.segments.forEach(segment => {
        if ((segment.tool || 'brush') === 'background') {
          const color = isHexColor(segment.color) ? segment.color.toLowerCase() : fillColor;
          this.backgroundColor = color;
          this.context.fillStyle = color;
          this.context.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
          return;
        }
        this.drawSegment(segment);
      }));
      this.context = main;
      this.strokes = previous;
      this.backgroundColor = previousBackground;
      this.canvas.style.backgroundColor = previousBackground;
      return this._exportBitmap(this._buffer, maxWidth, mimeType, quality);
    }

    /** 像素画板上采样放大到目标边长，矢量画板不超过逻辑分辨率。 */
    exportScale(maxWidth) {
      const requested = Number(maxWidth) || this.logicalWidth;
      if (this.pixelMode) {
        const target = Math.max(this.logicalWidth, requested);
        return Math.max(1, Math.round(target / this.logicalWidth));
      }
      const outputWidth = Math.min(requested, this.logicalWidth);
      return outputWidth / this.logicalWidth;
    }

    _exportBitmap(source, maxWidth, mimeType, quality) {
      const scale = this.exportScale(maxWidth);
      const output = document.createElement('canvas');
      output.width = Math.max(1, Math.round(this.logicalWidth * scale));
      output.height = Math.max(1, Math.round(this.logicalHeight * scale));
      const context = output.getContext('2d');
      context.imageSmoothingEnabled = !this.pixelMode;
      context.fillStyle = this.backgroundColor || this.defaultBackground;
      context.fillRect(0, 0, output.width, output.height);
      context.drawImage(source, 0, 0, output.width, output.height);
      return new Promise(resolve => output.toBlob(resolve, mimeType || 'image/webp', quality == null ? 0.82 : quality));
    }

    exportBlob(maxWidth, mimeType, quality) {
      return this._exportBitmap(this.canvas, maxWidth, mimeType, quality);
    }
    static cloneStrokes(strokes) { return cloneStrokes(strokes); }
    static isBackgroundSegment(segment) { return (segment && (segment.tool || 'brush')) === 'background'; }
    static isBackgroundOnlyStroke(stroke) {
      const segments = stroke && stroke.segments;
      return Array.isArray(segments) && segments.length > 0 && segments.every(segment => DrawingBoard.isBackgroundSegment(segment));
    }
    static keepBackgroundStrokes(strokes) {
      return cloneStrokes(strokes).filter(stroke => DrawingBoard.isBackgroundOnlyStroke(stroke));
    }
    static findStroke(strokes, ownerId, strokeId) { return (strokes || []).find(stroke => stroke.owner_id === ownerId && stroke.stroke_id === strokeId); }
    static setStrokeVisible(strokes, ownerId, strokeId, visible) { const stroke = DrawingBoard.findStroke(strokes, ownerId, strokeId); if (!stroke) return false; stroke.active = Boolean(visible); return true; }
  }
  global.DrawingBoard = DrawingBoard;
})(window);
