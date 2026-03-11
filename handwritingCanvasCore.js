// src/utils/handwritingCanvasCore.js
// ─────────────────────────────────────────────────────────────────────────────
// Low-level stylus canvas engine for the Alined handwriting input panel.
//
// This is a framework-agnostic class.  The React component
// (src/components/HandwritingCanvas.jsx) can use it directly:
//
//   import HandwritingCanvasCore from '../utils/handwritingCanvasCore';
//
//   // inside useEffect:
//   const core = new HandwritingCanvasCore(canvasRef.current, recognizer, parser);
//   core.on('dimension', ({ raw, parsed }) => { … });
//   return () => core.destroy();
//
// Why a separate class?
//   • Pointer Events (Apple Pencil / S Pen) are not exposed via React's
//     synthetic event system with the same fidelity.
//   • Pressure-sensitive line width requires low-level event handling.
//   • Stroke segmentation for multi-character input lives here.
// ─────────────────────────────────────────────────────────────────────────────

export default class HandwritingCanvasCore {

  // ── tuneable defaults ───────────────────────────────────────────────────────
  static RECOGNITION_DELAY  = 600;   // ms idle before auto-recognise (wait for pen lift)
  // CLUSTER_MAX_GAP_PX – strokes farther apart than this become separate clusters
  // (and thus separate characters).  80 px was too large — digits 50 px apart
  // were merged into one cluster, then classified as a single wrong character.
  // 50 px still groups the two strokes of "i" or a broken "1" while keeping
  // adjacent-digit clusters separate on typical stylus handwriting.
  static CLUSTER_MAX_GAP_PX = 50;
  // CLUSTER_MAX_GAP_MS – reduce time window so a digit written quickly after
  // a pause does not get merged with the previous character.
  static CLUSTER_MAX_GAP_MS = 700;   // was 1000 ms
  static MIN_STROKE_POINTS  = 2;     // ignore micro-touches
  static PRESSURE_SCALE     = 9;     // lineWidth = pressure × this (thicker for OCR)
  static MIN_LINE_WIDTH     = 3;     // minimum stroke width ensures OCR can read thin writing
  static MAX_LINE_WIDTH     = 16;    // maximum stroke width
  static STROKE_COLOR       = '#1a1a1a';
  static CANVAS_BG          = '#ffffff';
  static PADDING_PX         = 12;    // more padding when cropping so OCR doesn't clip glyphs
  // Output canvas size for recognition — fixed resolution improves consistency
  static OCR_WIDTH          = 400;
  static OCR_HEIGHT         = 200;

  /**
   * @param {HTMLCanvasElement}    el          – the <canvas> to draw on
   * @param {HandwritingRecognizer} recognizer  – from handwritingRecognizer.js
   * @param {DimensionParser}      parser       – from dimensionParser.js
   */
  constructor(el, recognizer, parser) {
    if (!el || el.tagName !== 'CANVAS') {
      throw new Error('[HandwritingCanvasCore] el must be an HTMLCanvasElement');
    }
    this._el          = el;
    this._recognizer  = recognizer;
    this._parser      = parser;
    this._ctx         = el.getContext('2d');
    this._listeners   = {};

    this._currentStroke  = null;
    this._strokes        = [];
    this._recognizeTimer = null;

    this._setup();
    this._bind();
  }

  // ── public ──────────────────────────────────────────────────────────────────

  /** Subscribe to 'dimension' | 'error' | 'clear' | 'strokeEnd' */
  on(event, handler) {
    (this._listeners[event] ??= []).push(handler);
    return this;
  }

  off(event, handler) {
    if (!handler) delete this._listeners[event];
    else this._listeners[event] = (this._listeners[event] ?? []).filter(h => h !== handler);
    return this;
  }

  clear() {
    this._strokes       = [];
    this._currentStroke = null;
    clearTimeout(this._recognizeTimer);
    this._clearCanvas();
    this._emit('clear');
  }

  async recognizeNow() {
    clearTimeout(this._recognizeTimer);
    await this._runRecognition();
  }

  destroy() {
    clearTimeout(this._recognizeTimer);
    this._el.removeEventListener('pointerdown',  this._onDown);
    this._el.removeEventListener('pointermove',  this._onMove);
    this._el.removeEventListener('pointerup',    this._onUp);
    this._el.removeEventListener('pointerleave', this._onLeave);
  }

  // ── canvas setup ─────────────────────────────────────────────────────────

  _setup() {
    const el  = this._el;
    const dpr = window.devicePixelRatio || 1;
    const rect = el.getBoundingClientRect();

    el.width  = Math.round(rect.width  * dpr);
    el.height = Math.round(rect.height * dpr);
    el.style.touchAction = 'none';   // prevent scroll during drawing

    this._ctx.scale(dpr, dpr);
    this._ctx.lineCap  = 'round';
    this._ctx.lineJoin = 'round';

    this._dpr      = dpr;
    this._cssWidth  = rect.width;
    this._cssHeight = rect.height;

    this._clearCanvas();
  }

