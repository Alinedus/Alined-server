// src/utils/geometry.js

/**
 * Ramer-Douglas-Peucker algorithm for path simplification.
 */
export function simplifyPath(points, epsilon) {
  if (points.length <= 2) return points;

  let dmax  = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const d = distanceToSegment(points[i], points[0], points[end]);
    if (d > dmax) { index = i; dmax = d; }
  }

  if (dmax > epsilon) {
    const r1 = simplifyPath(points.slice(0, index + 1), epsilon);
    const r2 = simplifyPath(points.slice(index), epsilon);
    return [...r1.slice(0, -1), ...r2];
  }
  return [points[0], points[end]];
}

function distanceToSegment(p, p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) return Math.sqrt((p.x - p1.x) ** 2 + (p.y - p1.y) ** 2);

  let t = ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const projX = p1.x + t * dx;
  const projY = p1.y + t * dy;
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}

/**
 * Straightens segments by snapping to horizontal/vertical when close.
 * Also ensures adjacent segments stay connected after snapping.
 *
 * angleToleranceDeg = 7° — only snap when the drawn line is within 7° of a
 * cardinal axis.  Lines clearly drawn at an angle are preserved as-is.
 * This matches the architectural spec: "If the angle is within ±7 degrees of
 * horizontal or vertical, snap the wall to exactly 0° 90° 180° 270°."
 */
export function straightenSegments(points, angleToleranceDeg = 7) {
  if (points.length < 2) return [];

  const threshold = (angleToleranceDeg * Math.PI) / 180;
  const segments  = [];

  for (let i = 0; i < points.length - 1; i++) {
    let start = { ...points[i] };
    let end   = { ...points[i + 1] };

    const dx    = end.x - start.x;
    const dy    = end.y - start.y;
    const angle = Math.atan2(dy, dx);

    // Nearest 90° multiple
    const snapped = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    const diff    = Math.abs(angle - snapped);

    // Snap if within tolerance (also handle ±2π wrap)
    if (diff < threshold || Math.abs(diff - 2 * Math.PI) < threshold) {
      if (snapped === 0 || Math.abs(snapped) === Math.PI) {
        end.y = start.y; // force horizontal
      } else {
        end.x = start.x; // force vertical
      }
    }

    segments.push({ start, end });
  }

  // Re-chain: each segment's start = the (possibly snapped) end of the
  // previous segment so corners stay joined after axis snapping.
  for (let i = 0; i < segments.length - 1; i++) {
    segments[i + 1].start = { ...segments[i].end };
  }

  return segments;
}

/**
 * Combined function: take raw points and return clean, straightened segments.
 *
 * epsilon         – RDP simplification tolerance (px)
 * angleToleranceDeg – ortho-snap tolerance passed to straightenSegments
 */
export function processRawPoints(points, epsilon = 15, angleToleranceDeg = 7) {
  if (points.length < 5) return [];

  // 1. Simplify
  const simplified = simplifyPath(points, epsilon);

  // 2. Straighten (snap to H/V within tolerance)
  const straightened = straightenSegments(simplified, angleToleranceDeg);

  // 3. Close-loop snap (generous 50 px threshold for freehand rooms)
  if (straightened.length >= 3) {
    const first = straightened[0].start;
    const last  = straightened[straightened.length - 1].end;
    const dist  = Math.sqrt((first.x - last.x) ** 2 + (first.y - last.y) ** 2);
    if (dist < 50) {
      straightened[straightened.length - 1].end = { ...first };
    }
  }

  // 4. Filter out very short segments (< 10 px)
  return straightened.filter(seg => {
    const dx = seg.end.x - seg.start.x;
    const dy = seg.end.y - seg.start.y;
    return Math.sqrt(dx * dx + dy * dy) > 10;
  });
}
