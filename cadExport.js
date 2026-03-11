// src/utils/cadExport.js - FIXED R2000 (AC1015) DXF EXPORT
// Fixes: endTab method, proper dimension entities, intelligent spacing, block definitions

import {
  processWalls,
  findOpeningsOnWall,
  getWallSegments,
  interpolateWallPoint,
  findLineIntersection,
  calculateDistance,
  isOpeningCorner,
} from './geometryProcessor';

/**
 * Professional DXF Writer for AC1015 (R2000)
 * Manages unique hexadecimal handles and ownership hierarchy
 */
class DxfWriter {
  constructor() {
    this.buffer = [];
    this.handleCount = 0x100; // Start high for safe entity handles
    this.handles = {
      modelSpace: '1F',
      paperSpace: '1E',
      modelSpaceRecord: '12',
      paperSpaceRecord: '13',
      layerTable: '2',
      blockRecordTable: '1',
      rootDict: 'C',
      groupDict: 'D',
    };
  }

  genHandle() {
    return (this.handleCount++).toString(16).toUpperCase();
  }

  p(tag, value) {
    if (value === undefined || value === null) return;
    this.buffer.push(String(tag).trim());
    this.buffer.push(String(value).trim());
  }

  section(name) {
    this.p(0, 'SECTION');
    this.p(2, name);
  }

  endSec() {
    this.p(0, 'ENDSEC');
  }

  // Critical: End table properly
  endTab() {
    this.p(0, 'ENDTAB');
  }

  toString() {
    return this.buffer.join('\r\n') + '\r\n';
  }
}

const SCALE = 10;
const COLORS = {
  WALL: 252,
  WINDOW: 5,
  DOOR: 34,
  GENERIC: 3,
  DIMENSIONS: 7,
  '0': 7
};

function f(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return "0.0000";
  return n.toFixed(4);
}

// --- Primitive Helpers ---

function writeLine(w, owner, layer, x1, y1, x2, y2, color) {
  w.p(0, 'LINE');
  w.p(5, w.genHandle());
  w.p(330, owner);
  w.p(100, 'AcDbEntity');
  w.p(8, layer || '0');
  if (color) w.p(62, color);
  w.p(100, 'AcDbLine');
  w.p(10, f(x1 * SCALE));
  w.p(20, f(-y1 * SCALE));
  w.p(30, "0.0000");
  w.p(11, f(x2 * SCALE));
  w.p(21, f(-y2 * SCALE));
  w.p(31, "0.0000");
}

function writeArc(w, owner, layer, x, y, r, startAngle, endAngle, color) {
  w.p(0, 'ARC');
  w.p(5, w.genHandle());
  w.p(330, owner);
  w.p(100, 'AcDbEntity');
  w.p(8, layer || '0');
  if (color) w.p(62, color);
  w.p(100, 'AcDbCircle');
  w.p(10, f(x * SCALE));
  w.p(20, f(-y * SCALE));
  w.p(30, "0.0000");
  w.p(40, f(r * SCALE));
  w.p(100, 'AcDbArc');
  w.p(50, f(startAngle));
  w.p(51, f(endAngle));
}

function writeText(w, owner, layer, x, y, height, text, rotation = 0, color) {
  w.p(0, 'TEXT');
  w.p(5, w.genHandle());
  w.p(330, owner);
  w.p(100, 'AcDbEntity');
  w.p(8, layer || '0');
  if (color) w.p(62, color);
  w.p(100, 'AcDbText');
  w.p(10, f(x * SCALE));
  w.p(20, f(-y * SCALE));
  w.p(30, "0.0000");
  w.p(40, f(height * SCALE));
  w.p(1, text);
  w.p(50, f(rotation));
  w.p(72, 1); // Horizontal center
  w.p(11, f(x * SCALE));
  w.p(21, f(-y * SCALE));
  w.p(31, "0.0000");
  w.p(100, 'AcDbText');
  w.p(73, 2); // Vertical center
}

/**
 * Write a closed LWPOLYLINE (the preferred way to export wall outlines in DXF).
 * pts: array of { x, y } in canvas pixels; coordinates are scaled and Y-flipped.
 */
