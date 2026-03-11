// src/components/IdeateCanvas.jsx
//
// IDEATE — infinite freehand sketch canvas
//
// New in this version
// ───────────────────
//  • Per-tool brush props  (color, size, opacity, smoothness)
//  • Color picker          (quick palette + HSL sliders)
//  • Smoothness processing (Chaikin curve → 100% = straight line)
//  • Shape recognition     (line / rect / ellipse snap on commit)
//  • Grid snap             (endpoint snap to GRID_MAJOR grid on commit)
//  • Stylus-only mode      (finger always pans; only Apple Pencil draws)
//  • 2-finger tap → undo   3-finger tap → redo
//  • Expanded side toolbar with sliders

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  Pencil, Highlighter, Eraser, Lasso, Hand,
  Undo2, Redo2, Grid, Minus, Plus, Shapes, Magnet,
} from 'lucide-react';
import {
  pubStrokeStart,
  pubStrokeMove,
  pubStrokeEnd,
  pubStrokeCommitted,
  pubStrokeUndo,
  pubStrokeErased,
} from '../utils/behaviourBus';

// ── Constants ────────────────────────────────────────────────────────────────
const MIN_ZOOM    = 0.05;
const MAX_ZOOM    = 8.0;
const BG_COLOR    = '#FAFAFA';
const GRID_MINOR  = 10;
const GRID_MAJOR  = 100;
const MAX_HISTORY = 50;
const TAP_MS      = 280;   // max ms for a multi-finger tap
const TAP_MOV_PX  = 12;    // max movement (px) before tap becomes drag

let _sid = 1;

// ── Per-tool defaults ─────────────────────────────────────────────────────────
const TOOL_DEFAULTS = {
  pen    : { color: '#111111', size: 2.5, opacity: 1.00, smoothness: 0.20 },
  marker : { color: '#111111', size: 16,  opacity: 0.30, smoothness: 0.40 },
  eraser : { color: BG_COLOR,  size: 32,  opacity: 1.00, smoothness: 0    },
  lasso  : { color: '#3b82f6', size: 1.5, opacity: 0.85, smoothness: 0    },
  hand   : { color: null,      size: 0,   opacity: 1.00, smoothness: 0    },
};

const TOOL_CURSOR = {
  pen: 'crosshair', marker: 'crosshair',
  eraser: 'cell', lasso: 'default', hand: 'grab',
};

const QUICK_PALETTE = [
  '#111111', '#555555', '#999999', '#CCCCCC', '#FFFFFF',
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#3B82F6',
  '#8B5CF6', '#EC4899',
];

// ── Color utilities ───────────────────────────────────────────────────────────
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

function hexToHsl(hex) {
  const n = hex.replace('#', '');
  if (n.length !== 6) return { h: 0, s: 0, l: 0 };
  let r = parseInt(n.slice(0, 2), 16) / 255;
  let g = parseInt(n.slice(2, 4), 16) / 255;
  let b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// ── Path utilities ────────────────────────────────────────────────────────────
function arcLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++)
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return len;
}

function rdpSimplify(pts, eps) {
  if (pts.length <= 2) return pts;
  const distToSeg = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const l = rdpSimplify(pts.slice(0, idx + 1), eps);
    const r = rdpSimplify(pts.slice(idx), eps);
    return [...l.slice(0, -1), ...r];
  }
  return [pts[0], pts[pts.length - 1]];
}

// ── Stroke processing ─────────────────────────────────────────────────────────

/** Chaikin curve smoothing. smoothness 0→1 (0=raw, ~1=straight line). */
function applySmoothing(points, smoothness) {
  if (!points || points.length < 2 || smoothness < 0.05) return points;
  if (smoothness > 0.95) return [points[0], points[points.length - 1]];
  const rounds = Math.max(1, Math.round(smoothness * 5));
  let pts = [...points];
  for (let r = 0; r < rounds; r++) {
    if (pts.length < 2) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y, pressure: a.pressure });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y, pressure: b.pressure });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/** Snap start + end points to nearest grid vertex. */
function applyGridSnap(points, gridSize) {
  if (!points || points.length < 2 || gridSize <= 0) return points;
  const snap = pt => ({ ...pt, x: Math.round(pt.x / gridSize) * gridSize, y: Math.round(pt.y / gridSize) * gridSize });
  const result = [...points];
  result[0] = snap(result[0]);
  result[result.length - 1] = snap(result[result.length - 1]);
  return result;
}

/**
 * Recognize a line, rectangle, or ellipse.
 * Returns replacement points array, or null if no shape detected.
 */
