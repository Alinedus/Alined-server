// src/stores/geometryStore.js
import { create } from 'zustand';
import {
  snapEndpointToWalls,
  findWallIntersections,
  splitWallAtPoint,
} from '../utils/wallNodeGraph.js';
import { pubElementCreated } from '../utils/behaviourBus.js';

let nextId = 1;
const DEFAULT_WALL_THICKNESS_PX = 23; // 9 inches
const MAX_HISTORY = 50;

const useGeometryStore = create((set, get) => ({
  walls: [],
  doors: [],
  windows: [],
  generics: [],
  mode: 'wall', // 'wall' | 'door' | 'window' | 'generic' | 'freehand' | 'erase' | 'select'
  viewMode: 'ALINE',
  preferredUnit: 'feet',
  lastDrawnId: null,
  lastDrawnType: null,
  newlyDrawnIds: [],
  viewport: { x: 0, y: 0, k: 1 },
  gridEnabled: false,

  // History Stacks
  past: [],
  future: [],

  setMode: (mode) => set({ mode }),
  setViewMode: (viewMode) => set({ viewMode, lastDrawnId: null, lastDrawnType: null }),
  setPreferredUnit: (unit) => set({ preferredUnit: unit }),
  setViewport: (viewport) => set((state) => ({
    viewport: typeof viewport === 'function' ? viewport(state.viewport) : viewport
  })),
  toggleGrid: () => set((state) => ({ gridEnabled: !state.gridEnabled })),

  clearLastDrawn: () => set({ lastDrawnId: null, lastDrawnType: null }),

  // --- History Actions ---
  saveHistory: () => {
    set((state) => {
      const snapshot = {
        walls: state.walls,
        doors: state.doors,
        windows: state.windows,
        generics: state.generics
      };
      const newPast = [...state.past, snapshot].slice(-MAX_HISTORY);
      return {
        past: newPast,
        future: []
      };
    });
  },

  undo: () => set((state) => {
    if (state.past.length === 0) return {};
    const previous = state.past[state.past.length - 1];
    const newPast = state.past.slice(0, -1);

    const currentSnapshot = {
      walls: state.walls,
      doors: state.doors,
      windows: state.windows,
      generics: state.generics
    };

    return {
      walls: previous.walls,
      doors: previous.doors,
      windows: previous.windows,
      generics: previous.generics,
      past: newPast,
      future: [currentSnapshot, ...state.future],
      lastDrawnId: null,
      lastDrawnType: null
    };
  }),

  redo: () => set((state) => {
    if (state.future.length === 0) return {};
    const next = state.future[0];
    const newFuture = state.future.slice(1);

    const currentSnapshot = {
      walls: state.walls,
      doors: state.doors,
      windows: state.windows,
      generics: state.generics
    };

    return {
      walls: next.walls,
      doors: next.doors,
      windows: next.windows,
      generics: next.generics,
      past: [...state.past, currentSnapshot],
      future: newFuture,
      lastDrawnId: null,
      lastDrawnType: null
    };
  }),

  // --- Mutating Actions (Wrapped to save history) ---

  addWall: (wallData) => {
    get().saveHistory();
    set((state) => {
      const newWallId = `wall_${nextId++}`;
      const newWall = {
        id: newWallId,
        ...wallData,
        thickness: DEFAULT_WALL_THICKNESS_PX,
        measurement: null,
        actualLength: null
      };

      return {
        walls: [...state.walls, newWall],
        lastDrawnId: newWallId,
        lastDrawnType: 'wall',
        newlyDrawnIds: [newWallId]
      };
    });
  },

  addWalls: (wallsArray) => {
    console.log('[ADDWALLS] Received', wallsArray.length, 'segments to create as walls');
    get().saveHistory();
    set((state) => {
      const newIds = [];
      const newWalls = wallsArray.map(data => {
        const id = `wall_${nextId++}`;
        newIds.push(id);
        return {
          id,
          ...data,
          thickness: DEFAULT_WALL_THICKNESS_PX,
          measurement: null,
          actualLength: null
        };
      }).filter(wall => {
        const dx = wall.end.x - wall.start.x;
        const dy = wall.end.y - wall.start.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        return length > 5;
      });

      return {
        walls: [...state.walls, ...newWalls],
        lastDrawnId: newIds[newIds.length - 1],
        lastDrawnType: 'wall',
        newlyDrawnIds: newIds
      };
    });
  },

  // ── Junction-aware wall addition ─────────────────────────────────────────
  // Replaces addWall for all wall-mode drawing. The pipeline:
  //   1. Snap both endpoints to the nearest existing wall endpoint (≤ 10 px).
  //   2. Detect every wall the new segment's interior crosses (T / X junctions).
  //   3. Split each crossed wall at the crossing point → two smaller walls.
  //   4. Split the new wall at each crossing point → chain of wall pieces.
  //   5. Commit all new/replacement walls in a single store update.
  addWallWithJunctions: (wallData) => {
    get().saveHistory();
    let committedWalls = [];
    set((state) => {
      const { walls: updatedWalls, newIds } = _applyWallWithJunctions(
        wallData, state.walls
      );
      if (newIds.length === 0) return {};
      committedWalls = updatedWalls.filter(w => newIds.includes(w.id));
      return {
        walls        : updatedWalls,
        lastDrawnId  : newIds[newIds.length - 1],
        lastDrawnType: 'wall',
        newlyDrawnIds: newIds,
      };
    });
    // Behaviour capture: fire after store update (snapCount carried via closure)
    for (const w of committedWalls) {
      const cx = (w.start.x + w.end.x) / 2;
      const cy = (w.start.y + w.end.y) / 2;
      pubElementCreated('wall', cx, cy, wallData._snapCount ?? 0);
    }
  },

  // Junction-aware polyline: each segment runs through the same pipeline,
  // and the running wall list is updated after each segment so subsequent
  // segments can split walls created by earlier ones.
  addWallsWithJunctions: (wallsArray) => {
    console.log('[ADDWALLS-J] Received', wallsArray.length, 'segments');
    get().saveHistory();
    let committedBySegment = []; // [{ walls, snapCount }]
    set((state) => {
      let currentWalls = [...state.walls];
      const allNewIds  = [];
      committedBySegment = [];

      for (const wallData of wallsArray) {
        const { walls: updated, newIds } = _applyWallWithJunctions(
          wallData, currentWalls
        );
        committedBySegment.push({
          walls: updated.filter(w => newIds.includes(w.id)),
          snapCount: wallData._snapCount ?? 0,
        });
        currentWalls = updated;
        allNewIds.push(...newIds);
      }

      if (allNewIds.length === 0) return {};
      return {
        walls        : currentWalls,
        lastDrawnId  : allNewIds[allNewIds.length - 1],
        lastDrawnType: 'wall',
        newlyDrawnIds: allNewIds,
      };
    });
    // Behaviour capture: fire after store update
    for (const { walls, snapCount } of committedBySegment) {
      for (const w of walls) {
        const cx = (w.start.x + w.end.x) / 2;
        const cy = (w.start.y + w.end.y) / 2;
        pubElementCreated('wall', cx, cy, snapCount);
      }
    }
  },

  addDoor: (doorData) => {
    get().saveHistory();
    set((state) => {
      const id = `door_${nextId++}`;
      return {
        doors: [...state.doors, {
          id,
          ...doorData,
          measurement: null,
          actualLength: null,
          orientation: 0
        }],
        lastDrawnId: id,
        lastDrawnType: 'door',
        newlyDrawnIds: [id]
      };
    });
  },

  addDoors: (doorsArray) => {
    get().saveHistory();
    set((state) => {
      const newIds = [];
      const newDoors = doorsArray.map(data => {
        const id = `door_${nextId++}`;
        newIds.push(id);
        return {
          id,
          ...data,
          measurement: null,
          actualLength: null,
          orientation: 0
        };
      }).filter(door => {
        const dx = door.end.x - door.start.x;
        const dy = door.end.y - door.start.y;
        return Math.sqrt(dx * dx + dy * dy) > 5;
      });

      return {
        doors: [...state.doors, ...newDoors],
        lastDrawnId: newIds[newIds.length - 1],
        lastDrawnType: 'door',
        newlyDrawnIds: newIds
      };
    });
  },

  addWindow: (windowData) => {
    get().saveHistory();
    set((state) => {
      const id = `window_${nextId++}`;
      return {
        windows: [...state.windows, {
          id,
          ...windowData,
          measurement: null,
          actualLength: null,
          orientation: 0
        }],
        lastDrawnId: id,
        lastDrawnType: 'window',
        newlyDrawnIds: [id]
      };
    });
  },

  addWindows: (windowsArray) => {
    get().saveHistory();
    set((state) => {
      const newIds = [];
      const newWindows = windowsArray.map(data => {
        const id = `window_${nextId++}`;
        newIds.push(id);
        return {
          id,
          ...data,
          measurement: null,
          actualLength: null,
          orientation: 0
        };
      }).filter(w => {
        const dx = w.end.x - w.start.x;
        const dy = w.end.y - w.start.y;
        return Math.sqrt(dx * dx + dy * dy) > 5;
      });

      return {
        windows: [...state.windows, ...newWindows],
        lastDrawnId: newIds[newIds.length - 1],
        lastDrawnType: 'window',
        newlyDrawnIds: newIds
      };
    });
  },

  rotateWindowOrientation: (windowId) => {
    get().saveHistory();
    set((state) => ({
      windows: state.windows.map(w => {
        if (w.id !== windowId) return w;
        const { start, end } = w;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const currentAngle = Math.atan2(dy, dx);
        const newAngle = currentAngle + Math.PI / 2;
        return {
          ...w,
          end: {
            x: start.x + Math.cos(newAngle) * length,
            y: start.y + Math.sin(newAngle) * length
          },
          orientation: ((w.orientation || 0) + 1) % 4
        };
      })
    }));
  },

  addGeneric: (genericData) => {
    get().saveHistory();
    set((state) => {
      const id = `generic_${nextId++}`;
      return {
        generics: [...state.generics, {
          id,
          ...genericData,
          measurement: null,
          actualLength: null
        }],
        lastDrawnId: id,
        lastDrawnType: 'generic',
        newlyDrawnIds: [id]
      };
    });
  },

  addGenerics: (genericsArray) => {
    get().saveHistory();
    set((state) => {
      const newIds = [];
      const newGenerics = genericsArray.map(data => {
        const id = `generic_${nextId++}`;
        newIds.push(id);
        return {
          id,
          ...data,
          measurement: null,
          actualLength: null
        };
      }).filter(g => {
        const dx = g.end.x - g.start.x;
        const dy = g.end.y - g.start.y;
        return Math.sqrt(dx * dx + dy * dy) > 5;
      });

      return {
        generics: [...state.generics, ...newGenerics],
        lastDrawnId: newIds[newIds.length - 1],
        lastDrawnType: 'generic',
        newlyDrawnIds: newIds
      };
    });
  },

  deleteElement: (id) => {
    get().saveHistory();
    set((state) => ({
      walls: state.walls.filter(w => w.id !== id),
      doors: state.doors.filter(d => d.id !== id),
      windows: state.windows.filter(w => w.id !== id),
      generics: state.generics.filter(g => g.id !== id)
    }));
  },

  updateDoorOrientation: (doorId, orientation) => {
    get().saveHistory();
    set((state) => ({
      doors: state.doors.map(door => {
        if (door.id !== doorId) return door;
        return { ...door, orientation: orientation % 2 };
      })
    }));
  },

  // ─── Unified measurement update ───────────────────────────────────────────
  // Used by HandwritingCanvas and any component that has a (type, id, measurement)
  // triple without knowing the full store action name.
  updateElementMeasurement: (elementType, elementId, measurementData) => {
    const { displayText, actualLength } = measurementData;
    const store = get();

    switch (elementType) {
      case 'wall':
        store.updateWallWithAutoConnect(elementId, displayText, actualLength);
        break;
      case 'door':
        store.addMeasurementToDoor(elementId, displayText, actualLength);
        break;
      case 'window':
        store.addMeasurementToWindow(elementId, displayText, actualLength);
        break;
      case 'generic':
        store.addMeasurementToGeneric(elementId, displayText, actualLength);
        break;
      default:
        console.warn('[updateElementMeasurement] Unknown type:', elementType);
    }
  },

  // addMeasurementToWall removed — it used processNewLength (no ortho snap)
  // and skipped orthoConstraintSolver, so walls could go diagonal.
  // All callers now route through updateWallWithAutoConnect which is correct.

  addMeasurementToDoor: (doorId, measurement, actualLength) => {
    get().saveHistory();
    set((state) => ({
      doors: state.doors.map(door => {
        if (door.id !== doorId) return door;
        const result = processNewLength(door.start, door.end, actualLength);
        return { ...door, end: result.end, measurement, actualLength, originalLength: result.originalLength };
      }),
      lastDrawnId: null,
      lastDrawnType: null
    }));
  },

  addMeasurementToWindow: (windowId, measurement, actualLength) => {
    get().saveHistory();
    set((state) => ({
      windows: state.windows.map(w => {
        if (w.id !== windowId) return w;
        const result = processNewLength(w.start, w.end, actualLength);
        return { ...w, end: result.end, measurement, actualLength, originalLength: result.originalLength };
      }),
      lastDrawnId: null,
      lastDrawnType: null
    }));
  },

  addMeasurementToGeneric: (genericId, measurement, actualLength) => {
    get().saveHistory();
    set((state) => ({
      generics: state.generics.map(g => {
        if (g.id !== genericId) return g;
        const result = processNewLength(g.start, g.end, actualLength);
        return { ...g, end: result.end, measurement, actualLength, originalLength: result.originalLength };
      }),
      lastDrawnId: null,
      lastDrawnType: null
    }));
  },

  rotateElement: (id, type, angleDegrees) => {
    get().saveHistory();
    set((state) => {
      const updateList = (list) => list.map(item => {
        if (item.id !== id) return item;
        const { start, end } = item;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const normalizedDegrees = ((angleDegrees % 360) + 360) % 360;
        const newAngleRad = (-normalizedDegrees * Math.PI) / 180;
        return {
          ...item,
          end: {
            x: start.x + Math.cos(newAngleRad) * length,
            y: start.y + Math.sin(newAngleRad) * length
          }
        };
      });

      if (type === 'wall')    return { walls:    updateList(state.walls) };
      if (type === 'door')    return { doors:    updateList(state.doors) };
      if (type === 'window')  return { windows:  updateList(state.windows) };
      if (type === 'generic') return { generics: updateList(state.generics) };
      return {};
    });
  },

  updateWallWithAutoConnect: (wallId, measurement, actualLength) => {
    console.log('[ALINE-UPDATE] Wall update triggered:', { wallId, measurement, actualLength });
    get().saveHistory();
    set((state) => {
      const wall = state.walls.find(w => w.id === wallId);
      if (!wall) {
        console.log('[ALINE-UPDATE] ✗ Wall not found:', wallId);
        return {};
      }

      const centerlineLength = actualLength + DEFAULT_WALL_THICKNESS_PX;
      // processNewLengthOrtho snaps to nearest H/V axis so the endpoint is
      // always exactly horizontal or vertical — no angle drift.
      const result = processNewLengthOrtho(wall.start, wall.end, centerlineLength);
      const updatedWall = {
        ...wall,
        end: result.end,
        measurement,
        actualLength,
        originalLength: result.originalLength,
        thickness: DEFAULT_WALL_THICKNESS_PX
      };

      // Replace the edited wall and run full polyline-aware update
      let updatedWalls = state.walls.map(w => w.id === wallId ? updatedWall : w);
      updatedWalls = orthoConstraintSolver(wallId, wall, updatedWall, updatedWalls);

      // Propagate the new endpoint to doors/windows/generics as well
      const oldEnd = wall.end;
      const newEnd = updatedWall.end;
      const updatedDoors    = propagateNodeMove(oldEnd, newEnd, '', state.doors);
      const updatedWindows  = propagateNodeMove(oldEnd, newEnd, '', state.windows);
      const updatedGenerics = propagateNodeMove(oldEnd, newEnd, '', state.generics);

      return {
        walls:    updatedWalls,
        doors:    updatedDoors,
        windows:  updatedWindows,
        generics: updatedGenerics,
        lastDrawnId:   null,
        lastDrawnType: null
      };
    });
  },

  clearAll: () => {
    get().saveHistory();
    set({
      walls: [],
      doors: [],
      windows: [],
      generics: [],
      lastDrawnId: null,
      lastDrawnType: null
    });
  }
}));

