// src/components/DefineViews.jsx - PROFESSIONAL SEAMLESS INTEGRATION
import React, { useRef, useEffect, useState, useCallback } from 'react';
import useGeometryStore from '../stores/geometryStore';
import {
  processWalls,
  findOpeningsOnWall,
  getWallSegments,
  interpolateWallPoint,
  calculateWindowFrame,
  calculateDoorGeometry,
  findWallForOpening,
  findWallsForOpening,
  findLineIntersection,
  findNearestPointOnLine,
  calculateDistance,
  WALL_THICKNESS
} from '../utils/geometryProcessor';
// measurementParser removed — measurement validity is checked via wall.actualLength

const POINT_KEY_PRECISION = 1000;

export default function DefineViews() {
  const canvasRef = useRef(null);
  const [selectedDoor, setSelectedDoor] = useState(null);
  const debugDimsRef = useRef({ logged: new Set() });
  const { walls, doors, windows, generics, updateDoorOrientation, viewport, setViewport, mode } = useGeometryStore();

  // Viewport state for infinite canvas
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState(null);
  const [touchState, setTouchState] = useState({ lastDistance: 0, lastCenter: null, gestureActive: false });
  
  // Double-click detection and segmented selection
  const lastClickRef = useRef({ time: 0, x: 0, y: 0, element: null });
  const [selectedSegment, setSelectedSegment] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const container = canvas.parentElement;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
    };
  }, []);

  const screenToWorld = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const screenX = (clientX - rect.left) * (canvas.width / rect.width);
    const screenY = (clientY - rect.top) * (canvas.height / rect.height);
    return {
      x: (screenX - viewport.x) / viewport.k,
      y: (screenY - viewport.y) / viewport.k
    };
  }, [viewport]);

  const worldToScreen = useCallback((worldX, worldY) => {
    return {
      x: worldX * viewport.k + viewport.x,
      y: worldY * viewport.k + viewport.y
    };
  }, [viewport]);

  const makePointKey = (p) => `${Math.round(p.x * POINT_KEY_PRECISION)}:${Math.round(p.y * POINT_KEY_PRECISION)}`;

  const handleWheel = (e) => {
    e.preventDefault();
    const zoomIntensity = 0.1;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = 1 + (direction * zoomIntensity);

    let newK = viewport.k * factor;
    newK = Math.max(0.1, Math.min(newK, 10));

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);

    const newX = mouseX - (mouseX - viewport.x) * (newK / viewport.k);
    const newY = mouseY - (mouseY - viewport.y) * (newK / viewport.k);

    setViewport({ x: newX, y: newY, k: newK });
  };

  const getTouchDistance = (touches) => {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getTouchCenter = (touches) => {
    if (touches.length < 2) return null;
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2
    };
  };

  const handleStart = (e) => {
    if (e.touches && e.touches.length === 2) {
      const distance = getTouchDistance(e.touches);
      const center = getTouchCenter(e.touches);
      setTouchState({ lastDistance: distance, lastCenter: center, gestureActive: true });
      return;
    }

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    if (e.button === 1 || e.buttons === 4 || e.touches) {
      setIsPanning(true);
      setLastPanPoint({ x: clientX, y: clientY });
    }
  };

  const handleMove = (e) => {
    if (touchState.gestureActive && e.touches && e.touches.length === 2) {
      const distance = getTouchDistance(e.touches);
      const center = getTouchCenter(e.touches);
      const factor = distance / touchState.lastDistance;
      let newK = viewport.k * factor;
      newK = Math.max(0.1, Math.min(newK, 10));

      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const centerX = (center.x - rect.left) * (canvas.width / rect.width);
      const centerY = (center.y - rect.top) * (canvas.height / rect.height);

      const newX = centerX - (centerX - viewport.x) * (newK / viewport.k);
      const newY = centerY - (centerY - viewport.y) * (newK / viewport.k);

      setViewport({ x: newX, y: newY, k: newK });
      setTouchState(prev => ({ ...prev, lastDistance: distance, lastCenter: center }));
      return;
    }

    if (isPanning && lastPanPoint) {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = clientX - lastPanPoint.x;
      const dy = clientY - lastPanPoint.y;
      setViewport(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      setLastPanPoint({ x: clientX, y: clientY });
    }
  };

  const handleEnd = () => {
    setIsPanning(false);
    setLastPanPoint(null);
    setTouchState(prev => ({ ...prev, gestureActive: false }));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.k, viewport.k);

    // Process walls with centered thickness and junction handling
    const processedWalls = processWalls(walls || []);

    const junctionMap = new Map();
    processedWalls.forEach(w => {
      const sk = makePointKey(w.start);
      const ek = makePointKey(w.end);
      if (!junctionMap.has(sk)) junctionMap.set(sk, []);
      if (!junctionMap.has(ek)) junctionMap.set(ek, []);
      junctionMap.get(sk).push({ wall: w, end: 'start' });
      junctionMap.get(ek).push({ wall: w, end: 'end' });
    });

    const adjustedWalls = processedWalls.map(wall => adjustWallJunctions(wall, junctionMap));

    const adjustedJunctionMap = new Map();
    adjustedWalls.forEach(w => {
      const sk = makePointKey(w.start);
      const ek = makePointKey(w.end);
      if (!adjustedJunctionMap.has(sk)) adjustedJunctionMap.set(sk, []);
      if (!adjustedJunctionMap.has(ek)) adjustedJunctionMap.set(ek, []);
      adjustedJunctionMap.get(sk).push({ wall: w, end: 'start' });
      adjustedJunctionMap.get(ek).push({ wall: w, end: 'end' });
    });

    // Build junction connectivity map BEFORE filtering
    const junctionConnectivity = new Map();
    adjustedWalls.forEach(w => {
      const sk = makePointKey(w.start);
      const ek = makePointKey(w.end);
      
      if (!junctionConnectivity.has(sk)) junctionConnectivity.set(sk, []);
      if (!junctionConnectivity.has(ek)) junctionConnectivity.set(ek, []);
      
      junctionConnectivity.get(sk).push({ wallId: w.id, endpoint: 'start', isStart: true });
      junctionConnectivity.get(ek).push({ wallId: w.id, endpoint: 'end', isStart: false });
    });

    // Filter out tiny segments (< 3 units) AND dangling terminal segments at junctions
    const filteredWalls = adjustedWalls.filter(wall => {
      const dx = wall.end.x - wall.start.x;
      const dy = wall.end.y - wall.start.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      
      // Remove segments < 3 units
      if (length <= 3) return false;
      
      // Remove dangling terminal segments
      const sk = makePointKey(wall.start);
      const ek = makePointKey(wall.end);
      
      const startConnections = junctionConnectivity.get(sk) || [];
      const endConnections = junctionConnectivity.get(ek) || [];
      
      // Count how many OTHER segments connect at each endpoint (excluding this wall)
      const otherAtStart = startConnections.filter(c => c.wallId !== wall.id).length;
      const otherAtEnd = endConnections.filter(c => c.wallId !== wall.id).length;
      
      // Total connections at each endpoint (including this wall)
      const totalAtStart = startConnections.length;
      const totalAtEnd = endConnections.length;
      
      // Remove BOTH types of dangling segments:
      // 1. Completely orphaned: neither endpoint has other segments (both are dead-ends)
      // 2. Terminal stubs: only one endpoint has other segments, AND this is a very short segment
      
      if (otherAtStart === 0 && otherAtEnd === 0) {
        // Completely orphaned segment - remove it
        return false;
      }
      
      // Terminal stub check: segment extends from a junction as a dead-end
      // Remove if: one endpoint is isolated AND other endpoint has connections
      // AND segment is relatively short (< 35 units, indicating it's a fragment not a main wall)
      const isTerminalStub = (
        (otherAtStart === 0 && totalAtEnd >= 2 && length < 35) ||
        (otherAtEnd === 0 && totalAtStart >= 2 && length < 35)
      );
      
      if (isTerminalStub) {
        console.log(`[Filter] Removing terminal stub: ${wall.id}, length ${Math.round(length)}, start others: ${otherAtStart}, end others: ${otherAtEnd}`);
        return false;
      }
      
      return true;
    });

    // Rebuild junction map from filtered walls
    const filteredJunctionMap = new Map();
    filteredWalls.forEach(w => {
      const sk = makePointKey(w.start);
      const ek = makePointKey(w.end);
      if (!filteredJunctionMap.has(sk)) filteredJunctionMap.set(sk, []);
      if (!filteredJunctionMap.has(ek)) filteredJunctionMap.set(ek, []);
      filteredJunctionMap.get(sk).push({ wall: w, end: 'start' });
      filteredJunctionMap.get(ek).push({ wall: w, end: 'end' });
    });

    // Structural footprints and cycles removed for barebones

    // Find all openings for each wall
    const wallsWithOpenings = filteredWalls.map(wall => ({
      ...wall,
      openings: findOpeningsOnWall(wall, doors || [], windows || [])
    }));

    // Draw in correct order - CRITICAL: Windows MUST be drawn AFTER patches to cover junction artifacts
    (generics || []).forEach(g => drawGeneric(ctx, g));
    wallsWithOpenings.forEach(wall => drawWall(ctx, wall, filteredWalls, doors || []));

    // Door-corner rectangular fills: keep walls visually extended to corners without changing wall/door geometry
    drawDoorCornerRectPatches(ctx, filteredJunctionMap);
    
    // Draw junction patches BEFORE windows so window fill can cover any artifacts
    drawTJunctionPatches(ctx, filteredJunctionMap, filteredWalls);
    drawCrossJunctionPatches(ctx, filteredJunctionMap, filteredWalls);

    // Corner Mullions and other complex structural logic removed for barebones

    // CRITICAL: Windows and doors drawn LAST so their corner fills cover all junction patches
    (windows || []).forEach(w => drawWindow(ctx, w, filteredWalls, processedWalls));
    (doors || []).forEach(d => drawDoor(ctx, d, filteredWalls));

    drawDimensionLines(ctx, wallsWithOpenings, windows || [], doors || [], generics || []);

    (doors || []).forEach(d => drawDoorArrow(ctx, d));

    ctx.restore();
  }, [walls, doors, windows, generics, viewport]);

  // --- Helper Functions Functions (Defined inside component to access state if needed, but safe to hoist manually if pure) ---

  const OPENING_T_EPS = 1e-3;
  const CORNER_OPENING_T_THRESHOLD = 0.1;

  const isOpeningBoundaryT = (t, openings) => {
    if (!openings || openings.length === 0) return false;
    if (t <= OPENING_T_EPS || t >= 1 - OPENING_T_EPS) return false;
    return openings.some(op =>
      Math.abs(op.startT - t) < OPENING_T_EPS || Math.abs(op.endT - t) < OPENING_T_EPS
    );
  };

  const isCornerWindowOpening = (opening) => {
    if (!opening) return false;
    if (opening.type !== 'window') return false;
    return opening.startT <= CORNER_OPENING_T_THRESHOLD || opening.endT >= 1 - CORNER_OPENING_T_THRESHOLD;
  };

  const getPerpEdgeIntersections = (wall, t) => {
    if (!wall) return null;
    const center = interpolateWallPoint(wall, t, 'center');
    const normalAngle = wall.angle - Math.PI / 2;
    const nx = Math.cos(normalAngle);
    const ny = Math.sin(normalAngle);

    const span = (wall.thickness || WALL_THICKNESS) * 4;
    const p1 = { x: center.x - nx * span, y: center.y - ny * span };
    const p2 = { x: center.x + nx * span, y: center.y + ny * span };

    const outerInt = findLineIntersection(p1, p2, wall.outerStart, wall.outerEnd);
    const innerInt = findLineIntersection(p1, p2, wall.innerStart, wall.innerEnd);

    if (!outerInt || !innerInt) return null;
    return { outer: outerInt, inner: innerInt };
  };

  const getOpeningCapPoints = (wall, t, openings) => {
    if (!isOpeningBoundaryT(t, openings)) return null;
    return getPerpEdgeIntersections(wall, t);
  };

  const getWallEndSquareCaps = (wall, endType) => {
    if (!wall) return null;
    const point = endType === 'start' ? wall.start : wall.end;
    if (!point) return null;
    const half = (wall.thickness || WALL_THICKNESS) / 2;
    const normalAngle = wall.angle - Math.PI / 2;
    const nx = Math.cos(normalAngle);
    const ny = Math.sin(normalAngle);

    // Align outer/inner with wall's existing orientation
    const outerRef = endType === 'start' ? wall.outerStart : wall.outerEnd;
    const refVec = outerRef ? { x: outerRef.x - point.x, y: outerRef.y - point.y } : { x: -nx, y: -ny };
    const sign = (refVec.x * nx + refVec.y * ny) >= 0 ? 1 : -1;
    const ox = point.x + nx * half * sign;
    const oy = point.y + ny * half * sign;
    const ix = point.x - nx * half * sign;
    const iy = point.y - ny * half * sign;

    return {
      outer: { x: ox, y: oy },
      inner: { x: ix, y: iy }
    };
  };

  const getWallEndIntersectionWithPerpWall = (wall, endType, perpWall) => {
    if (!wall || !perpWall) return null;
    const point = endType === 'start' ? wall.start : wall.end;
    if (!point) return null;

    // Extend wall edges horizontally/vertically to meet perpendicular wall edges
    const wallLine = { start: wall.outerStart, end: wall.outerEnd };
    const perpLineOuter = { start: perpWall.outerStart, end: perpWall.outerEnd };
    const perpLineInner = { start: perpWall.innerStart, end: perpWall.innerEnd };

    const outerIntersect = findLineIntersection(wallLine.start, wallLine.end, perpLineOuter.start, perpLineOuter.end);
    const innerIntersect = findLineIntersection(
      wall.innerStart, wall.innerEnd, perpLineInner.start, perpLineInner.end
    );

    return {
      outer: outerIntersect || getWallEndSquareCaps(wall, endType)?.outer,
      inner: innerIntersect || getWallEndSquareCaps(wall, endType)?.inner
    };
  };

  const getWallSquareCapsAtJunction = (wall, junctionPoint) => {
    if (!wall || !junctionPoint) return null;
    const junctionKey = makePointKey(junctionPoint);
    const startKey = makePointKey(wall.start);
    const endKey = makePointKey(wall.end);
    if (junctionKey === startKey) return getWallEndSquareCaps(wall, 'start');
    if (junctionKey === endKey) return getWallEndSquareCaps(wall, 'end');
    return null;
  };

  const getDoorEdgeForCorner = (wall, cornerWall, t) => {
    if (!wall || !cornerWall) return null;
    const caps = getPerpEdgeIntersections(wall, t);
    if (!caps) return null;

    // Choose the edge that is closest to the perpendicular wall's inner edge
    const outerProj = findNearestPointOnLine(caps.outer, cornerWall.innerStart, cornerWall.innerEnd);
    const innerProj = findNearestPointOnLine(caps.inner, cornerWall.innerStart, cornerWall.innerEnd);
    const distOuter = calculateDistance(caps.outer, outerProj.point);
    const distInner = calculateDistance(caps.inner, innerProj.point);

    return distOuter <= distInner ? 'outer' : 'inner';
  };

  const snapDoorHingeToPerpInnerEdge = (wall, cornerWall, edge, hingePoint) => {
    if (!wall || !cornerWall || !edge || !hingePoint) return hingePoint;
    const edgeStart = edge === 'outer' ? wall.outerStart : wall.innerStart;
    const edgeEnd = edge === 'outer' ? wall.outerEnd : wall.innerEnd;
    const hingeIntersect = findLineIntersection(
      edgeStart,
      edgeEnd,
      cornerWall.innerStart,
      cornerWall.innerEnd
    );
    return hingeIntersect || hingePoint;
  };

  const hasPerpendicularDoorAtJunction = (wall, junctionPoint, doorsArray, wallsArray) => {
    if (!wall || !junctionPoint || !doorsArray || !wallsArray) return false;
    const junctionKey = makePointKey(junctionPoint);
    const ANGLE_TOLERANCE = 10 * Math.PI / 180;

    for (const door of doorsArray) {
      if (!door) continue;
      const doorMatch = findWallForOpening(door, wallsArray);
      if (!doorMatch || !doorMatch.wall) continue;

      const doorWall = doorMatch.wall;
      const diff = angleDiff(wall.angle, doorWall.angle);
      if (Math.abs(diff - Math.PI / 2) > ANGLE_TOLERANCE) continue;

      const doorStartKey = makePointKey(doorWall.start);
      const doorEndKey = makePointKey(doorWall.end);

      if ((doorStartKey === junctionKey && doorMatch.startT <= OPENING_T_EPS) ||
          (doorEndKey === junctionKey && doorMatch.endT >= 1 - OPENING_T_EPS)) {
        return true;
      }
    }

    return false;
  };

  const hasCornerDoorAtWallEnd = (wall, endType) => {
    if (!wall || !doors) return false;
    const cornerThreshold = 0.1;

    return (doors || []).some(door => {
      if (!door) return false;
      const matches = findWallsForOpening(door, [wall]) || [];
      if (matches.length === 0) return false;
      const match = matches[0];
      if (!match || !match.wall || match.wall.id !== wall.id) return false;
      if (endType === 'start') return match.startT <= cornerThreshold;
      return match.endT >= 1 - cornerThreshold;
    });
  };

  const findDoorsAtWallEnds = (wall, doorsArray, wallsArray) => {
    if (!wall || !doorsArray || !wallsArray) return { start: null, end: null };
    const ANGLE_TOLERANCE = 10 * Math.PI / 180;
    const startKey = makePointKey(wall.start);
    const endKey = makePointKey(wall.end);
    const result = { start: null, end: null };

    for (const door of doorsArray) {
      if (!door) continue;
      const doorMatch = findWallForOpening(door, wallsArray);
      if (!doorMatch || !doorMatch.wall) continue;

      const doorWall = doorMatch.wall;
      const diff = angleDiff(wall.angle, doorWall.angle);
      if (Math.abs(diff - Math.PI / 2) > ANGLE_TOLERANCE) continue;

      const doorStartKey = makePointKey(doorWall.start);
      const doorEndKey = makePointKey(doorWall.end);

      if (doorStartKey === startKey && doorMatch.startT <= OPENING_T_EPS) {
        result.start = { door, match: doorMatch, wall: doorWall };
      }
      if (doorEndKey === endKey && doorMatch.endT >= 1 - OPENING_T_EPS) {
        result.end = { door, match: doorMatch, wall: doorWall };
      }
    }

    return result;
  };

  const isDoorAtJunctionPoint = (junctionPoint, wall) => {
    if (!junctionPoint || !wall || !(doors || []).length) return false;
    const ANGLE_TOLERANCE = 20 * Math.PI / 180;
    const SNAP_DIST = Math.max(14, (wall.thickness || WALL_THICKNESS) * 0.8);

    const result = (doors || []).some(door => {
      if (!door || !door.start || !door.end) return false;
      const doorAngle = Math.atan2(door.end.y - door.start.y, door.end.x - door.start.x);
      const diff = angleDiff(wall.angle, doorAngle);
      if (!(diff < ANGLE_TOLERANCE || diff > Math.PI - ANGLE_TOLERANCE)) return false;

      const distStart = Math.hypot(door.start.x - junctionPoint.x, door.start.y - junctionPoint.y);
      const distEnd = Math.hypot(door.end.x - junctionPoint.x, door.end.y - junctionPoint.y);
      const atJunction = distStart <= SNAP_DIST || distEnd <= SNAP_DIST;
      if (atJunction) {
        console.log('🚪 Found door at junction:', door.id, 'distStart:', distStart, 'distEnd:', distEnd);
      }
      return atJunction;
    });
    
    return result;
  };

  const isWindowAtJunctionPoint = (junctionPoint, wall) => {
    if (!junctionPoint || !wall || !(windows || []).length) return false;
    const ANGLE_TOLERANCE = 20 * Math.PI / 180;
    const SNAP_DIST = Math.max(14, (wall.thickness || WALL_THICKNESS) * 0.8);

    const result = (windows || []).some(win => {
      if (!win || !win.start || !win.end) return false;
      const winAngle = Math.atan2(win.end.y - win.start.y, win.end.x - win.start.x);
      const diff = angleDiff(wall.angle, winAngle);
      if (!(diff < ANGLE_TOLERANCE || diff > Math.PI - ANGLE_TOLERANCE)) return false;

      const distStart = Math.hypot(win.start.x - junctionPoint.x, win.start.y - junctionPoint.y);
      const distEnd = Math.hypot(win.end.x - junctionPoint.x, win.end.y - junctionPoint.y);
      const atJunction = distStart <= SNAP_DIST || distEnd <= SNAP_DIST;
      if (atJunction) {
        console.log('🪟 Found window at junction:', win.id, 'distStart:', distStart, 'distEnd:', distEnd);
      }
      return atJunction;
    });
    
    return result;
  };

  const drawWall = (ctx, wall, processedWalls = [], doorsArray = []) => {
    if (!wall) return;
    const { outerStart, outerEnd, innerStart, innerEnd, openings } = wall;
    if (!outerStart || !outerEnd || !innerStart || !innerEnd) return;
    const OPENING_ALIGN_TOL = 20 * Math.PI / 180;
    const alignedOpenings = (openings || []).filter(op => {
      if (!op?.start || !op?.end) return false;
      const opAngle = Math.atan2(op.end.y - op.start.y, op.end.x - op.start.x);
      const diff = angleDiff(wall.angle, opAngle);
      return diff < OPENING_ALIGN_TOL || diff > Math.PI - OPENING_ALIGN_TOL;
    });

    const hasStartConn = wall.connections?.start?.some(c => c.type === 'L' || c.type === 'T');
    const hasEndConn = wall.connections?.end?.some(c => c.type === 'L' || c.type === 'T');
    const doorsAtEnds = findDoorsAtWallEnds(wall, doorsArray, processedWalls);

    // Find perpendicular walls at start/end junctions for corner intersections
    const perpWallAtStart = findPerpWallAtJunction(wall, wall.start, processedWalls);
    const perpWallAtEnd = findPerpWallAtJunction(wall, wall.end, processedWalls);

    // Check if THIS wall has windows at corners - if so, don't use corner intersections
    const cornerThreshold = 0.1;
    const hasWindowAtThisWallStart = alignedOpenings.some(op => op.type === 'window' && op.startT <= cornerThreshold);
    const hasWindowAtThisWallEnd = alignedOpenings.some(op => op.type === 'window' && op.endT >= 1 - cornerThreshold);

    // CRITICAL: Check if a PERPENDICULAR wall has a window at THIS junction
    // VERY INTELLIGENT: Check perpendicular wall windows with expanded tolerance (10% at corners)
    // This catches windows that don't start exactly at T=0 but are still effectively at the corner
    const expandedCornerThreshold = 0.1; // Check 10% of wall length at each end for corner windows
    const perpWallStartHasWindow = perpWallAtStart && perpWallAtStart.openings && 
      perpWallAtStart.openings.some(op => {
        if (op.type !== 'window') return false;
        // Check if opening is near the START of perpWall (at THIS junction)
        if (op.startT <= expandedCornerThreshold) return true;
        // Check if opening is near the END of perpWall (also at THIS junction)
        if (op.endT >= 1 - expandedCornerThreshold) return true;
        return false;
      });
    const perpWallEndHasWindow = perpWallAtEnd && perpWallAtEnd.openings && 
      perpWallAtEnd.openings.some(op => {
        if (op.type !== 'window') return false;
        // Check if opening is near the START of perpWall (at THIS junction)
        if (op.startT <= expandedCornerThreshold) return true;
        // Check if opening is near the END of perpWall (also at THIS junction)
        if (op.endT >= 1 - expandedCornerThreshold) return true;
        return false;
      });

    // Calculate corner intersection points - with validation to prevent infinite extensions
    // BUT: Skip if this wall has a window at that corner (window takes priority)
    const safeCornerIntersection = (wallEdgeStart, wallEdgeEnd, perpEdgeStart, perpEdgeEnd, fallback) => {
      const intersection = findLineIntersection(wallEdgeStart, wallEdgeEnd, perpEdgeStart, perpEdgeEnd);
      if (!intersection) return fallback;
      
      // Validate intersection is within reasonable bounds (not infinitely far)
      const wallLen = Math.hypot(wallEdgeEnd.x - wallEdgeStart.x, wallEdgeEnd.y - wallEdgeStart.y);
      const distFromStart = Math.hypot(intersection.x - wallEdgeStart.x, intersection.y - wallEdgeStart.y);
      const distFromEnd = Math.hypot(intersection.x - wallEdgeEnd.x, intersection.y - wallEdgeEnd.y);
      
      // If intersection is more than 2x wall length away from either end, it's invalid
      if (distFromStart > wallLen * 2 && distFromEnd > wallLen * 2) return fallback;
      
      return intersection;
    };

    const cornerStartOuter = !hasWindowAtThisWallStart && !perpWallStartHasWindow && perpWallAtStart
      ? safeCornerIntersection(wall.outerStart, wall.outerEnd, perpWallAtStart.outerStart, perpWallAtStart.outerEnd, outerStart)
      : null;
    const cornerStartInner = !hasWindowAtThisWallStart && !perpWallStartHasWindow && perpWallAtStart
      ? safeCornerIntersection(wall.innerStart, wall.innerEnd, perpWallAtStart.innerStart, perpWallAtStart.innerEnd, innerStart)
      : null;
    const cornerEndOuter = !hasWindowAtThisWallEnd && !perpWallEndHasWindow && perpWallAtEnd
      ? safeCornerIntersection(wall.outerStart, wall.outerEnd, perpWallAtEnd.outerStart, perpWallAtEnd.outerEnd, outerEnd)
      : null;
    const cornerEndInner = !hasWindowAtThisWallEnd && !perpWallEndHasWindow && perpWallAtEnd
      ? safeCornerIntersection(wall.innerStart, wall.innerEnd, perpWallAtEnd.innerStart, perpWallAtEnd.innerEnd, innerEnd)
      : null;

    // Corner window handling: trim THIS wall to the window edge on the perpendicular wall
    const findCornerWindowAtJunction = (junctionPoint) => {
      if (!junctionPoint) return null;
      const junctionKey = makePointKey(junctionPoint);
      const ANGLE_TOLERANCE = 10 * Math.PI / 180;

      for (const win of (windows || [])) {
        if (!win) continue;
        const matches = findWallsForOpening(win, processedWalls) || [];
        for (const match of matches) {
          if (!match.wall || match.wall.id === wall.id) continue;
          const diff = angleDiff(wall.angle, match.wall.angle);
          if (Math.abs(diff - Math.PI / 2) > ANGLE_TOLERANCE) continue;

          const startKey = makePointKey(match.wall.start);
          const endKey = makePointKey(match.wall.end);

          if (match.startT <= OPENING_T_EPS && startKey === junctionKey) {
            return { match, wall: match.wall, atStart: true };
          }
          if (match.endT >= 1 - OPENING_T_EPS && endKey === junctionKey) {
            return { match, wall: match.wall, atStart: false };
          }
        }
      }

      return null;
    };

    const getCornerWindowTrimPoints = (cornerWindow, fallbackOuter, fallbackInner) => {
      if (!cornerWindow) return null;
      const boundaryT = cornerWindow.atStart ? cornerWindow.match.endT : cornerWindow.match.startT;
      const boundaryCaps = getPerpEdgeIntersections(cornerWindow.wall, boundaryT);
      if (!boundaryCaps) return null;

      return {
        outer: safeCornerIntersection(wall.outerStart, wall.outerEnd, boundaryCaps.outer, boundaryCaps.inner, fallbackOuter),
        inner: safeCornerIntersection(wall.innerStart, wall.innerEnd, boundaryCaps.outer, boundaryCaps.inner, fallbackInner)
      };
    };

    // NOTE: corner-window trim is handled via perpWallStartHasWindow / perpWallEndHasWindow above.

    if (alignedOpenings.length > 0) {
      const nonCornerOpenings = alignedOpenings.filter(op => !isCornerWindowOpening(op));
      const segments = getWallSegments(nonCornerOpenings);
      segments.forEach((seg, index) => {
        const cornerThreshold = 0.1;
        const hasOpeningAtStart = alignedOpenings.some(op => op.startT <= cornerThreshold);
        const hasOpeningAtEnd = alignedOpenings.some(op => op.endT >= 1 - cornerThreshold);
        const hasWindowAtStart = alignedOpenings.some(op => op.type === 'window' && op.startT <= cornerThreshold);
        const hasWindowAtEnd = alignedOpenings.some(op => op.type === 'window' && op.endT >= 1 - cornerThreshold);

        // When a segment starts/ends at a wall junction, use the wall's actual corner points
        // This ensures clean alignment with corner windows
        let outerSegStart = seg.startT === 0 ? outerStart : interpolateWallPoint(wall, seg.startT, 'outer', seg.startT > 0);
        let outerSegEnd = seg.endT === 1 ? outerEnd : interpolateWallPoint(wall, seg.endT, 'outer', seg.endT < 1);
        let innerSegStart = seg.startT === 0 ? innerStart : interpolateWallPoint(wall, seg.startT, 'inner');
        let innerSegEnd = seg.endT === 1 ? innerEnd : interpolateWallPoint(wall, seg.endT, 'inner');

        const startCap = getOpeningCapPoints(wall, seg.startT, nonCornerOpenings);
        const endCap = getOpeningCapPoints(wall, seg.endT, nonCornerOpenings);

        // CRITICAL: At corner windows, ALWAYS use the window's perpendicular edges (caps)
        // This ensures walls stop exactly at the window's inner edge
        if (startCap) {
          outerSegStart = startCap.outer;
          innerSegStart = startCap.inner;
        }
        if (endCap) {
          outerSegEnd = endCap.outer;
          innerSegEnd = endCap.inner;
        }

        let drawStartCap = seg.startT === 0 ? !hasStartConn : true;
        let drawEndCap = seg.endT === 1 ? !hasEndConn : true;
        
        // NEVER draw caps at corner windows - window will fill this area
        if (hasWindowAtStart && seg.startT <= cornerThreshold) drawStartCap = false;
        if (hasWindowAtEnd && seg.endT >= 1 - cornerThreshold) drawEndCap = false;
        
        const startJunction = seg.startT === 0 ? wall.start : null;
        const endJunction = seg.endT === 1 ? wall.end : null;

        // If doors at junctions, extend wall segments to corner junction for rectangular fill
        // BUT: Don't extend if there's a window at the corner - window takes priority
        if (startJunction && doorsAtEnds.start && !hasWindowAtStart) {
          drawStartCap = false;
          const squareStart = getWallEndSquareCaps(wall, 'start');
          outerSegStart = squareStart?.outer || cornerStartOuter || outerStart;
          innerSegStart = squareStart?.inner || cornerStartInner || innerStart;
        }
        if (endJunction && doorsAtEnds.end && !hasWindowAtEnd) {
          drawEndCap = false;
          const squareEnd = getWallEndSquareCaps(wall, 'end');
          outerSegEnd = squareEnd?.outer || cornerEndOuter || outerEnd;
          innerSegEnd = squareEnd?.inner || cornerEndInner || innerEnd;
        }

        // If a perpendicular wall has a corner window, trim THIS wall to the window edge
        // BUT: NEVER trim if THIS wall has a window at the corner - window is absolute priority
        // (startWindowTrim removed — corner trim is deferred to perpWallStartHasWindow logic)
        // (endWindowTrim removed — corner trim is deferred to perpWallEndHasWindow logic)

        drawWallSegment(
          ctx,
          outerSegStart,
          outerSegEnd,
          innerSegStart,
          innerSegEnd,
          drawStartCap,
          drawEndCap,
          startCap,
          endCap
        );
      });
    } else {
      // Wall with no openings - CRITICAL: Check if adjacent walls have corner windows
      // If so, this wall should be COMPLETELY BLOCKED from drawing at the corner

      let oS = cornerStartOuter || outerStart;
      let oE = cornerEndOuter || outerEnd;
      let iS = cornerStartInner || innerStart;
      let iE = cornerEndInner || innerEnd;
      let drawStartCap = !hasStartConn;
      let drawEndCap = !hasEndConn;

      // Keep wall corners fully extended; do not trim to perpendicular corner window bounds.
      
      // If there are perpendicular doors at junctions, don't draw caps
      if (doorsAtEnds.start) {
        drawStartCap = false;
        const squareStart = getWallEndSquareCaps(wall, 'start');
        oS = squareStart?.outer || oS;
        iS = squareStart?.inner || iS;
      }
      if (doorsAtEnds.end) {
        drawEndCap = false;
        const squareEnd = getWallEndSquareCaps(wall, 'end');
        oE = squareEnd?.outer || oE;
        iE = squareEnd?.inner || iE;
      }
      
      drawWallSegment(ctx, oS, oE, iS, iE, drawStartCap, drawEndCap);
    }
  };

  const drawWallSegment = (
    ctx,
    outerStart,
    outerEnd,
    innerStart,
    innerEnd,
    drawStartCap = false,
    drawEndCap = false,
    startCap = null,
    endCap = null
  ) => {
    // Fill
    ctx.fillStyle = '#e5e7eb';
    ctx.beginPath();
    ctx.moveTo(outerStart.x, outerStart.y);
    ctx.lineTo(outerEnd.x, outerEnd.y);
    ctx.lineTo(innerEnd.x, innerEnd.y);
    ctx.lineTo(innerStart.x, innerStart.y);
    ctx.closePath();
    ctx.fill();

    // Outline
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5 / viewport.k;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 4;

    // Outer edge
    ctx.beginPath();
    ctx.moveTo(outerStart.x, outerStart.y);
    ctx.lineTo(outerEnd.x, outerEnd.y);
    ctx.stroke();

    // Inner edge
    ctx.beginPath();
    ctx.moveTo(innerStart.x, innerStart.y);
    ctx.lineTo(innerEnd.x, innerEnd.y);
    ctx.stroke();

    // Caps
    if (drawStartCap) {
      const capOuter = startCap?.outer || outerStart;
      const capInner = startCap?.inner || innerStart;
      ctx.beginPath();
      ctx.moveTo(capOuter.x, capOuter.y);
      ctx.lineTo(capInner.x, capInner.y);
      ctx.stroke();
    }
    if (drawEndCap) {
      const capOuter = endCap?.outer || outerEnd;
      const capInner = endCap?.inner || innerEnd;
      ctx.beginPath();
      ctx.moveTo(capOuter.x, capOuter.y);
      ctx.lineTo(capInner.x, capInner.y);
      ctx.stroke();
    }
  };

  const angleDiff = (a, b) => {
    const diff = Math.abs(a - b) % (Math.PI * 2);
    return diff > Math.PI ? (Math.PI * 2 - diff) : diff;
  };

  const adjustWallJunctions = (wall, junctionMap) => {
    if (!wall) return wall;
    const ANGLE_TOLERANCE = 10 * Math.PI / 180;
    const updated = { ...wall };

    ['start', 'end'].forEach(endType => {
      const key = makePointKey(wall[endType]);
      const entries = junctionMap.get(key) || [];
      const others = entries.filter(entry => entry.wall.id !== wall.id);
      if (others.length === 0) return;

      // Classify neighbors: collinear (same direction) vs angled (perpendicular/other)
      const collinearNeighbors = [];
      const angledNeighbors = [];

      others.forEach(entry => {
        const diff = angleDiff(wall.angle, entry.wall.angle);
        if (diff < ANGLE_TOLERANCE || diff > Math.PI - ANGLE_TOLERANCE) {
          collinearNeighbors.push(entry);
        } else {
          angledNeighbors.push(entry);
        }
      });

      // ── Case 1: Only collinear neighbors (wall continuation) → no adjustment
      if (collinearNeighbors.length > 0 && angledNeighbors.length === 0) {
        return;
      }

      // ── Case 2: Through-wall at a T-junction OR cross-junction (+)
      //    This wall has collinear *and* angled neighbors → it's part of the through-wall
      if (collinearNeighbors.length > 0 && angledNeighbors.length > 0) {
        const termWall = angledNeighbors[0].wall;
        const junctionPt = wall[endType];

        // Detect cross (+) by checking if the angled neighbors are collinear with each other
        let isCross = false;
        if (angledNeighbors.length >= 2) {
          for (let i = 0; i < angledNeighbors.length && !isCross; i++) {
            for (let j = i + 1; j < angledNeighbors.length && !isCross; j++) {
              const diff = angleDiff(angledNeighbors[i].wall.angle, angledNeighbors[j].wall.angle);
              if (diff < ANGLE_TOLERANCE || diff > Math.PI - ANGLE_TOLERANCE) {
                isCross = true;
              }
            }
          }
        }

        // Which terminating wall edge is on the SAME SIDE as this through-wall segment?
        const awayDir = endType === 'end'
          ? { x: wall.start.x - wall.end.x, y: wall.start.y - wall.end.y }
          : { x: wall.end.x - wall.start.x, y: wall.end.y - wall.start.y };

        const tOuterMid = {
          x: (termWall.outerStart.x + termWall.outerEnd.x) / 2,
          y: (termWall.outerStart.y + termWall.outerEnd.y) / 2
        };
        const tInnerMid = {
          x: (termWall.innerStart.x + termWall.innerEnd.x) / 2,
          y: (termWall.innerStart.y + termWall.innerEnd.y) / 2
        };

        const dotO = (tOuterMid.x - junctionPt.x) * awayDir.x + (tOuterMid.y - junctionPt.y) * awayDir.y;
        const dotI = (tInnerMid.x - junctionPt.x) * awayDir.x + (tInnerMid.y - junctionPt.y) * awayDir.y;

        const sameSideEdge = dotO > dotI
          ? { start: termWall.outerStart, end: termWall.outerEnd }
          : { start: termWall.innerStart, end: termWall.innerEnd };

        if (isCross) {
          // Cross junction: trim BOTH edges against the perpendicular wall edge
          const outerInt = findLineIntersection(
            wall.outerStart, wall.outerEnd, sameSideEdge.start, sameSideEdge.end
          );
          const innerInt = findLineIntersection(
            wall.innerStart, wall.innerEnd, sameSideEdge.start, sameSideEdge.end
          );

          if (outerInt) updated[endType === 'start' ? 'outerStart' : 'outerEnd'] = outerInt;
          if (innerInt) updated[endType === 'start' ? 'innerStart' : 'innerEnd'] = innerInt;
          return;
        }

        // T-junction: only pull the NEAR edge back to create the gap for the terminating wall
        const termBodyPt = angledNeighbors[0].end === 'start' ? termWall.end : termWall.start;
        const termDir = { x: termBodyPt.x - junctionPt.x, y: termBodyPt.y - junctionPt.y };
        const myPerpAngle = wall.angle - Math.PI / 2;
        const myNormal = { x: Math.cos(myPerpAngle), y: Math.sin(myPerpAngle) };
        const termDot = termDir.x * myNormal.x + termDir.y * myNormal.y;
        const nearIsOuter = termDot < 0;

        const myNear = nearIsOuter
          ? { start: wall.outerStart, end: wall.outerEnd }
          : { start: wall.innerStart, end: wall.innerEnd };

        const intersect = findLineIntersection(myNear.start, myNear.end, sameSideEdge.start, sameSideEdge.end);

        if (intersect) {
          const prop = nearIsOuter
            ? (endType === 'start' ? 'outerStart' : 'outerEnd')
            : (endType === 'start' ? 'innerStart' : 'innerEnd');
          updated[prop] = intersect;
        }
        return;
      }

      // ── Case 3: No collinear neighbors → L-junction OR terminating wall at T-junction
      if (angledNeighbors.length === 0) return;

      // Check whether the angled neighbors are collinear *with each other*
      // (two split halves of the through-wall → this wall is the terminating wall at a T)
      let isTJunction = false;
      if (angledNeighbors.length >= 2) {
        for (let i = 0; i < angledNeighbors.length && !isTJunction; i++) {
          for (let j = i + 1; j < angledNeighbors.length && !isTJunction; j++) {
            const diff = angleDiff(angledNeighbors[i].wall.angle, angledNeighbors[j].wall.angle);
            if (diff < ANGLE_TOLERANCE || diff > Math.PI - ANGLE_TOLERANCE) {
              isTJunction = true;
            }
          }
        }
      }

      if (isTJunction) {
        // ── T-junction terminating wall
        // Both our edges must meet the through-wall's NEAR edge (the one facing us)
        const throughWall = angledNeighbors[0].wall;
        const junctionPt = wall[endType];
        const nonJunctionPt = endType === 'start' ? wall.end : wall.start;

        // Choose through-wall "near" edge based on terminating direction vs through-wall normal
        const termDir = { x: nonJunctionPt.x - junctionPt.x, y: nonJunctionPt.y - junctionPt.y };
        const twPerpAngle = throughWall.angle - Math.PI / 2;
        const twNormal = { x: Math.cos(twPerpAngle), y: Math.sin(twPerpAngle) };
        const termDot = termDir.x * twNormal.x + termDir.y * twNormal.y;

        const nearEdge = termDot > 0
          ? { start: throughWall.innerStart, end: throughWall.innerEnd }
          : { start: throughWall.outerStart, end: throughWall.outerEnd };

        // Intersect BOTH our edges with the near through-wall edge
        const outerInt = findLineIntersection(
          wall.outerStart, wall.outerEnd, nearEdge.start, nearEdge.end
        );
        const innerInt = findLineIntersection(
          wall.innerStart, wall.innerEnd, nearEdge.start, nearEdge.end
        );

        if (outerInt) updated[endType === 'start' ? 'outerStart' : 'outerEnd'] = outerInt;
        if (innerInt) updated[endType === 'start' ? 'innerStart' : 'innerEnd'] = innerInt;

      } else {
        // ── Regular L-junction (corner)
        const hasCornerDoorAtJunction = entries.some(entry =>
          isDoorAtJunctionPoint(entry.wall[entry.end], entry.wall)
        );
        const hasCornerWindowAtJunction = entries.some(entry =>
          isWindowAtJunctionPoint(entry.wall[entry.end], entry.wall)
        );

        console.log('L-junction check for wall', wall.id, endType, '- hasCornerDoor:', hasCornerDoorAtJunction, 'hasCornerWindow:', hasCornerWindowAtJunction);

        // Extend wall for corners with doors OR windows
        if (hasCornerDoorAtJunction || hasCornerWindowAtJunction) {
          console.log('✅ Applying wall extension for corner opening at wall', wall.id, endType);
          // Use the perpendicular wall to extend this wall to the corner
          if (angledNeighbors.length > 0) {
            const perpWall = angledNeighbors[0].wall;
            const intersect = getWallEndIntersectionWithPerpWall(wall, endType, perpWall);
            if (intersect) {
              updated[endType === 'start' ? 'outerStart' : 'outerEnd'] = intersect.outer;
              updated[endType === 'start' ? 'innerStart' : 'innerEnd'] = intersect.inner;
              console.log('Applied wall extension:', intersect);
            } else {
              console.log('❌ Failed to get intersection');
            }
          } else {
            console.log('⚠️ No angled neighbors found, using square caps fallback');
            const caps = getWallEndSquareCaps(wall, endType);
            if (caps) {
              updated[endType === 'start' ? 'outerStart' : 'outerEnd'] = caps.outer;
              updated[endType === 'start' ? 'innerStart' : 'innerEnd'] = caps.inner;
            }
          }
          return;
        }

        const neighbor = angledNeighbors[0].wall;
        const outerIntersect = findLineIntersection(
          wall.outerStart, wall.outerEnd,
          neighbor.outerStart, neighbor.outerEnd
        );
        const innerIntersect = findLineIntersection(
          wall.innerStart, wall.innerEnd,
          neighbor.innerStart, neighbor.innerEnd
        );

        if (outerIntersect) updated[endType === 'start' ? 'outerStart' : 'outerEnd'] = outerIntersect;
        if (innerIntersect) updated[endType === 'start' ? 'innerStart' : 'innerEnd'] = innerIntersect;
      }
    });

    return updated;
  };

  const drawTJunctionPatches = (ctx, junctions, knownWalls) => {
    const ANGLE_TOLERANCE = 10 * Math.PI / 180;

    junctions.forEach((entries) => {
      if (entries.length < 3) return;

      // Check if any wall at this junction has a corner window - if so, skip junction patch
      const junctionPoint = entries[0].wall[entries[0].end];
      const hasCornerWindow = entries.some(entry => {
        const wall = entry.wall;
        const isStart = entry.end === 'start';
        const tValueEps = 0.1;
        
        // Check if there's a window at this corner
        return (windows || []).some(w => {
          const matches = findWallsForOpening(w, knownWalls) || [];
          if (matches.length === 0) return false;
          const match = matches[0];
          if (match.wall.id !== wall.id) return false;
          const frame = calculateWindowFrame(w, match.wall, match);
          if (!frame) return false;
          if (isStart) return frame.startT <= tValueEps;
          else return frame.endT >= 1 - tValueEps;
        });
      });
      
      if (hasCornerWindow) return; // Skip junction patch where window exists

      let pair = null;
      for (let i = 0; i < entries.length && !pair; i++) {
        for (let j = i + 1; j < entries.length && !pair; j++) {
          const diff = angleDiff(entries[i].wall.angle, entries[j].wall.angle);
          if (diff < ANGLE_TOLERANCE || diff > Math.PI - ANGLE_TOLERANCE) {
            pair = [entries[i], entries[j]];
          }
        }
      }

      if (!pair) return;

      const hasPerp = entries.some(entry => {
        if (entry === pair[0] || entry === pair[1]) return false;
        const diff = angleDiff(entry.wall.angle, pair[0].wall.angle);
        return !(diff < ANGLE_TOLERANCE || diff > Math.PI - ANGLE_TOLERANCE);
      });

      if (!hasPerp) return;

      const patchPoints = pair.map(entry => {
        const { wall, end } = entry;
        const junctionPt = wall[end];
        const outerPt = end === 'start' ? wall.outerStart : wall.outerEnd;
        const innerPt = end === 'start' ? wall.innerStart : wall.innerEnd;

        const dOuter = Math.hypot(outerPt.x - junctionPt.x, outerPt.y - junctionPt.y);
        const dInner = Math.hypot(innerPt.x - junctionPt.x, innerPt.y - junctionPt.y);

        if (Math.abs(dOuter - dInner) < 0.01) return null;

        const nearPt = dOuter > dInner ? outerPt : innerPt;
        const farPt = dOuter > dInner ? innerPt : outerPt;
        return { junctionPt, nearPt, farPt };
      }).filter(Boolean);

      if (patchPoints.length !== 2) return;

      const junctionPt = patchPoints[0].farPt;

      ctx.fillStyle = '#e5e7eb';
      ctx.beginPath();
      ctx.moveTo(patchPoints[0].nearPt.x, patchPoints[0].nearPt.y);
      ctx.lineTo(junctionPt.x, junctionPt.y);
      ctx.lineTo(patchPoints[1].nearPt.x, patchPoints[1].nearPt.y);
      ctx.closePath();
      ctx.fill();
    });
  };

  const drawDoorCornerRectPatches = (ctx, junctions) => {
    const ANGLE_TOLERANCE = 10 * Math.PI / 180;

    junctions.forEach((entries) => {
      if (!entries || entries.length !== 2) return;

      const e1 = entries[0];
      const e2 = entries[1];
      if (!e1?.wall || !e2?.wall) return;

      const diff = angleDiff(e1.wall.angle, e2.wall.angle);
      const collinear = diff < ANGLE_TOLERANCE || diff > Math.PI - ANGLE_TOLERANCE;
      if (collinear) return;

      const junction1 = e1.wall[e1.end];
      const junction2 = e2.wall[e2.end];
      if (!junction1 || !junction2) return;

      const hasDoorAtJunction =
        isDoorAtJunctionPoint(junction1, e1.wall) ||
        isDoorAtJunctionPoint(junction2, e2.wall);
      if (!hasDoorAtJunction) return;

      const p1Outer = e1.end === 'start' ? e1.wall.outerStart : e1.wall.outerEnd;
      const p1Inner = e1.end === 'start' ? e1.wall.innerStart : e1.wall.innerEnd;
      const p2Outer = e2.end === 'start' ? e2.wall.outerStart : e2.wall.outerEnd;
      const p2Inner = e2.end === 'start' ? e2.wall.innerStart : e2.wall.innerEnd;

      // Smart fill: walls are already extended, so just use their endpoints directly
      // This creates a simple 4-point rectangular patch without recomputing corners
      ctx.fillStyle = '#e5e7eb';
      ctx.beginPath();
      ctx.moveTo(p1Outer.x, p1Outer.y);
      ctx.lineTo(p2Outer.x, p2Outer.y);
      ctx.lineTo(p2Inner.x, p2Inner.y);
      ctx.lineTo(p1Inner.x, p1Inner.y);
      ctx.closePath();
      ctx.fill();
      // No stroke: wall outlines already cover all edges.
      // Stroking the quad produces a spurious diagonal when p1Inner ≠ p2Inner.
    });
  };

  const drawCrossJunctionPatches = (ctx, junctions, knownWalls) => {
    const ANGLE_TOLERANCE = 10 * Math.PI / 180;
    const PERP_TOLERANCE = 15 * Math.PI / 180;

    junctions.forEach((entries) => {
      if (entries.length < 4) return;

      const junctionPt = entries[0].wall[entries[0].end];
      if (!junctionPt) return;
      
      // Check if any wall at this junction has a corner window - if so, skip junction patch
      const hasCornerWindow = entries.some(entry => {
        const wall = entry.wall;
        const isStart = entry.end === 'start';
        const tValueEps = 0.1;
        
        return (windows || []).some(w => {
          const matches = findWallsForOpening(w, knownWalls) || [];
          if (matches.length === 0) return false;
          const match = matches[0];
          if (match.wall.id !== wall.id) return false;
          const frame = calculateWindowFrame(w, match.wall, match);
          if (!frame) return false;
          if (isStart) return frame.startT <= tValueEps;
          else return frame.endT >= 1 - tValueEps;
        });
      });
      
      if (hasCornerWindow) return; // Skip junction patch where window exists

      const uniqueAngles = [];
      entries.forEach(entry => {
        const angle = ((entry.wall.angle % Math.PI) + Math.PI) % Math.PI;
        const exists = uniqueAngles.some(a => angleDiff(a, angle) < ANGLE_TOLERANCE || angleDiff(a, angle) > Math.PI - ANGLE_TOLERANCE);
        if (!exists) uniqueAngles.push(angle);
      });

      if (uniqueAngles.length !== 2) return;
      const perpDiff = angleDiff(uniqueAngles[0], uniqueAngles[1]);
      if (Math.abs(perpDiff - Math.PI / 2) > PERP_TOLERANCE) return;

      const thickness = entries[0].wall.thickness || WALL_THICKNESS;
      const half = thickness / 2;

      const u = { x: Math.cos(uniqueAngles[0]), y: Math.sin(uniqueAngles[0]) };
      const v = { x: Math.cos(uniqueAngles[1]), y: Math.sin(uniqueAngles[1]) };

      const p1 = { x: junctionPt.x + u.x * half + v.x * half, y: junctionPt.y + u.y * half + v.y * half };
      const p2 = { x: junctionPt.x - u.x * half + v.x * half, y: junctionPt.y - u.y * half + v.y * half };
      const p3 = { x: junctionPt.x - u.x * half - v.x * half, y: junctionPt.y - u.y * half - v.y * half };
      const p4 = { x: junctionPt.x + u.x * half - v.x * half, y: junctionPt.y + u.y * half - v.y * half };

      ctx.fillStyle = '#e5e7eb';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.lineTo(p4.x, p4.y);
      ctx.closePath();
      ctx.fill();
    });
  };


  const drawWallThicknessLabel = (ctx, wall) => {
    if (!wall || !wall.centerStart || !wall.centerEnd) return;
    const { centerStart, centerEnd, angle, length } = wall;
    if (length < 60) return;

    const midX = (centerStart.x + centerEnd.x) / 2;
    const midY = (centerStart.y + centerEnd.y) / 2;
    // const perpAngle = angle - Math.PI / 2;
    // const labelX = midX + Math.cos(perpAngle) * 0;
    // const labelY = midY + Math.sin(perpAngle) * 0;

    ctx.save();
    ctx.translate(midX, midY); // translate to center
    let textAngle = angle;
    if (textAngle > Math.PI / 2 || textAngle < -Math.PI / 2) textAngle += Math.PI;
    ctx.rotate(textAngle);

    ctx.font = `${8 / viewport.k}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#6b7280';
    ctx.fillText(`${WALL_THICKNESS}px`, 0, 0);
    ctx.restore();
  };

  const getSquareWallPoint = (wall, t, edge) => {
    if (!wall) return { x: 0, y: 0 };
    const center = interpolateWallPoint(wall, t, 'center');
    const half = (wall.thickness || WALL_THICKNESS) / 2;
    const normalAngle = wall.angle - Math.PI / 2;
    const dir = edge === 'outer' ? 1 : -1;
    return {
      x: center.x + Math.cos(normalAngle) * half * dir,
      y: center.y + Math.sin(normalAngle) * half * dir
    };
  };

  const getCornerWindowMatch = (currentWall, junctionPoint, currentWindowId, processedWalls) => {
    if (!junctionPoint) return null;
    const junctionKey = makePointKey(junctionPoint);
    const ANGLE_TOLERANCE = 10 * Math.PI / 180;

    for (const other of (windows || [])) {
      if (!other || other.id === currentWindowId) continue;
      const matches = findWallsForOpening(other, processedWalls) || [];
      for (const match of matches) {
        if (!match.wall) continue;
        const diff = angleDiff(currentWall.angle, match.wall.angle);
        const isPerp = Math.abs(diff - Math.PI / 2) < ANGLE_TOLERANCE;
        if (!isPerp) continue;

        const startKey = makePointKey(match.wall.start);
        const endKey = makePointKey(match.wall.end);

        const isAtStart = match.startT <= OPENING_T_EPS && startKey === junctionKey;
        const isAtEnd = match.endT >= 1 - OPENING_T_EPS && endKey === junctionKey;
        if (isAtStart || isAtEnd) return match.wall;
      }
    }

    return null;
  };

  const findPerpWallAtJunction = (currentWall, junctionPoint, processedWalls) => {
    if (!currentWall || !junctionPoint || !processedWalls) return null;
    const junctionKey = makePointKey(junctionPoint);
    const ANGLE_TOLERANCE = 10 * Math.PI / 180;

    for (const wall of processedWalls) {
      if (!wall || wall.id === currentWall.id) continue;
      const startKey = makePointKey(wall.start);
      const endKey = makePointKey(wall.end);
      if (startKey !== junctionKey && endKey !== junctionKey) continue;

      const diff = angleDiff(currentWall.angle, wall.angle);
      if (Math.abs(diff - Math.PI / 2) < ANGLE_TOLERANCE) return wall;
    }

    return null;
  };

  const adjustDoorFrameAtCorner = (wall, cornerWall, hingePoint, frameEnd, orientation) => {
    if (!wall || !cornerWall || !hingePoint || !frameEnd) return { hingePoint, frameEnd };
    
    // Calculate the shift needed so door swing doesn't overlap perpendicular wall
    const wallThickness = wall.thickness || WALL_THICKNESS;
    const wallNormalAngle = wall.angle - Math.PI / 2;
    
    // Get door direction vector
    const doorVector = { x: frameEnd.x - hingePoint.x, y: frameEnd.y - hingePoint.y };
    const doorLen = Math.hypot(doorVector.x, doorVector.y);
    if (doorLen === 0) return { hingePoint, frameEnd };
    
    // Normalized door direction
    const doorDirX = doorVector.x / doorLen;
    const doorDirY = doorVector.y / doorLen;
    
    // Normal perpendicular to door frame (pointing inward for cavity side)
    // This vector is perpendicular to the door frame itself
    const normalX = -doorDirY;
    const normalY = doorDirX;
    
    // For inward-swinging doors (orientation === 1), shift the frame inward
    // The shift amount should move the door toward the perpendicular wall's inner edge
    const shift = orientation === 1 ? wallThickness / 2 : 0;
    
    return {
      hingePoint: {
        x: hingePoint.x + normalX * shift,
        y: hingePoint.y + normalY * shift
      },
      frameEnd: {
        x: frameEnd.x + normalX * shift,
        y: frameEnd.y + normalY * shift
      }
    };
  };

  const intersectRaySegment = (origin, dir, a, b) => {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const denom = dir.x * vy - dir.y * vx;
    if (Math.abs(denom) < 1e-6) return null;

    const dx = a.x - origin.x;
    const dy = a.y - origin.y;
    const t = (dx * vy - dy * vx) / denom;
    const u = (dx * dir.y - dy * dir.x) / denom;

    if (t <= 0 || u < 0 || u > 1) return null;
    return { x: origin.x + t * dir.x, y: origin.y + t * dir.y, t };
  };

  const getWindowCornerOuterEdgeExtension = (wall, isAtStart, frame, processedWalls) => {
    if (!wall || !frame) return null;
    const junctionPoint = isAtStart ? wall.start : wall.end;
    const perpWall = findPerpWallAtJunction(wall, junctionPoint, processedWalls);
    if (!perpWall) return null;

    // For windows at corners, create PERPENDICULAR cuts to the wall direction
    // The cuts should meet at the INNER WALL EDGE, not in the middle of the wall
    
    // Get the wall's direction (normalized)
    const wallDir = {
      x: wall.end.x - wall.start.x,
      y: wall.end.y - wall.start.y
    };
    const wallLen = Math.hypot(wallDir.x, wallDir.y);
    if (wallLen === 0) return null;
    
    const wallNorm = { 
      x: wallDir.x / wallLen, 
      y: wallDir.y / wallLen 
    };
    
    // Get perpendicular direction (perpendicular to the wall, rotated 90 degrees)
    const perpDir = { 
      x: -wallNorm.y, 
      y: wallNorm.x 
    };
    
    // The window corners should be cut perpendicular to the wall at the INNER EDGE
    // Start the cut line from the inner edge of the wall at the junction
    const innerJunctionPoint = isAtStart ? wall.innerStart : wall.innerEnd;
    const cutLineStart = innerJunctionPoint;
    const cutLineEnd = {
      x: innerJunctionPoint.x + perpDir.x * 100, // Extend far enough to intersect window
      y: innerJunctionPoint.y + perpDir.y * 100
    };
    
    // Find where the window outer frame intersects this perpendicular cut line
    const outerLineInt = findLineIntersection(
      frame.outerStart,
      frame.outerEnd,
      cutLineStart,
      cutLineEnd
    );
    
    // Find where the window inner frame intersects this perpendicular cut line
    const innerLineInt = findLineIntersection(
      frame.innerStart,
      frame.innerEnd,
      cutLineStart,
      cutLineEnd
    );

    if (!outerLineInt || !innerLineInt) return null;
    
    // Return perpendicular cut points
    return { outer: outerLineInt, inner: innerLineInt };
  };

  const drawWindow = (ctx, window, processedWalls, baseWalls) => {
    const wallMatches = findWallsForOpening(window, processedWalls) || [];
    if (wallMatches.length > 0) {
      // Use the best (closest) match only
      const match = wallMatches[0];
      const frame = calculateWindowFrame(window, match.wall, match);
      if (!frame) return;

      // T-values are already corner-clamped by geometryProcessor (MIN_WINDOW_CORNER_GAP).
      // No visual correction needed here — draw exactly what the geometry says.
      const { startT, endT } = frame;
      const midT = (startT + endT) / 2;
      const wall = match.wall;

      const startEdge = getPerpEdgeIntersections(wall, startT);
      const endEdge   = getPerpEdgeIntersections(wall, endT);

      drawIntegratedWindow(ctx, {
        ...frame,
        outerStart:  startEdge?.outer ?? frame.outerStart,
        innerStart:  startEdge?.inner ?? frame.innerStart,
        outerEnd:    endEdge?.outer   ?? frame.outerEnd,
        innerEnd:    endEdge?.inner   ?? frame.innerEnd,
        outerCenter: interpolateWallPoint(wall, midT, 'outer'),
        innerCenter: interpolateWallPoint(wall, midT, 'inner'),
      }, wall.thickness || WALL_THICKNESS,
        /* drawStartCap */ true,
        /* drawEndCap   */ true
      );

    } else {
      // No valid wall match — only draw standalone if genuinely free-floating.
      const nearbyWall = processedWalls.some(w => {
        const midWin  = { x: (window.start.x + window.end.x) / 2, y: (window.start.y + window.end.y) / 2 };
        const midWall = { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
        return Math.min(
          Math.hypot(window.start.x - w.start.x, window.start.y - w.start.y),
          Math.hypot(window.end.x   - w.end.x,   window.end.y   - w.end.y),
          Math.hypot(midWin.x - midWall.x, midWin.y - midWall.y)
        ) < 80;
      });
      if (!nearbyWall) drawStandaloneWindow(ctx, window);
      // If near a wall but no valid match: window is in a protected corner zone
      // and was correctly rejected by the geometry engine — do not draw.
    }
  };

  const drawIntegratedWindow = (ctx, frame, thickness, drawStartCap = true, drawEndCap = true) => {
    const { outerStart, outerEnd, innerStart, innerEnd, outerCenter, innerCenter, angle } = frame;

    // Clear only the actual window opening.
    // outerStart/outerEnd are already adjusted for corner windows (inset from corner)
    // so this fill never erases the solid outer corner block.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(outerStart.x, outerStart.y);
    ctx.lineTo(innerStart.x, innerStart.y);
    ctx.lineTo(innerEnd.x, innerEnd.y);
    ctx.lineTo(outerEnd.x, outerEnd.y);
    ctx.closePath();
    ctx.fill();

    // Frame
    ctx.strokeStyle = '#1e40af';
    ctx.lineWidth = 2.5 / viewport.k;
    ctx.lineCap = 'square';

    ctx.beginPath();
    ctx.moveTo(outerStart.x, outerStart.y);
    ctx.lineTo(outerEnd.x, outerEnd.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(innerStart.x, innerStart.y);
    ctx.lineTo(innerEnd.x, innerEnd.y);
    ctx.stroke();

    ctx.lineWidth = 2 / viewport.k;
    if (drawStartCap) {
      ctx.beginPath();
      ctx.moveTo(outerStart.x, outerStart.y);
      ctx.lineTo(innerStart.x, innerStart.y);
      ctx.stroke();
    }

    if (drawEndCap) {
      ctx.beginPath();
      ctx.moveTo(outerEnd.x, outerEnd.y);
      ctx.lineTo(innerEnd.x, innerEnd.y);
      ctx.stroke();
    }

    // Glass
    ctx.strokeStyle = '#1e40af';
    ctx.lineWidth = 1 / viewport.k;
    ctx.setLineDash([4 / viewport.k, 4 / viewport.k]);
    ctx.beginPath();
    ctx.moveTo(outerCenter.x, outerCenter.y);
    ctx.lineTo(innerCenter.x, innerCenter.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Panes
    const perpAngle = angle - Math.PI / 2;
    const pane1Offset = thickness / 3;
    const pane2Offset = (thickness * 2) / 3;

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 / viewport.k;

    // Draw parallel lines at offsets
    [pane1Offset, pane2Offset].forEach(offset => {
      // NOTE: This angle offset logic might need updating if geometry offsets change logic
      // But frame coordinates are absolute now?
      // Wait, pane offsets need to be relative to outer/inner?
      // Actually frame.outerStart etc are points.
      // We can generate points on the fly.

      const p1x = outerStart.x + (innerStart.x - outerStart.x) * (offset / thickness);
      const p1y = outerStart.y + (innerStart.y - outerStart.y) * (offset / thickness);
      const p2x = outerEnd.x + (innerEnd.x - outerEnd.x) * (offset / thickness);
      const p2y = outerEnd.y + (innerEnd.y - outerEnd.y) * (offset / thickness);

      ctx.beginPath();
      ctx.moveTo(p1x, p1y);
      ctx.lineTo(p2x, p2y);
      ctx.stroke();
    });
  };

  const drawStandaloneWindow = (ctx, window) => {
    const { start, end } = window;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length === 0) return;

    const angle = Math.atan2(dy, dx);
    const perpAngle = angle - Math.PI / 2;
    const offset = WALL_THICKNESS;

    ctx.strokeStyle = '#1e40af';
    ctx.lineWidth = 2.5 / viewport.k;

    // Box
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(start.x + Math.cos(perpAngle) * offset, start.y + Math.sin(perpAngle) * offset);
    ctx.lineTo(end.x + Math.cos(perpAngle) * offset, end.y + Math.sin(perpAngle) * offset);
    ctx.stroke();

    // Ends
    ctx.lineWidth = 2 / viewport.k;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(start.x + Math.cos(perpAngle) * offset, start.y + Math.sin(perpAngle) * offset);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x + Math.cos(perpAngle) * offset, end.y + Math.sin(perpAngle) * offset);
    ctx.stroke();
  };

  const drawDoor = (ctx, door, processedWalls) => {
    const geometry = calculateDoorGeometry(door);
    if (!geometry) return;

    let { hingePoint, frameEnd, doorWidth, arcStartAngle, arcEndAngle, swingEnd } = geometry;
    const orientation = door.orientation || 0;
    let cornerWall = null;
    let leafRadius = doorWidth;
    let cornerDoorOverride = null;

    let wallMatch = findWallForOpening(door, processedWalls);
    
    // Check if this door is at a corner - if so, try to match it to the perpendicular wall instead
    if (wallMatch && wallMatch.wall) {
      const wall = wallMatch.wall;
      
      // Check if door is spatially near a wall junction
      const doorMid = { x: (door.start.x + door.end.x) / 2, y: (door.start.y + door.end.y) / 2 };
      const distToStart = Math.hypot(doorMid.x - wall.start.x, doorMid.y - wall.start.y);
      const distToEnd = Math.hypot(doorMid.x - wall.end.x, doorMid.y - wall.end.y);
      const junctionThreshold = WALL_THICKNESS * 1.5; // Within 1.5x wall thickness
      const nearJunction = distToStart < junctionThreshold || distToEnd < junctionThreshold;
      
      if (nearJunction) {
        const hingeJunction = distToStart < distToEnd ? wall.start : wall.end;
        const perpWall = findPerpWallAtJunction(wall, hingeJunction, processedWalls);
        if (perpWall) {
          // Try matching door to perpendicular wall instead
          const perpMatch = findWallForOpening(door, [perpWall]);
          if (perpMatch && perpMatch.wall) {
            console.log('🔄 Corner door detected - switching from', wall.id, 'to perpendicular wall', perpWall.id);
            wallMatch = perpMatch;
          }
        }
      }
    }
    
    if (wallMatch && wallMatch.wall) {
      const wall = wallMatch.wall;
      const startProj = findNearestPointOnLine(door.start, wall.start, wall.end);
      const endProj = findNearestPointOnLine(door.end, wall.start, wall.end);

      // Use the clamped T-values from the geometry processor for all hinge/frame
      // positioning.  These are already anchored to the inner wall face, so using
      // them instead of the raw startProj.t / endProj.t is what fixes the issue
      // of doors starting at the outer wall corner rather than the inner wall edge.
      const hingeT = wallMatch.startT;
      const frameT = wallMatch.endT;

      // Threshold now matches the geometry processor's halfThicknessT so that doors
      // clamped to the inner wall face are correctly identified as corner doors.
      const wallLen = wall.length || calculateDistance(wall.start, wall.end);
      const DOOR_CORNER_T_EPS = (WALL_THICKNESS / 2) / wallLen + 0.02;
      const hingeAtStart = startProj.t <= DOOR_CORNER_T_EPS;
      const hingeAtEnd = startProj.t >= 1 - DOOR_CORNER_T_EPS;
      const hingeJunction = hingeAtStart ? wall.start : (hingeAtEnd ? wall.end : null);
      cornerWall = hingeJunction ? findPerpWallAtJunction(wall, hingeJunction, processedWalls) : null;
      
      console.log('🚪 Door', door.id, '- startProj.t:', startProj.t, 'endProj.t:', endProj.t);
      console.log('   hingeAtStart:', hingeAtStart, 'hingeAtEnd:', hingeAtEnd, 'cornerWall:', !!cornerWall);
      console.log('   wall.start:', JSON.stringify(wall.start), 'wall.end:', JSON.stringify(wall.end));
      console.log('   wall.outerStart:', JSON.stringify(wall.outerStart), 'wall.outerEnd:', JSON.stringify(wall.outerEnd));
      console.log('   wall.innerStart:', JSON.stringify(wall.innerStart), 'wall.innerEnd:', JSON.stringify(wall.innerEnd));

      // ── BUG FIX: Determine the TRUE room-interior face ─────────────────────
      // The geometry engine labels faces "inner"/"outer" by the wall draw direction
      // (inner = right-hand side of the draw vector). A wall drawn right→left or
      // bottom→top will have its "inner" face pointing outward. We resolve this by
      // computing the room centroid and picking whichever face is closer to it.
      const _roomCentroid = (() => {
        if (!processedWalls || processedWalls.length === 0) return { x: 0, y: 0 };
        let sx = 0, sy = 0, n = 0;
        processedWalls.forEach(w => { sx += w.start.x + w.end.x; sy += w.start.y + w.end.y; n += 2; });
        return { x: sx / n, y: sy / n };
      })();

      const _interiorFace = (w) => {
        if (!w || !w.innerStart || !w.outerStart) return 'inner';
        const iMx = (w.innerStart.x + w.innerEnd.x) / 2;
        const iMy = (w.innerStart.y + w.innerEnd.y) / 2;
        const oMx = (w.outerStart.x + w.outerEnd.x) / 2;
        const oMy = (w.outerStart.y + w.outerEnd.y) / 2;
        const dI = Math.hypot(iMx - _roomCentroid.x, iMy - _roomCentroid.y);
        const dO = Math.hypot(oMx - _roomCentroid.x, oMy - _roomCentroid.y);
        return dI < dO ? 'inner' : 'outer';
      };

      // 'inner' or 'outer' — whichever of this wall's faces points into the room
      const edge   = _interiorFace(wall);
      const _faceS = (w, e) => (e === 'inner' ? w.innerStart : w.outerStart);
      const _faceE = (w, e) => (e === 'inner' ? w.innerEnd   : w.outerEnd);
      const _capPt = (caps, e) => (e === 'inner' ? caps.inner  : caps.outer);

      const perpCapsStart = getPerpEdgeIntersections(wall, hingeT);
      const perpCapsEnd   = getPerpEdgeIntersections(wall, frameT);

      // For corner doors, position frame exactly on the interior face
      if (hingeJunction && cornerWall) {
        const cwEdge = _interiorFace(cornerWall);
        // Hinge = intersection of the two room-interior face lines
        const hingeIntersect = findLineIntersection(
          _faceS(wall, edge),         _faceE(wall, edge),
          _faceS(cornerWall, cwEdge), _faceE(cornerWall, cwEdge)
        );
        console.log('   hingeIntersect result:', JSON.stringify(hingeIntersect));
        
        if (hingeIntersect) {
          hingePoint = hingeIntersect;
          console.log('   ✅ Set hingePoint to:', JSON.stringify(hingePoint));
          
          // Calculate the original door width from the geometry
          const originalWidth = Math.hypot(door.end.x - door.start.x, door.end.y - door.start.y);
          console.log('   Original door width:', originalWidth);
          
          // Direction along this wall's room-interior face
          const iFaceStart = _faceS(wall, edge);
          const iFaceEnd   = _faceE(wall, edge);
          const innerDir = {
            x: iFaceEnd.x - iFaceStart.x,
            y: iFaceEnd.y - iFaceStart.y
          };
          const innerLen = Math.hypot(innerDir.x, innerDir.y);

          if (innerLen > 0) {
            const nx = innerDir.x / innerLen;
            const ny = innerDir.y / innerLen;
            
            // Determine which direction along the inner edge to extend
            // If hinge is at wall start, extend forward; if at wall end, extend backward
            const dir = hingeAtStart ? 1 : -1;
            console.log('   Direction multiplier:', dir, '(hingeAtStart:', hingeAtStart, ')');
            
            // Use the clamped frame T so that the frame end is measured from
            // the inner face, not the raw unclamped drawing position.
            const oppositeT = hingeAtStart ? frameT : hingeT;
            const oppositeCaps = getPerpEdgeIntersections(wall, oppositeT);
            const oppositeInnerPoint = oppositeCaps ? _capPt(oppositeCaps, edge) : interpolateWallPoint(wall, oppositeT, edge);
            const oppositeVec = {
              x: oppositeInnerPoint.x - hingePoint.x,
              y: oppositeInnerPoint.y - hingePoint.y
            };

            let constrainedWidth = Math.max(
              WALL_THICKNESS * 0.4,
              oppositeVec.x * nx * dir + oppositeVec.y * ny * dir
            );
            
            // Find which edge of perpendicular wall acts as the constraint
            const perpLineOuter = { start: cornerWall.outerStart, end: cornerWall.outerEnd };
            const perpLineInner = { start: cornerWall.innerStart, end: cornerWall.innerEnd };
            
            // Test where the door would extend to
            const doorTestEnd = {
              x: hingePoint.x + nx * constrainedWidth * dir,
              y: hingePoint.y + ny * constrainedWidth * dir
            };
            
            // Find intersections with perpendicular wall boundaries
            const perpOuterInt = findLineIntersection(
              hingePoint, doorTestEnd,
              perpLineOuter.start, perpLineOuter.end
            );
            const perpInnerInt = findLineIntersection(
              hingePoint, doorTestEnd,
              perpLineInner.start, perpLineInner.end
            );
            
            // Use the constraint point that's closest to the hinge (most restrictive)
            let constraintPoint = null;
            if (perpOuterInt) {
              const distToOuter = Math.hypot(
                perpOuterInt.x - hingePoint.x,
                perpOuterInt.y - hingePoint.y
              );
              constraintPoint = { point: perpOuterInt, dist: distToOuter, type: 'outer' };
            }
            if (perpInnerInt) {
              const distToInner = Math.hypot(
                perpInnerInt.x - hingePoint.x,
                perpInnerInt.y - hingePoint.y
              );
              if (!constraintPoint || distToInner < constraintPoint.dist) {
                constraintPoint = { point: perpInnerInt, dist: distToInner, type: 'inner' };
              }
            }
            
            const maxHostWidth = Math.max(
              WALL_THICKNESS * 0.4,
              Math.hypot(
                (hingeAtStart ? _faceE(wall, edge).x : _faceS(wall, edge).x) - hingePoint.x,
                (hingeAtStart ? _faceE(wall, edge).y : _faceS(wall, edge).y) - hingePoint.y
              ) - 1
            );

            // Apply constraint if door would overlap
            if (constraintPoint && constraintPoint.dist > 0 && constraintPoint.dist < constrainedWidth) {
              constrainedWidth = Math.max(WALL_THICKNESS * 0.4, constraintPoint.dist - 1);
              console.log('   Door width constrained to', constrainedWidth, 'to prevent overlap');
            }

            constrainedWidth = Math.min(constrainedWidth, maxHostWidth);
            constrainedWidth = Math.max(0, constrainedWidth - 0.5);

            // ── BUG FIX: outer-corner door collapse ──────────────────────────────
            // At a convex (outer-building) corner the two interior faces intersect
            // INSIDE the wall material, so constrainedWidth collapses to ~0.
            // Detect this and bail out of corner treatment; the door will render
            // using its raw geometry via the non-corner path below instead.
            if (constrainedWidth < WALL_THICKNESS * 1.5) {
              // Reset — non-corner path will handle rendering
              hingePoint = null;
              frameEnd = null;
            } else {
              frameEnd = {
                x: hingePoint.x + nx * constrainedWidth * dir,
                y: hingePoint.y + ny * constrainedWidth * dir
              };
            }
          }
        }
        
        // Perpendicular jamb endpoint along cornerWall's room-interior face
        const cwEdgeForJamb = _interiorFace(cornerWall);
        const perpInnerDir = {
          x: _faceE(cornerWall, cwEdgeForJamb).x - _faceS(cornerWall, cwEdgeForJamb).x,
          y: _faceE(cornerWall, cwEdgeForJamb).y - _faceS(cornerWall, cwEdgeForJamb).y
        };
        const perpLen = Math.hypot(perpInnerDir.x, perpInnerDir.y);
        if (perpLen > 0) {
          const pnx = perpInnerDir.x / perpLen;
          const pny = perpInnerDir.y / perpLen;
          // Determine direction: which end of cornerWall is at the junction?
          const distToStart = Math.hypot(
            hingeJunction.x - cornerWall.start.x,
            hingeJunction.y - cornerWall.start.y
          );
          const distToEnd = Math.hypot(
            hingeJunction.x - cornerWall.end.x,
            hingeJunction.y - cornerWall.end.y
          );
          const perpDir = distToStart < distToEnd ? 1 : -1;
          const perpJambLength = WALL_THICKNESS / 2;
          
          cornerDoorOverride = {
            hingePoint,
            perpJambEnd: {
              x: hingePoint.x + pnx * perpJambLength * perpDir,
              y: hingePoint.y + pny * perpJambLength * perpDir
            }
          };
        }
      } else {
        // Non-corner door: use standard positioning
        if (perpCapsStart) {
          hingePoint = _capPt(perpCapsStart, edge);
          console.log('   Using perpCapsStart:', perpCapsStart, 'chose:', edge, 'result:', hingePoint);
        } else {
          hingePoint = interpolateWallPoint(wall, startProj.t, edge);
          console.log('   Using interpolateWallPoint at t:', startProj.t, 'edge:', edge, 'result:', hingePoint);
        }

        if (perpCapsEnd) {
          frameEnd = _capPt(perpCapsEnd, edge);
          console.log('   Using perpCapsEnd:', perpCapsEnd, 'chose:', edge, 'result:', frameEnd);
        } else {
          frameEnd = interpolateWallPoint(wall, endProj.t, edge);
          console.log('   Using interpolateWallPoint at t:', endProj.t, 'edge:', edge, 'result:', frameEnd);
        }
      }
      
      // ── Fallback: corner treatment collapsed (outer-corner door) ─────────────
      // If the corner block bailed (hingePoint reset to null), use the standard
      // perpendicular-cap positioning so the door still renders correctly.
      if (!hingePoint) {
        hingePoint = perpCapsStart ? _capPt(perpCapsStart, edge)
                                   : interpolateWallPoint(wall, startProj.t, edge);
        frameEnd   = perpCapsEnd   ? _capPt(perpCapsEnd,   edge)
                                   : interpolateWallPoint(wall, endProj.t,   edge);
      }

            console.log('📍 FINAL DOOR POSITIONING:');
      console.log('   hingePoint:', JSON.stringify(hingePoint));
      console.log('   frameEnd:', JSON.stringify(frameEnd));
      console.log('   doorWidth:', Math.hypot(frameEnd.x - hingePoint.x, frameEnd.y - hingePoint.y));
      
      doorWidth = Math.hypot(frameEnd.x - hingePoint.x, frameEnd.y - hingePoint.y);

      // Door frame already positioned correctly above, no additional adjustment needed

      const baseAngle = Math.atan2(frameEnd.y - hingePoint.y, frameEnd.x - hingePoint.x);
      arcStartAngle = baseAngle;
      arcEndAngle = baseAngle - Math.PI / 2;
      swingEnd = {
        x: hingePoint.x + Math.cos(baseAngle - Math.PI / 2) * doorWidth,
        y: hingePoint.y + Math.sin(baseAngle - Math.PI / 2) * doorWidth
      };

      leafRadius = doorWidth;
    }

    // Door frame line
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 3 / viewport.k;
    ctx.lineCap = 'butt';
    console.log('🎨 DRAWING DOOR FRAME FROM', JSON.stringify(hingePoint), 'TO', JSON.stringify(frameEnd));
    ctx.beginPath();
    ctx.moveTo(hingePoint.x, hingePoint.y);
    ctx.lineTo(frameEnd.x, frameEnd.y);
    ctx.stroke();

    // Corner override: draw perpendicular jamb segment along the other wall's inner edge
    if (cornerDoorOverride) {
      const { hingePoint: hp, perpJambEnd } = cornerDoorOverride;
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = 3 / viewport.k;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(hp.x, hp.y);
      ctx.lineTo(perpJambEnd.x, perpJambEnd.y);
      ctx.stroke();
    }

    // Calculate swing
    let adjustedArcStart = arcStartAngle;
    let adjustedArcEnd = arcEndAngle;
    const angle = Math.atan2(frameEnd.y - hingePoint.y, frameEnd.x - hingePoint.x);

    let swingX = hingePoint.x + Math.cos(adjustedArcEnd) * doorWidth;
    let swingY = hingePoint.y + Math.sin(adjustedArcEnd) * doorWidth;

    switch (orientation) {
      case 0:
        adjustedArcStart = angle;
        adjustedArcEnd = angle + Math.PI / 2;
        swingX = hingePoint.x + Math.cos(adjustedArcEnd) * doorWidth;
        swingY = hingePoint.y + Math.sin(adjustedArcEnd) * doorWidth;
        break;
      case 1:
        adjustedArcStart = angle;
        adjustedArcEnd = angle - Math.PI / 2;
        swingX = hingePoint.x + Math.cos(adjustedArcEnd) * doorWidth;
        swingY = hingePoint.y + Math.sin(adjustedArcEnd) * doorWidth;
        break;
    }

    // Clamp arc to both adjacent perpendicular wall AND the wall the door sits on
    if (cornerWall) {
      const dir = { x: Math.cos(adjustedArcEnd), y: Math.sin(adjustedArcEnd) };
      const hit = intersectRaySegment(hingePoint, dir, cornerWall.innerStart, cornerWall.innerEnd);
      if (hit && hit.t > 0) {
        leafRadius = Math.min(leafRadius, hit.t);
        swingX = hit.x;
        swingY = hit.y;
      }
    }
    
    // Also clamp to the wall the door sits on (prevent arc from extending past frameEnd)
    if (leafRadius > doorWidth) {
      leafRadius = doorWidth;
      swingX = frameEnd.x;
      swingY = frameEnd.y;
    }

    // Arc
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1.5 / viewport.k;
    ctx.beginPath();
    const counterClockwise = orientation === 1;
    ctx.arc(hingePoint.x, hingePoint.y, leafRadius, adjustedArcStart, adjustedArcEnd, counterClockwise);
    ctx.stroke();

    // Panel
    ctx.lineWidth = 2.5 / viewport.k;
    ctx.beginPath();
    ctx.moveTo(hingePoint.x, hingePoint.y);
    ctx.lineTo(swingX, swingY);
    ctx.stroke();

    // Highlight
    if (selectedDoor && selectedDoor.id === door.id) {
      ctx.fillStyle = 'rgba(147, 51, 234, 0.1)';
      ctx.beginPath();
      ctx.arc(hingePoint.x, hingePoint.y, doorWidth + 5 / viewport.k, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#9333ea';
      ctx.lineWidth = 2 / viewport.k;
      ctx.stroke();
    }
  };

  const drawDoorArrow = (ctx, door) => {
    if (!door || !door.start || !door.end) return;

    const { start, end } = door;
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.atan2(dy, dx);

    ctx.save();
    ctx.translate(midX, midY);
    ctx.rotate(angle);

    // Circle
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0,0,0,0.2)';
    ctx.shadowBlur = 4 / viewport.k;
    ctx.beginPath();
    ctx.arc(0, 0, 10 / viewport.k, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1 / viewport.k;
    ctx.stroke();

    // Icon
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1.5 / viewport.k;
    ctx.beginPath();
    ctx.arc(0, 0, 5 / viewport.k, 0, Math.PI * 1.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(5 / viewport.k, -2 / viewport.k);
    ctx.lineTo(5 / viewport.k, 0);
    ctx.lineTo(3 / viewport.k, 0);
    ctx.stroke();

    ctx.restore();
  };

  const drawCornerMullions = (ctx, processedWalls, doors, windows) => {
    // Detect corners where two openings meet and draw a square block
    processedWalls.forEach((w1, i) => {
      processedWalls.forEach((w2, j) => {
        if (i >= j) return;

        ['start', 'end'].forEach(e1 => {
          ['start', 'end'].forEach(e2 => {
            const p1 = e1 === 'start' ? w1.innerStart : w1.innerEnd;
            const p2 = e2 === 'start' ? w2.innerStart : w2.innerEnd;

            if (p1 && p2 && typeof p1.x === 'number' && typeof p2.x === 'number' && calculateDistance(p1, p2) < 5) {
              // Vertex shared. Now check for openings on both walls at this vertex
              const ops1 = findOpeningsOnWall(w1, doors, windows);
              const ops2 = findOpeningsOnWall(w2, doors, windows);

              const hasOp1 = ops1.some(op => (e1 === 'start' ? op.startT < 0.2 : op.endT > 0.8));
              const hasOp2 = ops2.some(op => (e2 === 'start' ? op.startT < 0.2 : op.endT > 0.8));

              if (hasOp1 && hasOp2) {
                // FAIL-SAFE GEOGRAPHIC CHECK: If ANY window endpoint is near this corner, kill the mullion.
                const windowNear = windows.some(win =>
                  calculateDistance(win.start, p1) < 25 ||
                  calculateDistance(win.end, p1) < 25
                );

                if (windowNear) {
                  return; // SEAMLESS JOIN: No wall mullion
                }

                // Any side has a window? Skip.
                const op1 = ops1.find(op => (e1 === 'start' ? op.startT < 0.2 : op.endT > 0.8));
                const op2 = ops2.find(op => (e2 === 'start' ? op.startT < 0.2 : op.endT > 0.8));

                if (op1?.type === 'window' || op2?.type === 'window') {
                  return;
                }

                // Both sides have doors or generic openings. Draw square mullion.
                const cornerInner = p1;
                const cornerOuter = findLineIntersection(w1.outerStart, w1.outerEnd, w2.outerStart, w2.outerEnd);

                if (cornerInner && cornerOuter) {
                  // Force squaring of the mullion faces to align with the door hinges
                  const p1Force = interpolateWallPoint(w1, e1 === 'start' ? 0 : 1, 'outer', true);
                  const p2Force = interpolateWallPoint(w2, e2 === 'start' ? 0 : 1, 'outer', true);

                  ctx.fillStyle = '#e5e7eb';
                  ctx.strokeStyle = '#000000';
                  ctx.lineWidth = 1.5 / viewport.k;
                  ctx.beginPath();
                  ctx.moveTo(cornerInner.x, cornerInner.y);
                  ctx.lineTo(p1Force.x, p1Force.y);
                  ctx.lineTo(cornerOuter.x, cornerOuter.y);
                  ctx.lineTo(p2Force.x, p2Force.y);
                  ctx.closePath();
                  ctx.fill();
                  ctx.stroke();

                  // If it's a door corner, we want the block on the TOP-LEFT of the intersection
                  // This is achieved by ensuring the fill is solid and the outline crosses the junction.
                }
              }
            }
          });
        });
      });
    });
  };

  const drawGeneric = (ctx, generic) => {
    const { start, end } = generic;
    ctx.strokeStyle = '#059669';
    ctx.lineWidth = 2 / viewport.k;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  };

  // --- Dimensions ---

  // --- Dimensions ---

  function formatMeasurement(meters) {
    const feet = Math.floor(meters / 0.3048);
    const inches = Math.round((meters % 0.3048) / 0.0254);
    if (inches === 12) return `${feet + 1}'-0"`;
    if (inches === 0) return `${feet}'-0"`;
    return `${feet}'-${inches}"`;
  }

  const drawDimensionLine = (ctx, start, end, text, angle, color, offset = 35, skipStartExt = false, skipEndExt = false) => {
    if (!start || !end) return;

    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const perpAngle = angle - Math.PI / 2;

    const extStart = 5 / viewport.k;
    const extEnd = (Math.abs(offset) + 10) / viewport.k * (offset > 0 ? 1 : -1);

    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5 / viewport.k;
    ctx.setLineDash([3 / viewport.k, 3 / viewport.k]);

    // Ext 1
    if (!skipStartExt) {
      ctx.beginPath();
      ctx.moveTo(start.x + Math.cos(perpAngle) * extStart, start.y + Math.sin(perpAngle) * extStart);
      ctx.lineTo(start.x + Math.cos(perpAngle) * extEnd, start.y + Math.sin(perpAngle) * extEnd);
      ctx.stroke();
    }

    // Ext 2
    if (!skipEndExt) {
      ctx.beginPath();
      ctx.moveTo(end.x + Math.cos(perpAngle) * extStart, end.y + Math.sin(perpAngle) * extStart);
      ctx.lineTo(end.x + Math.cos(perpAngle) * extEnd, end.y + Math.sin(perpAngle) * extEnd);
      ctx.stroke();
    }

    // Line
    ctx.setLineDash([]);
    ctx.lineWidth = 0.8 / viewport.k;
    ctx.beginPath();
    const lineX_S = start.x + Math.cos(perpAngle) * offset / viewport.k;
    const lineY_S = start.y + Math.sin(perpAngle) * offset / viewport.k;
    const lineX_E = end.x + Math.cos(perpAngle) * offset / viewport.k;
    const lineY_E = end.y + Math.sin(perpAngle) * offset / viewport.k;

    ctx.moveTo(lineX_S, lineY_S);
    ctx.lineTo(lineX_E, lineY_E);
    ctx.stroke();

    // Arrows
    const drawArrow = (px, py, ang) => {
      const arrowSize = 6 / viewport.k;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - Math.cos(ang - Math.PI / 6) * arrowSize, py - Math.sin(ang - Math.PI / 6) * arrowSize);
      ctx.moveTo(px, py);
      ctx.lineTo(px - Math.cos(ang + Math.PI / 6) * arrowSize, py - Math.sin(ang + Math.PI / 6) * arrowSize);
      ctx.stroke();
    };

    const actualOffset = offset / viewport.k;
    drawArrow(start.x + Math.cos(perpAngle) * actualOffset, start.y + Math.sin(perpAngle) * actualOffset, angle + Math.PI);
    drawArrow(end.x + Math.cos(perpAngle) * actualOffset, end.y + Math.sin(perpAngle) * actualOffset, angle);

    // Text
    const textX = midX + Math.cos(perpAngle) * actualOffset;
    const textY = midY + Math.sin(perpAngle) * actualOffset;

    ctx.save();
    ctx.translate(textX, textY);

    ctx.font = `bold ${10 / viewport.k}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (text) {
      const textWidth = ctx.measureText(text).width;
      ctx.fillStyle = 'white';
      ctx.fillRect(-textWidth / 2 - 4 / viewport.k, -8 / viewport.k, textWidth + 8 / viewport.k, 16 / viewport.k);
      ctx.fillStyle = color;
      ctx.fillText(text, 0, 0);
    }
    ctx.restore();
  };

  const drawDimensionLines = (ctx, walls, windows, doors, generics) => {
    // 1. Map junctions to suppress extension lines
    const junctionPoints = [];
    walls.forEach(w => {
      junctionPoints.push({ x: w.start.x, y: w.start.y });
      junctionPoints.push({ x: w.end.x, y: w.end.y });
    });

    const getJunctionCount = (p) => {
      let count = 0;
      walls.forEach(w => {
        if (Math.hypot(w.start.x - p.x, w.start.y - p.y) < 5) count++;
        if (Math.hypot(w.end.x - p.x, w.end.y - p.y) < 5) count++;
      });
      return count;
    };

    // Other elements
    const allElements = [
      ...doors.filter(d => d.measurement).map(d => ({ ...d, type: 'door', color: '#92400e' })),
      ...windows.filter(w => w.measurement).map(w => ({ ...w, type: 'window', color: '#1e40af' })),
      ...generics.filter(g => g.measurement).map(g => ({ ...g, type: 'generic', color: '#059669' }))
    ];

    // 2. Calculate Centroid for Outward Logic
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasGeo = false;
    walls.forEach(w => {
      if (w && w.start && w.end) {
        minX = Math.min(minX, w.start.x, w.end.x);
        maxX = Math.max(maxX, w.start.x, w.end.x);
        minY = Math.min(minY, w.start.y, w.end.y);
        maxY = Math.max(maxY, w.start.y, w.end.y);
        hasGeo = true;
      }
    });
    const centroid = hasGeo ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : { x: 0, y: 0 };

    const isValidLength = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
    // wall.actualLength is already in pixels (100 px = 1 m), set by
    // updateWallWithAutoConnect via parseRecognizedMeasurement → meters × 100.
    // No secondary parser or unit conversion needed here.
    const getMeasuredLengthPx = (wall) => {
      if (!wall || !wall.measurement || !isValidLength(wall.actualLength)) return null;
      return wall.actualLength;   // px, directly stored by the geometry store
    };
    const pointDistSq = (a, b) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx * dx + dy * dy;
    };
    // (getConnectedEndCount removed — the old formula that used it produced
    // the centerline length for measured walls instead of the true outer face,
    // causing measured walls to show "5'-9"" while unmeasured walls showed the
    // geometrically correct "6'-6"". Both tiers now use face geometry directly.)

    // ── DEDUPLICATION ──────────────────────────────────────────────────────────
    // processWalls() splits every original wall at junctions, so `walls` here
    // contains many short segments that all share a parentId.  Drawing one
    // dimension per segment causes stacked, overlapping labels.
    // Solution: group segments by parentId, then build ONE representative wall
    // per group whose outer/inner extents span the FULL original wall.
    const wallsByParent = new Map();
    walls.forEach(wall => {
      const key = wall.parentId || wall.id;
      if (!wallsByParent.has(key)) wallsByParent.set(key, []);
      wallsByParent.get(key).push(wall);
    });

    // Produce one entry per original wall, preserving the segment that carries
    // measurement/actualLength data (prefer measured over un-measured).
    const dedupedWalls = [];
    wallsByParent.forEach(segs => {
      // Sort by position along original wall so [0] = start, [last] = end
      segs.sort((a, b) => {
        const ax = a.outerStart ? a.outerStart.x + a.outerStart.y : 0;
        const bx = b.outerStart ? b.outerStart.x + b.outerStart.y : 0;
        return ax - bx;
      });
      const first = segs[0];
      const last = segs[segs.length - 1];
      // Pick the segment that has an explicit measurement, or fall back to first
      const measured = segs.find(s => s.measurement) || first;
      dedupedWalls.push({
        ...measured,
        // Span the full wall extent
        outerStart: first.outerStart,
        outerEnd: last.outerEnd,
        innerStart: first.innerStart,
        innerEnd: last.innerEnd,
        // Accumulated length for un-measured walls
        length: segs.reduce((s, seg) => s + (seg.length || 0), 0),
        // Carry all openings from every segment
        openings: segs.flatMap(s => s.openings || []),
      });
    });
    // ───────────────────────────────────────────────────────────────────────────

    dedupedWalls.forEach(wall => {
      const { innerStart, innerEnd, outerStart, outerEnd, angle, id, openings } = wall;
      if (!innerStart || !innerEnd || !outerStart || !outerEnd) return;

      const midX = (outerStart.x + outerEnd.x) / 2;
      const midY = (outerStart.y + outerEnd.y) / 2;

      const dx = outerEnd.x - outerStart.x;
      const dy = outerEnd.y - outerStart.y;
      const wallAngle = Math.atan2(dy, dx);

      // Simple outward logic based on centroid
      const pOffTest = { x: midX + Math.cos(wallAngle - Math.PI / 2) * 50, y: midY + Math.sin(wallAngle - Math.PI / 2) * 50 };
      const d1 = (pOffTest.x - centroid.x) ** 2 + (pOffTest.y - centroid.y) ** 2;
      const pOffTest2 = { x: midX + Math.cos(wallAngle + Math.PI / 2) * 50, y: midY + Math.sin(wallAngle + Math.PI / 2) * 50 };
      const d2 = (pOffTest2.x - centroid.x) ** 2 + (pOffTest2.y - centroid.y) ** 2;
      const dirMult = d1 > d2 ? 1 : -1;

      const tierInner = 110 * dirMult;
      const tierOuter = 140 * dirMult;

      const skipS = getJunctionCount(wall.start) > 2;
      const skipE = getJunctionCount(wall.end) > 2;

      // Determine true interior/exterior edges relative to the shape centroid.
      // Wall-local "outer/inner" depends on draw direction and is not globally reliable.
      const outerMid = { x: (outerStart.x + outerEnd.x) / 2, y: (outerStart.y + outerEnd.y) / 2 };
      const innerMid = { x: (innerStart.x + innerEnd.x) / 2, y: (innerStart.y + innerEnd.y) / 2 };
      const outerIsExterior = pointDistSq(outerMid, centroid) >= pointDistSq(innerMid, centroid);

      const exteriorStart = outerIsExterior ? outerStart : innerStart;
      const exteriorEnd = outerIsExterior ? outerEnd : innerEnd;
      const interiorStart = outerIsExterior ? innerStart : outerStart;
      const interiorEnd = outerIsExterior ? innerEnd : outerEnd;

      const thicknessPx = wall.thickness || WALL_THICKNESS;

      // ── Measurement rule: ALL dimensions from inner wall faces ────────────────
      // Both tiers are computed geometrically from the already-computed face
      // points so that measured and unmeasured walls use the exact same source
      // of truth.  The old formula path added thicknessContribution to the
      // stored actualLength, which gave the *centerline* length for measured
      // walls but the *true outer face* for unmeasured ones — an inconsistency
      // that caused "5'-0"" walls to show "5'-9"" (centerline) in one tier and
      // "6'-6"" (actual outer face) in another.
      //
      //   interiorLengthPx  =  inner-face-A → inner-face-B   (user's clear dim)
      //   exteriorLengthPx  =  outer-face-A → outer-face-B   (structural total)
      const interiorLengthPx = calculateDistance(interiorStart, interiorEnd);
      const exteriorLengthPx = calculateDistance(exteriorStart, exteriorEnd);

      // Label for inner tier: prefer the user's stored string when it exists
      // (so "5'-0"" stays exactly as entered); fall back to geometry-derived text.
      const measuredLengthPx = getMeasuredLengthPx(wall);
      const hasMeasuredDisplay = wall.measurement && isValidLength(measuredLengthPx);

      const debugEnabled = typeof window !== 'undefined' && window.__DEBUG_DIMS__ === true;
      if (debugEnabled && wall.id && !debugDimsRef.current.logged.has(wall.id)) {
        debugDimsRef.current.logged.add(wall.id);
        console.log('[DIM-DEBUG]', {
          id: wall.id,
          measurement: wall.measurement,
          interiorGeomPx: interiorLengthPx,
          exteriorGeomPx: exteriorLengthPx,
          thicknessPx,
        });
      }
      
      // If selectedSegment is set for this wall, show only segmented measurements
      const isSegmentSelected = selectedSegment === id;
      
      if (isSegmentSelected && openings && openings.length > 0) {
        // Show measurements for each opening segment instead of full wall
        let lastPoint = innerStart;
        openings.forEach((op, idx) => {
          if (op.startT > 0.01) {
            // Segment before opening
            const segStart = lastPoint;
            const segEnd = interpolateWallPoint(wall, op.startT, 'inner');
            const segLen = calculateDistance(segStart, segEnd);
            if (segLen > 20) {
              drawDimensionLine(ctx, segStart, segEnd, formatMeasurement(segLen / 100), angle, '#059669', tierInner, false, false);
            }
          }
          lastPoint = interpolateWallPoint(wall, op.endT, 'inner');
        });
        // Final segment after last opening
        if (lastPoint && Math.hypot(lastPoint.x - innerEnd.x, lastPoint.y - innerEnd.y) > 20) {
          const segLen = calculateDistance(lastPoint, innerEnd);
          drawDimensionLine(ctx, lastPoint, innerEnd, formatMeasurement(segLen / 100), angle, '#059669', tierInner, false, false);
        }
      } else {
        // Normal display: show full wall measurements
        // 1. TIER OUTER: TOTAL OUTER LENGTH (Structural Total)
        const outerLength = exteriorLengthPx;
        if (outerLength < 50) return; // Skip tiny segments
        const outerDisplay = formatMeasurement(outerLength / 100);
        drawDimensionLine(ctx, exteriorStart, exteriorEnd, outerDisplay, angle, '#000000', tierOuter, skipS, skipE);

        // 2. TIER INNER: INNER CLEAR SPAN (room interior)
        // — always sourced from inner face geometry; label uses the stored
        //   user string (e.g. "5'-0"") when available so it stays bit-exact.
        if (interiorLengthPx < 30) return; // Skip tiny interior spans
        const innerDisplay = hasMeasuredDisplay
          ? wall.measurement
          : formatMeasurement(interiorLengthPx / 100);

        drawDimensionLine(ctx, interiorStart, interiorEnd, innerDisplay, angle, '#4b5563', tierInner, skipS, skipE);
      }

      // TIER 1 (Details) REMOVED for walls to ensure absolute minimal clutter
    });

    allElements.forEach(el => {
      const { start, end, measurement, angle, color } = el;
      if (!start || !end) return;
      const elAngle = angle || Math.atan2(end.y - start.y, end.x - start.x);

      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const testPt = { x: midX + Math.cos(elAngle - Math.PI / 2) * 50, y: midY + Math.sin(elAngle - Math.PI / 2) * 50 };
      const distTest = (testPt.x - centroid.x) ** 2 + (testPt.y - centroid.y) ** 2;
      const distBase = (midX - centroid.x) ** 2 + (midY - centroid.y) ** 2;
      const dirMult = distTest > distBase ? 1 : -1;

      drawDimensionLine(ctx, start, end, measurement, elAngle, color, 90 * dirMult);
    });
  };

  // --- Interaction ---

  function handleCanvasClick(e) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const point = screenToWorld(e.clientX, e.clientY);
    const x = point.x;
    const y = point.y;
    
    // Detect double-click
    const now = Date.now();
    const lastClick = lastClickRef.current;
    const isDoubleClick = now - lastClick.time < 300 && 
      Math.hypot(x - lastClick.x, y - lastClick.y) < 20;
    
    lastClickRef.current = { time: now, x, y, element: null };

    // --- Priority-based selection based on current mode ---
    // If in 'door' mode, prioritize doors; in 'window' mode, prioritize windows; in 'wall' mode, prioritize walls
    
    // Check doors (highest priority if mode is 'door')
    if (mode === 'door') {
      for (const door of doors) {
        const geometry = calculateDoorGeometry(door);
        if (!geometry) continue;
        const { hingePoint, frameEnd } = geometry;
        const distStart = Math.sqrt((x - hingePoint.x) ** 2 + (y - hingePoint.y) ** 2);
        const distEnd = Math.sqrt((x - frameEnd.x) ** 2 + (y - frameEnd.y) ** 2);
        const dist = Math.min(distStart, distEnd);
        if (dist < 15) {
          if (isDoubleClick && lastClick.element === door.id) {
            // Double-click: select segmented part
            setSelectedSegment(door.id);
            setSelectedDoor(null);
          } else {
            // Single click: select door
            setSelectedDoor(door);
            setSelectedSegment(null);
          }
          lastClickRef.current.element = door.id;
          return;
        }
      }
    }
    
    // Check windows (highest priority if mode is 'window')
    // BUG FIX: calculateWindowFrame requires (window, wall, match) — calling it with
    // only `win` always returns null.  Use raw endpoint proximity instead.
    if (mode === 'window') {
      for (const win of windows) {
        if (!win || !win.start || !win.end) continue;
        const midX = (win.start.x + win.end.x) / 2;
        const midY = (win.start.y + win.end.y) / 2;
        const dist = Math.min(
          Math.sqrt((x - win.start.x) ** 2 + (y - win.start.y) ** 2),
          Math.sqrt((x - win.end.x)   ** 2 + (y - win.end.y)   ** 2),
          Math.sqrt((x - midX)        ** 2 + (y - midY)        ** 2)
        );
        if (dist < 15) {
          if (isDoubleClick && lastClick.element === win.id) {
            setSelectedSegment(win.id);
          } else {
            setSelectedSegment(null);
          }
          lastClickRef.current.element = win.id;
          return;
        }
      }
    }
    
    // Check walls (highest priority if mode is 'wall')
    if (mode === 'wall') {
      const processedWalls = processWalls(walls);
      for (const wall of processedWalls) {
        const { outerStart, outerEnd, innerStart, innerEnd } = wall;
        const outerDist = Math.min(
          Math.sqrt((x - outerStart.x) ** 2 + (y - outerStart.y) ** 2),
          Math.sqrt((x - outerEnd.x) ** 2 + (y - outerEnd.y) ** 2)
        );
        const innerDist = Math.min(
          Math.sqrt((x - innerStart.x) ** 2 + (y - innerStart.y) ** 2),
          Math.sqrt((x - innerEnd.x) ** 2 + (y - innerEnd.y) ** 2)
        );
        const dist = Math.min(outerDist, innerDist);
        if (dist < 15) {
          if (isDoubleClick && lastClick.element === wall.id) {
            setSelectedSegment(wall.id);
          } else {
            setSelectedSegment(null);
          }
          lastClickRef.current.element = wall.id;
          return;
        }
      }
    }
    
    // If no mode-specific match, fall back to general selection (all elements)
    for (const door of doors) {
      const geometry = calculateDoorGeometry(door);
      if (!geometry) continue;
      const { hingePoint, frameEnd } = geometry;
      const distStart = Math.sqrt((x - hingePoint.x) ** 2 + (y - hingePoint.y) ** 2);
      const distEnd = Math.sqrt((x - frameEnd.x) ** 2 + (y - frameEnd.y) ** 2);
      if (distStart < 15 || distEnd < 15) {
        setSelectedDoor(door);
        return;
      }
    }

    // Rotation/orientation click on doors
    for (const door of doors) {
      const { start, end } = door;
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const dist = Math.sqrt((x - midX) ** 2 + (y - midY) ** 2);
      if (dist < 15) {
        const current = door.orientation || 0;
        const next = (current + 1) % 2;
        updateDoorOrientation(door.id, next);
        return;
      }
    }
    
    setSelectedDoor(null);
    setSelectedSegment(null);
  }

  return (
    <div className="relative w-full h-full bg-white">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full cursor-pointer touch-none"
        onClick={handleCanvasClick}
        onWheel={handleWheel}
        onMouseDown={handleStart}
        onMouseMove={handleMove}
        onMouseUp={handleEnd}
        onMouseLeave={handleEnd}
        onTouchStart={handleStart}
        onTouchMove={handleMove}
        onTouchEnd={handleEnd}
        onTouchCancel={handleEnd}
      />

      {selectedDoor && (
        <div className="absolute top-6 right-6 bg-white rounded-xl shadow-lg p-4 z-50 border border-gray-200">
          <div className="text-sm font-semibold text-gray-900 mb-4">Door Orientation</div>
          <div className="flex flex-col gap-2 w-32">
            <button
              onClick={() => {
                const next = ((selectedDoor.orientation || 0) + 1) % 2;
                updateDoorOrientation(selectedDoor.id, next);
                setSelectedDoor({ ...selectedDoor, orientation: next });
              }}
              className="w-full py-2 px-4 bg-purple-600 text-white rounded-lg font-medium shadow-sm active:scale-95 transition-all"
            >
              Flip Direction
            </button>
            <button
              onClick={() => setSelectedDoor(null)}
              className="w-full py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}