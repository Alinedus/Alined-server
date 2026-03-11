// src/utils/characterSegmenter.js
// ─────────────────────────────────────────────────────────────────────────────
// Pixel-based character segmentation using vertical projection profiles.
//
// Splits a rendered cluster image (any size) into individual character images
// sorted left → right.  Used as a fallback when stroke data is unavailable,
// and as a sanity-check / secondary path for complex connected writing.
//
// Algorithm
// ─────────────────────────────────────────────────────────────────────────────
//  1. Build vertical projection P[x] = count of dark pixels in column x.
//  2. Gaussian-smooth P to bridge tiny gaps within one character.
//  3. Walk left → right: ink-run starts when P[x] > inkThreshold,
//     ends when P[x] drops back to ≤ inkThreshold.
//  4. Merge runs that are very close together (likely one character with an
//     internal gap, e.g. the dot of "i", or a stroke crossing a dash).
//  5. Trim, pad, and return each run as an HTMLCanvasElement.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  inkThreshold  : 0,     // columns with ≤ this many dark pixels → gap
                          // (0 = even a single dark pixel counts as ink)
  smoothRadius  : 2,     // gaussian blur radius on projection (columns)
  minCharWidth  : 3,     // px — ignore runs narrower than this
  padding       : 5,     // px added to each side of a character crop
  mergeGap      : 8,     // px — merge two runs whose gap is ≤ this
  darkThreshold : 128,   // luminance below this = dark (ink) pixel
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Segment a canvas into individual character sub-canvases.
 *
 * @param  {HTMLCanvasElement} sourceCanvas
 * @param  {object}            [opts]        – override DEFAULTS
 * @returns {Array<{ canvas:HTMLCanvasElement, cx:number, x1:number, x2:number }>}
 *          sorted left → right by x-centre
 */
export function segmentCharacters(sourceCanvas, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  const ctx  = sourceCanvas.getContext('2d');
  const W    = sourceCanvas.width;
  const H    = sourceCanvas.height;
  const data = ctx.getImageData(0, 0, W, H).data;

  // ── 1. Vertical projection ────────────────────────────────────────────────
  const proj = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let count = 0;
    for (let y = 0; y < H; y++) {
      const i   = (y * W + x) * 4;
      const lum = (data[i] + data[i+1] + data[i+2]) / 3;
      if (lum < cfg.darkThreshold) count++;
    }
    proj[x] = count;
  }

  // ── 2. Gaussian smoothing ─────────────────────────────────────────────────
  const smoothed = _gaussSmooth(proj, cfg.smoothRadius);

  // ── 3. Find ink runs ──────────────────────────────────────────────────────
  const runs = [];
  let inRun = false, runStart = 0;

  for (let x = 0; x < W; x++) {
    const hasInk = smoothed[x] > cfg.inkThreshold;
    if (!inRun && hasInk) {
      inRun    = true;
      runStart = x;
    } else if (inRun && !hasInk) {
      inRun = false;
      if (x - runStart >= cfg.minCharWidth) {
        runs.push({ x1: runStart, x2: x });
      }
    }
  }
  if (inRun && W - runStart >= cfg.minCharWidth) {
    runs.push({ x1: runStart, x2: W });
  }

  // ── 4. Merge nearby runs ──────────────────────────────────────────────────
  const merged = _mergeRuns(runs, cfg.mergeGap);

  // ── 5. Extract character canvases ─────────────────────────────────────────
  return merged.map(run => {
    const x1 = Math.max(0, run.x1 - cfg.padding);
    const x2 = Math.min(W,  run.x2 + cfg.padding);
    const cx  = (x1 + x2) / 2;
    const cw  = Math.max(1, x2 - x1);

    const charCanvas     = document.createElement('canvas');
    charCanvas.width     = cw;
    charCanvas.height    = H;
    charCanvas.getContext('2d').drawImage(sourceCanvas, x1, 0, cw, H, 0, 0, cw, H);

    return { canvas: charCanvas, cx, x1, x2 };
  });
}

/**
 * Build a horizontal-projection (row sums), useful for detecting where
 * symbols like ' and " sit vertically relative to digits.
 *
 * @param  {HTMLCanvasElement} canvas
 * @returns {Float32Array}  length = canvas.height
 */
export function horizontalProjection(canvas) {
  const ctx  = canvas.getContext('2d');
  const W    = canvas.width;
  const H    = canvas.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  const proj = new Float32Array(H);

  for (let y = 0; y < H; y++) {
    let count = 0;
    for (let x = 0; x < W; x++) {
      const i   = (y * W + x) * 4;
      const lum = (data[i] + data[i+1] + data[i+2]) / 3;
      if (lum < 128) count++;
    }
    proj[y] = count;
  }
  return proj;
}

/**
 * Re-render a set of strokes (from HandwritingCanvasCore) into a fresh canvas
 * for use with segmentCharacters().
 *
 * @param  {Array}  strokes   – [{points:[{x,y,pressure}], bounds}]
 * @param  {number} padding   – extra px around tight bounds
 * @param  {number} lineWidth – default ink width
 * @returns {HTMLCanvasElement}
 */
export function renderStrokesToCanvas(strokes, padding = 10, lineWidth = 4) {
  if (!strokes || strokes.length === 0) return null;

  // Tight bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const b = s.bounds;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }

  const W = Math.max(1, maxX - minX + padding * 2);
  const H = Math.max(1, maxY - minY + padding * 2);

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#000000';
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (pts.length < 2) continue;

    ctx.beginPath();
    ctx.moveTo(pts[0].x - minX + padding, pts[0].y - minY + padding);

    for (let i = 1; i < pts.length; i++) {
      const p        = pts[i];
      const pressure = Math.max(0.1, p.pressure ?? 0.5);
      ctx.lineWidth  = Math.max(2, Math.min(12, pressure * lineWidth * 2));
      ctx.lineTo(p.x - minX + padding, p.y - minY + padding);
    }
    ctx.stroke();
  }

  return canvas;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _gaussSmooth(arr, radius) {
  if (radius <= 0) return arr;
  const kernel = _gaussKernel(radius);
  const half   = Math.floor(kernel.length / 2);
  const result = new Float32Array(arr.length);

  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    for (let k = 0; k < kernel.length; k++) {
      const j = i - half + k;
      if (j >= 0 && j < arr.length) sum += arr[j] * kernel[k];
    }
    result[i] = sum;
  }
  return result;
}

function _gaussKernel(radius) {
  const sigma  = Math.max(0.5, radius / 2);
  const size   = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let   sum    = 0;
  for (let i = 0; i < size; i++) {
    const x    = i - radius;
    kernel[i]  = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum       += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;
  return kernel;
}

function _mergeRuns(runs, maxGap) {
  if (runs.length <= 1) return runs;
  const merged = [{ ...runs[0] }];

  for (let i = 1; i < runs.length; i++) {
    const prev = merged[merged.length - 1];
    const gap  = runs[i].x1 - prev.x2;
    if (gap <= maxGap) {
      prev.x2 = runs[i].x2; // extend
    } else {
      merged.push({ ...runs[i] });
    }
  }
  return merged;
}
