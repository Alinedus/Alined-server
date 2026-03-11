// src/utils/wallScaler.js
// ─────────────────────────────────────────────────────────────────────────────
// Geometry utilities for scaling wall (and eventually door/window) segments
// after a dimension is recognised from the handwriting input panel.
//
// Sits alongside geometry.js (path simplification / RDP) and
// geometryProcessor.js (line detection).  WallScaler handles the *output*
// step: given a recognised measurement, reposition nodeB so the wall matches.
//
// Coordinate system
//   The app canvas uses pixel coordinates.  A "pixels per unit" scale (ppu)
//   converts to real-world units.  The default is 100 px = 1 m (matching the
//   PIXELS_PER_METER constant in handwritingOCR.js).
//
// Usage:
//   import WallScaler from './wallScaler';
//   const scaler = new WallScaler({ ppu: 100, unit: 'm' });
//   const result = scaler.scaleWall(nodeA, nodeB, parsedDimension);
//   // → { nodeB: { x, y }, lengthPx, lengthUnits }
// ─────────────────────────────────────────────────────────────────────────────

export default class WallScaler {
  /**
   * @param {object} opts
   * @param {number} opts.ppu          Pixels per unit.
   *                                   Default: 100 (= 1 m, matching handwritingOCR.js)
   * @param {'m'|'cm'|'mm'|'feet'|'inches'} opts.unit
   *                                   Which unit ppu describes.
   * @param {number} [opts.minLength]  Minimum length in units (default 0.01)
   * @param {number} [opts.maxLength]  Maximum length in units (default 99999)
   */
  constructor(opts = {}) {
    this.ppu       = opts.ppu       ?? 100;
    this.unit      = opts.unit      ?? 'm';
    this.minLength = opts.minLength ?? 0.01;
    this.maxLength = opts.maxLength ?? 99999;
  }

  // ── public ──────────────────────────────────────────────────────────────────

  /**
   * Reposition nodeB so the wall length equals the dimension in `parsed`.
   * nodeA is the fixed pivot; direction is preserved.
   *
   * @param   {{ x, y }} nodeA     Fixed anchor
   * @param   {{ x, y }} nodeB     Free end (will move)
   * @param   {DimensionResult}  parsed   Output of DimensionParser.parse()
   * @returns {{ nodeB:{x,y}, lengthPx:number, lengthUnits:number } | null}
   */
  scaleWall(nodeA, nodeB, parsed) {
    if (!parsed?.valid) return null;

    const lengthUnits = this._toUnit(parsed);
    if (lengthUnits === null) return null;

    if (lengthUnits < this.minLength || lengthUnits > this.maxLength) {
      console.warn(
        `[WallScaler] ${lengthUnits} ${this.unit} is outside bounds ` +
        `[${this.minLength}, ${this.maxLength}]`
      );
      return null;
    }

    const lengthPx  = lengthUnits * this.ppu;
    const dir       = this.normalize(this.sub(nodeB, nodeA));
    if (!dir) return null;   // degenerate zero-length wall

    return {
      nodeB      : this.add(nodeA, this.scale(dir, lengthPx)),
      lengthPx,
      lengthUnits,
    };
  }

  /**
   * Convenience: apply a scale result directly to a wall object in-place.
   * Works with the Wall.js model structure ({ start:{x,y}, end:{x,y} }).
   *
   * @param {{ start:{x,y}, end:{x,y} }} wall
   * @param {DimensionResult}            parsed
   * @returns {boolean}  true if the wall was updated
   */
  applyToWall(wall, parsed) {
    const result = this.scaleWall(wall.start, wall.end, parsed);
    if (!result) return false;
    wall.end = result.nodeB;
    return true;
  }

  /** Measure the current pixel length of a wall in world units. */
  measureWall(nodeA, nodeB) {
    return this.dist(nodeA, nodeB) / this.ppu;
  }

  /** Snap a point to the nearest grid vertex. */
  snapToGrid(pt, gridSizePx) {
    return {
      x: Math.round(pt.x / gridSizePx) * gridSizePx,
      y: Math.round(pt.y / gridSizePx) * gridSizePx,
    };
  }

  /**
   * Snap wall angle to the nearest N-degree step (default 45°).
   * Returns adjusted nodeB at the same length.
   */
  snapAngle(nodeA, nodeB, step = 45) {
    const dx      = nodeB.x - nodeA.x;
    const dy      = nodeB.y - nodeA.y;
    const len     = Math.sqrt(dx * dx + dy * dy);
    const rad     = Math.atan2(dy, dx);
    const stepRad = (step * Math.PI) / 180;
    const snapped = Math.round(rad / stepRad) * stepRad;
    return {
      x: nodeA.x + len * Math.cos(snapped),
      y: nodeA.y + len * Math.sin(snapped),
    };
  }

  /** Mid-point between two nodes (for placing dimension labels). */
  midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /**
   * Format a length (in this scaler's unit) as a human-readable label.
   * Produces the same ft'-in" style as the existing fmtFtIn() in handwritingOCR.js.
   */
  formatLabel(lengthUnits) {
    switch (this.unit) {
      case 'feet': {
        const totalIn = Math.round(lengthUnits * 12);
        const ft  = Math.floor(totalIn / 12);
        const ins = totalIn % 12;
        return ins === 0 ? `${ft}'` : `${ft}'-${ins}"`;
      }
      case 'inches': return `${Math.round(lengthUnits)}"`;
      case 'm'     : return `${lengthUnits.toFixed(2)}m`;
      case 'cm'    : return `${Math.round(lengthUnits)}cm`;
      case 'mm'    : return `${Math.round(lengthUnits)}mm`;
      default      : return `${lengthUnits.toFixed(2)} ${this.unit}`;
    }
  }

  // ── vector math (mirrors geometry.js style) ──────────────────────────────

  sub(a, b)  { return { x: a.x - b.x, y: a.y - b.y }; }
  add(a, b)  { return { x: a.x + b.x, y: a.y + b.y }; }
  scale(v,s) { return { x: v.x * s,   y: v.y * s   }; }
  dot(a, b)  { return a.x * b.x + a.y * b.y;           }
  mag(v)     { return Math.sqrt(v.x * v.x + v.y * v.y); }
  dist(a, b) { return this.mag(this.sub(b, a));           }

  normalize(v) {
    const m = this.mag(v);
    return m < 1e-9 ? null : { x: v.x / m, y: v.y / m };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  _toUnit(parsed) {
    if (!parsed?.valid) return null;
    switch (this.unit) {
      case 'feet'  : return parsed.totalFeet;
      case 'inches': return parsed.totalInches;
      case 'm'     : return parsed.meters;
      case 'cm'    : return parsed.meters * 100;
      case 'mm'    : return parsed.meters * 1000;
      default      : return parsed.totalFeet;
    }
  }
}
