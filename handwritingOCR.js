// src/utils/handwritingOCR.js — OFFLINE OCR using Tesseract.js (no API key needed)

/**
 * 🎯 Recognize handwritten text FULLY OFFLINE using Tesseract.js
 *
 * • No Google API key required
 * • No internet connection needed after initial package install
 * • Optimised for measurement input: digits, ', ", m, mm, ft, °
 */

let tesseractWorker = null;
let workerReady = false;
let workerLoading = false;

// ─── Worker management ───────────────────────────────────────────────────────

async function getTesseractWorker() {
  if (workerReady && tesseractWorker) return tesseractWorker;

  if (workerLoading) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (workerReady && tesseractWorker) { clearInterval(poll); resolve(tesseractWorker); }
        if (Date.now() - t0 > 30000)        { clearInterval(poll); reject(new Error('Tesseract timeout')); }
      }, 150);
    });
  }

  workerLoading = true;
  try {
    const { createWorker } = await import('tesseract.js');

    tesseractWorker = await createWorker('eng', 1, { logger: () => {} });

    await tesseractWorker.setParameters({
      tessedit_pageseg_mode: '7',                          // single line
      tessedit_char_whitelist: "0123456789'.\"/-mftincMFTINC° ",
      preserve_interword_spaces: '1',
    });

    workerReady  = true;
    workerLoading = false;
    console.log('✅ Tesseract OCR worker ready (offline)');
    return tesseractWorker;
  } catch (err) {
    workerLoading = false;
    throw err;
  }
}

// ─── Public: recognise handwriting ──────────────────────────────────────────

/**
 * Recognise handwritten measurement on a canvas — 100 % offline.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<string|null>} Raw recognised string, or null on failure.
 */
export async function recognizeHandwriting(canvas) {
  try {
    console.log('🖊️  Running offline OCR…');
    const enhanced = enhanceImageForOCR(canvas);
    const worker   = await getTesseractWorker();

    // Run all three PSM modes and collect every non-empty result.
    // PSM 7  = single text line  – good for "10'" or "5'-4""
    // PSM 8  = single word       – better for isolated numbers like "10"
    // PSM 13 = raw line, no OSD  – catches stubborn cases
    //
    // KEY FIX: do NOT return on the first hit.  PSM 7 might read "10" when
    // the user wrote "10'-4"".  If we stop there we lose the inch component.
    // Instead we gather all candidates and score them by "richness" — a
    // result containing both feet + inches beats one with only feet, which
    // beats a bare number.  Only return the richest candidate.
    const psmModes = ['7', '8', '13'];
    const candidates = [];   // { psm, text, score }

    for (const psm of psmModes) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data: { text, confidence } } = await worker.recognize(enhanced);
      const recognized = text.trim();
      console.log(`  PSM${psm} (${confidence.toFixed(0)}%): "${recognized}"`);

      if (recognized) {
        const fixed = fixOCRMistakes(recognized);
        if (fixed) {
          candidates.push({ psm, text: fixed, score: ocrRichnessScore(fixed) });
        }
      }
    }

    // Reset to default PSM regardless of outcome
    await worker.setParameters({ tessedit_pageseg_mode: '7' }).catch(() => {});

    if (candidates.length === 0) {
      console.warn('⚠️ OCR: all PSM modes returned empty');
      return null;
    }

    // Pick the candidate with the highest richness score; ties go to the
    // earlier PSM (which has better structural heuristics).
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    console.log(`✅ OCR best (PSM${best.psm}, score ${best.score}): "${best.text}"`);
    return best.text;

  } catch (err) {
    console.error('❌ OCR Error:', err);
    return null;
  }
}

// ─── Richness scorer ─────────────────────────────────────────────────────────
// Scores a candidate OCR string so we can prefer "10'-4"" over bare "10".
// Higher score = richer (more information present).
//   4 – feet + inches (e.g. "5'-4\"", "10'6")
//   3 – metric with unit (e.g. "3m", "300cm", "3000mm")
//   2 – feet only (e.g. "10'", "10ft")
//   1 – bare number (e.g. "10") — valid but ambiguous
//   0 – empty / unparseable

