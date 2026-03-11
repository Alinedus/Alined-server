// src/utils/geometryProcessor.js - Barebones Wall System
// Simplified for direct user input without automatic corrections or junction detection.

export const WALL_THICKNESS = 23; // Default wall thickness
export const CORNER_THRESHOLD = 20; // Snap threshold
export const OPENING_WALL_PROXIMITY = 50; // Proximity for openings (windows/doors)

// Minimum pixel gap a window must maintain from each wall corner.
// A window cannot start at T=0 or end at T=1 — there must always be solid
// wall material between the corner junction and the window edge.
// Minimum T-fraction a window must stay away from each wall endpoint.
// T=0 and T=1 are wall corner junctions — structural nodes, not free coordinates.
// A window at T=0 means it starts at the corner itself, which is architecturally
// invalid. Enforcing this HERE (in the geometry engine) is the only correct place:
// AlignCanvas stores raw pixel coords; geometryStore stores them unchanged;
// only geometryProcessor knows which wall segment a window belongs to and can
// compute the T-fraction required to guarantee a visible solid wall stub at corners.
//
// Rule: window.tStart >= MIN_WINDOW_CORNER_GAP
//       window.tEnd   <= 1 - MIN_WINDOW_CORNER_GAP
export const MIN_WINDOW_CORNER_GAP = 0.05; // 5% of wall length from each corner

const INTERSECTION_EPSILON = 1e-4;
const POINT_KEY_PRECISION = 1000;

export function calculateDistance(p1, p2) {
    if (!p1 || !p2) return 0;
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function makePointKey(point) {
    return `${Math.round(point.x * POINT_KEY_PRECISION)}:${Math.round(point.y * POINT_KEY_PRECISION)}`;
}

function arePointsEqual(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3;
}

function getSegmentIntersection(p1, p2, p3, p4) {
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < INTERSECTION_EPSILON) return null;

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / denom;

    if (t < -INTERSECTION_EPSILON || t > 1 + INTERSECTION_EPSILON) return null;
    if (u < -INTERSECTION_EPSILON || u > 1 + INTERSECTION_EPSILON) return null;

    return {
        point: { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) },
        t,
        u
    };
}

/**
 * Process raw walls: Simplified "Barebones" version.
 * Always treats walls as centered around the drawn line.
 */