// ─── Pure helpers (no store access) ──────────────────────────────────────────

function processNewLength(start, end, newLength) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const originalLength = Math.sqrt(dx * dx + dy * dy);
  if (originalLength === 0) return { end, originalLength: 0 };
  const angle = Math.atan2(dy, dx);
  const newEnd = {
    x: start.x + Math.cos(angle) * newLength,
    y: start.y + Math.sin(angle) * newLength
  };
  return { end: newEnd, originalLength };
}

// Like processNewLength but snaps the direction to the nearest H/V axis first.
// Prevents floating-point angle drift from accumulating across measurement edits —
// the endpoint is always EXACTLY horizontal or vertical from the start point.
function processNewLengthOrtho(start, end, newLength) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const originalLength = Math.sqrt(dx * dx + dy * dy);
  if (originalLength === 0) return { end, originalLength: 0 };
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal wall — keep Y identical to start
    const sign = dx >= 0 ? 1 : -1;
    return { end: { x: snapCoord(start.x + sign * newLength), y: start.y }, originalLength };
  } else {
    // Vertical wall — keep X identical to start
    const sign = dy >= 0 ? 1 : -1;
    return { end: { x: start.x, y: snapCoord(start.y + sign * newLength) }, originalLength };
  }
}

function calcDist(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// areParallel kept for potential external use
function areParallel(wall1, wall2) {
  const ANGLE_TOLERANCE = 0.15;
  const dx1 = wall1.end.x - wall1.start.x, dy1 = wall1.end.y - wall1.start.y;
  const dx2 = wall2.end.x - wall2.start.x, dy2 = wall2.end.y - wall2.start.y;
  const a1 = Math.atan2(dy1, dx1), a2 = Math.atan2(dy2, dx2);
  const diff = Math.abs(a1 - a2);
  return Math.min(diff, Math.PI - diff, Math.abs(diff - Math.PI)) < ANGLE_TOLERANCE;
}

// Returns true when a wall is axis-aligned (horizontal or vertical within 5°).
// Used to skip the expensive parallel-wall search for non-ORTHO elements.
function isOrthoWall(wall) {
  const dx = Math.abs(wall.end.x - wall.start.x);
  const dy = Math.abs(wall.end.y - wall.start.y);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return false;
  const ORTHO_TOLERANCE = Math.sin(5 * Math.PI / 180); // sin(5°) ≈ 0.087
  return (dy / len) < ORTHO_TOLERANCE || (dx / len) < ORTHO_TOLERANCE;
}

// ─── Polyline chain detection ─────────────────────────────────────────────────
// Finds a closed chain of walls that form a connected polygon starting from
// the given wallId. Returns an array of { id, start, end } in traversal order,
// or null if no closed loop is found.
// Threshold is generous enough to absorb sub-pixel floating-point drift while
// remaining tight enough to avoid connecting genuinely separate walls.
const CHAIN_CONNECT_DIST = 50;

function findPolylineChain(wallId, walls) {
  const startWall = walls.find(w => w.id === wallId);
  if (!startWall) return null;

  // Orient startWall canonically
  const chain = [{ id: startWall.id, start: { ...startWall.start }, end: { ...startWall.end } }];
  const visited = new Set([wallId]);
  let currentEnd = startWall.end;

  for (let attempt = 0; attempt < walls.length; attempt++) {
    // Find the wall whose start or end is closest to currentEnd (excluding visited)
    let bestWall = null;
    let bestDist = CHAIN_CONNECT_DIST;
    let bestFlipped = false;

    for (const w of walls) {
      if (visited.has(w.id)) continue;
      const ds = calcDist(currentEnd, w.start);
      const de = calcDist(currentEnd, w.end);
      if (ds < bestDist) { bestDist = ds; bestWall = w; bestFlipped = false; }
      if (de < bestDist) { bestDist = de; bestWall = w; bestFlipped = true; }
    }

    if (!bestWall) break;

    const oriented = bestFlipped
      ? { id: bestWall.id, start: { ...bestWall.end }, end: { ...bestWall.start } }
      : { id: bestWall.id, start: { ...bestWall.start }, end: { ...bestWall.end } };

    chain.push(oriented);
    visited.add(bestWall.id);
    currentEnd = oriented.end;

    // Check if the chain closed back to startWall.start
    if (calcDist(currentEnd, startWall.start) < CHAIN_CONNECT_DIST) {
      if (chain.length >= 3) return chain;
      break;
    }
  }

  return null;
}

// ─── Propagate a node move through all walls that share that node ─────────────
// When nodeB of a wall moves, every other wall that was sharing the same
// coordinate must have its endpoint updated to the new position.
function propagateNodeMove(oldNode, newNode, wallId, walls, threshold = CHAIN_CONNECT_DIST) {
  return walls.map(w => {
    if (w.id === wallId) return w; // already updated by caller
    let updated = { ...w };
    if (calcDist(w.start, oldNode) < threshold) updated = { ...updated, start: { ...newNode } };
    if (calcDist(w.end,   oldNode) < threshold) updated = { ...updated, end:   { ...newNode } };
    return updated;
  });
}

// ─── Snap a coordinate to the nearest integer to prevent floating-point drift ─
function snapCoord(v) { return Math.round(v * 100) / 100; }
function snapPt(p)    { return { x: snapCoord(p.x), y: snapCoord(p.y) }; }

// ─── ORTHO Constraint Solver ──────────────────────────────────────────────────
// CAD-style cascading delta propagation that keeps all axis-aligned walls
// horizontal or vertical when a measurement changes one wall's length.
//
// Constraint priority (highest → lowest):
//   1. ORTHO        – H/V walls stay H/V; direction never drifts to an angle
//   2. Node integrity – connected walls always share a node position
//   3. Locked dims  – walls with a user measurement keep their current length
//   4. Stretch free – unmeasured walls absorb size changes by stretching
//   5. Diagonal     – last resort when the anchor blocks an ORTHO solution
//
// How the cascade works
// ─────────────────────
// The edited wall's endpoint moved from `originalWall.end` to `updatedWall.end`
// producing an initial delta (dx₀, dy₀).  We visit every wall that shares that
// endpoint and propagate deltas according to orientation:
//
//   HORIZONTAL wall receives (dx, dy):
//     • dy (⊥ to axis) → translates entire wall; fixed end also shifts in Y
//     • dx (∥ to axis) → FREE wall stretches (fixed end stays); LOCKED wall
//                         passes dx through so fixed end also moves in X
//
//   VERTICAL wall receives (dx, dy):
//     • dx (⊥ to axis) → translates entire wall; fixed end also shifts in X
//     • dy (∥ to axis) → FREE wall stretches; LOCKED wall passes dy through
//
//   DIAGONAL wall: moved end follows delta, fixed end stays, no cascade
//
// Cascade terminates when it reaches the ANCHOR (`updatedWall.start`, the
// pivot of the edited wall).  A wall whose fixed end IS the anchor goes
// diagonal (last resort) and the cascade stops there.
// ─────────────────────────────────────────────────────────────────────────────
function orthoConstraintSolver(editedWallId, originalWall, updatedWall, allWalls) {
  const dx0 = updatedWall.end.x - originalWall.end.x;
  const dy0 = updatedWall.end.y - originalWall.end.y;
  if (Math.abs(dx0) < 0.5 && Math.abs(dy0) < 0.5) return allWalls; // nothing moved

  let walls = allWalls.map(w => ({ ...w }));        // mutable working copy

  const movedFrom      = originalWall.end;           // old position of edited end
  const anchorPt       = updatedWall.start;          // pivot – must never move
  const ANCHOR_THRESH  = 5;                          // px – tighter than CHAIN_CONNECT_DIST

  // ── Orientation classifiers (5° tolerance) ──────────────────────────────
  const SIN5 = Math.sin(5 * Math.PI / 180);          // ≈ 0.087

  function wallIsH(w) {
    const adx = Math.abs(w.end.x - w.start.x);
    const ady = Math.abs(w.end.y - w.start.y);
    const len = Math.sqrt(adx * adx + ady * ady);
    return len > 1 && (ady / len) < SIN5;
  }

  function wallIsV(w) {
    const adx = Math.abs(w.end.x - w.start.x);
    const ady = Math.abs(w.end.y - w.start.y);
    const len = Math.sqrt(adx * adx + ady * ady);
    return len > 1 && (adx / len) < SIN5;
  }

  // ── FIFO cascade queue ───────────────────────────────────────────────────
  // { wallId, movedEndKey: 'start'|'end', originPt, delta: {dx,dy} }
  const queue   = [];
  const visited = new Set();    // `${wallId}-${movedEndKey}` — processed once

  // Seed: every wall (except the edited one) sharing the moved endpoint
  for (const w of walls) {
    if (w.id === editedWallId) continue;
    if (calcDist(w.start, movedFrom) < CHAIN_CONNECT_DIST) {
      queue.push({ wallId: w.id, movedEndKey: 'start',
                   originPt: { ...movedFrom }, delta: { dx: dx0, dy: dy0 } });
    } else if (calcDist(w.end, movedFrom) < CHAIN_CONNECT_DIST) {
      queue.push({ wallId: w.id, movedEndKey: 'end',
                   originPt: { ...movedFrom }, delta: { dx: dx0, dy: dy0 } });
    }
  }

  // ── Process ──────────────────────────────────────────────────────────────
  while (queue.length > 0) {
    const { wallId, movedEndKey, delta } = queue.shift();
    const vKey = `${wallId}-${movedEndKey}`;
    if (visited.has(vKey)) continue;
    visited.add(vKey);

    const w = walls.find(ww => ww.id === wallId);
    if (!w) continue;

    const fixedEndKey  = movedEndKey === 'start' ? 'end' : 'start';
    const origMovedPt  = { ...w[movedEndKey] };
    const origFixedPt  = { ...w[fixedEndKey] };

    // If the MOVED end itself is the anchor it absolutely cannot move — skip
    if (calcDist(origMovedPt, anchorPt) < ANCHOR_THRESH) continue;

    // New position of the moved end (always follows delta for connectivity)
    const newMovedPt = snapPt({
      x: origMovedPt.x + delta.dx,
      y: origMovedPt.y + delta.dy
    });

    // Determine how much of the delta reaches the fixed end
    const isH    = wallIsH(w);
    const isV    = wallIsV(w);
    const locked = !!w.measurement;

    let cascDx = 0, cascDy = 0;
    if (isH) {
      // ⊥ (Y) always propagates; ∥ (X) only propagates when wall is locked
      cascDy = delta.dy;
      cascDx = locked ? delta.dx : 0;
    } else if (isV) {
      // ⊥ (X) always propagates; ∥ (Y) only propagates when wall is locked
      cascDx = delta.dx;
      cascDy = locked ? delta.dy : 0;
    }
    // diagonal wall: cascDx = cascDy = 0 → fixed end untouched, no cascade

    // New position of the fixed end
    let newFixedPt = snapPt({
      x: origFixedPt.x + cascDx,
      y: origFixedPt.y + cascDy
    });

    // If the fixed end IS the anchor it cannot move → wall goes diagonal (last resort)
    if (calcDist(origFixedPt, anchorPt) < ANCHOR_THRESH) {
      newFixedPt = { ...origFixedPt };
      cascDx = 0;
      cascDy = 0;
    }

    // Apply update to this wall
    walls = walls.map(ww => {
      if (ww.id !== wallId) return ww;
      return { ...ww, [movedEndKey]: newMovedPt, [fixedEndKey]: newFixedPt };
    });

    // If the fixed end actually moved, cascade to walls sharing its OLD position
    if (Math.abs(cascDx) > 0.5 || Math.abs(cascDy) > 0.5) {
      const cascDelta = { dx: cascDx, dy: cascDy };
      for (const nw of walls) {
        if (nw.id === wallId || nw.id === editedWallId) continue;
        // Search at the ORIGINAL fixedPt (other walls haven't been updated yet)
        if (calcDist(nw.start, origFixedPt) < CHAIN_CONNECT_DIST) {
          queue.push({ wallId: nw.id, movedEndKey: 'start',
                       originPt: { ...origFixedPt }, delta: cascDelta });
        } else if (calcDist(nw.end, origFixedPt) < CHAIN_CONNECT_DIST) {
          queue.push({ wallId: nw.id, movedEndKey: 'end',
                       originPt: { ...origFixedPt }, delta: cascDelta });
        }
      }
    }
  }

  return walls;
}

// ─── Junction-aware wall application (pure, no store access) ─────────────────
//
// Given a single new wall data object and the current walls array, returns
// { walls: newWallsArray, newIds: string[] }.
//
// Algorithm:
//   A. Snap both endpoints to the nearest existing endpoint within NODE_SNAP_RADIUS.
//   B. Find all existing walls the interior of the new segment crosses.
//   C. For each crossing (sorted by distance along new wall):
//       – Replace the crossed wall with two sub-walls that meet at the crossing.
//       – Record a waypoint so the new wall is also split at the crossing.
//   D. Add a new wall segment for each piece of the original new wall.
//   E. Filter out degenerate (length < 5 px) segments.
//
function _applyWallWithJunctions(wallData, existingWalls) {
  // ── A. Endpoint snapping ──────────────────────────────────────────────────
  const start = snapEndpointToWalls(wallData.start, existingWalls);
  const end   = snapEndpointToWalls(wallData.end,   existingWalls);

  if (_calcDist(start, end) < 5) return { walls: existingWalls, newIds: [] };

  // ── B. Find interior intersections ───────────────────────────────────────
  const hits = findWallIntersections(start, end, existingWalls);

  // ── C. Split crossed walls ────────────────────────────────────────────────
  let walls = [...existingWalls];

  for (const hit of hits) {
    const ewIdx = walls.findIndex(w => w.id === hit.wallId);
    if (ewIdx === -1) continue;

    const ew           = walls[ewIdx];
    const [seg1, seg2] = splitWallAtPoint(ew, hit.pt);
    const replacements = [];

    if (_calcDist(seg1.start, seg1.end) > 5) {
      replacements.push({
        ...ew,
        id    : `wall_${nextId++}`,
        start : seg1.start,
        end   : seg1.end,
      });
    }
    if (_calcDist(seg2.start, seg2.end) > 5) {
      replacements.push({
        ...ew,
        id    : `wall_${nextId++}`,
        start : seg2.start,
        end   : seg2.end,
      });
    }

    walls.splice(ewIdx, 1, ...replacements);
  }

  // ── D. Segment the new wall at each crossing point ────────────────────────
  const waypoints = [start, ...hits.map(h => h.pt), end];
  const newIds    = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const segStart = waypoints[i];
    const segEnd   = waypoints[i + 1];
    if (_calcDist(segStart, segEnd) < 5) continue;

    const id = `wall_${nextId++}`;
    newIds.push(id);
    walls.push({
      id,
      start         : { x: segStart.x, y: segStart.y },
      end           : { x: segEnd.x,   y: segEnd.y   },
      thickness     : DEFAULT_WALL_THICKNESS_PX,
      measurement   : null,
      actualLength  : null,
      originalLength: _calcDist(segStart, segEnd),
    });
  }

  return { walls, newIds };
}

function _calcDist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// ─── Line intersection helpers (used by the store's snap logic) ──────────────

function getLineIntersection(p1, p2, p3, p4) {
  const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
  const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 0.0001) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t };
  }
  return null;
}

export default useGeometryStore;
