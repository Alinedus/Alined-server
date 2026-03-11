// src/models/Door.js
// Door element model and helper functions.
// A door is stored as a segment (start → end) that lies ON a wall.
// Its visual geometry (hinge point, swing arc, frame) is derived in
// geometryProcessor.calculateDoorGeometry — never stored in state.

// ─── Constants ───────────────────────────────────────────────────────────────

/** Orientations: 0 = swing right / up, 1 = swing left / down */
export const DOOR_ORIENTATION_DEFAULT = 0;
export const DOOR_ORIENTATION_FLIPPED = 1;

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a plain door data object suitable for the geometry store.
 * @param {string} id
 * @param {{x:number,y:number}} start   - hinge end of the door
 * @param {{x:number,y:number}} end     - free end of the door (determines width)
 * @param {object} [overrides]
 * @returns {object}
 */
export function createDoor(id, start, end, overrides = {}) {
  return {
    id,
    start:       { ...start },
    end:         { ...end },
    orientation: DOOR_ORIENTATION_DEFAULT,
    measurement:    null,
    actualLength:   null,
    originalLength: null,
    ...overrides,
  };
}

// ─── Derived geometry ─────────────────────────────────────────────────────────

/**
 * Door width in canvas pixels (distance start → end).
 * Do NOT store this — compute on demand.
 */
export function doorWidth({ start, end }) {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

/**
 * Door angle in radians (direction from hinge to free end).
 */
export function doorAngle({ start, end }) {
  return Math.atan2(end.y - start.y, end.x - start.x);
}

/**
 * Midpoint of the door segment (used for hit-testing and labels).
 */
export function doorMidpoint({ start, end }) {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

/**
 * Returns the next orientation value (cycles 0 → 1 → 0).
 */
export function toggleOrientation(current) {
  return ((current || 0) + 1) % 2;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Returns true if the door object is structurally valid.
 */
export function isValidDoor(door) {
  return (
    door &&
    typeof door.id === 'string' &&
    door.start && typeof door.start.x === 'number' && typeof door.start.y === 'number' &&
    door.end   && typeof door.end.x   === 'number' && typeof door.end.y   === 'number' &&
    doorWidth(door) > 0
  );
}