export function processWalls(walls) {
    if (!walls || !Array.isArray(walls)) return [];

    const baseWalls = walls
        .filter(wall => wall && wall.start && wall.end)
        .map((wall, index) => ({ ...wall, _index: index }));

    if (baseWalls.length === 0) return [];

    const splitMap = new Map();
    baseWalls.forEach(wall => {
        splitMap.set(wall.id, [0, 1]);
    });

    for (let i = 0; i < baseWalls.length; i += 1) {
        for (let j = i + 1; j < baseWalls.length; j += 1) {
            const w1 = baseWalls[i];
            const w2 = baseWalls[j];

            const intersection = getSegmentIntersection(w1.start, w1.end, w2.start, w2.end);
            if (!intersection) continue;

            const splits1 = splitMap.get(w1.id) || [];
            const splits2 = splitMap.get(w2.id) || [];

            splits1.push(Math.min(1, Math.max(0, intersection.t)));
            splits2.push(Math.min(1, Math.max(0, intersection.u)));

            splitMap.set(w1.id, splits1);
            splitMap.set(w2.id, splits2);
        }
    }

    const segments = [];
    baseWalls.forEach(wall => {
        const splits = splitMap.get(wall.id) || [0, 1];
        const uniqueSplits = Array.from(new Set(splits.map(t => Math.min(1, Math.max(0, t))))).sort((a, b) => a - b);

        for (let i = 0; i < uniqueSplits.length - 1; i += 1) {
            const tStart = uniqueSplits[i];
            const tEnd = uniqueSplits[i + 1];
            if (tEnd - tStart < 1e-4) continue;

            const start = {
                x: wall.start.x + (wall.end.x - wall.start.x) * tStart,
                y: wall.start.y + (wall.end.y - wall.start.y) * tStart
            };
            const end = {
                x: wall.start.x + (wall.end.x - wall.start.x) * tEnd,
                y: wall.start.y + (wall.end.y - wall.start.y) * tEnd
            };

            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const length = Math.hypot(dx, dy);
            if (length < 1) continue;

            const angle = Math.atan2(dy, dx);
            const perpAngle = angle - Math.PI / 2;
            const halfX = Math.cos(perpAngle) * (WALL_THICKNESS / 2);
            const halfY = Math.sin(perpAngle) * (WALL_THICKNESS / 2);

            const centerStart = { ...start };
            const centerEnd = { ...end };
            const outerStart = { x: start.x - halfX, y: start.y - halfY };
            const outerEnd = { x: end.x - halfX, y: end.y - halfY };
            const innerStart = { x: start.x + halfX, y: start.y + halfY };
            const innerEnd = { x: end.x + halfX, y: end.y + halfY };

            segments.push({
                ...wall,
                id: `${wall.id}_seg_${i}`,
                parentId: wall.id,
                start,
                end,
                centerStart,
                centerEnd,
                outerStart,
                outerEnd,
                innerStart,
                innerEnd,
                angle,
                thickness: WALL_THICKNESS,
                length,
                connections: { start: [], end: [], splits: [] }
            });
        }
    });

    const endpointMap = new Map();
    segments.forEach(seg => {
        const startKey = makePointKey(seg.start);
        const endKey = makePointKey(seg.end);
        if (!endpointMap.has(startKey)) endpointMap.set(startKey, []);
        if (!endpointMap.has(endKey)) endpointMap.set(endKey, []);
        endpointMap.get(startKey).push({ seg, end: 'start' });
        endpointMap.get(endKey).push({ seg, end: 'end' });
    });

    endpointMap.forEach(entries => {
        if (entries.length < 2) return;
        entries.forEach(entry => {
            const connection = { type: 'L' };
            if (entry.end === 'start') entry.seg.connections.start.push(connection);
            if (entry.end === 'end') entry.seg.connections.end.push(connection);
        });
    });

    return segments;
}

export function findLineIntersection(p1, p2, p3, p4) {
    if (!p1 || !p2 || !p3 || !p4) return null;
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-4) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

function distancePointToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return calculateDistance(point, start);
    let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: start.x + t * dx, y: start.y + t * dy };
    return calculateDistance(point, proj);
}

function angleDiffRadians(a, b) {
    const diff = Math.abs(a - b) % (Math.PI * 2);
    return diff > Math.PI ? (Math.PI * 2 - diff) : diff;
}

export function findNearestPointOnLine(point, lineStart, lineEnd) {
    if (!point || !lineStart || !lineEnd) return { point: lineStart || { x: 0, y: 0 }, t: 0 };
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { point: lineStart, t: 0 };
    const t = Math.max(0, Math.min(1, ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq));
    return { point: { x: lineStart.x + t * dx, y: lineStart.y + t * dy }, t };
}

export function getWallSubDimensions(wall) {
    if (!wall) return [];
    const splits = [];

    if (wall && wall.connections && wall.connections.splits) {
        wall.connections.splits.forEach(split => {
            splits.push({ t: split.t, type: 'wall' });
        });
    }

    splits.sort((a, b) => a.t - b.t);

    const dimensions = [];
    let lastT = 0;
    splits.forEach(split => {
        const segLen = (split.t - lastT) * wall.length;
        const midT = (lastT + split.t) / 2;
        dimensions.push({
            len: segLen,
            midT: midT,
            startT: lastT,
            endT: split.t,
            type: 'segment'
        });
        lastT = split.t;
    });
    if (lastT < 1) {
        dimensions.push({
            len: (1 - lastT) * wall.length,
            midT: (lastT + 1) / 2,
            startT: lastT,
            endT: 1,
            type: 'segment'
        });
    }
    return dimensions;
}

// --- Openings (Windows/Doors) ---

