// src/components/AlignCanvas.jsx
import React, { useRef, useState, useEffect, useCallback } from 'react';
import useGeometryStore from '../stores/geometryStore';
import { recognizeHandwriting, parseRecognizedMeasurement } from '../utils/handwritingOCR';
import { processRawPoints } from '../utils/geometry';


export default function AlignCanvas() {
  const canvasRef = useRef(null);
  const handwritingCanvasRef = useRef(null);
  const recognitionTimeoutRef = useRef(null);
  const holdTimeoutRef = useRef(null);
  const holdActivatedRef = useRef(false);
  const downPointRef = useRef(null);
  const prevLastDrawnIdRef = useRef(null);
  const activeEditingRef = useRef(null);
  const lastEditingRef = useRef(null);
  const handwritingTargetRef = useRef(null);
  const recognitionQueueRef = useRef([]);
  const recognitionInFlightRef = useRef(false);
  const previewSnapRef = useRef(null);

  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState(null);
  const [snapPoint, setSnapPoint] = useState(null);
  const [previewPoint, setPreviewPoint] = useState(null);

  const [editingElement, setEditingElement] = useState(null);
  const [handwritingStrokes, setHandwritingStrokes] = useState([]);
  const [currentStroke, setCurrentStroke] = useState([]);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [boxBounds, setBoxBounds] = useState(null);
  const [isAngleMeasurement, setIsAngleMeasurement] = useState(false);
  const [freehandPoints, setFreehandPoints] = useState([]);

  // Touch gesture state for pinch-to-zoom
  const [touchState, setTouchState] = useState({
    lastDistance: 0,
    lastCenter: null,
    gestureActive: false
  });

  // Double-click detection for segment selection
  const [lastClickTime, setLastClickTime] = useState(0);
  const [lastClickPoint, setLastClickPoint] = useState(null);
  const [selectedSegmentOnly, setSelectedSegmentOnly] = useState(false);
  const lastClickRef = useRef({ time: 0, point: null, element: null });

  // Angle snapping
  const [orthoMode, setOrthoMode] = useState(false);
  const [angleSnapType, setAngleSnapType] = useState(null); // 'H', 'V', '45', or null

  // Behaviour capture: count snap adjustments per stroke
  const bhvSnapCountRef = useRef(0);

  // OCR failure state — shows "write again" prompt instead of keyboard
  const [ocrFailed, setOcrFailed] = useState(false);
  // Keyboard fallback (optional, only shown on explicit user request)
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualInputElement, setManualInputElement] = useState(null);
  const manualInputRef = useRef(null);

  useEffect(() => {
    activeEditingRef.current = editingElement;
    if (editingElement) {
      lastEditingRef.current = editingElement;
    }
  }, [editingElement]);

  const {
    walls, doors, windows, generics, mode,
    addWall, addWalls, addWallWithJunctions, addWallsWithJunctions,
    addDoor, addDoors, addWindow, addWindows, addGeneric, addGenerics, deleteElement,
    addMeasurementToDoor,
    addMeasurementToWindow, addMeasurementToGeneric,
    updateWallWithAutoConnect,
    rotateElement,
    lastDrawnId, lastDrawnType, newlyDrawnIds,
    preferredUnit,
    viewport, setViewport,
    gridEnabled
  } = useGeometryStore();

  const SNAP_CONFIG = {
    vertexPx: 18,
    endpointPx: 80,
    segmentPx: 28,
    stickyPx: 40
  };

  // Touch gesture helpers for iPad pinch-to-zoom
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

  // Auto-open measurement box for last drawn element
  useEffect(() => {
    if (lastDrawnId && lastDrawnType && lastDrawnId !== prevLastDrawnIdRef.current) {
      // If we have newlyDrawnIds, just focus on the first one or the last one?
      // User says "boxes should pop up for EACH line". 
      // We'll handle rendering multiple boxes in the draw loop based on newlyDrawnIds.
      // But we still need one to be "active" for the OCR target if they start writing.

      let element = null;
      if (lastDrawnType === 'wall') element = walls.find(w => w.id === lastDrawnId);
      else if (lastDrawnType === 'door') element = doors.find(d => d.id === lastDrawnId);
      else if (lastDrawnType === 'window') element = windows.find(w => w.id === lastDrawnId);
      else if (lastDrawnType === 'generic') element = generics.find(g => g.id === lastDrawnId);

      if (element && !element.measurement) {
        setEditingElement({ ...element, type: lastDrawnType });
        setHandwritingStrokes([]);
        setCurrentStroke([]);
        setBoxBounds(calculateBoxBoundsWithAvoidance(element, [
          ...walls.map(w => ({ ...w, type: 'wall' })),
          ...doors.map(d => ({ ...d, type: 'door' })),
          ...windows.map(w => ({ ...w, type: 'window' })),
          ...generics.map(g => ({ ...g, type: 'generic' }))
        ], []));
      }

      prevLastDrawnIdRef.current = lastDrawnId;
    }

    if (!lastDrawnId) prevLastDrawnIdRef.current = null;
  }, [lastDrawnId, lastDrawnType, walls, doors, windows, generics]);

  useEffect(() => {
    if (!editingElement) return;
    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];
    const nextBounds = calculateBoxBoundsWithAvoidance(editingElement, allElements, []);
    if (nextBounds && (!boxBounds || !areBoundsEqual(nextBounds, boxBounds))) {
      setBoxBounds(nextBounds);
    }
  }, [editingElement, walls, doors, windows, generics, boxBounds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const handwritingCanvas = handwritingCanvasRef.current;
    if (!canvas || !handwritingCanvas) return;

    const resize = () => {
      const container = canvas.parentElement;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      handwritingCanvas.width = container.clientWidth;
      handwritingCanvas.height = container.clientHeight;
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const screenToCanvas = (clientX, clientY) => {
    // Legacy support if needed, but we prefer screenToWorld
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  };

  const screenToWorld = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();

    // Screen relative to canvas
    const screenX = (clientX - rect.left) * (canvas.width / rect.width);
    const screenY = (clientY - rect.top) * (canvas.height / rect.height);

    // Apply viewport transform inverse: (screen - pan) / zoom
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

  // Handle Zoom
  const handleWheel = (e) => {
    if (e.ctrlKey || e.metaKey || true) { // Always Zoom on wheel for typical CAD feel
      e.preventDefault();
      const zoomIntensity = 0.1;
      const direction = e.deltaY > 0 ? -1 : 1;
      const factor = 1 + (direction * zoomIntensity);

      let newK = viewport.k * factor;
      newK = Math.max(0.1, Math.min(newK, 10)); // Limits

      // Zoom towards mouse
      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
      const mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);

      const newX = mouseX - (mouseX - viewport.x) * (newK / viewport.k);
      const newY = mouseY - (mouseY - viewport.y) * (newK / viewport.k);

      setViewport({ x: newX, y: newY, k: newK });
    }
  };

  // Find intersection snap point when drawing a line
  const findIntersectionSnap = (startPoint, currentPoint) => {
    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];

    let nearest = null;
    let minDist = Infinity;

    allElements.forEach(el => {
      const intersection = getLineIntersection(
        startPoint, currentPoint,
        el.start, el.end
      );

      if (intersection && !isNearEndpoint(intersection, el, 15)) {
        // Distance from current point to intersection
        const dist = Math.hypot(
          intersection.x - currentPoint.x,
          intersection.y - currentPoint.y
        );
        
        // Snap to intersections within 40 pixels
        if (dist < 40 && dist < minDist) {
          minDist = dist;
          nearest = {
            x: intersection.x,
            y: intersection.y,
            type: 'intersection',
            element: el
          };
        }
      }
    });

    return nearest;
  };

  // Find snap point on line segments (strict threshold - must be hovering directly over line)
  const findLineSegmentSnap = (point) => {
    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];

    let nearest = null;
    let minDist = Infinity;
    const SEGMENT_SNAP_THRESHOLD = 15; // Must be within 15px of line to snap during preview

    allElements.forEach(el => {
      const { start, end } = el;
      if (!start || !end) return;
      
      const snap = projectPointToSegment(point, start, end);
      
      // Only snap if very close to the line segment
      if (snap.dist < SEGMENT_SNAP_THRESHOLD && snap.dist < minDist) {
        minDist = snap.dist;
        nearest = {
          x: snap.point.x,
          y: snap.point.y,
          type: 'line-segment',
          element: el,
          projectionDist: snap.dist
        };
      }
    });

    return nearest;
  };

  const findSnapPoints = () => {
    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];

    const snapPoints = [];

    allElements.forEach(element => {
      const { start, end } = element;

      // Start point
      snapPoints.push({
        x: start.x,
        y: start.y,
        type: 'start',
        element: element
      });

      // Quarter point
      snapPoints.push({
        x: start.x + (end.x - start.x) * 0.25,
        y: start.y + (end.y - start.y) * 0.25,
        type: 'quarter',
        element: element
      });

      // Midpoint
      snapPoints.push({
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
        type: 'mid',
        element: element
      });

      // Three-quarter point
      snapPoints.push({
        x: start.x + (end.x - start.x) * 0.75,
        y: start.y + (end.y - start.y) * 0.75,
        type: 'three-quarter',
        element: element
      });

      // End point
      snapPoints.push({
        x: end.x,
        y: end.y,
        type: 'end',
        element: element
      });
    });

    return snapPoints;
  };

  const findNearestEndpointSnap = (point, threshold) => {
    const snapPoints = findSnapPoints();
    let nearest = null;
    let minDist = threshold;

    snapPoints.forEach(sp => {
      if (sp.type !== 'start' && sp.type !== 'end') return;
      const dist = Math.hypot(point.x - sp.x, point.y - sp.y);
      if (dist < minDist) {
        minDist = dist;
        nearest = sp;
      }
    });

    return nearest;
  };

  const findOtherVertexSnap = (point, threshold) => {
    const snapPoints = findSnapPoints();
    let nearest = null;
    let minDist = threshold;

    snapPoints.forEach(sp => {
      if (sp.type === 'start' || sp.type === 'end') return;
      const dist = Math.hypot(point.x - sp.x, point.y - sp.y);
      if (dist < minDist) {
        minDist = dist;
        nearest = sp;
      }
    });

    return nearest;
  };

  const projectPointToSegment = (point, start, end) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { point: start, t: 0, dist: Math.hypot(point.x - start.x, point.y - start.y) };
    let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: start.x + t * dx, y: start.y + t * dy };
    return { point: proj, t, dist: Math.hypot(point.x - proj.x, point.y - proj.y) };
  };

  const findNearestSegmentSnap = (point, threshold) => {
    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];

    let nearest = null;
    let minDist = threshold;

    allElements.forEach(el => {
      const { start, end } = el;
      if (!start || !end) return;
      const snap = projectPointToSegment(point, start, end);
      if (snap.dist < minDist) {
        minDist = snap.dist;
        nearest = {
          x: snap.point.x,
          y: snap.point.y,
          type: 'segment',
          element: el,
          t: snap.t
        };
      }
    });

    return nearest;
  };

  const getSnapThresholds = () => ({
    vertex: SNAP_CONFIG.vertexPx / viewport.k,
    endpoint: SNAP_CONFIG.endpointPx / viewport.k,
    segment: SNAP_CONFIG.segmentPx / viewport.k,
    sticky: SNAP_CONFIG.stickyPx / viewport.k
  });

  const findBestSnapTarget = (point, thresholds = getSnapThresholds()) => {
    const endpointSnap = findNearestEndpointSnap(point, thresholds.endpoint);
    if (endpointSnap) return endpointSnap;
    const segmentSnap = findNearestSegmentSnap(point, thresholds.segment);
    if (segmentSnap) return segmentSnap;
    const otherVertexSnap = findOtherVertexSnap(point, thresholds.vertex);
    if (otherVertexSnap) return otherVertexSnap;
    return null;
  };

  const getPerpendicularPoint = (start, current) => {
    const dx = current.x - start.x;
    const dy = current.y - start.y;

    if (Math.abs(dx) > Math.abs(dy)) {
      return { x: current.x, y: start.y };
    } else {
      return { x: start.x, y: current.y };
    }
  };

  // Orthogonalise a chain of segments so each one is purely H or V.
  // The start of each segment is clamped to the snapped end of the previous
  // one so the polyline stays connected after snapping.
  const orthoSnapSegments = (segs) => {
    const result = [];
    for (let i = 0; i < segs.length; i++) {
      const seg   = segs[i];
      const start = result.length > 0 ? result[result.length - 1].end : seg.start;
      const snappedEnd = getPerpendicularPoint(start, seg.end);
      bhvSnapCountRef.current++;  // behaviour: count each ortho snap
      result.push({
        ...seg,
        start,
        end: snappedEnd,
        originalLength: Math.hypot(snappedEnd.x - start.x, snappedEnd.y - start.y)
      });
    }
    return result;
  };

  // --- ANGLE SNAPPING ---
  // Snaps a drawn line to the nearest clean architectural angle.
  // Tolerance: 8 degrees. Allowed: 0°, 45°, 90°, 135°, 180° (and negatives).
  // In ORTHO mode only 0° / 90° are allowed.
  const ANGLE_SNAP_TOLERANCE_DEG = 8;

  const applyAngleSnap = (start, end, isOrtho = false) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 5) return { snapped: end, snapType: null };

    const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI); // –180 to +180
    const allowedAngles = isOrtho
      ? [0, 90, 180, -90, -180]
      : [0, 45, 90, 135, 180, -45, -90, -135, -180];

    let bestAngle = null;
    let bestDiff = Infinity;
    for (const a of allowedAngles) {
      const diff = Math.abs(angleDeg - a);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestAngle = a;
      }
    }

    if (bestAngle !== null && bestDiff <= ANGLE_SNAP_TOLERANCE_DEG) {
      const snapAngleRad = bestAngle * (Math.PI / 180);
      const snappedEnd = {
        x: start.x + length * Math.cos(snapAngleRad),
        y: start.y + length * Math.sin(snapAngleRad)
      };
      const normAngle = ((bestAngle % 360) + 360) % 360;
      let snapType = '45';
      if (normAngle === 0 || normAngle === 180) snapType = 'H';
      else if (normAngle === 90 || normAngle === 270) snapType = 'V';
      return { snapped: snappedEnd, snapType };
    }

    return { snapped: end, snapType: null };
  };

  const calculatePolylineGuides = (fromPoint, toPoint, allElements) => {
    const guides = [];

    // Check for horizontal/vertical alignment with existing lines
    allElements.forEach(element => {
      const { start, end } = element;
      
      // Horizontal alignment - check if from or to points align with element endpoints
      const tolerance = 15 / viewport.k; // Convert pixel tolerance to world space
      
      if (Math.abs(fromPoint.y - start.y) < tolerance) {
        guides.push({
          type: 'horizontal',
          y: start.y,
          x1: Math.min(fromPoint.x, toPoint.x),
          x2: Math.max(fromPoint.x, toPoint.x)
        });
      }
      if (Math.abs(fromPoint.y - end.y) < tolerance) {
        guides.push({
          type: 'horizontal',
          y: end.y,
          x1: Math.min(fromPoint.x, toPoint.x),
          x2: Math.max(fromPoint.x, toPoint.x)
        });
      }

      // Vertical alignment
      if (Math.abs(fromPoint.x - start.x) < tolerance) {
        guides.push({
          type: 'vertical',
          x: start.x,
          y1: Math.min(fromPoint.y, toPoint.y),
          y2: Math.max(fromPoint.y, toPoint.y)
        });
      }
      if (Math.abs(fromPoint.x - end.x) < tolerance) {
        guides.push({
          type: 'vertical',
          x: end.x,
          y1: Math.min(fromPoint.y, toPoint.y),
          y2: Math.max(fromPoint.y, toPoint.y)
        });
      }

      // Perpendicular guides at endpoints
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen > 0) {
        const perpX = -dy / segLen;
        const perpY = dx / segLen;
        
        // From start point
        if (Math.hypot(fromPoint.x - start.x, fromPoint.y - start.y) < tolerance * 3) {
          guides.push({
            type: 'perpendicular',
            fromX: start.x,
            fromY: start.y,
            toX: start.x + perpX * 1000,
            toY: start.y + perpY * 1000
          });
        }
        
        // From end point
        if (Math.hypot(fromPoint.x - end.x, fromPoint.y - end.y) < tolerance * 3) {
          guides.push({
            type: 'perpendicular',
            fromX: end.x,
            fromY: end.y,
            toX: end.x + perpX * 1000,
            toY: end.y + perpY * 1000
          });
        }
      }
    });

    return guides;
  };

  const calculatePolylineSegmentGuides = (segments, lastSegment, startPoint) => {
    if (!lastSegment || segments.length === 0) return [];

    const guides = [];
    const { end: lastEnd } = lastSegment;
    const tolerance = 30 / viewport.k;

    // Get the first segment for reference
    const firstSegment = segments[0];
    const startPt = startPoint || firstSegment.start;

    // Generate guides from all previous segments
    segments.forEach((seg, idx) => {
      if (idx === segments.length - 1) return; // Skip the last segment being drawn
      
      const { start, end } = seg;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);

      // Horizontal alignment with previous segments
      if (Math.abs(dy) < Math.abs(dx) * 0.1) {
        guides.push({
          type: 'horizontal',
          y: end.y,
          x1: end.x,
          x2: lastEnd.x
        });
      }

      // Vertical alignment with previous segments
      if (Math.abs(dx) < Math.abs(dy) * 0.1) {
        guides.push({
          type: 'vertical',
          x: end.x,
          y1: end.y,
          y2: lastEnd.y
        });
      }

      // Perpendicular guides from segment endpoints
      if (segLen > 0) {
        const perpX = -dy / segLen;
        const perpY = dx / segLen;
        
        guides.push({
          type: 'perpendicular',
          fromX: end.x,
          fromY: end.y,
          toX: end.x + perpX * 800,
          toY: end.y + perpY * 800
        });
      }
    });

    // Guides for connecting back to the starting point (closing the polyline)
    if (segments.length > 1) {
      const distToStart = Math.hypot(lastEnd.x - startPt.x, lastEnd.y - startPt.y);
      
      // Only show closing guides if reasonably close to completion
      if (distToStart < tolerance * 5) {
        // Horizontal alignment with starting point
        if (Math.abs(lastEnd.y - startPt.y) < tolerance) {
          guides.push({
            type: 'horizontal-close',
            y: startPt.y,
            x1: Math.min(lastEnd.x, startPt.x),
            x2: Math.max(lastEnd.x, startPt.x)
          });
        }

        // Vertical alignment with starting point
        if (Math.abs(lastEnd.x - startPt.x) < tolerance) {
          guides.push({
            type: 'vertical-close',
            x: startPt.x,
            y1: Math.min(lastEnd.y, startPt.y),
            y2: Math.max(lastEnd.y, startPt.y)
          });
        }
      }
    }

    // Guides for continuing in same direction as first segment
    if (segments.length > 0) {
      const firstDx = firstSegment.end.x - firstSegment.start.x;
      const firstDy = firstSegment.end.y - firstSegment.start.y;
      
      // If drawing horizontally, show extension guide
      if (Math.abs(firstDy) < Math.abs(firstDx) * 0.1) {
        guides.push({
          type: 'horizontal-continue',
          y: lastEnd.y,
          x1: lastEnd.x,
          x2: lastEnd.x + (firstDx > 0 ? 500 : -500)
        });
      }
      
      // If drawing vertically, show extension guide
      if (Math.abs(firstDx) < Math.abs(firstDy) * 0.1) {
        guides.push({
          type: 'vertical-continue',
          x: lastEnd.x,
          y1: lastEnd.y,
          y2: lastEnd.y + (firstDy > 0 ? 500 : -500)
        });
      }
    }

    return guides;
  };

  const findClickedElement = (point, priorityMode = null) => {
    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];

    // If a priority mode is specified, first try to find an element of that type
    if (priorityMode && priorityMode !== 'erase' && priorityMode !== 'freehand') {
      for (const element of allElements) {
        if (element.type === priorityMode) {
          const { start, end } = element;
          const dist = distanceToSegment(point, start, end);
          if (dist < 10) return element;
        }
      }
    }

    // Fall back to finding any element if no priority match found
    for (const element of allElements) {
      const { start, end } = element;
      const dist = distanceToSegment(point, start, end);
      if (dist < 10) return element;
    }
    return null;
  };

  const distanceToSegment = (point, start, end) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
      return Math.sqrt((point.x - start.x) ** 2 + (point.y - start.y) ** 2);
    }

    const t = Math.max(0, Math.min(1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
    ));

    const nearestX = start.x + t * dx;
    const nearestY = start.y + t * dy;

    return Math.sqrt((point.x - nearestX) ** 2 + (point.y - nearestY) ** 2);
  };

  // Detect intersections on a wall element
  const findIntersectionsOnWall = (wall) => {
    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];

    const intersections = [];

    allElements.forEach(el => {
      if (el.id === wall.id) return;

      // Check for line-line intersection
      const intersection = getLineIntersection(
        wall.start, wall.end,
        el.start, el.end
      );

      if (intersection && !isNearEndpoint(intersection, wall, 10)) {
        const distFromStart = Math.hypot(
          intersection.x - wall.start.x,
          intersection.y - wall.start.y
        );
        intersections.push({
          point: intersection,
          distance: distFromStart,
          wallId: el.id
        });
      }
    });

    return intersections.sort((a, b) => a.distance - b.distance);
  };

  // Get line-line intersection
  const getLineIntersection = (p1, p2, p3, p4) => {
    const x1 = p1.x, y1 = p1.y;
    const x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y;
    const x4 = p4.x, y4 = p4.y;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

    if (Math.abs(denom) < 0.0001) return null;

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return {
        x: x1 + t * (x2 - x1),
        y: y1 + t * (y2 - y1),
        t: t
      };
    }

    return null;
  };

  // Check if point is near endpoint
  const isNearEndpoint = (point, segment, threshold = 5) => {
    const distStart = Math.hypot(point.x - segment.start.x, point.y - segment.start.y);
    const distEnd = Math.hypot(point.x - segment.end.x, point.y - segment.end.y);
    return distStart < threshold || distEnd < threshold;
  };

  // Find which segment was clicked if wall is segmented
  const findClickedSegment = (wall, clickPoint) => {
    const intersections = findIntersectionsOnWall(wall);
    if (intersections.length === 0) return null;

    // Build segments from intersections
    const segments = [];
    let currentStart = wall.start;

    intersections.forEach((intersection) => {
      segments.push({
        start: currentStart,
        end: intersection.point,
        intersectionAtEnd: true
      });
      currentStart = intersection.point;
    });

    // Add final segment
    segments.push({
      start: currentStart,
      end: wall.end,
      intersectionAtEnd: false
    });

    // Find which segment was clicked
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const dist = distanceToSegment(clickPoint, segment.start, segment.end);
      if (dist < 10) {
        return {
          segmentIndex: i,
          totalSegments: segments.length,
          segment: segment
        };
      }
    }

    return null;
  };


  const calculateBoxBounds = (element) => {
    if (!element) return null;

    const { start, end } = element;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.atan2(dy, dx);
    // Bounds logic remains in World Space, but we check interactions via screenToWorld
    const boxWidth = 120;
    const boxHeight = 60;
    const offsetDistance = 35;
    const sideOffset = 15;

    const perpX = -Math.sin(angle) * offsetDistance;
    const perpY = Math.cos(angle) * offsetDistance;
    const alongX = Math.cos(angle) * sideOffset;
    const alongY = Math.sin(angle) * sideOffset;

    const boxCenterX = start.x + alongX + perpX;
    const boxCenterY = start.y + alongY + perpY;

    return {
      minX: boxCenterX - boxWidth / 2,
      maxX: boxCenterX + boxWidth / 2,
      minY: boxCenterY - boxHeight / 2,
      maxY: boxCenterY + boxHeight / 2,
      centerX: boxCenterX,
      centerY: boxCenterY
    };
  };

  const buildBoxBounds = (centerX, centerY, boxWidth = 200, boxHeight = 100) => ({
    minX: centerX - boxWidth / 2,
    maxX: centerX + boxWidth / 2,
    minY: centerY - boxHeight / 2,
    maxY: centerY + boxHeight / 2,
    centerX,
    centerY
  });

  const pointInRect = (point, rect, padding = 0) => (
    point.x >= rect.minX - padding && point.x <= rect.maxX + padding &&
    point.y >= rect.minY - padding && point.y <= rect.maxY + padding
  );

  const rectsOverlap = (a, b, padding = 0) => (
    a.minX - padding < b.maxX + padding &&
    a.maxX + padding > b.minX - padding &&
    a.minY - padding < b.maxY + padding &&
    a.maxY + padding > b.minY - padding
  );

  const areBoundsEqual = (a, b, epsilon = 0.01) => {
    if (!a || !b) return false;
    return (
      Math.abs(a.minX - b.minX) < epsilon &&
      Math.abs(a.maxX - b.maxX) < epsilon &&
      Math.abs(a.minY - b.minY) < epsilon &&
      Math.abs(a.maxY - b.maxY) < epsilon
    );
  };

  const segmentsIntersect = (p1, p2, p3, p4) => {
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d1 = cross(p1, p2, p3);
    const d2 = cross(p1, p2, p4);
    const d3 = cross(p3, p4, p1);
    const d4 = cross(p3, p4, p2);

    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      return true;
    }
    return false;
  };

  const rectIntersectsSegment = (rect, start, end, padding = 0) => {
    if (pointInRect(start, rect, padding) || pointInRect(end, rect, padding)) return true;

    const corners = [
      { x: rect.minX - padding, y: rect.minY - padding },
      { x: rect.maxX + padding, y: rect.minY - padding },
      { x: rect.maxX + padding, y: rect.maxY + padding },
      { x: rect.minX - padding, y: rect.maxY + padding }
    ];

    const edges = [
      [corners[0], corners[1]],
      [corners[1], corners[2]],
      [corners[2], corners[3]],
      [corners[3], corners[0]]
    ];

    return edges.some(([a, b]) => segmentsIntersect(start, end, a, b));
  };

  const calculateBoxBoundsWithAvoidance = (element, allElements, occupiedBoxes) => {
    if (!element) return null;

    const { start, end, id } = element;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.atan2(dy, dx);

    const boxWidth = 200;
    const boxHeight = 100;
    const offsetDistance = 55;
    const sideOffset = 15;
    const padding = 10;

    const baseX = start.x + Math.cos(angle) * sideOffset;
    const baseY = start.y + Math.sin(angle) * sideOffset;
    const perpX = -Math.sin(angle);
    const perpY = Math.cos(angle);

    const candidates = [
      { perp: 1, along: 1 },
      { perp: 1, along: -1 },
      { perp: -1, along: 1 },
      { perp: -1, along: -1 },
      { perp: 1.6, along: 0 },
      { perp: -1.6, along: 0 },
      { perp: 0, along: 1.6 },
      { perp: 0, along: -1.6 }
    ];

    const hasCollision = (bounds) => {
      if (occupiedBoxes && occupiedBoxes.some(box => rectsOverlap(bounds, box, padding))) {
        return true;
      }

      if (!allElements) return false;
      return allElements.some(other => {
        if (!other || other.id === id) return false;
        return rectIntersectsSegment(bounds, other.start, other.end, padding);
      });
    };

    for (const candidate of candidates) {
      const centerX = baseX + perpX * offsetDistance * candidate.perp + Math.cos(angle) * sideOffset * candidate.along;
      const centerY = baseY + perpY * offsetDistance * candidate.perp + Math.sin(angle) * sideOffset * candidate.along;
      const bounds = buildBoxBounds(centerX, centerY, boxWidth, boxHeight);
      if (!hasCollision(bounds)) {
        return bounds;
      }
    }

    return buildBoxBounds(baseX + perpX * offsetDistance, baseY + perpY * offsetDistance, boxWidth, boxHeight);
  };

  const isPointInBox = (point, bounds) => {
    if (!bounds) return false;
    return point.x >= bounds.minX && point.x <= bounds.maxX &&
      point.y >= bounds.minY && point.y <= bounds.maxY;
  };

  const findClickedMeasurement = (point) => {
    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];

    for (const element of allElements) {
      if (!element.measurement) continue;

      const { start, end } = element;
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const angle = Math.atan2(dy, dx);

      const offsetDistance = 20;
      const perpX = -Math.sin(angle) * offsetDistance;
      const perpY = Math.cos(angle) * offsetDistance;
      const textX = midX + perpX;
      const textY = midY + perpY;

      const textWidth = element.measurement.length * 8;
      const textHeight = 16;

      const rotatedX = (point.x - textX) * Math.cos(-angle) - (point.y - textY) * Math.sin(-angle);
      const rotatedY = (point.x - textX) * Math.sin(-angle) + (point.y - textY) * Math.cos(-angle);

      if (Math.abs(rotatedX) < textWidth / 2 && Math.abs(rotatedY) < textHeight / 2) {
        return element;
      }
    }

    return null;
  };

  const startDrawingAtPoint = (point) => {
    holdActivatedRef.current = true;
    if (editingElement) {
      flushPendingHandwriting();
      setEditingElement(null);
      setHandwritingStrokes([]);
      setCurrentStroke([]);
      setBoxBounds(null);
      setIsAngleMeasurement(false);
    }
    
    // Check if clicking on a line segment first (highest priority)
    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];
    
    const START_SEGMENT_THRESHOLD = 20; // Snap to line if within 20px
    let lineSegmentSnap = null;
    let minSegDist = Infinity;
    
    allElements.forEach(el => {
      const { start, end } = el;
      const projection = projectPointToSegment(point, start, end);
      
      if (projection.dist < START_SEGMENT_THRESHOLD && projection.dist < minSegDist) {
        minSegDist = projection.dist;
        lineSegmentSnap = {
          x: projection.point.x,
          y: projection.point.y
        };
      }
    });
    
    if (lineSegmentSnap) {
      setStartPoint(lineSegmentSnap);
      setFreehandPoints([lineSegmentSnap]);
    } else {
      // Fall back to snap points if not on a line
      const snapPoints = [];
      allElements.forEach(el => {
        const { start, end } = el;
        
        snapPoints.push({ x: start.x, y: start.y, type: 'endpoint' });
        snapPoints.push({ x: end.x, y: end.y, type: 'endpoint' });
        snapPoints.push({
          x: (start.x + end.x) / 2,
          y: (start.y + end.y) / 2,
          type: 'midpoint'
        });
        snapPoints.push({
          x: start.x + (end.x - start.x) * 0.25,
          y: start.y + (end.y - start.y) * 0.25,
          type: 'quarter'
        });
        snapPoints.push({
          x: start.x + (end.x - start.x) * 0.75,
          y: start.y + (end.y - start.y) * 0.75,
          type: 'quarter'
        });
      });
      
      // 10 px node snap (spec requirement: endpoints within 10 px must merge)
      const START_SNAP_THRESHOLD = 10;
      let nearestSnap = null;
      let minDist = Infinity;

      snapPoints.forEach(sp => {
        const dist = Math.hypot(point.x - sp.x, point.y - sp.y);
        if (dist < START_SNAP_THRESHOLD && dist < minDist) {
          minDist = dist;
          nearestSnap = sp;
        }
      });
      
      if (nearestSnap) {
        setStartPoint({ x: nearestSnap.x, y: nearestSnap.y });
        setFreehandPoints([{ x: nearestSnap.x, y: nearestSnap.y }]);
      } else {
        setStartPoint(point);
        setFreehandPoints([point]);
      }
    }
    
    setSnapPoint(null);
    previewSnapRef.current = null;
    setIsDrawing(true);
  };

  const handleStart = (e) => {
    // e.preventDefault(); // allow focus
    // if (e.target !== canvasRef.current) return;

    // Two-finger gesture for pinch-to-zoom (iPad support)
    if (e.touches && e.touches.length === 2) {
      const distance = getTouchDistance(e.touches);
      const center = getTouchCenter(e.touches);
      setTouchState({
        lastDistance: distance,
        lastCenter: center,
        gestureActive: true
      });
      return;
    }

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const point = screenToWorld(clientX, clientY);
    downPointRef.current = point;
    holdActivatedRef.current = false;

    // Pan Mode Check (Middle Mouse or Space Key - here simplified to Middle or if Panning Tool active)
    if (e.button === 1 || (e.buttons === 4)) {
      setIsPanning(true);
      setLastPanPoint({ x: clientX, y: clientY });
      return;
    }

    // Gesture Logic Initialization
    if (holdTimeoutRef.current) clearTimeout(holdTimeoutRef.current);

    // Immediately handle measurement box, erase, or special modes
    if (editingElement && boxBounds && isPointInBox(point, boxBounds)) {
      handwritingTargetRef.current = editingElement;
      setCurrentStroke([point]);
      setOcrFailed(false); // clear any previous failure so box returns to normal prompt
      return;
    }

    if (mode === 'erase') {
      const element = findClickedElement(point, 'erase');
      if (element) deleteElement(element.id);
      return;
    }

    const isDrawMode = mode === 'wall' || mode === 'window' || mode === 'door' || mode === 'generic' || mode === 'freehand';
    if (!isDrawMode) return;

    if (mode === 'freehand') {
      if (holdTimeoutRef.current) clearTimeout(holdTimeoutRef.current);
      startDrawingAtPoint(point);
      return;
    }

    // Set a timeout for "Hold to Draw"
    holdTimeoutRef.current = setTimeout(() => {
      startDrawingAtPoint(point);
      holdTimeoutRef.current = null;
    }, 300); // 300ms hold threshold
  };

  const handleMove = (e) => {
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    // Two-finger pinch-to-zoom handling (iPad infinite canvas)
    if (e.touches && e.touches.length === 2 && touchState.gestureActive) {
      e.preventDefault();
      const distance = getTouchDistance(e.touches);
      const center = getTouchCenter(e.touches);

      if (touchState.lastDistance && touchState.lastCenter) {
        // Calculate zoom factor
        const scale = distance / touchState.lastDistance;
        let newK = viewport.k * scale;
        newK = Math.max(0.1, Math.min(10, newK)); // Limit zoom range

        // Zoom towards pinch center
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const centerX = (center.x - rect.left) * (canvas.width / rect.width);
        const centerY = (center.y - rect.top) * (canvas.height / rect.height);

        // Calculate pan offset
        const dx = center.x - touchState.lastCenter.x;
        const dy = center.y - touchState.lastCenter.y;

        const newX = centerX - (centerX - viewport.x - dx) * (newK / viewport.k);
        const newY = centerY - (centerY - viewport.y - dy) * (newK / viewport.k);

        setViewport({ x: newX, y: newY, k: newK });
      }

      setTouchState({
        lastDistance: distance,
        lastCenter: center,
        gestureActive: true
      });
      return;
    }

    if (isPanning && lastPanPoint) {
      const dx = clientX - lastPanPoint.x;
      const dy = clientY - lastPanPoint.y;
      setViewport(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      setLastPanPoint({ x: clientX, y: clientY });
      return;
    }

    const point = screenToWorld(clientX, clientY);

    // Handle handwriting
    if (currentStroke.length > 0 && editingElement && boxBounds) {
      setCurrentStroke(prev => [...prev, point]);
      return;
    }

    // Handle preview
    if (isDrawing && startPoint) {
      let preview = point;

      if (mode !== 'freehand') {
        // Check for snaps in this order: line segments, snap points, intersections
        const lineSegmentSnap = findLineSegmentSnap(point);
        
        if (lineSegmentSnap) {
          // Hovering directly over a line - snap to the projected point on that line
          preview = { x: lineSegmentSnap.x, y: lineSegmentSnap.y };
          previewSnapRef.current = lineSegmentSnap;
        } else {
          // Not directly over a line, check for snap points with strict threshold
          const allElements = [
            ...walls.map(w => ({ ...w, type: 'wall' })),
            ...doors.map(d => ({ ...d, type: 'door' })),
            ...windows.map(w => ({ ...w, type: 'window' })),
            ...generics.map(g => ({ ...g, type: 'generic' }))
          ];
          
          const snapPoints = [];
          allElements.forEach(el => {
            const { start, end } = el;
            
            snapPoints.push({ x: start.x, y: start.y, type: 'endpoint' });
            snapPoints.push({ x: end.x, y: end.y, type: 'endpoint' });
            snapPoints.push({
              x: (start.x + end.x) / 2,
              y: (start.y + end.y) / 2,
              type: 'midpoint'
            });
            snapPoints.push({
              x: start.x + (end.x - start.x) * 0.25,
              y: start.y + (end.y - start.y) * 0.25,
              type: 'quarter'
            });
            snapPoints.push({
              x: start.x + (end.x - start.x) * 0.75,
              y: start.y + (end.y - start.y) * 0.75,
              type: 'quarter'
            });
          });
          
          // Strict threshold for preview: only snap if directly on the snap point (15px)
          const PREVIEW_SNAP_THRESHOLD = 15;
          let nearestSnapPoint = null;
          let snapPointDist = Infinity;
          
          snapPoints.forEach(sp => {
            const dist = Math.hypot(point.x - sp.x, point.y - sp.y);
            if (dist < PREVIEW_SNAP_THRESHOLD && dist < snapPointDist) {
              snapPointDist = dist;
              nearestSnapPoint = {
                x: sp.x,
                y: sp.y,
                type: 'snappoint'
              };
            }
          });
          
          // Only snap if directly hovering over snap point or intersection
          if (nearestSnapPoint) {
            preview = { x: nearestSnapPoint.x, y: nearestSnapPoint.y };
            previewSnapRef.current = nearestSnapPoint;
          } else {
            const intersectionSnap = findIntersectionSnap(startPoint, point);
            if (intersectionSnap) {
              preview = { x: intersectionSnap.x, y: intersectionSnap.y };
              previewSnapRef.current = intersectionSnap;
            } else {
              previewSnapRef.current = null;
            }
          }
        }

        // Apply angle snapping when not locked to an existing element.
        // Walls always enforce ORTHO (nearest H/V axis, no tolerance).
        // Other element types use the softer 8° angle-snap.
        if (!previewSnapRef.current) {
          if (mode === 'wall') {
            preview = getPerpendicularPoint(startPoint, preview);
            const dx = preview.x - startPoint.x;
            const dy = preview.y - startPoint.y;
            setAngleSnapType(Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V');
          } else {
            const { snapped, snapType } = applyAngleSnap(startPoint, preview, orthoMode);
            preview = snapped;
            setAngleSnapType(snapType);
          }
        } else {
          setAngleSnapType(null);
        }
      }
      setPreviewPoint(preview);
      setFreehandPoints(prev => [...prev, point]);
    }
  };

  const handleEnd = async (e) => {
    e.preventDefault();

    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }

    // Reset touch gesture state (for pinch-to-zoom)
    if (touchState.gestureActive) {
      setTouchState({
        lastDistance: 0,
        lastCenter: null,
        gestureActive: false
      });
      return;
    }

    if (isPanning) {
      setIsPanning(false);
      setLastPanPoint(null);
      return;
    }

    if (isDrawing && startPoint) {
      const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
      const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
      let endPoint = screenToWorld(clientX, clientY);

      const activeDrawType = mode === 'freehand' ? 'wall' : mode;
      const angleTolerance = 7; // ±7° ortho-snap for both freehand and wall mode
      const shouldProcessFreehand = mode === 'freehand' ? freehandPoints.length > 2 : freehandPoints.length > 5;

      // Check if it's a polyline/freehand stroke
      if (shouldProcessFreehand) {
        const EPSILON = 15 / viewport.k;
        const rawSegments = processRawPoints(freehandPoints, EPSILON, angleTolerance);
        console.log('[CANVAS] processRawPoints returned', rawSegments.length, 'segments');
        rawSegments.forEach((seg, i) => {
          const len = Math.sqrt((seg.end.x - seg.start.x) ** 2 + (seg.end.y - seg.start.y) ** 2);
          console.log(`  [${i}] (${Math.round(seg.start.x)},${Math.round(seg.start.y)}) -> (${Math.round(seg.end.x)},${Math.round(seg.end.y)}) len=${Math.round(len)}`);
        });

        // Walls always enforce ORTHO: snap every freehand segment to the nearest
        // H or V axis and re-chain so corners stay connected.
        const segments = (activeDrawType === 'wall' && rawSegments.length >= 1)
          ? orthoSnapSegments(rawSegments)
          : rawSegments;

        if (segments.length > 1) {
          // It's a polyline! Support for all element types
          console.log('[CANVAS] Creating', activeDrawType, 's from', segments.length, 'segments');
          if (activeDrawType === 'wall') {
            const _sc = bhvSnapCountRef.current;
            addWallsWithJunctions(segments.map(s => ({ ...s, _snapCount: _sc }))); // junction-aware: snaps nodes + splits at crossings
          } else if (activeDrawType === 'window') {
            addWindows(segments);
          } else if (activeDrawType === 'door') {
            addDoors(segments);
          } else if (activeDrawType === 'generic') {
            addGenerics(segments);
          }
          finishDrawing();
          return;
        }

        if (segments.length === 1) {
          const segment = segments[0];
          if (activeDrawType === 'wall') {
            addWallWithJunctions({ ...segment, _snapCount: bhvSnapCountRef.current }); // junction-aware
          } else if (activeDrawType === 'window') {
            addWindow(segment);
          } else if (activeDrawType === 'door') {
            addDoor(segment);
          } else if (activeDrawType === 'generic') {
            addGeneric(segment);
          }
          finishDrawing();
          return;
        }

        if (mode === 'freehand' && freehandPoints.length >= 2) {
          const start = freehandPoints[0];
          const end = freehandPoints[freehandPoints.length - 1];
          const fallbackSegment = { start, end, originalLength: Math.hypot(end.x - start.x, end.y - start.y) };
          addWallWithJunctions({ ...fallbackSegment, _snapCount: bhvSnapCountRef.current }); // junction-aware fallback
          finishDrawing();
          return;
        }
      }

      // Legacy Single Line Logic
      // Only snap if user was hovering over something during drag
      if (mode !== 'freehand') {
        const lastSnap = previewSnapRef.current;
        let snappedToElement = false;

        // If user was hovering over something, snap to it
        if (lastSnap) {
          endPoint = { x: lastSnap.x, y: lastSnap.y };
          snappedToElement = true;
        } else {
          // Check if endpoint is near any line segment (fallback)
          const allElements = [
            ...walls.map(w => ({ ...w, type: 'wall' })),
            ...doors.map(d => ({ ...d, type: 'door' })),
            ...windows.map(w => ({ ...w, type: 'window' })),
            ...generics.map(g => ({ ...g, type: 'generic' }))
          ];

          let nearestSegment = null;
          let minSegDist = Infinity;
          const FALLBACK_SEGMENT_THRESHOLD = 20;

          allElements.forEach(el => {
            const { start, end } = el;
            const projection = projectPointToSegment(endPoint, start, end);

            if (projection.dist < FALLBACK_SEGMENT_THRESHOLD && projection.dist < minSegDist) {
              minSegDist = projection.dist;
              nearestSegment = {
                x: projection.point.x,
                y: projection.point.y
              };
            }
          });

          if (nearestSegment) {
            endPoint = nearestSegment;
            snappedToElement = true;
          }
        }

        // Apply angle snapping to ensure geometrically clean lines.
        // Only skip if the endpoint was explicitly snapped to an existing element.
        // Walls always enforce ORTHO (no tolerance); other types use 8° snap.
        if (!snappedToElement) {
          if (mode === 'wall') {
            endPoint = getPerpendicularPoint(startPoint, endPoint);
          } else {
            const { snapped } = applyAngleSnap(startPoint, endPoint, orthoMode);
            endPoint = snapped;
          }
        }

        setAngleSnapType(null);
      }

      const lenDx = endPoint.x - startPoint.x;
      const lenDy = endPoint.y - startPoint.y;
      const length = Math.sqrt(lenDx * lenDx + lenDy * lenDy);

      if (length > 20) {
        const lineData = {
          start: startPoint,
          end: endPoint,
          originalLength: length
        };

        if (activeDrawType === 'wall') {
          addWallWithJunctions({ ...lineData, _snapCount: bhvSnapCountRef.current }); // junction-aware: snaps + splits at T/X junctions
        } else if (activeDrawType === 'door') {
          addDoor(lineData);
        } else if (activeDrawType === 'window') {
          addWindow(lineData);
        } else if (activeDrawType === 'generic') {
          addGeneric(lineData);
        }
      }

      finishDrawing();

    } else if (!holdActivatedRef.current && currentStroke.length === 0) {
      const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
      const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
      const upPoint = screenToWorld(clientX, clientY);
      const downPoint = downPointRef.current || upPoint;
      const tapDistance = Math.hypot(upPoint.x - downPoint.x, upPoint.y - downPoint.y);
      const TAP_THRESHOLD = 10 / viewport.k;

      if (tapDistance <= TAP_THRESHOLD) {
        const isDrawMode = mode === 'wall' || mode === 'window' || mode === 'door' || mode === 'generic' || mode === 'freehand';
        if (isDrawMode) {
          const clickedElement = findClickedElement(upPoint, mode) || findClickedMeasurement(upPoint);
          if (clickedElement) {
            // Double-click detection for segment selection
            const currentTime = Date.now();
            const isDoubleClick = 
              lastClickRef.current.element &&
              lastClickRef.current.element.id === clickedElement.id &&
              currentTime - lastClickRef.current.time < 300 &&
              Math.hypot(
                upPoint.x - (lastClickRef.current.point?.x || 0),
                upPoint.y - (lastClickRef.current.point?.y || 0)
              ) < 50 / viewport.k;

            lastClickRef.current = {
              time: currentTime,
              point: upPoint,
              element: clickedElement
            };

            // Toggle segment-only selection on double-click
            let elementToShow = clickedElement;
            const shouldShowSegmentOnly = isDoubleClick && clickedElement.type === 'wall' 
              ? !selectedSegmentOnly 
              : false;

            // If showing segment only, adjust element to show just that segment
            if (shouldShowSegmentOnly) {
              const segmentInfo = findClickedSegment(clickedElement, upPoint);
              if (segmentInfo && segmentInfo.segment) {
                elementToShow = {
                  ...clickedElement,
                  start: segmentInfo.segment.start,
                  end: segmentInfo.segment.end,
                  isSegment: true,
                  segmentIndex: segmentInfo.segmentIndex,
                  totalSegments: segmentInfo.totalSegments,
                  originalStart: clickedElement.start,
                  originalEnd: clickedElement.end
                };
              }
            }

            flushPendingHandwriting();
            setEditingElement({ 
              ...elementToShow, 
              type: clickedElement.type,
              selectSegmentOnly: shouldShowSegmentOnly,
              clickPoint: upPoint
            });
            setSelectedSegmentOnly(shouldShowSegmentOnly);
            setHandwritingStrokes([]);
            setCurrentStroke([]);
            setBoxBounds(calculateBoxBoundsWithAvoidance(elementToShow, [
              ...walls.map(w => ({ ...w, type: 'wall' })),
              ...doors.map(d => ({ ...d, type: 'door' })),
              ...windows.map(w => ({ ...w, type: 'window' })),
              ...generics.map(g => ({ ...g, type: 'generic' }))
            ], []));
            setIsAngleMeasurement(false);
            return;
          }
        }
      }

    } else if (currentStroke.length > 0) {
      setHandwritingStrokes(prev => [...prev, currentStroke]);
      setCurrentStroke([]);
    }
  };

  // Apply a manually typed measurement when OCR fails
  const handleManualMeasurementSubmit = useCallback((rawValue) => {
    const text = (rawValue || '').trim();
    if (!text || !manualInputElement) return;

    const measurement = parseRecognizedMeasurement(text, preferredUnit);
    if (!measurement) {
      // Shake the input to signal invalid input — reset value and keep open
      if (manualInputRef.current) {
        manualInputRef.current.classList.add('animate-bounce');
        setTimeout(() => manualInputRef.current?.classList.remove('animate-bounce'), 600);
      }
      return;
    }

    const el = manualInputElement;
    setShowManualInput(false);
    setManualInputElement(null);

    if (measurement.isAngle) {
      rotateElement(el.id, el.type, measurement.angleValue);
    } else {
      const { actualLength, displayText } = measurement;
      switch (el.type) {
        case 'wall':    updateWallWithAutoConnect(el.id, displayText, actualLength); break;
        case 'door':    addMeasurementToDoor(el.id, displayText, actualLength); break;
        case 'window':  addMeasurementToWindow(el.id, displayText, actualLength); break;
        case 'generic': addMeasurementToGeneric(el.id, displayText, actualLength); break;
      }
    }

    setEditingElement(null);
    setBoxBounds(null);
  }, [manualInputElement, preferredUnit, rotateElement, updateWallWithAutoConnect,
      addMeasurementToDoor, addMeasurementToWindow, addMeasurementToGeneric]);

  const finishDrawing = () => {
    bhvSnapCountRef.current = 0;  // reset snap counter per stroke
    setIsDrawing(false);
    setStartPoint(null);
    setSnapPoint(null);
    setPreviewPoint(null);
    setFreehandPoints([]);
    previewSnapRef.current = null;
  };

  const processHandwritingJob = useCallback(async (element, strokes) => {
    if (!element || strokes.length === 0) return;

    // Larger canvas → more pixels for Tesseract to work with
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 1000;
    tempCanvas.height = 500;
    const ctx = tempCanvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    strokes.forEach(stroke => {
      stroke.forEach(point => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
    });

    if (!isFinite(minX) || !isFinite(maxX)) {
      setOcrFailed(true);
      return;
    }

    const padding = 80;
    const strokeWidth = maxX - minX || 1;
    const strokeHeight = maxY - minY || 1;

    const scaleX = (tempCanvas.width - 2 * padding) / strokeWidth;
    const scaleY = (tempCanvas.height - 2 * padding) / strokeHeight;
    // Allow up to 4× so small writing fills the canvas
    const scale = Math.min(scaleX, scaleY, 4);

    const scaledWidth = strokeWidth * scale;
    const scaledHeight = strokeHeight * scale;
    const offsetX = (tempCanvas.width - scaledWidth) / 2;
    const offsetY = (tempCanvas.height - scaledHeight) / 2;

    ctx.strokeStyle = '#000000';
    // Thicker strokes: at least 8px, and 12px when scale is small
    ctx.lineWidth = Math.max(8, 12 / scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    strokes.forEach(stroke => {
      if (stroke.length < 2) return;
      ctx.beginPath();
      const firstPoint = {
        x: offsetX + (stroke[0].x - minX) * scale,
        y: offsetY + (stroke[0].y - minY) * scale
      };
      ctx.moveTo(firstPoint.x, firstPoint.y);
      stroke.forEach(point => {
        const scaledPoint = {
          x: offsetX + (point.x - minX) * scale,
          y: offsetY + (point.y - minY) * scale
        };
        ctx.lineTo(scaledPoint.x, scaledPoint.y);
      });
      ctx.stroke();
    });

    const recognizedText = await recognizeHandwriting(tempCanvas);
    if (!recognizedText) {
      // OCR failed — prompt user to write again (no keyboard needed on tablet)
      setOcrFailed(true);
      return;
    }

    const measurement = parseRecognizedMeasurement(recognizedText, preferredUnit);
    if (!measurement) return;

    if (measurement.isAngle) {
      rotateElement(element.id, element.type, measurement.angleValue);
      setEditingElement(prev => (prev && prev.id === element.id ? null : prev));
      setBoxBounds(prev => {
        const current = activeEditingRef.current;
        if (current && current.id === element.id) return null;
        return prev;
      });
      return;
    }

    const { actualLength, displayText } = measurement;
    switch (element.type) {
      case 'wall': updateWallWithAutoConnect(element.id, displayText, actualLength); break;
      case 'door': addMeasurementToDoor(element.id, displayText, actualLength); break;
      case 'window': addMeasurementToWindow(element.id, displayText, actualLength); break;
      case 'generic': addMeasurementToGeneric(element.id, displayText, actualLength); break;
    }

    setEditingElement(prev => (prev && prev.id === element.id ? null : prev));
    setBoxBounds(prev => {
      const current = activeEditingRef.current;
      if (current && current.id === element.id) return null;
      return prev;
    });
  }, [addMeasurementToDoor, addMeasurementToGeneric, updateWallWithAutoConnect, addMeasurementToWindow, preferredUnit, rotateElement, setOcrFailed]);

  const startNextRecognition = useCallback(() => {
    if (recognitionInFlightRef.current) return;

    const nextJob = recognitionQueueRef.current.shift();
    if (!nextJob) {
      setIsRecognizing(false);
      return;
    }

    recognitionInFlightRef.current = true;
    setIsRecognizing(true);

    (async () => {
      try {
        await processHandwritingJob(nextJob.element, nextJob.strokes);
      } catch (error) {
        console.error('❌ Handwriting processing error:', error);
      } finally {
        recognitionInFlightRef.current = false;
        startNextRecognition();
      }
    })();
  }, [processHandwritingJob]);

  const enqueueRecognitionJob = useCallback((element, strokes) => {
    if (!element || !strokes || strokes.length === 0) return;
    recognitionQueueRef.current.push({ element, strokes });
    startNextRecognition();
  }, [startNextRecognition]);

  // Auto-recognize handwriting shortly after inactivity
  useEffect(() => {
    if (recognitionTimeoutRef.current) {
      clearTimeout(recognitionTimeoutRef.current);
    }

    const hasStrokes = handwritingStrokes.length > 0 || currentStroke.length > 0;
    if (hasStrokes && handwritingTargetRef.current) {
      recognitionTimeoutRef.current = setTimeout(() => {
        const target = handwritingTargetRef.current;
        const strokesToProcess = [...handwritingStrokes, currentStroke].filter(s => s.length > 0);
        enqueueRecognitionJob(target, strokesToProcess);
        setHandwritingStrokes([]);
        setCurrentStroke([]);
        handwritingTargetRef.current = null;
      }, 600);
    }

    return () => {
      if (recognitionTimeoutRef.current) {
        clearTimeout(recognitionTimeoutRef.current);
      }
    };
  }, [handwritingStrokes, currentStroke, enqueueRecognitionJob]);

  const flushPendingHandwriting = () => {
    const target = handwritingTargetRef.current || lastEditingRef.current;
    const strokesToProcess = [...handwritingStrokes, currentStroke].filter(s => s.length > 0);
    if (target && strokesToProcess.length > 0) {
      enqueueRecognitionJob(target, strokesToProcess);
    }
    setHandwritingStrokes([]);
    setCurrentStroke([]);
    handwritingTargetRef.current = null;
  };

  const getElementColor = (type) => {
    switch (type) {
      case 'wall': return '#000000';
      case 'window': return '#1e40af';
      case 'door': return '#92400e';
      case 'generic': return '#059669';
      default: return '#000000';
    }
  };

  const drawLine = (ctx, element, type, allElements, occupiedBoxes, activeBounds) => {
    const { start, end, id, measurement } = element;
    const color = getElementColor(type);

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    // Selection Highlight
    const isSelected = editingElement && (
      editingElement.id === id ||
      (editingElement.selectedGroupIds && editingElement.selectedGroupIds.includes(id))
    );

    if (isSelected) {
      ctx.save();
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 6;
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    if (measurement && (!editingElement || editingElement.id !== id)) {
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const angle = Math.atan2(dy, dx);

      const offsetDistance = 20;
      const perpX = -Math.sin(angle) * offsetDistance;
      const perpY = Math.cos(angle) * offsetDistance;
      const textX = midX + perpX;
      const textY = midY + perpY;

      ctx.save();
      ctx.translate(textX, textY);

      ctx.font = 'bold 14px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const textWidth = ctx.measureText(measurement).width;
      const padding = 4;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.fillRect(-textWidth / 2 - padding, -8, textWidth + 2 * padding, 16);

      ctx.fillStyle = color;
      ctx.fillText(measurement, 0, 0);
      ctx.restore();
    }

    // NEW: Show box if it's newly drawn OR if it belongs to a selected group
    const isNewlyDrawn = newlyDrawnIds && newlyDrawnIds.includes(id);
    const isInSelectedGroup = editingElement && editingElement.selectedGroupIds && editingElement.selectedGroupIds.includes(id);
    const isPrimarySelect = editingElement && editingElement.id === id;

    if ((isNewlyDrawn && !measurement) || isInSelectedGroup || isPrimarySelect) {
      const bounds = isPrimarySelect && activeBounds
        ? activeBounds
        : calculateBoxBoundsWithAvoidance(element, allElements, occupiedBoxes);
      if (bounds) {
        const { minX, maxX, minY, maxY, centerX, centerY } = bounds;
        const isActuallyBeingEdited = isPrimarySelect && activeBounds;

        ctx.save();
        ctx.fillStyle = isActuallyBeingEdited ? 'rgba(255, 255, 255, 0.98)' : 'rgba(255, 255, 255, 0.7)';
        ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
        ctx.strokeStyle = isActuallyBeingEdited ? '#8b5cf6' : '#94a3b8';
        ctx.lineWidth = isActuallyBeingEdited ? 1.5 : 1;
        if (isActuallyBeingEdited) ctx.setLineDash([3, 3]);
        ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

        if (isActuallyBeingEdited && handwritingStrokes.length === 0 && currentStroke.length === 0) {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (ocrFailed) {
            // OCR failed — prompt user to write again more clearly
            ctx.fillStyle = '#ef4444';
            ctx.font = `bold 12px system-ui`;
            ctx.fillText('✕ Not recognised — write again', centerX, centerY - 10);
            ctx.fillStyle = '#f87171';
            ctx.font = '10px system-ui';
            ctx.fillText('Write larger and more clearly', centerX, centerY + 8);
          } else {
            // Normal idle state — invite stylus writing
            ctx.fillStyle = '#8b5cf6';
            ctx.font = `bold 13px system-ui`;
            ctx.fillText('✏  Write dimension', centerX, centerY - 8);
            ctx.fillStyle = '#c4b5fd';
            ctx.font = '10px system-ui';
            ctx.fillText("e.g.  10'  ·  3m  ·  5'-4\"", centerX, centerY + 9);
          }
        } else if (isInSelectedGroup && !isPrimarySelect) {
          // If part of group but not focused, show measurement if exists, otherwise "Tap"
          ctx.fillStyle = '#94a3b8';
          ctx.font = '10px system-ui';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(measurement || 'Tap', centerX, centerY);
        } else if (isNewlyDrawn && !isActuallyBeingEdited) {
          ctx.fillStyle = '#94a3b8';
          ctx.font = '10px system-ui';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('Tap to add', centerX, centerY);
        }
        ctx.restore();
        if (occupiedBoxes) {
          occupiedBoxes.push({ ...bounds, id });
        }
      }
    }
  };

  const drawSnapPoints = (ctx) => {
    if (mode === 'erase') return;

    const snapPoints = findSnapPoints();

    snapPoints.forEach(sp => {
      ctx.fillStyle = '#9ca3af';
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  const drawPerpendicularGuides = (ctx) => {
    if (!isDrawing || !startPoint || !snapPoint) return;

    ctx.strokeStyle = 'rgba(147, 51, 234, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);

    ctx.beginPath();
    ctx.moveTo(0, startPoint.y);
    ctx.lineTo(canvasRef.current.width, startPoint.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(startPoint.x, 0);
    ctx.lineTo(startPoint.x, canvasRef.current.height);
    ctx.stroke();

    ctx.setLineDash([]);
  };

  // Draws orange guide lines to show the active angle snap axis
  const drawAngleSnapGuides = (ctx, snapType) => {
    if (!isDrawing || !startPoint || !previewPoint || !snapType) return;
    const extentWorld = 3000;

    ctx.save();
    ctx.strokeStyle = 'rgba(249, 115, 22, 0.5)';
    ctx.lineWidth = 1.2 / viewport.k;
    ctx.setLineDash([7, 5]);

    if (snapType === 'H') {
      ctx.beginPath();
      ctx.moveTo(startPoint.x - extentWorld, startPoint.y);
      ctx.lineTo(startPoint.x + extentWorld, startPoint.y);
      ctx.stroke();
    } else if (snapType === 'V') {
      ctx.beginPath();
      ctx.moveTo(startPoint.x, startPoint.y - extentWorld);
      ctx.lineTo(startPoint.x, startPoint.y + extentWorld);
      ctx.stroke();
    } else if (snapType === '45') {
      ctx.beginPath();
      ctx.moveTo(startPoint.x - extentWorld, startPoint.y - extentWorld);
      ctx.lineTo(startPoint.x + extentWorld, startPoint.y + extentWorld);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(startPoint.x - extentWorld, startPoint.y + extentWorld);
      ctx.lineTo(startPoint.x + extentWorld, startPoint.y - extentWorld);
      ctx.stroke();
    }

    // Snapped endpoint indicator
    ctx.fillStyle = 'rgba(249, 115, 22, 0.85)';
    ctx.beginPath();
    ctx.arc(previewPoint.x, previewPoint.y, 5 / viewport.k, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };

  const drawPolylineGuides = (ctx, allElements) => {
    // Only show guides when drawing polylines in normal modes (not freehand, not when snapped)
    if (!isDrawing || !startPoint || !previewPoint || mode === 'freehand') return;

    const guides = calculatePolylineGuides(startPoint, previewPoint, allElements);
    if (guides.length === 0) return;

    ctx.save();

    guides.forEach(guide => {
      if (guide.type === 'horizontal') {
        // Horizontal alignment guide
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
        ctx.lineWidth = 1.5 / viewport.k;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.min(guide.x1, guide.x2), guide.y);
        ctx.lineTo(Math.max(guide.x1, guide.x2), guide.y);
        ctx.stroke();
      } else if (guide.type === 'vertical') {
        // Vertical alignment guide
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
        ctx.lineWidth = 1.5 / viewport.k;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(guide.x, Math.min(guide.y1, guide.y2));
        ctx.lineTo(guide.x, Math.max(guide.y1, guide.y2));
        ctx.stroke();
      } else if (guide.type === 'perpendicular') {
        // Perpendicular reference line (subtle)
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.2)';
        ctx.lineWidth = 1 / viewport.k;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(guide.fromX, guide.fromY);
        ctx.lineTo(guide.toX, guide.toY);
        ctx.stroke();
      }
    });

    ctx.restore();
  };

  const drawPolylineSegmentGuides = (ctx, segments, lastSegment) => {
    // Show guides between segments being drawn in the polyline
    if (!isDrawing || !lastSegment || segments.length <= 1) return;

    const guides = calculatePolylineSegmentGuides(segments, lastSegment, startPoint);
    if (guides.length === 0) return;

    ctx.save();

    guides.forEach(guide => {
      if (guide.type === 'horizontal' || guide.type === 'horizontal-close' || guide.type === 'horizontal-continue') {
        // Horizontal alignment with previous polygon segments or closing guides
        const isClose = guide.type === 'horizontal-close';
        const isContinue = guide.type === 'horizontal-continue';
        ctx.strokeStyle = isClose ? 'rgba(34, 197, 94, 0.4)' : isContinue ? 'rgba(168, 85, 247, 0.25)' : 'rgba(59, 130, 246, 0.35)';
        ctx.lineWidth = isClose ? 2.5 / viewport.k : 2 / viewport.k;
        ctx.setLineDash(isClose ? [6, 4] : [4, 3]);
        ctx.beginPath();
        ctx.moveTo(guide.x1, guide.y);
        ctx.lineTo(guide.x2, guide.y);
        ctx.stroke();
      } else if (guide.type === 'vertical' || guide.type === 'vertical-close' || guide.type === 'vertical-continue') {
        // Vertical alignment with previous polygon segments or closing guides
        const isClose = guide.type === 'vertical-close';
        const isContinue = guide.type === 'vertical-continue';
        ctx.strokeStyle = isClose ? 'rgba(34, 197, 94, 0.4)' : isContinue ? 'rgba(168, 85, 247, 0.25)' : 'rgba(59, 130, 246, 0.35)';
        ctx.lineWidth = isClose ? 2.5 / viewport.k : 2 / viewport.k;
        ctx.setLineDash(isClose ? [6, 4] : [4, 3]);
        ctx.beginPath();
        ctx.moveTo(guide.x, guide.y1);
        ctx.lineTo(guide.x, guide.y2);
        ctx.stroke();
      } else if (guide.type === 'perpendicular') {
        // Perpendicular guides from previous segment endpoints
        ctx.strokeStyle = 'rgba(139, 92, 246, 0.2)';
        ctx.lineWidth = 1.2 / viewport.k;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(guide.fromX, guide.fromY);
        ctx.lineTo(guide.toX, guide.toY);
        ctx.stroke();
      }
    });

    ctx.restore();
  };

  const drawGrid = (ctx) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gridSize = 50;
    const majorEvery = 5;

    const left = -viewport.x / viewport.k;
    const top = -viewport.y / viewport.k;
    const right = (canvas.width - viewport.x) / viewport.k;
    const bottom = (canvas.height - viewport.y) / viewport.k;

    const startX = Math.floor(left / gridSize) * gridSize;
    const startY = Math.floor(top / gridSize) * gridSize;

    for (let x = startX; x <= right; x += gridSize) {
      const isMajor = Math.round(x / gridSize) % majorEvery === 0;
      ctx.strokeStyle = isMajor ? 'rgba(15, 23, 42, 0.14)' : 'rgba(15, 23, 42, 0.06)';
      ctx.lineWidth = (isMajor ? 1.5 : 1) / viewport.k;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }

    for (let y = startY; y <= bottom; y += gridSize) {
      const isMajor = Math.round(y / gridSize) % majorEvery === 0;
      ctx.strokeStyle = isMajor ? 'rgba(15, 23, 42, 0.14)' : 'rgba(15, 23, 42, 0.06)';
      ctx.lineWidth = (isMajor ? 1.5 : 1) / viewport.k;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }
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

    if (gridEnabled) {
      drawGrid(ctx);
    }

    if (isDrawing && snapPoint) {
      drawPerpendicularGuides(ctx);
    }

    const allElements = [
      ...walls.map(w => ({ ...w, type: 'wall' })),
      ...doors.map(d => ({ ...d, type: 'door' })),
      ...windows.map(w => ({ ...w, type: 'window' })),
      ...generics.map(g => ({ ...g, type: 'generic' }))
    ];

    // Draw angle snap guides (shows the locked axis while drawing)
    if (isDrawing && angleSnapType) {
      drawAngleSnapGuides(ctx, angleSnapType);
    }

    // Draw polyline alignment guides
    if (isDrawing && mode !== 'freehand') {
      drawPolylineGuides(ctx, allElements);
    }

    const occupiedBoxes = [];
    const activeBounds = editingElement
      ? (boxBounds || calculateBoxBoundsWithAvoidance(editingElement, allElements, occupiedBoxes))
      : null;

    if (activeBounds && editingElement) {
      occupiedBoxes.push({ ...activeBounds, id: editingElement.id });
    }

    walls.forEach(wall => drawLine(ctx, wall, 'wall', allElements, occupiedBoxes, activeBounds));
    windows.forEach(window => drawLine(ctx, window, 'window', allElements, occupiedBoxes, activeBounds));
    doors.forEach(door => drawLine(ctx, door, 'door', allElements, occupiedBoxes, activeBounds));
    generics.forEach(generic => drawLine(ctx, generic, 'generic', allElements, occupiedBoxes, activeBounds));

    if (!isDrawing || mode !== 'erase') {
      drawSnapPoints(ctx);
    }

    // Draw Preview Line / Polyline
    if (isDrawing && startPoint) {
      const activeDrawType = mode === 'freehand' ? 'wall' : mode;
      const angleTolerance = 7; // ±7° ortho-snap — matches commit path
      const color = getElementColor(activeDrawType);

      if (mode === 'freehand') {
        if (freehandPoints.length > 1) {
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 3 / viewport.k;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.moveTo(freehandPoints[0].x, freehandPoints[0].y);
          freehandPoints.forEach(pt => ctx.lineTo(pt.x, pt.y));
          if (previewPoint) {
            ctx.lineTo(previewPoint.x, previewPoint.y);
          }
          ctx.stroke();
        }
      } else if (freehandPoints.length > 5) {
        // --- SEAMLESS ARCHITECTURAL POLYLINE PREVIEW ---
        const EPSILON = 15 / viewport.k;
        const rawPreviewSegs = processRawPoints(freehandPoints, EPSILON, angleTolerance);
        // Mirror the same ORTHO-snap that will be applied on commit so the
        // preview exactly matches what will be stored.
        const segments = (activeDrawType === 'wall' && rawPreviewSegs.length >= 1)
          ? orthoSnapSegments(rawPreviewSegs)
          : rawPreviewSegs;

        if (segments.length > 0) {
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 4 / viewport.k; // Bold architectural weight
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          ctx.moveTo(segments[0].start.x, segments[0].start.y);
          segments.forEach(seg => {
            ctx.lineTo(seg.end.x, seg.end.y);
          });

          // Perfectly connect to current cursor/snapped position
          const currentPt = previewPoint || freehandPoints[freehandPoints.length - 1];
          ctx.lineTo(currentPt.x, currentPt.y);
          ctx.stroke();

          // Draw closing edge preview when multiple segments exist
          if (segments.length > 2) {
            const lastSegEnd = segments[segments.length - 1].end;
            const startSegStart = segments[0].start;
            const distToStart = Math.hypot(lastSegEnd.x - startSegStart.x, lastSegEnd.y - startSegStart.y);
            const closingThreshold = 200 / viewport.k; // Show closing preview when reasonably close
            
            if (distToStart < closingThreshold) {
              // Draw the closing edge as a semi-transparent preview
              ctx.save();
              ctx.strokeStyle = `rgba(${color === '#000000' ? '0, 0, 0' : '30, 58, 138'}, 0.25)`;
              ctx.lineWidth = 3 / viewport.k;
              ctx.setLineDash([8, 6]);
              ctx.lineCap = 'round';
              ctx.beginPath();
              ctx.moveTo(lastSegEnd.x, lastSegEnd.y);
              ctx.lineTo(startSegStart.x, startSegStart.y);
              ctx.stroke();
              ctx.restore();

              // Highlight the closing snap point
              ctx.save();
              ctx.fillStyle = 'rgba(34, 197, 94, 0.6)';
              ctx.beginPath();
              ctx.arc(startSegStart.x, startSegStart.y, 6 / viewport.k, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = 'rgba(34, 197, 94, 0.8)';
              ctx.lineWidth = 2 / viewport.k;
              ctx.stroke();
              
              // Add a pulsing ring to draw attention
              ctx.strokeStyle = `rgba(34, 197, 94, ${0.3 + 0.2 * Math.sin(Date.now() / 300)})`;
              ctx.lineWidth = 1 / viewport.k;
              ctx.beginPath();
              ctx.arc(startSegStart.x, startSegStart.y, 10 / viewport.k, 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
            }
          }

          // Draw guides for polyline alignment (helping connect segments)
          if (segments.length > 1) {
            const lastSegment = segments[segments.length - 1];
            drawPolylineSegmentGuides(ctx, segments, lastSegment);
          }
        }
      } else if (previewPoint) {
        // Standard single straight line preview
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 4 / viewport.k;
        ctx.lineCap = 'round';
        ctx.moveTo(startPoint.x, startPoint.y);
        ctx.lineTo(previewPoint.x, previewPoint.y);
        ctx.stroke();
      }
    }

    ctx.restore(); // Restore convert transform for anything else (if needed) but we are done drawing world elements

    // Drawn handwriting strokes (Screen Space or World Space? World Space relative to editing element)
    // Actually handwriting canvas is separate overlaid. 
    // We should probably clear it and handle it separately or transform it too?
    // The previous implementation used a second canvas 'handwritingCanvasRef'.
    // We need to ensure that matches the transform IF the box moves with zoom.
    // BUT the boxBounds are calculated in World Space. 
    // The handwriting is captured in... Screen Space in original? 
    // Looking at `handleMove`: stroke points are `point` which is now World.
    // So handwriting is stored in WORLD coordinates. 
    // So handwriting canvas MUST also be transformed.

  }, [walls, doors, windows, generics, editingElement, boxBounds, handwritingStrokes, currentStroke, isDrawing, startPoint, previewPoint, snapPoint, mode, viewport, gridEnabled, angleSnapType, ocrFailed]);

  // Transform Handwriting Canvas
  useEffect(() => {
    const canvas = handwritingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.k, viewport.k);

    if (!editingElement) {
      ctx.restore();
      return;
    }

    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 4 / viewport.k; // Thick enough for stylus preview
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    [...handwritingStrokes, currentStroke].forEach(stroke => {
      if (stroke.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      stroke.forEach(point => ctx.lineTo(point.x, point.y));
      ctx.stroke();
    });

    ctx.restore();
  }, [handwritingStrokes, currentStroke, editingElement, viewport]);

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        onWheel={handleWheel}
      />

      <canvas
        ref={handwritingCanvasRef}
        className="absolute inset-0 w-full h-full touch-none"
        style={{
          cursor: isPanning ? 'grabbing' : editingElement ? 'crosshair' : mode === 'erase' ? 'pointer' : isDrawing ? 'crosshair' : 'default',
          pointerEvents: 'auto'
        }}
        onMouseDown={handleStart}
        onMouseMove={handleMove}
        onMouseUp={handleEnd}
        onMouseLeave={handleEnd}
        onWheel={handleWheel}
        onTouchStart={handleStart}
        onTouchMove={handleMove}
        onTouchEnd={handleEnd}
      />

      {/* Keyboard fallback — only shown when user explicitly taps "⌨ type instead" */}
      {showManualInput && manualInputElement && (() => {
        let sx = 0, sy = 0;
        if (boxBounds) {
          const s = worldToScreen(boxBounds.centerX, boxBounds.centerY);
          sx = s.x; sy = s.y;
        } else {
          const canvas = canvasRef.current;
          if (canvas) { sx = canvas.width / 2; sy = canvas.height / 2; }
        }
        return (
          <div
            style={{ position: 'absolute', left: sx, top: sy, transform: 'translate(-50%, -50%)', zIndex: 50 }}
            className="bg-white border-2 border-orange-400 rounded-xl shadow-2xl px-3 py-2 flex flex-col gap-1"
            onPointerDown={e => e.stopPropagation()}
          >
            <p className="text-xs text-orange-500 font-semibold text-center">Type measurement</p>
            <div className="flex items-center gap-1">
              <input
                ref={manualInputRef}
                type="text"
                autoFocus
                placeholder="e.g. 10  10'  3m  5'-4&quot;"
                className="text-sm font-mono border border-gray-300 rounded px-2 py-1 w-36 outline-none focus:border-orange-400"
                onKeyDown={e => {
                  if (e.key === 'Enter') handleManualMeasurementSubmit(e.target.value);
                  if (e.key === 'Escape') { setShowManualInput(false); setManualInputElement(null); }
                }}
              />
              <button
                onClick={() => manualInputRef.current && handleManualMeasurementSubmit(manualInputRef.current.value)}
                className="bg-orange-500 hover:bg-orange-600 text-white rounded px-2 py-1 text-sm font-bold"
              >✓</button>
            </div>
            <button
              onClick={() => { setShowManualInput(false); setManualInputElement(null); }}
              className="text-xs text-gray-400 hover:text-gray-600 text-center"
            >Cancel</button>
          </div>
        );
      })()}

      {/* "⌨ type instead" link — only shown when OCR has failed, for non-tablet users */}
      {ocrFailed && editingElement && !showManualInput && (() => {
        let sx = 0, sy = 0;
        if (boxBounds) {
          const s = worldToScreen(boxBounds.centerX, boxBounds.maxY);
          sx = s.x; sy = s.y + 8;
        } else {
          const canvas = canvasRef.current;
          if (canvas) { sx = canvas.width / 2; sy = canvas.height / 2 + 60; }
        }
        return (
          <button
            style={{ position: 'absolute', left: sx, top: sy, transform: 'translate(-50%, 0)', zIndex: 40 }}
            className="text-xs text-gray-400 hover:text-purple-500 underline underline-offset-2 bg-white/80 px-2 py-0.5 rounded"
            onPointerDown={e => { e.stopPropagation(); setManualInputElement(editingElement); setShowManualInput(true); setOcrFailed(false); }}
          >⌨ type instead</button>
        );
      })()}

      {/* ORTHO mode toggle — constrains lines to 0° / 90° only */}
      <button
        onClick={() => setOrthoMode(prev => !prev)}
        title={orthoMode ? 'ORTHO ON – click to allow diagonals' : 'ORTHO OFF – click to lock to 0°/90°'}
        className={`absolute bottom-6 left-6 px-3 py-1.5 rounded text-xs font-mono font-semibold shadow transition-colors select-none ${
          orthoMode
            ? 'bg-orange-500 text-white'
            : 'bg-white text-gray-500 border border-gray-300 hover:border-orange-400 hover:text-orange-500'
        }`}
      >
        ORTHO {orthoMode ? 'ON' : 'OFF'}
      </button>

      {isRecognizing && (
        <div className="absolute top-6 right-6 bg-purple-600 text-white rounded-full px-4 py-2 shadow-lg flex items-center gap-2 text-sm">
          <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
          <span>Recognizing...</span>
        </div>
      )}
    </div>
  );
}