function tryRecognizeShape(points) {
  if (!points || points.length < 5) return null;
  const arc   = arcLength(points);
  if (arc < 40) return null;

  const first = points[0], last = points[points.length - 1];

  // Straight line
  const endDist = Math.hypot(last.x - first.x, last.y - first.y);
  if (endDist / arc > 0.88) {
    return [{ x: first.x, y: first.y, pressure: 0.5 }, { x: last.x, y: last.y, pressure: 0.5 }];
  }

  // Closed shape?
  if (Math.hypot(last.x - first.x, last.y - first.y) > arc * 0.25) return null;

  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const W = maxX - minX, H = maxY - minY;
  if (W < 15 || H < 15) return null;

  const eps        = Math.min(W, H) * 0.08;
  const simplified = rdpSimplify(points, eps);
  const nCorners   = simplified.length;

  // Rectangle: 3–7 corners with roughly right angles
  if (nCorners >= 3 && nCorners <= 7) {
    let rightAngles = 0;
    for (let i = 0; i < simplified.length - 2; i++) {
      const a = simplified[i], b = simplified[i + 1], c = simplified[i + 2];
      const dx1 = b.x - a.x, dy1 = b.y - a.y;
      const dx2 = c.x - b.x, dy2 = c.y - b.y;
      const angle = Math.abs(Math.atan2(Math.abs(dx1 * dy2 - dy1 * dx2), dx1 * dx2 + dy1 * dy2));
      if (Math.abs(angle - Math.PI / 2) < 0.45) rightAngles++;
    }
    if (rightAngles >= 2) {
      const p = 0.5;
      return [
        { x: minX, y: minY, pressure: p }, { x: maxX, y: minY, pressure: p },
        { x: maxX, y: maxY, pressure: p }, { x: minX, y: maxY, pressure: p },
        { x: minX, y: minY, pressure: p },
      ];
    }
  }

  // Ellipse / Circle
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rx = W / 2, ry = H / 2;
  const pts = [];
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), pressure: 0.5 });
  }
  return pts;
}

// ── Stroke rendering ──────────────────────────────────────────────────────────
function renderStroke(ctx, stroke) {
  const { points, color, size, opacity, tool } = stroke;
  if (!points || points.length < 2) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (tool === 'lasso') {
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (tool === 'pen') {
    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1], p1 = points[i];
      const p  = Math.max(0.15, (p0.pressure + p1.pressure) / 2);
      ctx.beginPath();
      ctx.lineWidth = Math.max(0.5, size * p);
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
  } else {
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.stroke();
  }
  ctx.restore();
}

// ── Grid rendering ────────────────────────────────────────────────────────────
function renderGrid(ctx, W, H, vp) {
  const { x: ox, y: oy, k } = vp;
  const majorPx = GRID_MAJOR * k, minorPx = GRID_MINOR * k;
  if (minorPx >= 5) _gridLines(ctx, W, H, ox, oy, minorPx, 'rgba(0,0,0,0.045)');
  _gridLines(ctx, W, H, ox, oy, majorPx, 'rgba(0,0,0,0.09)');
}
function _gridLines(ctx, W, H, ox, oy, size, color) {
  const sx = ((ox % size) + size) % size, sy = ((oy % size) + size) % size;
  ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 0.5;
  for (let x = sx; x <= W; x += size) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = sy; y <= H; y += size) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
}