function writeLwPolyline(w, owner, layer, pts, closed = false, color) {
  w.p(0, 'LWPOLYLINE');
  w.p(5, w.genHandle());
  w.p(330, owner);
  w.p(100, 'AcDbEntity');
  w.p(8, layer || '0');
  if (color) w.p(62, color);
  w.p(100, 'AcDbPolyline');
  w.p(90, pts.length);          // vertex count
  w.p(70, closed ? 1 : 0);      // 1 = closed loop
  w.p(43, '0.0000');             // constant width = 0
  pts.forEach(pt => {
    w.p(10, f(pt.x * SCALE));
    w.p(20, f(-pt.y * SCALE));  // negate Y: canvas down → DXF up
  });
}

/**
 * Write a BLOCK INSERT reference.
 * x,y in canvas pixels; rotation_deg in DXF degrees (CCW from +X, Y-up).
 */
function writeInsert(w, owner, layer, blockName, x, y, xscale, yscale, rotation_deg, color) {
  w.p(0, 'INSERT');
  w.p(5, w.genHandle());
  w.p(330, owner);
  w.p(100, 'AcDbEntity');
  w.p(8, layer || '0');
  if (color) w.p(62, color);
  w.p(100, 'AcDbBlockReference');
  w.p(2, blockName);
  w.p(10, f(x * SCALE));
  w.p(20, f(-y * SCALE));       // negate Y
  w.p(30, '0.0000');
  w.p(41, f(xscale));
  w.p(42, f(yscale));
  w.p(43, '1.0000');
  w.p(50, f(((rotation_deg % 360) + 360) % 360));
}

/**
 * Write a proper AutoCAD aligned dimension entity
 */
function writeAlignedDimension(w, owner, layer, p1, p2, dimLineOffset, text, dimStyle = 'STANDARD') {
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const perpAngle = angle - Math.PI / 2;

  // Dimension line point (offset from midpoint)
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const dimLinePoint = {
    x: midX + Math.cos(perpAngle) * dimLineOffset,
    y: midY + Math.sin(perpAngle) * dimLineOffset
  };

  w.p(0, 'DIMENSION');
  w.p(5, w.genHandle());
  w.p(330, owner);
  w.p(100, 'AcDbEntity');
  w.p(8, layer);
  w.p(100, 'AcDbDimension');
  w.p(2, '*D0'); // Anonymous dimension block prefix
  // Definition point (dimension line point)
  w.p(10, f(dimLinePoint.x * SCALE));
  w.p(20, f(-dimLinePoint.y * SCALE));
  w.p(30, "0.0000");
  // Text midpoint
  w.p(11, f(dimLinePoint.x * SCALE));
  w.p(21, f(-dimLinePoint.y * SCALE));
  w.p(31, "0.0000");
  w.p(70, 1); // Dimension type: Aligned
  w.p(71, 5); // Text alignment: Center horizontal, center vertical
  w.p(1, text); // Explicit text override
  w.p(3, dimStyle); // Dimension style name
  w.p(100, 'AcDbAlignedDimension');
  // Extension line 1 origin (first point)
  w.p(13, f(p1.x * SCALE));
  w.p(23, f(-p1.y * SCALE));
  w.p(33, "0.0000");
  // Extension line 2 origin (second point)
  w.p(14, f(p2.x * SCALE));
  w.p(24, f(-p2.y * SCALE));
  w.p(34, "0.0000");
}

/**
 * Calculate dimension offsets to prevent overlap
 */
function calculateDimensionOffsets(walls) {
  const offsets = new Map();
  const usedRegions = [];

  walls.forEach(wall => {
    if (!wall.outerStart || !wall.outerEnd) return;

    let offset = 40; // Base offset in pixels
    const wallMid = {
      x: (wall.outerStart.x + wall.outerEnd.x) / 2,
      y: (wall.outerStart.y + wall.outerEnd.y) / 2
    };
    const wallAngle = wall.angle || Math.atan2(
      wall.outerEnd.y - wall.outerStart.y,
      wall.outerEnd.x - wall.outerStart.x
    );

    // Check for overlaps with existing dimension positions
    let iterations = 0;
    while (iterations < 10) {
      const perpAngle = wallAngle - Math.PI / 2;
      const testPoint = {
        x: wallMid.x + Math.cos(perpAngle) * offset,
        y: wallMid.y + Math.sin(perpAngle) * offset
      };

      const hasOverlap = usedRegions.some(region => {
        const dist = Math.sqrt(
          Math.pow(testPoint.x - region.x, 2) +
          Math.pow(testPoint.y - region.y, 2)
        );
        return dist < 50; // Minimum spacing between dimension texts
      });

      if (!hasOverlap) {
        usedRegions.push(testPoint);
        break;
      }

      offset += 30;
      iterations++;
    }

    offsets.set(wall.id, offset);
  });

  return offsets;
}