export function findWallsForOpening(opening, walls) {
    if (!opening || !opening.start || !opening.end) return null;
    if (!walls || walls.length === 0) return null;
    const openingDx = opening.end.x - opening.start.x;
    const openingDy = opening.end.y - opening.start.y;
    const openingLength = Math.hypot(openingDx, openingDy);
    if (openingLength < 1) return null;

    const openingAngle = Math.atan2(openingDy, openingDx);
    const midpoint = { x: (opening.start.x + opening.end.x) / 2, y: (opening.start.y + opening.end.y) / 2 };
    const candidates = [];

    walls.forEach(wall => {
        const wallAngle = wall.angle || Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
        const diff = angleDiffRadians(openingAngle, wallAngle);
        const isAligned = diff < (20 * Math.PI / 180) || diff > (Math.PI - 20 * Math.PI / 180);

        const distStart = distancePointToSegment(opening.start, wall.start, wall.end);
        const distEnd = distancePointToSegment(opening.end, wall.start, wall.end);
        const distMid = distancePointToSegment(midpoint, wall.start, wall.end);
        const minDist = Math.min(distStart, distEnd, distMid);

        if (minDist > OPENING_WALL_PROXIMITY) return;

        // FIXED: Non-aligned openings must NOT match perpendicular walls.
        // The old fallback allowed windows/doors at corners to match the adjacent
        // perpendicular wall because one endpoint happened to be close.
        // Only perfectly-aligned (parallel) walls should host an opening.
        if (!isAligned) return;

        const projStart = findNearestPointOnLine(opening.start, wall.start, wall.end);
        const projEnd = findNearestPointOnLine(opening.end, wall.start, wall.end);
        const startT = Math.min(projStart.t, projEnd.t);
        const endT = Math.max(projStart.t, projEnd.t);

        // ── STRETCH GUARD ─────────────────────────────────────────────────────
        // findNearestPointOnLine clamps t to [0,1].  When a split-wall segment is
        // shorter than the original wall, an endpoint that projects PAST the segment
        // end gets clamped to T=1, silently stretching the window to fill the whole
        // segment.  Detect this by comparing the projected span (px) to the actual
        // drawn window length (px).  If clamping inflated the span by more than 30%,
        // this segment is not the correct host — reject it.
        const wallLen = wall.length || calculateDistance(wall.start, wall.end);
        const projectedSpanPx = (endT - startT) * wallLen;
        if (projectedSpanPx > openingLength * 1.30) return;

        // All openings (doors and windows) follow the same placement rule:
        // they must begin at the inner wall face, never at the raw wall endpoint.
        // The inner-face T-fraction is wall-length-dependent so that the protected
        // solid corner zone scales correctly for both short and long walls.
        const halfThicknessT = (WALL_THICKNESS / 2) / wallLen;

        let clampedStartT = Math.max(0, startT);
        let clampedEndT   = Math.min(1, endT);

        // Unified inner-wall-face alignment for all opening types (doors and windows).
        // Replaces: door snap-to-corner (fixed 4%) + window MIN_WINDOW_CORNER_GAP (fixed 5%).
        // Rule: opening_start >= inner_face_T, opening_end <= 1 - inner_face_T
        clampedStartT = Math.max(clampedStartT, halfThicknessT);
        clampedEndT   = Math.min(clampedEndT,   1 - halfThicknessT);

        // Reject if the opening no longer fits on this segment after clamping
        if (clampedStartT >= clampedEndT - 0.01) return;

        // Corner flags: opening sits at the inner-face boundary.
        // Used only to inform the renderer — NOT for further geometry correction.
        const CORNER_T = halfThicknessT + 0.01;
        const atCornerStart = clampedStartT <= CORNER_T;
        const atCornerEnd   = clampedEndT   >= 1 - CORNER_T;

        const span = Math.abs(clampedEndT - clampedStartT) * wall.length;
        if (span < 5) return;

        candidates.push({
            wall,
            positionT: (startT + endT) / 2,
            openingLength,
            startT: clampedStartT,
            endT: clampedEndT,
            distance: minDist,
            atCornerStart,
            atCornerEnd
        });
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.distance - b.distance);
    return candidates;
}

export function findWallForOpening(opening, walls) {
    const matches = findWallsForOpening(opening, walls);
    if (!matches || matches.length === 0) return null;
    return matches[0];
}

export function findOpeningsOnWall(wall, doors, windows) {
    if (!wall) return [];
    const allOpenings = [
        ...(doors || []).map(d => ({ ...d, type: 'door' })),
        ...(windows || []).map(w => ({ ...w, type: 'window' }))
    ];
    return allOpenings
        .flatMap(op => {
            const res = findWallsForOpening(op, [wall]);
            if (!res || res.length === 0) return [];
            return res
                .filter(match => match.wall.id === wall.id)
                .map(match => ({
                    ...op,
                    ...match
                }));
        })
        .filter(Boolean)
        .sort((a, b) => a.startT - b.startT);
}

export function getWallSegments(openings) {
    if (!openings || openings.length === 0) return [{ startT: 0, endT: 1 }];
    const segments = [];
    let prev = 0;
    openings.forEach(op => {
        if (op.startT > prev) segments.push({ startT: prev, endT: op.startT });
        prev = Math.max(prev, op.endT);
    });
    if (prev < 1) segments.push({ startT: prev, endT: 1 });
    return segments;
}

export function interpolateWallPoint(wall, t, edge = 'outer') {
    if (!wall) return { x: 0, y: 0 };

    let start, end;
    if (edge === 'inner') { start = wall.innerStart; end = wall.innerEnd; }
    else if (edge === 'center') { start = wall.centerStart; end = wall.centerEnd; }
    else { start = wall.outerStart; end = wall.outerEnd; }

    if (!start || !end) return { x: 0, y: 0 };

    return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t
    };
}

