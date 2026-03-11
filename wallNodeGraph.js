// src/utils/wallNodeGraph.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure geometry helpers for the wall node/junction graph.
//
// WALL NODE MODEL
// ───────────────
// A "node" is a shared endpoint where two or more wall segments meet.
// Rather than a separate registry, we derive connectivity at draw-time by
// comparing endpoint coordinates within NODE_SNAP_RADIUS.  This keeps the
// Zustand store schema simple while guaranteeing junction integrity.
//
// JUNCTION FLOW  (called by geometryStore.addWallWithJunctions)
// ──────────────
//  1. snapEndpointToWalls  — snap new wall's start/end to nearest node
//  2. findWallIntersections — find all walls the new segment's interior crosses
//  3. splitWallAtPoint      — split each intersected wall at the crossing point
//  4. segment new wall      — break the new wall into pieces at each crossing
//  5. commit                — push all new/replacement walls to the store
// ─────────────────────────────────────────────────────────────────────────────

// How close two endpoints must be (px) to merge into one shared node.
export const NODE_SNAP_RADIUS = 10;

// ─── Endpoint (node) snapping ─────────────────────────────────────────────────
/**
 * If `pt` is within `radius` px of any wall endpoint, return that endpoint
 * exactly.  Otherwise return `pt` unchanged.
 *
 * @param {{ x:number, y:number }}        pt      – point to snap
 * @param {Array<{start,end}>}            walls   – existing walls
 * @param {number}                        radius  – snap radius in px
 * @returns {{ x:number, y:number }}
 */
export function snapEndpointToWalls(pt, walls, radius = NODE_SNAP_RADIUS) {
  let best = null;
  let bestDist = radius;

  for (const w of walls) {
    const ds = _dist(pt, w.start);
    const de = _dist(pt, w.end);
    if (ds < bestDist) { bestDist = ds; best = w.start; }
    if (de < bestDist) { bestDist = de; best = w.end;   }
  }

  return best ? { x: best.x, y: best.y } : { x: pt.x, y: pt.y };
}

// ─── Segment–segment interior intersection ────────────────────────────────────
/**
 * Compute the strict interior intersection of segments A→B and C→D.
 * "Strict interior" means 0 < t < 1 and 0 < u < 1 (a small MARGIN avoids
 * counting endpoint touches that are already handled by node snapping).
 *
 * @returns {{ x, y, t, u }} where t = param on A→B, u = param on C→D
 *          or null if no intersection.
 */
export function segSegIntersect(A, B, C, D) {
  const dx1 = B.x - A.x, dy1 = B.y - A.y;
  const dx2 = D.x - C.x, dy2 = D.y - C.y;
  const denom = dx1 * dy2 - dy1 * dx2;

  if (Math.abs(denom) < 1e-9) return null; // parallel / collinear

  const t = ((C.x - A.x) * dy2 - (C.y - A.y) * dx2) / denom;
  const u = ((C.x - A.x) * dy1 - (C.y - A.y) * dx1) / denom;

  const MARGIN = 0.01; // exclude endpoint touches
  if (t > MARGIN && t < 1 - MARGIN && u > MARGIN && u < 1 - MARGIN) {
    return {
      x: A.x + t * dx1,
      y: A.y + t * dy1,
      t,
      u,
    };
  }
  return null;
}

/**
 * Find all existing walls that the new segment (newStart→newEnd) strictly
 * intersects.  Returns array sorted by ascending t (order of encounter along
 * the new wall).
 *
 * @param {{ x,y }} newStart
 * @param {{ x,y }} newEnd
 * @param {Array}   walls
 * @returns {Array<{ wallId:string, pt:{x,y}, t:number, u:number }>}
 */
export function findWallIntersections(newStart, newEnd, walls) {
  const hits = [];
  for (const w of walls) {
    const pt = segSegIntersect(newStart, newEnd, w.start, w.end);
    if (pt) {
      hits.push({
        wallId : w.id,
        pt     : { x: pt.x, y: pt.y },
        t      : pt.t,
        u      : pt.u,
      });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}

// ─── Wall splitting ───────────────────────────────────────────────────────────
/**
 * Split `wall` at `pt`, producing two partial segment data objects.
 * The caller is responsible for assigning new ids and copying properties
 * (thickness, type, etc.) from the original wall.
 *
 * @param {{ start, end, ...rest }} wall
 * @param {{ x, y }}               pt
 * @returns [segA, segB]  – segA ends at pt, segB starts at pt
 */
export function splitWallAtPoint(wall, pt) {
  return [
    { start: { ...wall.start }, end: { x: pt.x, y: pt.y } },
    { start: { x: pt.x, y: pt.y }, end: { ...wall.end } },
  ];
}

// ─── Private helpers ──────────────────────────────────────────────────────────
function _dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}
