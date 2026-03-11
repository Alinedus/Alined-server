// src/utils/strokeGeometryDetector.js
// ─────────────────────────────────────────────────────────────────────────────
// Fast stroke-geometry classifier for architectural measurement characters.
//
// Runs BEFORE the CNN on raw stroke data (no rendering required).
// Handles the easy structural cases in < 1 ms, so the CNN only sees ambiguous
// multi-stroke digit shapes.
//
// Input:  strokes  – array of { points:[{x,y,pressure}], bounds:{minX,minY,maxX,maxY} }
// Output: { char, confidence, method:'geometry' }  OR  null (→ defer to CNN)
// ─────────────────────────────────────────────────────────────────────────────

// ── Geometry thresholds (CSS-pixel units on a 300 px-tall canvas) ─────────────
// Calibrated so a typical digit spans 60-150 px in height, ~40-100 px wide.

const T = {
  // Apostrophe  ' ────────────────────────────────────────────────────────────
  APOS_MAX_H   : 52,    // px — must be short
  APOS_MAX_W   : 30,    // px — must be narrow
  APOS_MIN_H_W : 1.20,  // height / width ≥ this (taller than wide)
  APOS_MAX_ARC : 90,    // px — stroke must be short

  // Double-quote  " ────────────────────────────────────────────────────────
  QUOTE_MAX_X_GAP : 40, // px between the two apos centers

  // Dash  - ────────────────────────────────────────────────────────────────
  DASH_MIN_W_H : 2.2,   // width / height ≥ this
  DASH_MAX_H   : 32,    // px — must be flat
  DASH_MAX_ARC : 130,   // px — keeps it short

  // Digit 1 ─────────────────────────────────────────────────────────────────
  ONE_MAX_W_H  : 0.30,  // very narrow (width / height)
  ONE_MIN_H    : 30,    // px — must be tall enough to be a digit, not an apos

  // Digit 0 ─────────────────────────────────────────────────────────────────
  ZERO_MIN_ASPECT  : 0.50,   // width/height — not too narrow
  ZERO_MAX_ASPECT  : 1.90,   // width/height — not too square
  ZERO_CLOSE_DIST  : 16,     // px — start-to-end distance qualifies as closed loop
  ZERO_MIN_ARC_RATIO: 0.62,  // arc / perimeter — must fill the oval
  // UPPER bound is the key 0-vs-8 discriminator:
  // '0' traces ~1 oval  → arcRatio ≈ 0.70–0.92
  // '8' traces ~2 ovals → arcRatio ≈ 1.0–1.5  (hits this cap → deferred to CNN)
  ZERO_MAX_ARC_RATIO: 0.96,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to identify a CHARACTER from 1–N stylus strokes using geometry only.
 *
 * @param  {Array}  strokes  – strokes belonging to ONE candidate character
 * @returns {{ char:string, confidence:number, method:'geometry' } | null}
 */
export function detectByGeometry(strokes) {
  if (!strokes || strokes.length === 0) return null;
  const n = strokes.length;

  // ── Single-stroke symbols ────────────────────────────────────────────────
  if (n === 1) {
    const s  = strokes[0];
    const ft = _features(s);

    // Dash:  wide, flat, horizontal ─────────────────────────────────────────
    if (
      ft.w / ft.h >= T.DASH_MIN_W_H &&
      ft.h        <= T.DASH_MAX_H   &&
      ft.arc      <= T.DASH_MAX_ARC
    ) {
      return _ok('-', 0.92);
    }

    // Apostrophe:  short, narrow, tallish ────────────────────────────────────
    if (
      ft.h       <= T.APOS_MAX_H   &&
      ft.w       <= T.APOS_MAX_W   &&
      ft.h / ft.w >= T.APOS_MIN_H_W &&
      ft.arc      <= T.APOS_MAX_ARC
    ) {
      return _ok("'", 0.90);
    }

    // Digit 1:  very narrow, tall, single stroke ─────────────────────────────
    if (
      ft.w / ft.h <= T.ONE_MAX_W_H &&
      ft.h        >= T.ONE_MIN_H
    ) {
      return _ok('1', 0.76);
    }

    // Digit 0:  closed loop, roughly oval ────────────────────────────────────
    // arcRatio upper-cap rejects '8' (two loops → much higher arc length).
    if (
      ft.closeDist  <= T.ZERO_CLOSE_DIST   &&
      ft.aspect     >= T.ZERO_MIN_ASPECT   &&
      ft.aspect     <= T.ZERO_MAX_ASPECT   &&
      ft.arcRatio   >= T.ZERO_MIN_ARC_RATIO &&
      ft.arcRatio   <= T.ZERO_MAX_ARC_RATIO   // keeps '8' out → CNN decides
    ) {
      return _ok('0', 0.74);
    }
  }

  // ── Two-stroke combinations ───────────────────────────────────────────────
  if (n === 2) {
    const [a, b] = strokes;
    const fa = _features(a);
    const fb = _features(b);
    const xGap = Math.abs(_cx(b.bounds) - _cx(a.bounds));

    // Double-quote:  two close apostrophe-like strokes ────────────────────────
    const aposA = fa.h <= T.APOS_MAX_H && fa.w <= T.APOS_MAX_W &&
                  fa.h / fa.w >= T.APOS_MIN_H_W && fa.arc <= T.APOS_MAX_ARC;
    const aposB = fb.h <= T.APOS_MAX_H && fb.w <= T.APOS_MAX_W &&
                  fb.h / fb.w >= T.APOS_MIN_H_W && fb.arc <= T.APOS_MAX_ARC;

    if (aposA && aposB && xGap <= T.QUOTE_MAX_X_GAP) {
      return _ok('"', 0.90);
    }
  }

  return null; // → send to CNN
}

/**
 * Quick check: does this single stroke look like a SYMBOL rather than a digit?
 * Used by the segmenter to decide whether to group strokes or stop a digit run.
 */
export function isSymbolStroke(stroke) {
  const ft = _features(stroke);

  // Dash
  if (ft.w / ft.h >= T.DASH_MIN_W_H && ft.h <= T.DASH_MAX_H) return true;
  // Apostrophe / quote part
  if (ft.h <= T.APOS_MAX_H && ft.w <= T.APOS_MAX_W && ft.h / ft.w >= T.APOS_MIN_H_W) return true;

  return false;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _features(stroke) {
  const b   = stroke.bounds;
  const pts = stroke.points;
  const w   = Math.max(1, b.maxX - b.minX);
  const h   = Math.max(1, b.maxY - b.minY);
  const arc = _arcLen(pts);

  // Start-to-end distance  (closeness = loop detection)
  const first = pts[0];
  const last  = pts[pts.length - 1];
  const closeDist = Math.sqrt(
    (last.x - first.x) ** 2 + (last.y - first.y) ** 2
  );

  // Arc / perimeter ratio  (high = fills the bounding oval, good for '0')
  const perimeter = 2 * (w + h);
  const arcRatio  = arc / perimeter;

  // Dominant direction  (angle of the principal axis in radians)
  const angle = Math.atan2(last.y - first.y, last.x - first.x);

  // Straightness: ratio of straight-line distance to arc length
  const straight = closeDist / Math.max(1, arc);

  return { w, h, arc, closeDist, arcRatio, aspect: w / h, angle, straight };
}

function _arcLen(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i-1].x;
    const dy = points[i].y - points[i-1].y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

function _cx(bounds) {
  return (bounds.minX + bounds.maxX) / 2;
}

function _ok(char, confidence) {
  return { char, confidence, method: 'geometry' };
}