  _clearCanvas() {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._cssWidth, this._cssHeight);
    ctx.fillStyle = HandwritingCanvasCore.CANVAS_BG;
    ctx.fillRect(0, 0, this._cssWidth, this._cssHeight);

    // Light guide grid (matches existing HandwritingCanvas.jsx grid style)
    ctx.strokeStyle = '#f0f0f0';
    ctx.lineWidth   = 1;
    const gs = 20;
    for (let x = 0; x < this._cssWidth;  x += gs) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this._cssHeight); ctx.stroke();
    }
    for (let y = 0; y < this._cssHeight; y += gs) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this._cssWidth, y); ctx.stroke();
    }
  }

  // ── pointer events ────────────────────────────────────────────────────────

  _bind() {
    this._onDown  = e => this._handleDown(e);
    this._onMove  = e => this._handleMove(e);
    this._onUp    = e => this._handleUp(e);
    this._onLeave = e => this._handleUp(e);

    this._el.addEventListener('pointerdown',  this._onDown,  { passive: false });
    this._el.addEventListener('pointermove',  this._onMove,  { passive: false });
    this._el.addEventListener('pointerup',    this._onUp,    { passive: false });
    this._el.addEventListener('pointerleave', this._onLeave, { passive: false });
    this._el.addEventListener('contextmenu',  e => e.preventDefault());
  }

  _pt(e) {
    const r = this._el.getBoundingClientRect();
    return {
      x        : e.clientX - r.left,
      y        : e.clientY - r.top,
      pressure : e.pressure ?? 0.5,
    };
  }

  _handleDown(e) {
    e.preventDefault();
    this._el.setPointerCapture(e.pointerId);
    const pt = this._pt(e);
    this._currentStroke = { points: [pt], startTime: Date.now() };
    this._ctx.beginPath();
    this._ctx.moveTo(pt.x, pt.y);
    clearTimeout(this._recognizeTimer);
  }

  _handleMove(e) {
    if (!this._currentStroke) return;
    e.preventDefault();
    const pt  = this._pt(e);
    const ctx = this._ctx;

    const pressure  = Math.max(0.1, pt.pressure);
    ctx.lineWidth   = Math.min(
      HandwritingCanvasCore.MAX_LINE_WIDTH,
      Math.max(HandwritingCanvasCore.MIN_LINE_WIDTH, pressure * HandwritingCanvasCore.PRESSURE_SCALE)
    );
    ctx.strokeStyle = HandwritingCanvasCore.STROKE_COLOR;

    const prev = this._currentStroke.points.at(-1);
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();

    this._currentStroke.points.push(pt);
  }

  _handleUp(e) {
    if (!this._currentStroke) return;
    const stroke = this._currentStroke;
    stroke.endTime = Date.now();
    this._currentStroke = null;

    if (stroke.points.length >= HandwritingCanvasCore.MIN_STROKE_POINTS) {
      stroke.bounds = this._bounds(stroke.points);
      this._strokes.push(stroke);
      this._emit('strokeEnd', { stroke });
    }

    this._recognizeTimer = setTimeout(
      () => this._runRecognition(),
      HandwritingCanvasCore.RECOGNITION_DELAY
    );
  }

  // ── stroke geometry ───────────────────────────────────────────────────────

  _bounds(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { x, y } of points) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  _boundsDist(a, b) {
    const xGap = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
    const yGap = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
    return Math.sqrt(xGap * xGap + yGap * yGap);
  }

  _mergeBounds(a, b) {
    return {
      minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
      maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
    };
  }

  // ── cluster segmentation ──────────────────────────────────────────────────

  _segmentClusters() {
    const clusters = [];
    for (const stroke of this._strokes) {
      let merged = false;
      for (const cluster of clusters) {
        if (
          (stroke.startTime - cluster.endTime) < HandwritingCanvasCore.CLUSTER_MAX_GAP_MS &&
          this._boundsDist(stroke.bounds, cluster.bounds) < HandwritingCanvasCore.CLUSTER_MAX_GAP_PX
        ) {
          cluster.strokes.push(stroke);
          cluster.bounds  = this._mergeBounds(cluster.bounds, stroke.bounds);
          cluster.endTime = stroke.endTime;
          merged = true;
          break;
        }
      }
      if (!merged) {
        clusters.push({
          strokes: [stroke],
          bounds: { ...stroke.bounds },
          startTime: stroke.startTime,
          endTime: stroke.endTime,
        });
      }
    }
    return clusters.sort((a, b) => a.bounds.minX - b.bounds.minX);
  }

  // ── recognition ───────────────────────────────────────────────────────────

  async _runRecognition() {
    if (this._strokes.length === 0) return;

    try {
      const clusters = this._segmentClusters();

      // ── New path: MeasurementRecognizer (symbol-aware) ──────────────────
      // MeasurementRecognizer exposes recognizeCluster(cluster, renderFn).
      // It classifies apostrophe/quote/dash by stroke geometry and sends only
      // digit sub-clusters to the CNN.  This is the correct path for all input
      // that may contain unit symbols like ' and ".
      if (typeof this._recognizer.recognizeCluster === 'function') {
        const parts = [];
        for (const cluster of clusters) {
          const str = await this._recognizer.recognizeCluster(
            cluster,
            strokes => this._renderStrokesAsCanvas(strokes)
          );
          if (str) parts.push(str);
        }
        if (parts.length === 0) {
          this._emit('error', { message: 'Could not recognise any characters.' });
          return;
        }
        const raw    = parts.join('');
        const parsed = this._parser.parse(raw);
        this._emit('dimension', { raw, parsed, digits: [] });
        return;
      }

      // ── Legacy path: plain MNIST per-cluster (digits only) ──────────────
      // Kept as a fallback in case HandwritingRecognizer is passed directly.
      const digits = [];
      for (const cluster of clusters) {
        const offscreen   = this._cropCluster(cluster);
        const predictions = await this._recognizer.predict(offscreen, 3);
        const top         = predictions[0];
        if (top.confidence < 0.40) {
          console.warn(`[HWRCore] Low confidence (${(top.confidence * 100).toFixed(0)}%) – skipping`);
          continue;
        }
        digits.push({ digit: top.digit, confidence: top.confidence });
      }
      if (digits.length === 0) {
        this._emit('error', { message: 'Could not recognise any digits.' });
        return;
      }
      const raw    = digits.map(d => String(d.digit)).join('');
      const parsed = this._parser.parse(raw);
      this._emit('dimension', { raw, parsed, digits });

    } catch (err) {
      console.error('[HWRCore] Recognition error:', err);
      this._emit('error', { message: err.message });
    }
  }

  /**
   * Render a subset of strokes to an offscreen canvas at the same fixed
   * OCR resolution used by _cropCluster, so the output is compatible with
   * both MNIST (28×28 internally) and the custom CNN (32×32 internally).
   *
   * @param {Array} strokes – subset of this._strokes
   * @returns {HTMLCanvasElement|null}
   */
  _renderStrokesAsCanvas(strokes) {
    if (!strokes || strokes.length === 0) return null;

    // Compute tight bounding box over just these strokes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      const b = s.bounds;
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }

    // Delegate to _cropCluster with a synthetic cluster — reuses all the
    // letterboxing / centering / scaling logic already there.
    return this._cropCluster({
      strokes,
      bounds: { minX, minY, maxX, maxY },
    });
  }

  _cropCluster(cluster) {
    const pad = HandwritingCanvasCore.PADDING_PX;
    const b   = cluster.bounds;
    const srcW = Math.max(1, b.maxX - b.minX + pad * 2);
    const srcH = Math.max(1, b.maxY - b.minY + pad * 2);

    // Render strokes to an intermediate canvas at native resolution
    const inter    = document.createElement('canvas');
    inter.width    = srcW;
    inter.height   = srcH;
    const interCtx = inter.getContext('2d');

    interCtx.fillStyle = HandwritingCanvasCore.CANVAS_BG;
    interCtx.fillRect(0, 0, srcW, srcH);
    interCtx.lineCap  = 'round';
    interCtx.lineJoin = 'round';
    interCtx.strokeStyle = HandwritingCanvasCore.STROKE_COLOR;

    for (const stroke of cluster.strokes) {
      const pts = stroke.points;
      if (pts.length < 2) continue;
      interCtx.beginPath();
      interCtx.moveTo(pts[0].x - b.minX + pad, pts[0].y - b.minY + pad);
      for (let i = 1; i < pts.length; i++) {
        const pressure = Math.max(0.1, pts[i].pressure || 0.5);
        interCtx.lineWidth = Math.min(
          HandwritingCanvasCore.MAX_LINE_WIDTH,
          Math.max(HandwritingCanvasCore.MIN_LINE_WIDTH, pressure * HandwritingCanvasCore.PRESSURE_SCALE)
        );
        interCtx.lineTo(pts[i].x - b.minX + pad, pts[i].y - b.minY + pad);
      }
      interCtx.stroke();
    }

    // Scale to fixed OCR resolution so TF model always sees same-size input
    const ocrW = HandwritingCanvasCore.OCR_WIDTH;
    const ocrH = HandwritingCanvasCore.OCR_HEIGHT;

    const off    = document.createElement('canvas');
    off.width    = ocrW;
    off.height   = ocrH;
    const offCtx = off.getContext('2d');

    offCtx.fillStyle = HandwritingCanvasCore.CANVAS_BG;
    offCtx.fillRect(0, 0, ocrW, ocrH);

    // Centre the content with letterboxing
    const scale = Math.min((ocrW - pad * 2) / srcW, (ocrH - pad * 2) / srcH);
    const dw    = srcW * scale;
    const dh    = srcH * scale;
    const dx    = (ocrW - dw) / 2;
    const dy    = (ocrH - dh) / 2;

    offCtx.imageSmoothingEnabled = true;
    offCtx.imageSmoothingQuality = 'high';
    offCtx.drawImage(inter, 0, 0, srcW, srcH, dx, dy, dw, dh);

    return off;
  }

  // ── emitter ───────────────────────────────────────────────────────────────

  _emit(event, data = {}) {
    for (const h of this._listeners[event] ?? []) {
      try { h(data); } catch (e) { console.error(e); }
    }
  }
}
