// src/models/Wall.js
// Wall element model and helper functions.
// Walls are stored as centerline segments (start → end) with a uniform
// thickness.  All visual geometry (inner/outer edges) is derived in
// geometryProcessor.js — never stored in state.

import { WALL_THICKNESS } from '../utils/geometryProcessor';

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_THICKNESS_PX = WALL_THICKNESS; // 23 px ≈ 9 inches at 100 px/m

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a plain wall data object suitable for the geometry store.
 * @param {string} id
 * @param {{x:number,y:number}} start
 * @param {{x:number,y:number}} end
 * @param {object} [overrides]
 * @returns {object}
 */
export function createWall(id, start, end, overrides = {}) {
  return {
    id,
    start: { ...start },
    end:   { ...end },
    thickness: DEFAULT_THICKNESS_PX,
    measurement:    null,   // user-entered display string e.g. "10'-6\""
    actualLength:   null,   // interior clear length in canvas pixels
    originalLength: null,   // pixel length before the measurement was applied
    ...overrides,
  };
}

// ─── Derived geometry (pure, no state mutation) ───────────────────────────────

/**
 * Returns the pixel length of the wall centerline.
 * NOTE: do NOT store this in state — always compute on demand.
 */
export function wallLength({ start, end }) {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

/**
 * Returns the wall angle in radians (−π … +π).
 */
export function wallAngle({ start, end }) {
  return Math.atan2(end.y - start.y, end.x - start.x);
}

/**
 * Returns the midpoint of the wall centerline.
 */
export function wallMidpoint({ start, end }) {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

/**
 * Returns {outerStart, outerEnd, innerStart, innerEnd} for a wall
 * using the standard centred-thickness convention.
 * (This mirrors the logic in geometryProcessor.processWalls but can be
 *  used anywhere without importing the full processor.)
 */
export function wallEdgePoints(wall) {
  const { start, end } = wall;
  const angle      = wallAngle(wall);
  const perpAngle  = angle - Math.PI / 2;
  const half       = (wall.thickness || DEFAULT_THICKNESS_PX) / 2;
  const hx = Math.cos(perpAngle) * half;
  const hy = Math.sin(perpAngle) * half;

  return {
    outerStart: { x: start.x - hx, y: start.y - hy },
    outerEnd:   { x: end.x   - hx, y: end.y   - hy },
    innerStart: { x: start.x + hx, y: start.y + hy },
    innerEnd:   { x: end.x   + hx, y: end.y   + hy },
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Returns true if the wall object has the minimum required properties.
 */
export function isValidWall(wall) {
  return (
    wall &&
    typeof wall.id === 'string' &&
    wall.start && typeof wall.start.x === 'number' && typeof wall.start.y === 'number' &&
    wall.end   && typeof wall.end.x   === 'number' && typeof wall.end.y   === 'number' &&
    wallLength(wall) > 0
  );
}
