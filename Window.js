// src/models/Window.js
// Window element model and helper functions.
// A window is stored as a segment (start → end) that lies ON a wall.
// Its visual geometry (frame, panes, glass line) is derived in
// geometryProcessor.calculateWindowFrame — never stored in state.
//
// ⚠️  Architectural constraint:
//   A window must be placed entirely within a single wall segment and must
//   not start at T=0 or end at T=1 of the host wall (the MIN_WINDOW_CORNER_GAP
//   rule in geometryProcessor.js ensures solid wall material at corners).

import { MIN_WINDOW_CORNER_GAP } from '../utils/geometryProcessor';

// ─── Constants ───────────────────────────────────────────────────────────────

export { MIN_WINDOW_CORNER_GAP };

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a plain window data object suitable for the geometry store.
 * @param {string} id
 * @param {{x:number,y:number}} start
 * @param {{x:number,y:number}} end
 * @param {object} [overrides]
 * @returns {object}
 */
export function createWindow(id, start, end, overrides = {}) {
  return {
    id,
    start:       { ...start },
    end:         { ...end },
    orientation: 0,
    measurement:    null,
    actualLength:   null,
    originalLength: null,
    ...overrides,
  };
}

// ─── Derived geometry ─────────────────────────────────────────────────────────

/**
 * Window width in canvas pixels.  Do NOT store — compute on demand.
 */
export function windowWidth({ start, end }) {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

/**
 * Window angle in radians.
 */
export function windowAngle({ start, end }) {
  return Math.atan2(end.y - start.y, end.x - start.x);
}

/**
 * Midpoint of the window segment.
 */
export function windowMidpoint({ start, end }) {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Returns true if the window object has valid geometry.
 */
export function isValidWindow(win) {
  return (
    win &&
    typeof win.id === 'string' &&
    win.start && typeof win.start.x === 'number' && typeof win.start.y === 'number' &&
    win.end   && typeof win.end.x   === 'number' && typeof win.end.y   === 'number' &&
    windowWidth(win) > 0
  );
}

/**
 * Returns true if the window is correctly inset from both wall corners.
 * @param {number} startT  - T-fraction of window start on host wall
 * @param {number} endT    - T-fraction of window end on host wall
 */
export function isWindowInsideCornerGap(startT, endT) {
  return startT >= MIN_WINDOW_CORNER_GAP && endT <= 1 - MIN_WINDOW_CORNER_GAP;
}
