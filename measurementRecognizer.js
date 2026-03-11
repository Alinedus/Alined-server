// src/utils/measurementRecognizer.js
// ─────────────────────────────────────────────────────────────────────────────
// Hybrid stroke-geometry + CNN pipeline for architectural measurement input.
//
// FULL PIPELINE
// ─────────────
//  Stylus strokes
//    └─ stroke clustering        (HandwritingCanvasCore._segmentClusters)
//         └─ characterSegmentation   (this module, stroke-level)
//              ├─ strokeGeometryDetector  → instant symbol/digit detection
//              └─ MeasurementCNN         → 13-class CNN for ambiguous digits
//                   └─ assemble tokens → "10'-6\""
//                        └─ DimensionParser → { actualLength, displayText }
//
// RECOGNITION MODES (fastest-first waterfall)
// ────────────────────────────────────────────
//  Mode 1 — Symbol geometry   (< 0.1 ms):
//    Single short narrow stroke  →  '  (feet)
//    Two close short strokes      →  "  (inches)
//    Short wide horizontal stroke →  -  (separator / dash)
//
//  Mode 2 — Digit geometry    (< 0.2 ms):
//    Very narrow single stroke    →  1
//    Closed oval single stroke    →  0
//
//  Mode 3 — CNN               (3–8 ms, runs only for ambiguous digits):
//    28×28 greyscale input → 13-class softmax
//    Classes: 0 1 2 3 4 5 6 7 8 9 ' " -
//
// OFFLINE GUARANTEE
// ─────────────────
//  All three modes run fully in the browser with zero network calls.
//  The CNN weights are loaded from /public/models/measurement-recognizer/
//  which is served by Vite's static file server (no CDN).
// ─────────────────────────────────────────────────────────────────────────────

import { detectByGeometry, isSymbolStroke } from './strokeGeometryDetector.js';
import MeasurementCNN from './measurementCNN.js';

// ── Tuning knobs ──────────────────────────────────────────────────────────────
// DIGIT_GROUP_MAX_GAP – how far apart (px) two strokes can be and still
//   belong to the same digit (e.g. the two strokes of "i" or a split "1").
//   Tighter (45 px) prevents adjacent digits being glued into one character.
const DIGIT_GROUP_MAX_GAP = 45;

// CNN_MIN_CONFIDENCE – minimum softmax probability to accept a CNN prediction.
//   0.40 eliminates most noise hits while keeping confident results.
//   (Was 0.28 — too permissive, admitted wrong characters for ambiguous strokes.)
const CNN_MIN_CONFIDENCE  = 0.40;

// GEO_MIN_CONFIDENCE – geometry shortcut is used only when confidence is at
//   least this high.  Below this threshold the CNN gets a chance to decide.
//   (Was 0.74 — raised to 0.80 for fewer geometry-path false positives.)
const GEO_MIN_CONFIDENCE  = 0.80;

// ── Singleton CNN (shared across all recognizer instances) ───────────────────
const _cnn = new MeasurementCNN();