function ocrRichnessScore(s) {
  if (!s || !s.trim()) return 0;
  // feet + inches
  if (/\d+['`´]\s*[-–]?\s*\d/.test(s)) return 4;
  // metric with explicit unit
  if (/\d+\s*(mm|cm|m)\b/i.test(s)) return 3;
  // feet-only symbol
  if (/\d+['`´]/.test(s) || /\d+\s*ft\b/i.test(s)) return 2;
  // inches-only symbol
  if (/\d+[""]/.test(s) || /\d+\s*in\b/i.test(s)) return 2;
  // bare number
  if (/^\d+(\.\d+)?$/.test(s.trim())) return 1;
  return 0;
}

// ─── Fix common OCR character confusion ─────────────────────────────────────

function fixOCRMistakes(text) {
  let s = text;
  // Digit lookalikes
  s = s.replace(/[oO]/g, '0');
  s = s.replace(/[lI|]/g, '1');
  s = s.replace(/[Zz]/g, '2');
  // Unit normalisation
  s = s.replace(/mm/gi, 'mm');
  s = s.replace(/\bM\b/g, 'm');
  s = s.replace(/\bFT\b/gi, 'ft');
  s = s.replace(/\bFEET\b/gi, 'ft');
  s = s.replace(/\bIN\b/gi, '"');
  s = s.replace(/[`´]/g, "'");
  s = s.replace(/[""]/g, '"');
  // Strip anything not part of a measurement
  s = s.replace(/[^0-9'."\-/mftincMFTINC° ]/g, '');
  return s.trim();
}

// ─── Image enhancement for better OCR ───────────────────────────────────────

function enhanceImageForOCR(sourceCanvas) {
  const out = document.createElement('canvas');
  out.width  = 1600;
  out.height = 500;
  const ctx = out.getContext('2d');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out.width, out.height);

  const srcCtx = sourceCanvas.getContext('2d');
  const imgData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);

  let minX = sourceCanvas.width,  minY = sourceCanvas.height;
  let maxX = 0, maxY = 0, pixels = 0;

  for (let y = 0; y < sourceCanvas.height; y++) {
    for (let x = 0; x < sourceCanvas.width; x++) {
      const i = (y * sourceCanvas.width + x) * 4;
      const r = imgData.data[i], g = imgData.data[i+1], b = imgData.data[i+2], a = imgData.data[i+3];
      // More lenient: catch antialiased/semi-transparent ink pixels
      if (a > 30 && (r < 230 || g < 230 || b < 230)) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        pixels++;
      }
    }
  }

  if (pixels === 0 || minX >= maxX || minY >= maxY) return sourceCanvas;

  // Generous padding so OCR doesn't clip ascenders/descenders
  const pad = 90;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(sourceCanvas.width,  maxX + pad);
  maxY = Math.min(sourceCanvas.height, maxY + pad);

  const cw = maxX - minX, ch = maxY - minY;
  // Allow up to 6× upscaling so small handwriting fills the output canvas
  const scale  = Math.min((out.width - 120) / cw, (out.height - 80) / ch, 6);
  const sw = cw * scale, sh = ch * scale;
  const ox = (out.width  - sw) / 2;
  const oy = (out.height - sh) / 2;

  // Smooth scaling preserves stroke shape better than nearest-neighbor
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, minX, minY, cw, ch, ox, oy, sw, sh);

  // Threshold: relaxed to 180 to keep antialiased stroke edges
  const d = ctx.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const bright = (d.data[i] + d.data[i+1] + d.data[i+2]) / 3;
    const v = bright < 180 ? 0 : 255;
    d.data[i] = d.data[i+1] = d.data[i+2] = v;
    d.data[i+3] = 255;
  }

  // Dilation pass: expand each black pixel to its 4-connected neighbours.
  // Thickens thin strokes so OCR can read them even when original writing was faint.
  const src = new Uint8ClampedArray(d.data); // snapshot before we write
  const W = out.width, H = out.height;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (src[(y * W + x) * 4] === 0) { // black pixel in snapshot
        for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const ni = ((y + dy) * W + (x + dx)) * 4;
          d.data[ni] = d.data[ni+1] = d.data[ni+2] = 0;
          d.data[ni+3] = 255;
        }
      }
    }
  }

  ctx.putImageData(d, 0, 0);
  return out;
}

// ─── Public: parse text → measurement ───────────────────────────────────────

/**
 * Parse the OCR'd string into a measurement the app can use.
 *
 * @param {string} text         - Raw recognised text
 * @param {string} preferredUnit - 'feet' | 'meters' | 'millimeters'
 * @returns {{ actualLength: number, displayText: string, valueInMeters: number, isAngle: boolean } | null}
 *
 * actualLength = pixels at app scale (100 px = 1 m).  This is what scales the drawn line.
 */
export function parseRecognizedMeasurement(text, preferredUnit = 'feet') {
  if (!text) return null;

  console.log('📏 Parsing:', JSON.stringify(text), '| unit:', preferredUnit);

  const raw = text.trim();

  // ── Angle ────────────────────────────────────────────────────────────────
  if (/°|º|deg|degree/i.test(raw)) {
    const m = raw.match(/([-+]?\d+(?:\.\d+)?)\s*(?:°|º|deg(?:ree)?s?)/i);
    if (m) {
      const angle = parseFloat(m[1]);
      return { actualLength: 0, displayText: `${angle}°`, valueInMeters: 0, isAngle: true, angleValue: angle };
    }
  }

  let meters = null;
  let displayText = null;

  // ── Feet + Inches  5'-4"  5'4"  1'-6 1/2" ───────────────────────────────
  const fiMatch = raw.match(/(\d+)\s*['`´]\s*[-–]?\s*(\d+(?:\s+\d+\/\d+)?)\s*["]/);
  if (fiMatch) {
    const ft = parseFloat(fiMatch[1]);
    const inchStr = fiMatch[2].trim();
    let inches = 0;
    const fM = inchStr.match(/(\d+)(?:\s+(\d+)\/(\d+))?/);
    if (fM) {
      inches = parseFloat(fM[1]);
      if (fM[2] && fM[3]) inches += parseFloat(fM[2]) / parseFloat(fM[3]);
    }
    meters      = (ft + inches / 12) * 0.3048;
    displayText = fmtFtIn(ft, inches);
  }

  // ── Feet only  10'  2.5'  10ft ───────────────────────────────────────────
  if (!meters) {
    const ftM = raw.match(/^(\d+(?:\.\d+)?)\s*(?:'|`|´|ft|feet)$/i);
    if (ftM) {
      const fv = parseFloat(ftM[1]);
      meters      = fv * 0.3048;
      const wf   = Math.floor(fv);
      const ri   = Math.round((fv - wf) * 12 * 8) / 8;
      displayText = fmtFtIn(wf, ri);
    }
  }

  // ── Meters  3m  3.5m ─────────────────────────────────────────────────────
  if (!meters) {
    const mM = raw.match(/^(\d+(?:\.\d+)?)\s*m$/i);
    if (mM) { meters = parseFloat(mM[1]); displayText = `${meters}m`; }
  }

  // ── Centimetres  300cm ────────────────────────────────────────────────────
  if (!meters) {
    const cM = raw.match(/^(\d+(?:\.\d+)?)\s*cm$/i);
    if (cM) { const v = parseFloat(cM[1]); meters = v / 100; displayText = `${Math.round(v)}cm`; }
  }

  // ── Millimetres  3000mm ───────────────────────────────────────────────────
  if (!meters) {
    const mmM = raw.match(/^(\d+(?:\.\d+)?)\s*mm$/i);
    if (mmM) { const v = parseFloat(mmM[1]); meters = v / 1000; displayText = `${Math.round(v)}mm`; }
  }

  // ── Inches  36"  36in ─────────────────────────────────────────────────────
  if (!meters) {
    const inM = raw.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch(?:es)?)$/i);
    if (inM) { const v = parseFloat(inM[1]); meters = v * 0.0254; displayText = `${v}"`; }
  }

  // ── Plain number → interpret by preferredUnit ─────────────────────────────
  if (!meters) {
    const nM = raw.match(/^(\d+(?:\.\d+)?)$/);
    if (nM) {
      const num = parseFloat(nM[1]);
      if (preferredUnit === 'meters') {
        meters = num; displayText = `${num}m`;
      } else if (preferredUnit === 'millimeters') {
        meters = num / 1000; displayText = `${Math.round(num)}mm`;
      } else {
        // feet (default)
        meters      = num * 0.3048;
        const wf   = Math.floor(num);
        const ri   = Math.round((num - wf) * 12 * 8) / 8;
        displayText = fmtFtIn(wf, ri);
      }
    }
  }

  if (meters === null || displayText === null) {
    console.warn('⚠️ Could not parse:', text);
    return null;
  }

  // Sanity: 1 cm – 100 m
  if (meters < 0.01 || meters > 100) {
    console.warn('⚠️ Out of range:', meters, 'm');
    return null;
  }

  // ── Convert to canvas pixels and return ──────────────────────────────────
  // The app uses 100 px = 1 m.  actualLength is what the store uses to
  // rescale (stretch/shrink) the drawn line segment to match the measurement.
  const PIXELS_PER_METER = 100;
  const actualLength = meters * PIXELS_PER_METER;

  console.log(`✅ ${displayText} → ${meters.toFixed(3)} m → ${actualLength.toFixed(1)} px`);
  return { actualLength, displayText, valueInMeters: meters, isAngle: false };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtFtIn(feet, inches) {
  const whole = Math.floor(inches);
  const frac  = inches - whole;
  let s = `${whole}`;
  if      (Math.abs(frac - 0.5)   < 0.07) s += ' 1/2';
  else if (Math.abs(frac - 0.25)  < 0.07) s += ' 1/4';
  else if (Math.abs(frac - 0.75)  < 0.07) s += ' 3/4';
  else if (Math.abs(frac - 0.125) < 0.07) s += ' 1/8';
  return `${feet}'-${s}"`;
}

// ─── Pre-warm (call from App.jsx) ────────────────────────────────────────────

/** Warm up the Tesseract worker in the background so first recognition is fast */
export function preloadOCR() {
  getTesseractWorker().catch(() => {});
}

// ─── Diagnostic self-test ────────────────────────────────────────────────────

export async function testOCRConnection() {
  const canvas = document.createElement('canvas');
  canvas.width = 400; canvas.height = 160;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 160);
  ctx.fillStyle = '#000'; ctx.font = 'bold 100px Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText("5'", 200, 80);

  const result = await recognizeHandwriting(canvas);
  if (result) {
    alert(`✅ Offline OCR Working!\n\nDetected: "${result}"\nNo API key needed.`);
    return true;
  }
  return false;
}

// Keep old name as alias so nothing else breaks
export const testAPIConnection = testOCRConnection;