export function calculateWindowFrame(window, wall, openingMatch = null) {
    if (!wall) return null;
    const res = openingMatch || findWallForOpening(window, [wall]);
    if (!res) return null;

    const { startT, endT } = res;
    return {
        outerStart: interpolateWallPoint(wall, startT, 'outer'),
        outerEnd: interpolateWallPoint(wall, endT, 'outer'),
        innerStart: interpolateWallPoint(wall, startT, 'inner'),
        innerEnd: interpolateWallPoint(wall, endT, 'inner'),
        outerCenter: interpolateWallPoint(wall, (startT + endT) / 2, 'outer'),
        innerCenter: interpolateWallPoint(wall, (startT + endT) / 2, 'inner'),
        angle: wall.angle,
        startT, endT
    };
}

/**
 * Returns true if the opening sits at the very start or end of its wall
 * (within a corner threshold). Used by cadExport to skip cap lines at corners.
 */
export function isOpeningCorner(opening, wall) {
  if (!opening || !wall) return false;
  // Use the same inner-face threshold as findWallsForOpening so the renderer
  // correctly identifies corner openings regardless of wall length.
  const wallLen = wall.length || calculateDistance(wall.start, wall.end);
  const CORNER_T_THRESHOLD = (WALL_THICKNESS / 2) / wallLen + 0.01;
  const res = findWallForOpening(opening, [wall]);
  if (!res) return false;
  return res.startT <= CORNER_T_THRESHOLD || res.endT >= 1 - CORNER_T_THRESHOLD;
}

export function calculateDoorGeometry(door) {
    if (!door || !door.start || !door.end) return null;
    const dx = door.end.x - door.start.x;
    const dy = door.end.y - door.start.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const angle = Math.atan2(dy, dx);
    return {
        hingePoint: door.start,
        frameEnd: door.end,
        doorWidth: len,
        angle,
        swingEnd: { x: door.start.x + Math.cos(angle - Math.PI / 2) * len, y: door.start.y + Math.sin(angle - Math.PI / 2) * len },
        arcStartAngle: angle,
        arcEndAngle: angle - Math.PI / 2
    };
}