export default class MeasurementRecognizer {
  constructor() {
    this._initPromise = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Pre-load the CNN.  Called once at app start.
   * Safe to call multiple times — returns the same promise.
   */
  async init() {
    if (!this._initPromise) {
      this._initPromise = _cnn.load().catch(e => {
        console.warn('[MeasRec] CNN load failed:', e.message);
      });
    }
    return this._initPromise;
  }

  // ── HandwritingCanvasCore interface ───────────────────────────────────────

  /**
   * Recognise a full measurement string from ONE cluster of strokes.
   *
   * Called by HandwritingCanvasCore._runRecognition() via the duck-typed
   * `recognizeCluster` check — no subclassing needed.
   *
   * @param  {object}   cluster   { strokes:[{points,bounds}], bounds }
   * @param  {Function} renderFn  renderFn(strokes) → HTMLCanvasElement
   * @returns {Promise<string|null>}   e.g. "10'-6\"" | "3000" | null
   */
  async recognizeCluster(cluster, renderFn) {
    if (!cluster.strokes.length) return null;

    // Sort all strokes in this cluster left → right
    const sorted = [...cluster.strokes].sort(
      (a, b) => _cx(a.bounds) - _cx(b.bounds)
    );

    const tokens = await this._processStrokes(sorted, renderFn);
    if (!tokens.length) return null;

    // Final left-to-right sort (geometry passes may create out-of-order tokens)
    tokens.sort((a, b) => a.cx - b.cx);
    const result = tokens.map(t => t.char).join('');
    console.log(`[MeasRec] ✅ "${result}"  (${tokens.length} tokens)`);
    return result;
  }

  // ── Core sequencing ───────────────────────────────────────────────────────

  async _processStrokes(sorted, renderFn) {
    const tokens = [];
    let   i      = 0;

    while (i < sorted.length) {
      // ── Try to match a SYMBOL at position i ─────────────────────────────
      const sym = this._matchSymbol(sorted, i);
      if (sym) {
        tokens.push(sym.token);
        i += sym.consumed;
        continue;
      }

      // ── Accumulate a DIGIT sub-cluster ───────────────────────────────────
      // Greedily grab consecutive non-symbol strokes that are x-close
      const digitStrokes = [sorted[i]];
      let   prevCx       = _cx(sorted[i].bounds);
      i++;

      while (i < sorted.length) {
        const s      = sorted[i];
        const curCx  = _cx(s.bounds);
        const gap    = curCx - prevCx;

        // Stop if this stroke is a symbol
        if (isSymbolStroke(s)) break;
        // Stop if the gap is large (different characters)
        if (gap > DIGIT_GROUP_MAX_GAP) break;

        digitStrokes.push(s);
        prevCx = curCx;
        i++;
      }

      // ── Mode 2: geometry shortcut for 0 and 1 ──────────────────────────
      const geo = detectByGeometry(digitStrokes);
      if (geo && geo.confidence >= GEO_MIN_CONFIDENCE) {
        const groupCx = _groupCx(digitStrokes);
        tokens.push({ cx: groupCx, char: geo.char, source: 'geometry' });
        continue;
      }

      // ── Mode 3: CNN ──────────────────────────────────────────────────────
      const canvas = renderFn(digitStrokes);
      if (!canvas) continue;

      const pred = await _cnn.predict(canvas);
      if (pred.confidence >= CNN_MIN_CONFIDENCE) {
        const groupCx = _groupCx(digitStrokes);
        tokens.push({ cx: groupCx, char: pred.char, source: 'cnn',
                      confidence: pred.confidence });
        console.log(`[MeasRec] CNN: "${pred.char}" (${(pred.confidence*100).toFixed(0)}%)`);
      } else {
        console.warn(`[MeasRec] CNN low confidence ${(pred.confidence*100).toFixed(0)}% — skipped`);
      }
    }

    return tokens;
  }

  // ── Symbol matching ───────────────────────────────────────────────────────

  /**
   * Try to match a symbol token at position `i` in the sorted stroke array.
   * Returns { token:{cx,char,source}, consumed:number } or null.
   */
  _matchSymbol(sorted, i) {
    const cur = sorted[i];

    // ── Two-stroke double-quote check FIRST ────────────────────────────────
    // CRITICAL ORDER: must precede the single-apostrophe check.
    // If the user writes " as two short strokes and we check ' first,
    // the first stroke is greedily consumed as ' and the second is
    // consumed as ' on the next iteration → output is '' instead of ".
    if (i + 1 < sorted.length) {
      const next = sorted[i + 1];
      const pair = detectByGeometry([cur, next]);
      if (pair && pair.char === '"') {
        const cx = (_cx(cur.bounds) + _cx(next.bounds)) / 2;
        return {
          token    : { cx, char: '"', source: 'geometry' },
          consumed : 2,
        };
      }
    }

    // ── Single-stroke symbol  (' or -) ─────────────────────────────────────
    const single = detectByGeometry([cur]);
    if (single && (single.char === "'" || single.char === '-')) {
      return {
        token    : { cx: _cx(cur.bounds), char: single.char, source: 'geometry' },
        consumed : 1,
      };
    }

    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _cx(bounds) {
  return (bounds.minX + bounds.maxX) / 2;
}

function _groupCx(strokes) {
  let sum = 0;
  for (const s of strokes) sum += _cx(s.bounds);
  return sum / strokes.length;
}