/**
 * Format measurement for DXF dimension text (feet-inches)
 */
function formatDimensionText(meters) {
  const totalInches = Math.round(meters / 0.0254);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}'-${inches}"`;
}

// --- Main Export ---

export function exportToDXF(walls, doors, windows, generics) {
  const pWalls = processWalls(walls || []);
  const wOpenings = pWalls.map(wall => ({
    ...wall,
    openings: findOpeningsOnWall(wall, doors || [], windows || [])
  }));

  const w = new DxfWriter();

  // Pre-defined handles for critical objects
  const blockRecordHandles = {
    '*Model_Space': '12',
    '*Paper_Space': '13',
    'DOOR_BLOCK': '20',
    'WINDOW_BLOCK': '21',
    '*D0': '22'         // anonymous block referenced by all DIMENSION entities
  };

  const layerHandles = {};

  // ========== 1. HEADER ==========
  w.section('HEADER');
  w.p(9, '$ACADVER'); w.p(1, 'AC1015'); // AutoCAD R2000
  w.p(9, '$HANDSEED'); w.p(5, 'FFFF');
  w.p(9, '$INSBASE'); w.p(10, '0.0'); w.p(20, '0.0'); w.p(30, '0.0');
  w.p(9, '$EXTMIN'); w.p(10, '0.0'); w.p(20, '0.0'); w.p(30, '0.0');
  w.p(9, '$EXTMAX'); w.p(10, '10000.0'); w.p(20, '10000.0'); w.p(30, '0.0');
  w.p(9, '$INSUNITS'); w.p(70, 4); // Millimeters
  w.p(9, '$MEASUREMENT'); w.p(70, 1); // Metric
  w.p(9, '$DIMSCALE'); w.p(40, '1.0');
  w.p(9, '$DIMTXT'); w.p(40, '2.5');
  w.p(9, '$DIMASZ'); w.p(40, '2.5');
  w.p(9, '$DIMEXO'); w.p(40, '0.625');
  w.p(9, '$DIMEXE'); w.p(40, '1.25');
  w.endSec();

  // ========== 2. CLASSES ==========
  w.section('CLASSES');
  w.endSec();

  // ========== 3. TABLES ==========
  w.section('TABLES');

  // --- VPORT Table ---
  w.p(0, 'TABLE');
  w.p(2, 'VPORT');
  w.p(5, '8');
  w.p(330, '0');
  w.p(100, 'AcDbSymbolTable');
  w.p(70, 1);

  w.p(0, 'VPORT');
  w.p(5, '30');
  w.p(330, '8');
  w.p(100, 'AcDbSymbolTableRecord');
  w.p(100, 'AcDbViewportTableRecord');
  w.p(2, '*ACTIVE');
  w.p(70, 0);
  w.p(10, 0.0); w.p(20, 0.0);
  w.p(11, 1.0); w.p(21, 1.0);
  w.p(12, 0.0); w.p(22, 0.0);
  w.p(13, 0.0); w.p(23, 0.0);
  w.p(14, 10.0); w.p(24, 10.0);
  w.p(15, 10.0); w.p(25, 10.0);
  w.p(16, 0.0); w.p(26, 0.0); w.p(36, 1.0);
  w.p(17, 0.0); w.p(27, 0.0); w.p(37, 0.0);
  w.p(40, 1000.0);
  w.p(41, 2.0);
  w.p(42, 50.0);
  w.p(43, 0.0);
  w.p(44, 0.0);
  w.p(50, 0.0);
  w.p(51, 0.0);
  w.p(71, 0);
  w.p(72, 100);
  w.endTab();

  // --- LTYPE Table ---
  w.p(0, 'TABLE');
  w.p(2, 'LTYPE');
  w.p(5, '5');
  w.p(330, '0');
  w.p(100, 'AcDbSymbolTable');
  w.p(70, 3);

  // BYBLOCK
  w.p(0, 'LTYPE');
  w.p(5, '31');
  w.p(330, '5');
  w.p(100, 'AcDbSymbolTableRecord');
  w.p(100, 'AcDbLinetypeTableRecord');
  w.p(2, 'BYBLOCK');
  w.p(70, 0);
  w.p(3, '');
  w.p(72, 65);
  w.p(73, 0);
  w.p(40, 0.0);

  // BYLAYER
  w.p(0, 'LTYPE');
  w.p(5, '33');
  w.p(330, '5');
  w.p(100, 'AcDbSymbolTableRecord');
  w.p(100, 'AcDbLinetypeTableRecord');
  w.p(2, 'BYLAYER');
  w.p(70, 0);
  w.p(3, '');
  w.p(72, 65);
  w.p(73, 0);
  w.p(40, 0.0);

  // CONTINUOUS
  w.p(0, 'LTYPE');
  w.p(5, '32');
  w.p(330, '5');
  w.p(100, 'AcDbSymbolTableRecord');
  w.p(100, 'AcDbLinetypeTableRecord');
  w.p(2, 'CONTINUOUS');
  w.p(70, 0);
  w.p(3, 'Solid line');
  w.p(72, 65);
  w.p(73, 0);
  w.p(40, 0.0);
  w.endTab();

  // --- LAYER Table ---
  const layers = ['0', 'WALL', 'DOOR', 'WINDOW', 'GENERIC', 'DIMENSIONS'];
  w.p(0, 'TABLE');
  w.p(2, 'LAYER');
  w.p(5, '2');
  w.p(330, '0');
  w.p(100, 'AcDbSymbolTable');
  w.p(70, layers.length);

  layers.forEach(layerName => {
    const handle = w.genHandle();
    layerHandles[layerName] = handle;
    w.p(0, 'LAYER');
    w.p(5, handle);
    w.p(330, '2');
    w.p(100, 'AcDbSymbolTableRecord');
    w.p(100, 'AcDbLayerTableRecord');
    w.p(2, layerName);
    w.p(70, 0);
    w.p(62, COLORS[layerName] || 7);
    w.p(6, 'CONTINUOUS');
  });
  w.endTab();

  // --- STYLE Table ---
  w.p(0, 'TABLE');
  w.p(2, 'STYLE');
  w.p(5, '3');
  w.p(330, '0');
  w.p(100, 'AcDbSymbolTable');
  w.p(70, 1);

  w.p(0, 'STYLE');
  w.p(5, '41');
  w.p(330, '3');
  w.p(100, 'AcDbSymbolTableRecord');
  w.p(100, 'AcDbTextStyleTableRecord');
  w.p(2, 'STANDARD');
  w.p(70, 0);
  w.p(40, 0.0);
  w.p(41, 1.0);
  w.p(50, 0.0);
  w.p(71, 0);
  w.p(42, 2.5);
  w.p(3, 'txt');
  w.p(4, '');
  w.endTab();

  // --- VIEW Table (required for AC1015) ---
  w.p(0, 'TABLE');
  w.p(2, 'VIEW');
  w.p(5, '6');
  w.p(330, '0');
  w.p(100, 'AcDbSymbolTable');
  w.p(70, 0);
  w.endTab();

  // --- UCS Table (required for AC1015) ---
  w.p(0, 'TABLE');
  w.p(2, 'UCS');
  w.p(5, '7');
  w.p(330, '0');
  w.p(100, 'AcDbSymbolTable');
  w.p(70, 0);
  w.endTab();

  // --- DIMSTYLE Table ---
  w.p(0, 'TABLE');
  w.p(2, 'DIMSTYLE');
  w.p(5, 'A');
  w.p(330, '0');
  w.p(100, 'AcDbSymbolTable');
  w.p(70, 1);
  w.p(100, 'AcDbDimStyleTable');
  w.p(71, 1);

  w.p(0, 'DIMSTYLE');
  w.p(105, '43');
  w.p(330, 'A');
  w.p(100, 'AcDbSymbolTableRecord');
  w.p(100, 'AcDbDimStyleTableRecord');
  w.p(2, 'STANDARD');
  w.p(70, 0);
  w.p(41, 2.5); // DIMASZ - arrow size
  w.p(42, 0.625); // DIMEXO - extension line offset
  w.p(43, 3.75); // DIMDLI - dimension line increment
  w.p(44, 1.25); // DIMEXE - extension line extension
  w.p(140, 2.5); // DIMTXT - text height
  w.p(77, 1); // DIMTAD - text above dimension line
  w.p(147, 0.625); // DIMGAP - text gap
  w.endTab();

  // --- APPID Table ---
  w.p(0, 'TABLE');
  w.p(2, 'APPID');
  w.p(5, '9');
  w.p(330, '0');
  w.p(100, 'AcDbSymbolTable');
  w.p(70, 1);

  w.p(0, 'APPID');
  w.p(5, '42');
  w.p(330, '9');
  w.p(100, 'AcDbSymbolTableRecord');
  w.p(100, 'AcDbRegAppTableRecord');
  w.p(2, 'ACAD');
  w.p(70, 0);
  w.endTab();

  // --- BLOCK_RECORD Table ---
  w.p(0, 'TABLE');
  w.p(2, 'BLOCK_RECORD');
  w.p(5, '1');
  w.p(330, '0');
  w.p(100, 'AcDbSymbolTable');
  w.p(70, Object.keys(blockRecordHandles).length);

  Object.entries(blockRecordHandles).forEach(([name, handle]) => {
    w.p(0, 'BLOCK_RECORD');
    w.p(5, handle);
    w.p(330, '1');
    w.p(100, 'AcDbSymbolTableRecord');
    w.p(100, 'AcDbBlockTableRecord');
    w.p(2, name);
  });
  w.endTab();

  w.endSec();

  // ========== 4. BLOCKS ==========
  w.section('BLOCKS');

  // Model Space block
  w.p(0, 'BLOCK');
  w.p(5, '1F');
  w.p(330, blockRecordHandles['*Model_Space']);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockBegin');
  w.p(2, '*Model_Space');
  w.p(70, 0);
  w.p(10, 0.0); w.p(20, 0.0); w.p(30, 0.0);
  w.p(3, '*Model_Space');
  w.p(1, '');
  w.p(0, 'ENDBLK');
  w.p(5, w.genHandle());
  w.p(330, blockRecordHandles['*Model_Space']);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockEnd');

  // Paper Space block
  w.p(0, 'BLOCK');
  w.p(5, '1E');
  w.p(330, blockRecordHandles['*Paper_Space']);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockBegin');
  w.p(2, '*Paper_Space');
  w.p(70, 0);
  w.p(10, 0.0); w.p(20, 0.0); w.p(30, 0.0);
  w.p(3, '*Paper_Space');
  w.p(1, '');
  w.p(0, 'ENDBLK');
  w.p(5, w.genHandle());
  w.p(330, blockRecordHandles['*Paper_Space']);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockEnd');

  // Door Block Definition
  const doorBRHandle = blockRecordHandles['DOOR_BLOCK'];
  w.p(0, 'BLOCK');
  w.p(5, w.genHandle());
  w.p(330, doorBRHandle);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockBegin');
  w.p(2, 'DOOR_BLOCK');
  w.p(70, 0);
  w.p(10, 0.0); w.p(20, 0.0); w.p(30, 0.0);
  w.p(3, 'DOOR_BLOCK');
  w.p(1, '');
  // Door geometry: baseline + arc + swing line
  writeLine(w, doorBRHandle, '0', 0, 0, 100, 0, COLORS.DOOR);
  writeArc(w, doorBRHandle, '0', 0, 0, 100, 0, 90, COLORS.DOOR);
  writeLine(w, doorBRHandle, '0', 0, 0, 0, 100, COLORS.DOOR);
  w.p(0, 'ENDBLK');
  w.p(5, w.genHandle());
  w.p(330, doorBRHandle);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockEnd');

  // Window Block Definition
  const windowBRHandle = blockRecordHandles['WINDOW_BLOCK'];
  w.p(0, 'BLOCK');
  w.p(5, w.genHandle());
  w.p(330, windowBRHandle);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockBegin');
  w.p(2, 'WINDOW_BLOCK');
  w.p(70, 0);
  w.p(10, 0.0); w.p(20, 0.0); w.p(30, 0.0);
  w.p(3, 'WINDOW_BLOCK');
  w.p(1, '');
  // Window geometry: frame rectangle + center mullion line
  writeLine(w, windowBRHandle, '0', 0, 0, 100, 0, COLORS.WINDOW);
  writeLine(w, windowBRHandle, '0', 100, 0, 100, 10, COLORS.WINDOW);
  writeLine(w, windowBRHandle, '0', 100, 10, 0, 10, COLORS.WINDOW);
  writeLine(w, windowBRHandle, '0', 0, 10, 0, 0, COLORS.WINDOW);
  writeLine(w, windowBRHandle, '0', 0, 5, 100, 5, COLORS.WINDOW);
  w.p(0, 'ENDBLK');
  w.p(5, w.genHandle());
  w.p(330, windowBRHandle);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockEnd');

  // *D0 — anonymous block required by every DIMENSION entity.
  // AutoCAD regenerates the actual dimension geometry on DIMREGEN so the
  // block can be empty; its presence prevents "undefined block" crashes.
  const d0BRHandle = blockRecordHandles['*D0'];
  w.p(0, 'BLOCK');
  w.p(5, w.genHandle());
  w.p(330, d0BRHandle);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockBegin');
  w.p(2, '*D0');
  w.p(70, 1);   // anonymous block flag
  w.p(10, 0.0); w.p(20, 0.0); w.p(30, 0.0);
  w.p(3, '*D0');
  w.p(1, '');
  w.p(0, 'ENDBLK');
  w.p(5, w.genHandle());
  w.p(330, d0BRHandle);
  w.p(100, 'AcDbEntity');
  w.p(8, '0');
  w.p(100, 'AcDbBlockEnd');

  w.endSec();

  // ========== 5. ENTITIES ==========
  w.section('ENTITIES');

  // All entities are owned by the model space block record
  const modelSpaceHandle = '1F'; // Model space block handle

  // --- Draw Walls as LWPOLYLINE (closed rectangles) ---
  // Each solid wall segment (between openings) is a single closed polyline so
  // AutoCAD treats it as one connected object rather than 4 disconnected lines.
  wOpenings.forEach(wall => {
    const segments = wall.openings && wall.openings.length > 0
      ? getWallSegments(wall.openings)
      : [{ startT: 0, endT: 1 }];

    segments.forEach(seg => {
      const pts = [
        interpolateWallPoint(wall, seg.startT, 'outer', seg.startT > 0),
        interpolateWallPoint(wall, seg.endT,   'outer', seg.endT   < 1),
        interpolateWallPoint(wall, seg.endT,   'inner'),
        interpolateWallPoint(wall, seg.startT, 'inner'),
      ];
      if (pts.some(p => !p)) return; // skip degenerate segments
      writeLwPolyline(w, modelSpaceHandle, 'WALL', pts, true /* closed */, COLORS.WALL);
    });
  });

  // --- Draw Doors as BLOCK INSERTs ---
  // DOOR_BLOCK geometry is written via writeLine/writeArc which already
  // multiply every coordinate by SCALE.  Therefore the INSERT scale must NOT
  // include SCALE again — the block occupies 100*SCALE = 1000 DXF units (mm).
  //
  // Correct INSERT scale  = (desired door width in DXF mm) / (block width in DXF units)
  //                       = (len * SCALE)  /  (100 * SCALE)
  //                       = len / 100
  //
  // Orientation 1/3 mirrors the swing by negating yscale (standard CAD technique).
  doors.forEach(door => {
    const { start, end, orientation = 0 } = door;
    const len = calculateDistance(start, end);
    if (len < 5) return;

    // Door angle in canvas (Y-down) → DXF rotation (Y-up, degrees CCW)
    const canvasAngle = Math.atan2(end.y - start.y, end.x - start.x);
    const dxfAngleDeg = (-canvasAngle * 180 / Math.PI + 360) % 360;
    // Block is 100 * SCALE DXF-units wide; scale to real door length in DXF-units
    const blockScale  = len / 100;   // = (len * SCALE) / (100 * SCALE)
    const yscale      = (orientation === 1 || orientation === 3) ? -blockScale : blockScale;

    writeInsert(w, modelSpaceHandle, 'DOOR', 'DOOR_BLOCK',
      start.x, start.y, blockScale, yscale, dxfAngleDeg, COLORS.DOOR);
  });

  // --- Draw Windows as BLOCK INSERTs ---
  // WINDOW_BLOCK is 100 units wide × 10 units tall (in pre-SCALE block coords).
  // After writeLine multiplies by SCALE the block becomes 1000 × 100 DXF-units.
  //
  //   xscale = len / 100           (width:  len*SCALE mm / (100*SCALE) = len/100)
  //   yscale = thickness / 10      (height: t*SCALE mm  / (10*SCALE)   = t/10)
  const DEFAULT_WIN_THICKNESS = 23; // px — matches DEFAULT_WALL_THICKNESS_PX
  windows.forEach(win => {
    const { start, end } = win;
    const len = calculateDistance(start, end);
    if (len < 5) return;

    const canvasAngle = Math.atan2(end.y - start.y, end.x - start.x);
    const dxfAngleDeg = (-canvasAngle * 180 / Math.PI + 360) % 360;
    const xscale = len / 100;
    const yscale = DEFAULT_WIN_THICKNESS / 10;

    writeInsert(w, modelSpaceHandle, 'WINDOW', 'WINDOW_BLOCK',
      start.x, start.y, xscale, yscale, dxfAngleDeg, COLORS.WINDOW);
  });

  // --- Draw Generics ---
  (generics || []).forEach(generic => {
    const { start, end } = generic;
    writeLine(w, modelSpaceHandle, 'GENERIC', start.x, start.y, end.x, end.y, COLORS.GENERIC);
  });

  // --- Draw Dimensions as DIMENSION entities (inner face, per measurement rule) ---
  // All dimensions reference inner wall faces (user's entered interior clear span).
  // The *D0 anonymous block defined above satisfies the AC1015 block-reference
  // requirement; AutoCAD regenerates the visual geometry via DIMREGEN.
  const dimensionOffsets = calculateDimensionOffsets(wOpenings);

  wOpenings.forEach(wall => {
    const { innerStart, innerEnd, outerStart, outerEnd } = wall;
    if (!innerStart || !innerEnd) return;

    // Measure along the inner face (interior clear dimension)
    const len = calculateDistance(innerStart, innerEnd);
    if (len < 50) return;

    // Place dimension line outward from the wall (away from room centroid)
    // Use the outer face midpoint to determine outward direction.
    const offset = (dimensionOffsets.get(wall.id) || 40);
    const text   = wall.measurement || formatDimensionText(len / 100);

    writeAlignedDimension(w, modelSpaceHandle, 'DIMENSIONS', innerStart, innerEnd, offset, text);
  });

  w.endSec();

  // ========== 6. OBJECTS ==========
  w.section('OBJECTS');

  // Root dictionary
  w.p(0, 'DICTIONARY');
  w.p(5, 'C');
  w.p(330, '0');
  w.p(100, 'AcDbDictionary');
  w.p(281, 1);
  w.p(3, 'ACAD_GROUP');
  w.p(350, 'D');

  // Group dictionary
  w.p(0, 'DICTIONARY');
  w.p(5, 'D');
  w.p(330, 'C');
  w.p(100, 'AcDbDictionary');
  w.p(281, 1);

  w.endSec();

  // ========== EOF ==========
  w.p(0, 'EOF');

  return w.toString();
}

export function downloadDXF(dxfContent, filename = 'alined_plan') {
  const blob = new Blob([dxfContent], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}_${new Date().toISOString().slice(0, 10)}.dxf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportGeometryToDXF(walls, doors, windows, generics) {
  if (walls.length + doors.length + windows.length + generics.length === 0) {
    console.warn('No geometry to export');
    return false;
  }

  try {
    const dxfContent = exportToDXF(walls, doors, windows, generics);
    downloadDXF(dxfContent);
    return true;
  } catch (error) {
    console.error('DXF Export failed:', error);
    return false;
  }
}