// ── ColorPicker sub-component ─────────────────────────────────────────────────
function ColorPicker({ color, onChange, onClose }) {
  const hsl = hexToHsl(color);
  const [h, setH] = useState(hsl.h);
  const [s, setS] = useState(hsl.s);
  const [l, setL] = useState(hsl.l);
  const [hex, setHex] = useState(color);

  const commit = (nh, ns, nl) => {
    const c = hslToHex(nh, ns, nl);
    setHex(c); onChange(c);
  };
  const handleQuick = (c) => {
    const { h: nh, s: ns, l: nl } = hexToHsl(c);
    setH(nh); setS(ns); setL(nl); setHex(c); onChange(c);
  };
  const handleHex = (v) => {
    setHex(v);
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      const { h: nh, s: ns, l: nl } = hexToHsl(v);
      setH(nh); setS(ns); setL(nl); onChange(v);
    }
  };

  const sliders = [
    { label: 'H', val: h, max: 360, set: v => { setH(v); commit(v, s, l); },
      bg: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' },
    { label: 'S', val: s, max: 100, set: v => { setS(v); commit(h, v, l); },
      bg: `linear-gradient(to right,${hslToHex(h, 0, l)},${hslToHex(h, 100, l)})` },
    { label: 'L', val: l, max: 100, set: v => { setL(v); commit(h, s, v); },
      bg: `linear-gradient(to right,#000,${hslToHex(h, s, 50)},#fff)` },
  ];

  return (
    <div
      className="absolute left-full ml-2 top-0 z-30 rounded-2xl border border-gray-200/80 shadow-xl p-3 w-52"
      style={{ background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(12px)' }}
      onClick={e => e.stopPropagation()}
    >
      {/* Quick palette */}
      <div className="grid grid-cols-6 gap-1 mb-3">
        {QUICK_PALETTE.map(c => (
          <button
            key={c}
            onClick={() => handleQuick(c)}
            className="w-6 h-6 rounded-md transition-all hover:scale-110"
            style={{
              backgroundColor: c,
              border: c === color ? '2px solid #3b82f6' : c === '#FFFFFF' ? '1px solid #e5e7eb' : '1px solid transparent',
            }}
          />
        ))}
      </div>

      {/* HSL sliders */}
      <div className="space-y-2.5">
        {sliders.map(({ label, val, max, set, bg }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-xs font-mono text-gray-400 w-3">{label}</span>
            <div className="relative flex-1 h-3 rounded-full overflow-hidden" style={{ background: bg }}>
              <input
                type="range" min={0} max={max} value={val}
                onChange={e => set(parseInt(e.target.value))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow pointer-events-none"
                style={{ left: `calc(${(val / max) * 100}% - 6px)`, background: hslToHex(h, s, l) }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Hex input */}
      <div className="mt-3 flex items-center gap-2">
        <div className="w-5 h-5 rounded border border-gray-200 flex-shrink-0" style={{ background: hex }} />
        <input
          type="text" value={hex} onChange={e => handleHex(e.target.value)}
          className="flex-1 text-xs font-mono border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400"
          maxLength={7}
        />
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
      </div>
    </div>
  );
}

// ── Tiny shared sub-components ────────────────────────────────────────────────
function SliderRow({ label, value, min, max, step, display, onChange }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-gray-400 font-medium">{label}</span>
        <span className="text-xs font-mono text-gray-500">{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1 rounded-full cursor-pointer"
        style={{ accentColor: '#111827' }}
      />
    </div>
  );
}

function ToggleRow({ label, active, Icon, onToggle }) {
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-all duration-150 ${
        active ? 'bg-gray-900 text-white' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700'
      }`}
    >
      <Icon size={11} />
      <span className="font-medium">{label}</span>
      <div className="ml-auto relative w-6 h-3.5 rounded-full flex-shrink-0" style={{ background: active ? 'rgba(255,255,255,0.3)' : '#e5e7eb' }}>
        <div
          className="absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all duration-150"
          style={{ left: active ? '12px' : '1px', background: active ? 'white' : '#9ca3af' }}
        />
      </div>
    </button>
  );
}

function BarBtn({ onClick, disabled, title, active, children }) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      className={`p-2 rounded-full transition-all ${
        active   ? 'bg-gray-900 text-white' :
        disabled ? 'opacity-25 cursor-not-allowed text-gray-700' :
                   'text-gray-700 hover:bg-gray-100'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() { return <div className="w-px h-4 bg-gray-200 mx-0.5" />; }

// ── Main component ────────────────────────────────────────────────────────────
export default function IdeateCanvas() {
  const bgRef        = useRef(null);
  const fgRef        = useRef(null);
  const containerRef = useRef(null);

  // Mutable drawing state (refs — zero React re-renders per frame)
  const vpRef            = useRef({ x: 0, y: 0, k: 1 });
  const strokesRef       = useRef([]);
  const pastRef          = useRef([]);
  const futureRef        = useRef([]);
  const liveRef          = useRef(null);
  const preEraseRef      = useRef(null);
  const activePointerRef = useRef(null);
  const panPointerRef    = useRef(null);
  const panRef           = useRef(null);
  const pinchRef         = useRef(null);
  const tapRef           = useRef(null);
  const bhvMoveThrottleRef = useRef(0);  // behaviour: last pubStrokeMove timestamp

  // Ref mirrors (read by event handlers — avoids stale closures)
  const toolRef       = useRef('pen');
  const gridRef       = useRef(false);
  const stylusOnlyRef = useRef(false);
  const shapeSnapRef  = useRef(false);
  const gridSnapRef   = useRef(false);

  // Per-tool brush properties
  const toolPropsRef = useRef({
    pen    : { ...TOOL_DEFAULTS.pen    },
    marker : { ...TOOL_DEFAULTS.marker },
    eraser : { ...TOOL_DEFAULTS.eraser },
    lasso  : { ...TOOL_DEFAULTS.lasso  },
    hand   : { ...TOOL_DEFAULTS.hand   },
  });

  // React state (toolbar only)
  const [activeTool,       _setActiveTool   ] = useState('pen');
  const [zoom,              setZoom          ] = useState(1);
  const [gridEnabled,      _setGrid         ] = useState(false);
  const [stylusOnly,       _setStylusOnly   ] = useState(false);
  const [shapeSnap,        _setShapeSnap    ] = useState(false);
  const [gridSnap,         _setGridSnap     ] = useState(false);
  const [canUndo,           setCanUndo      ] = useState(false);
  const [canRedo,           setCanRedo      ] = useState(false);
  const [colorPickerOpen,   setColorPickerOpen] = useState(false);
  const [toolProps,         setToolProps    ] = useState({ ...TOOL_DEFAULTS.pen });

  // Sync helpers
  const setTool = useCallback((t) => {
    toolRef.current = t; _setActiveTool(t);
    setToolProps({ ...toolPropsRef.current[t] });
    setColorPickerOpen(false);
  }, []);

  const updateToolProp = useCallback((prop, value) => {
    toolPropsRef.current[toolRef.current][prop] = value;
    setToolProps(prev => ({ ...prev, [prop]: value }));
  }, []);

  const syncHistory = useCallback(() => {
    setCanUndo(pastRef.current.length   > 0);
    setCanRedo(futureRef.current.length > 0);
  }, []);

  // ── Rendering ──────────────────────────────────────────────────────────────
  const drawBg = useCallback(() => {
    const bg = bgRef.current; if (!bg) return;
    const ctx = bg.getContext('2d'), W = bg.width, H = bg.height;
    ctx.fillStyle = BG_COLOR; ctx.fillRect(0, 0, W, H);
    if (gridRef.current) renderGrid(ctx, W, H, vpRef.current);
    const { x: ox, y: oy, k } = vpRef.current;
    ctx.save(); ctx.translate(ox, oy); ctx.scale(k, k);
    for (const s of strokesRef.current) renderStroke(ctx, s);
    ctx.restore();
  }, []);

  const drawFg = useCallback(() => {
    const fg = fgRef.current; if (!fg) return;
    const ctx = fg.getContext('2d');
    ctx.clearRect(0, 0, fg.width, fg.height);
    const stroke = liveRef.current;
    if (!stroke || stroke.points.length < 2) return;
    const { x: ox, y: oy, k } = vpRef.current;
    ctx.save(); ctx.translate(ox, oy); ctx.scale(k, k);
    renderStroke(ctx, stroke); ctx.restore();
  }, []);

  const clearFg = useCallback(() => {
    const fg = fgRef.current; if (!fg) return;
    fg.getContext('2d').clearRect(0, 0, fg.width, fg.height);
  }, []);

  // ── Canvas sizing ───────────────────────────────────────────────────────────
  const resize = useCallback(() => {
    const c = containerRef.current, bg = bgRef.current, fg = fgRef.current;
    if (!c || !bg || !fg) return;
    const W = c.clientWidth, H = c.clientHeight;
    [bg, fg].forEach(cv => {
      cv.width = W; cv.height = H;
      cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    });
    drawBg();
  }, [drawBg]);

  useEffect(() => {
    resize();
    const ro = new ResizeObserver(resize);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [resize]);

  // ── History ─────────────────────────────────────────────────────────────────
  const saveHistory = useCallback(() => {
    pastRef.current   = [...pastRef.current, [...strokesRef.current]].slice(-MAX_HISTORY);
    futureRef.current = [];
    syncHistory();
  }, [syncHistory]);

  const undo = useCallback(() => {
    if (!pastRef.current.length) return;
    // Find which stroke was just removed (for behaviour zone tracking)
    const prev = pastRef.current[pastRef.current.length - 1];
    const removed = strokesRef.current.filter(s => !prev.find(p => p.id === s.id));
    for (const rs of removed) {
      if (rs.points.length > 0) {
        const mid = rs.points[Math.floor(rs.points.length / 2)];
        pubStrokeUndo(`${Math.floor(mid.x / 300)}_${Math.floor(mid.y / 300)}`);
      }
    }
    futureRef.current  = [strokesRef.current, ...futureRef.current];
    strokesRef.current = prev;
    pastRef.current    = pastRef.current.slice(0, -1);
    liveRef.current    = null;
    drawBg(); clearFg(); syncHistory();
  }, [drawBg, clearFg, syncHistory]);

  const redo = useCallback(() => {
    if (!futureRef.current.length) return;
    pastRef.current    = [...pastRef.current, strokesRef.current];
    strokesRef.current = futureRef.current[0];
    futureRef.current  = futureRef.current.slice(1);
    liveRef.current    = null;
    drawBg(); clearFg(); syncHistory();
  }, [drawBg, clearFg, syncHistory]);

  // ── Coordinate helpers ──────────────────────────────────────────────────────
  const toWorld = useCallback((clientX, clientY) => {
    const fg = fgRef.current, rect = fg?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const { x: ox, y: oy, k } = vpRef.current;
    return { x: (clientX - rect.left - ox) / k, y: (clientY - rect.top - oy) / k };
  }, []);

  // ── Zoom ────────────────────────────────────────────────────────────────────
  const doZoom = useCallback((factor, clientX, clientY) => {
    const vp   = vpRef.current, fg = fgRef.current;
    const rect = fg?.getBoundingClientRect();
    const sx   = rect ? clientX - rect.left : 0, sy = rect ? clientY - rect.top : 0;
    const newK = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.k * factor));
    const s    = newK / vp.k;
    vpRef.current = { k: newK, x: sx - s * (sx - vp.x), y: sy - s * (sy - vp.y) };
    setZoom(newK); drawBg(); clearFg();
  }, [drawBg, clearFg]);

  const resetViewport = useCallback(() => {
    vpRef.current = { x: 0, y: 0, k: 1 }; setZoom(1); drawBg(); clearFg();
  }, [drawBg, clearFg]);

  // ── Stroke post-processing + commit ─────────────────────────────────────────
  const processAndCommit = useCallback((rawStroke) => {
    if (!rawStroke || rawStroke.points.length < 2) return;
    let pts = rawStroke.points;

    // 1. Chaikin smoothing (pen + marker)
    if (['pen', 'marker'].includes(rawStroke.tool))
      pts = applySmoothing(pts, toolPropsRef.current[rawStroke.tool].smoothness);

    // 2. Grid snap
    if (gridSnapRef.current)
      pts = applyGridSnap(pts, GRID_MAJOR);

    // 3. Shape recognition (pen only)
    if (shapeSnapRef.current && rawStroke.tool === 'pen') {
      const recognized = tryRecognizeShape(pts);
      if (recognized) pts = recognized;
    }

    saveHistory();
    strokesRef.current = [...strokesRef.current, { ...rawStroke, points: pts }];

    // ── Behaviour capture: stroke committed ────────────────────────────────
    if (pts.length > 0) {
      const mid = pts[Math.floor(pts.length / 2)];
      pubStrokeCommitted(mid.x, mid.y);
    }

    drawBg();
  }, [saveHistory, drawBg]);

  // ── Pointer handlers ────────────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    const tool      = toolRef.current;
    const isFinger  = e.pointerType === 'touch';
    const shouldPan = tool === 'hand' || (stylusOnlyRef.current && isFinger);

    if (shouldPan) {
      if (activePointerRef.current !== null) return;
      panRef.current        = { cx: e.clientX, cy: e.clientY, ...vpRef.current };
      panPointerRef.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (activePointerRef.current !== null) return;
    activePointerRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);

    const pt       = toWorld(e.clientX, e.clientY);
    const pressure = e.pressure > 0 ? e.pressure : 0.5;
    const props    = toolPropsRef.current[tool];

    liveRef.current = {
      id: `s${_sid++}`, tool,
      points:    [{ ...pt, pressure }],
      color:     props.color,
      size:      props.size,
      opacity:   props.opacity,
      timestamp: Date.now(),
    };

    // ── Behaviour capture ──────────────────────────────────────────────────
    pubStrokeStart(pt.x, pt.y);

    if (tool === 'eraser' && !preEraseRef.current)
      preEraseRef.current = [...strokesRef.current];
  }, [toWorld]);

  const onPointerMove = useCallback((e) => {
    e.preventDefault();

    if (e.pointerId === panPointerRef.current && panRef.current) {
      const dx = e.clientX - panRef.current.cx, dy = e.clientY - panRef.current.cy;
      vpRef.current = { ...vpRef.current, x: panRef.current.x + dx, y: panRef.current.y + dy };
      drawBg(); clearFg(); return;
    }

    if (e.pointerId !== activePointerRef.current || !liveRef.current) return;

    const evts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evts) {
      const pt = toWorld(ev.clientX, ev.clientY);
      liveRef.current.points.push({ ...pt, pressure: ev.pressure > 0 ? ev.pressure : 0.5 });
    }

    if (liveRef.current.tool === 'eraser') {
      const pt = toWorld(e.clientX, e.clientY);
      const r  = (toolPropsRef.current.eraser.size / 2) / vpRef.current.k;
      const before = strokesRef.current.length;
      strokesRef.current = strokesRef.current.filter(
        s => !s.points.some(p => Math.hypot(p.x - pt.x, p.y - pt.y) < r)
      );
      if (strokesRef.current.length !== before) drawBg();
      return;
    }

    // ── Behaviour capture: throttled stroke:move (~10fps) ──────────────────
    {
      const now = Date.now();
      if (now - bhvMoveThrottleRef.current >= 100) {
        bhvMoveThrottleRef.current = now;
        const mpt = toWorld(e.clientX, e.clientY);
        pubStrokeMove(mpt.x, mpt.y);
      }
    }

    drawFg();
  }, [drawBg, drawFg, clearFg, toWorld]);

  const onPointerUp = useCallback((e) => {
    e.preventDefault();

    if (e.pointerId === panPointerRef.current) {
      panRef.current = null; panPointerRef.current = null; return;
    }

    if (e.pointerId !== activePointerRef.current) return;
    activePointerRef.current = null;
    const stroke = liveRef.current;
    liveRef.current = null;
    clearFg();

    if (!stroke) return;

    // ── Behaviour capture: stroke end ──────────────────────────────────────
    if (stroke.points.length > 0) {
      const last = stroke.points[stroke.points.length - 1];
      pubStrokeEnd(last.x, last.y);
    }

    if (stroke.tool === 'eraser') {
      if (preEraseRef.current !== null) {
        // Publish erased events for removed strokes' zones
        const removedStrokes = preEraseRef.current.filter(
          s => !strokesRef.current.find(r => r.id === s.id)
        );
        for (const rs of removedStrokes) {
          if (rs.points.length > 0) {
            const mid = rs.points[Math.floor(rs.points.length / 2)];
            pubStrokeErased(`${Math.floor(mid.x / 300)}_${Math.floor(mid.y / 300)}`);
          }
        }
        pastRef.current   = [...pastRef.current, preEraseRef.current].slice(-MAX_HISTORY);
        futureRef.current = [];
        preEraseRef.current = null;
        syncHistory();
      }
      return;
    }

    if (stroke.tool === 'lasso') return;

    processAndCommit(stroke);
  }, [clearFg, processAndCommit, syncHistory]);

  // ── Wheel zoom ──────────────────────────────────────────────────────────────
  const onWheel = useCallback((e) => {
    e.preventDefault();
    doZoom(e.deltaY < 0 ? 1.1 : 0.9, e.clientX, e.clientY);
  }, [doZoom]);

  // ── Touch: pinch zoom + multi-finger tap ────────────────────────────────────
  const onTouchStart = useCallback((e) => {
    const n = e.touches.length;
    if (n >= 2) {
      e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      tapRef.current = {
        fingers: n, t: Date.now(), moved: false,
        startPositions: Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY })),
      };
      pinchRef.current = {
        dist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY),
        cx: (t0.clientX + t1.clientX) / 2, cy: (t0.clientY + t1.clientY) / 2,
        vp: { ...vpRef.current },
      };
      activePointerRef.current = null;
      liveRef.current = null;
      preEraseRef.current = null;
      clearFg();
    }
  }, [clearFg]);

  const onTouchMove = useCallback((e) => {
    if (e.touches.length >= 2 && pinchRef.current) {
      e.preventDefault();
      if (tapRef.current) {
        const moved = Array.from(e.touches).some((t, i) => {
          const s = tapRef.current.startPositions[i];
          return s && Math.hypot(t.clientX - s.x, t.clientY - s.y) > TAP_MOV_PX;
        });
        if (moved) tapRef.current.moved = true;
      }
      const t0 = e.touches[0], t1 = e.touches[1];
      const nd = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const ncx = (t0.clientX + t1.clientX) / 2, ncy = (t0.clientY + t1.clientY) / 2;
      const { dist: od, vp, cx: ocx, cy: ocy } = pinchRef.current;
      const fg = fgRef.current, rect = fg?.getBoundingClientRect();
      const scale = nd / od;
      const newK  = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.k * scale));
      const s     = newK / vp.k;
      const ox    = ocx - (rect?.left ?? 0), oy2 = ocy - (rect?.top ?? 0);
      vpRef.current = {
        k: newK,
        x: vp.x * s + ox  * (1 - s) + (ncx - ocx),
        y: vp.y * s + oy2 * (1 - s) + (ncy - ocy),
      };
      setZoom(newK); drawBg(); clearFg();
    }
  }, [drawBg, clearFg]);

  const onTouchEnd = useCallback((e) => {
    const tap = tapRef.current;
    if (tap && !tap.moved && Date.now() - tap.t < TAP_MS && e.touches.length === 0) {
      if (tap.fingers === 2) undo();
      if (tap.fingers === 3) redo();
    }
    if (e.touches.length < 2) { pinchRef.current = null; tapRef.current = null; }
  }, [undo, redo]);

  // ── Register non-passive listeners ─────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current; if (!fg) return;
    fg.addEventListener('wheel',      onWheel,      { passive: false });
    fg.addEventListener('touchstart', onTouchStart, { passive: false });
    fg.addEventListener('touchmove',  onTouchMove,  { passive: false });
    fg.addEventListener('touchend',   onTouchEnd,   { passive: false });
    return () => {
      fg.removeEventListener('wheel',      onWheel);
      fg.removeEventListener('touchstart', onTouchStart);
      fg.removeEventListener('touchmove',  onTouchMove);
      fg.removeEventListener('touchend',   onTouchEnd);
    };
  }, [onWheel, onTouchStart, onTouchMove, onTouchEnd]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault(); e.shiftKey ? redo() : undo(); return;
      }
      const map = { p: 'pen', m: 'marker', e: 'eraser', l: 'lasso', h: 'hand' };
      if (map[e.key?.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, setTool]);

  // ── Toolbar controls ────────────────────────────────────────────────────────
  const handleClear = () => {
    if (!strokesRef.current.length) return;
    saveHistory(); strokesRef.current = []; drawBg();
  };

  const handleZoom = (dir) => {
    const fg = fgRef.current, rect = fg?.getBoundingClientRect();
    doZoom(dir > 0 ? 1.25 : 0.8, rect ? rect.left + rect.width / 2 : 0, rect ? rect.top + rect.height / 2 : 0);
  };

  const handleGridToggle  = () => { gridRef.current = !gridRef.current; _setGrid(v => !v); drawBg(); };
  const toggleStylusOnly  = () => { stylusOnlyRef.current = !stylusOnlyRef.current; _setStylusOnly(v => !v); };
  const toggleShapeSnap   = () => { shapeSnapRef.current  = !shapeSnapRef.current;  _setShapeSnap(v => !v);  };
  const toggleGridSnap    = () => { gridSnapRef.current   = !gridSnapRef.current;   _setGridSnap(v => !v);   };

  // ── Toolbar config ──────────────────────────────────────────────────────────
  const TOOLS = [
    { id: 'pen',    Icon: Pencil,      label: 'Pen'    },
    { id: 'marker', Icon: Highlighter, label: 'Marker' },
    { id: 'eraser', Icon: Eraser,      label: 'Eraser' },
    { id: 'lasso',  Icon: Lasso,       label: 'Lasso'  },
    { id: 'hand',   Icon: Hand,        label: 'Pan'    },
  ];

  const showColor   = ['pen', 'marker', 'lasso'].includes(activeTool);
  const showSize    = ['pen', 'marker', 'eraser'].includes(activeTool);
  const showOpacity = ['pen', 'marker'].includes(activeTool);
  const showSmooth  = ['pen', 'marker'].includes(activeTool);

  const zoomPct     = Math.round(zoom * 100);
  const panelStyle  = { background: 'rgba(255,255,255,0.93)', backdropFilter: 'blur(10px)' };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      className="w-full h-full relative overflow-hidden"
      style={{ background: BG_COLOR, userSelect: 'none', WebkitUserSelect: 'none' }}
      onClick={() => colorPickerOpen && setColorPickerOpen(false)}
    >
      {/* Canvas stack */}
      <div ref={containerRef} className="absolute inset-0">
        <canvas ref={bgRef} className="absolute inset-0 pointer-events-none" />
        <canvas
          ref={fgRef}
          className="absolute inset-0"
          style={{ cursor: TOOL_CURSOR[activeTool] ?? 'crosshair', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={resetViewport}
        />
      </div>

      {/* ── Left toolbar ─────────────────────────────────────────────────── */}
      <div
        className="absolute left-4 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-2 pointer-events-auto"
        style={{ width: '168px' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="rounded-2xl border border-gray-200/80 shadow-sm overflow-visible" style={panelStyle}>

          {/* Tool buttons */}
          <div className="p-1.5 flex flex-col gap-0.5">
            {TOOLS.map(({ id, Icon, label }) => (
              <button
                key={id}
                onClick={() => setTool(id)}
                title={`${label} (${id[0]})`}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-all duration-150 text-left ${
                  activeTool === id
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
                }`}
              >
                <Icon size={14} strokeWidth={activeTool === id ? 2.5 : 2} />
                <span className="text-xs font-medium">{label}</span>
              </button>
            ))}
          </div>

          {/* Brush properties */}
          {(showColor || showSize || showOpacity || showSmooth) && (
            <div className="border-t border-gray-100 p-2.5 space-y-2.5">

              {/* Color swatch */}
              {showColor && (
                <div className="relative">
                  <button
                    onClick={() => setColorPickerOpen(v => !v)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-xl border border-gray-200 hover:border-gray-300 transition-all"
                  >
                    <div
                      className="w-4 h-4 rounded border border-gray-300 flex-shrink-0"
                      style={{ backgroundColor: toolProps.color }}
                    />
                    <span className="text-xs font-mono text-gray-500 truncate">{toolProps.color}</span>
                  </button>
                  {colorPickerOpen && (
                    <ColorPicker
                      color={toolProps.color}
                      onChange={c => updateToolProp('color', c)}
                      onClose={() => setColorPickerOpen(false)}
                    />
                  )}
                </div>
              )}

              {showSize && (
                <SliderRow
                  label="Size"
                  value={toolProps.size}
                  min={activeTool === 'eraser' ? 8 : 1}
                  max={activeTool === 'eraser' ? 120 : activeTool === 'marker' ? 40 : 20}
                  step={0.5}
                  display={`${Math.round(toolProps.size)}px`}
                  onChange={v => updateToolProp('size', v)}
                />
              )}

              {showOpacity && (
                <SliderRow
                  label="Opacity"
                  value={Math.round(toolProps.opacity * 100)}
                  min={5} max={100} step={1}
                  display={`${Math.round(toolProps.opacity * 100)}%`}
                  onChange={v => updateToolProp('opacity', v / 100)}
                />
              )}

              {showSmooth && (
                <SliderRow
                  label="Smooth"
                  value={Math.round(toolProps.smoothness * 100)}
                  min={0} max={100} step={1}
                  display={`${Math.round(toolProps.smoothness * 100)}%`}
                  onChange={v => updateToolProp('smoothness', v / 100)}
                />
              )}
            </div>
          )}

          {/* Feature toggles */}
          <div className="border-t border-gray-100 p-1.5 space-y-0.5">
            <ToggleRow label="Shape snap"   active={shapeSnap}  Icon={Shapes}  onToggle={toggleShapeSnap}  />
            <ToggleRow label="Grid snap"    active={gridSnap}   Icon={Magnet}  onToggle={toggleGridSnap}   />
            <ToggleRow label="Stylus only"  active={stylusOnly} Icon={Pencil}  onToggle={toggleStylusOnly} />
          </div>
        </div>

        {/* Clear — outside panel to signal destructiveness */}
        <button
          onClick={handleClear}
          className="w-full py-2 rounded-xl border border-gray-200/80 text-xs font-medium text-gray-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-all duration-150 shadow-sm"
          style={panelStyle}
        >
          Clear
        </button>
      </div>

      {/* ── Bottom controls ───────────────────────────────────────────────── */}
      <div className="absolute left-1/2 -translate-x-1/2 z-20 pointer-events-auto" style={{ bottom: '88px' }}>
        <div className="flex items-center gap-0.5 px-2 py-1.5 rounded-full border border-gray-200/80 shadow-md" style={panelStyle}>
          <BarBtn onClick={undo}               disabled={!canUndo} title="Undo (⌘Z)">    <Undo2 size={13} /></BarBtn>
          <BarBtn onClick={redo}               disabled={!canRedo} title="Redo (⌘⇧Z)">   <Redo2 size={13} /></BarBtn>
          <Divider />
          <BarBtn onClick={() => handleZoom(-1)} title="Zoom out">  <Minus size={13} /></BarBtn>
          <button
            onClick={resetViewport} title="Reset zoom"
            className="text-xs font-mono text-gray-500 w-10 text-center hover:text-gray-800 transition-colors tabular-nums"
          >
            {zoomPct}%
          </button>
          <BarBtn onClick={() => handleZoom(1)} title="Zoom in">    <Plus size={13} /></BarBtn>
          <Divider />
          <BarBtn onClick={handleGridToggle} title="Toggle grid" active={gridEnabled}>
            <Grid size={13} />
          </BarBtn>
        </div>
      </div>
    </div>
  );
}
