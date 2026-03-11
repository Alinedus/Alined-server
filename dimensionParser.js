// src/utils/dimensionParser.js
// ─────────────────────────────────────────────────────────────────────────────
// Enhanced measurement parser for the Alined handwriting recognition pipeline.
//
// This sits alongside the existing measurementParser.js (which returns mm for
// the drawing engine) and adds:
//   • richer multi-format detection
//   • structured output (feet + inches + meters) so WallScaler can operate
//     in any unit system
//   • tolerant fuzzy cleaning (OCR noise: l→1, O→0)
//
// Both parsers can coexist.  Where handwriting-OCR produces a raw digit string
// (e.g. "106" for "10'6"), use this parser.  Where Tesseract OCR already
// produces a unit-annotated string (e.g. "10'-6\""), the existing
// parseRecognizedMeasurement() in handwritingOCR.js handles it directly.
//
// Usage:
//   import DimensionParser from './dimensionParser';
//   const parser = new DimensionParser({ defaultUnit: 'feet' });
//   const result = parser.parse("10'6");
//   // → { valid: true, feet: 10, inches: 6, totalFeet: 10.5,
//   //      totalInches: 126, meters: 3.2004, raw: "10'6" }
// ─────────────────────────────────────────────────────────────────────────────

export default class DimensionParser {
  /**
   * @param {object} opts
   * @param {'feet'|'inches'|'m'|'cm'|'mm'} opts.defaultUnit
   *   Interpretation for bare numbers with no unit symbol.
   *   Defaults to 'feet' to match the project's preferred imperial default.
   * @param {number} opts.maxValue
   *   Sanity cap in the chosen unit.  Results above this are marked invalid.
   */
  constructor(opts = {}) {
    this.defaultUnit = opts.defaultUnit ?? 'feet';
    this.maxValue    = opts.maxValue    ?? 9999;
  }

  // ── public ──────────────────────────────────────────────────────────────────

  /**
   * Parse a raw string into a structured dimension object.
   * Returns { valid: false } when no pattern matches.
   *
   * @param  {string} raw
   * @returns {DimensionResult}
   */
  parse(raw) {
    const cleaned = this._clean(raw);

    const parsers = [
      this._parseFeetInchesSymbols,   // 10'6"  or  10'6
      this._parseFeetInchesHyphen,    // 5-4   (separator style from measurementParser.js)
      this._parseFeetInchesSpace,     // 10 6  (space-separated)
      this._parseInchesOnly,          // 6"
      this._parseFeetOnly,            // 10'  or bare number
      this._parseMetric,              // 305cm / 3.05m / 3000mm
    ];

    for (const fn of parsers) {
      const result = fn.call(this, cleaned);
      if (result?.valid) return { ...result, raw };
    }

    return { valid: false, raw, error: `Cannot parse: "${raw}"` };
  }

  /**
   * Extract the scalar value in a desired unit from a parsed result.
   * @param  {DimensionResult} result
   * @param  {'feet'|'inches'|'m'|'cm'|'mm'} unit
   * @returns {number|null}
   */
  toUnit(result, unit) {
    if (!result?.valid) return null;
    switch (unit) {
      case 'feet'  : return result.totalFeet;
      case 'inches': return result.totalInches;
      case 'm'     : return result.meters;
      case 'cm'    : return result.meters * 100;
      case 'mm'    : return result.meters * 1000;
      default      : return result.totalFeet;
    }
  }

  /**
   * Convert a parsed result to the object shape expected by the existing
   * parseRecognizedMeasurement() callers (actualLength in px at 100 px/m).
   *
   * @param  {DimensionResult} result
   * @returns {{ actualLength, displayText, valueInMeters, isAngle } | null}
   */
  toAppMeasurement(result) {
    if (!result?.valid) return null;
    const PIXELS_PER_METER = 100;
    return {
      actualLength  : result.meters * PIXELS_PER_METER,
      displayText   : this._formatLabel(result),
      valueInMeters : result.meters,
      isAngle       : false,
    };
  }

  // ── parsers ─────────────────────────────────────────────────────────────────

  _clean(raw) {
    return String(raw)
      .trim()
      .replace(/,/g,  '')
      .replace(/[lL|I]/g, '1')   // common OCR misreads of '1'
      .replace(/[oO]/g,   '0')   // common OCR misreads of '0'
      .replace(/\s+/g, ' ');
  }

  /** 10'6"  |  10'6  |  10' */
  _parseFeetInchesSymbols(s) {
    const m = s.match(/^(\d+(?:\.\d+)?)'(?:\s*(\d+(?:\.\d+)?)(?:")?)?$/);
    if (!m) return null;
    return this._build(parseFloat(m[1]), m[2] ? parseFloat(m[2]) : 0);
  }

  /** 6" */
  _parseInchesOnly(s) {
    const m = s.match(/^(\d+(?:\.\d+)?)"$/);
    if (!m) return null;
    return this._build(0, parseFloat(m[1]));
  }

  /** 5-4  |  5-4" */
  _parseFeetInchesHyphen(s) {
    const m = s.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)"?$/);
    if (!m) return null;
    return this._build(parseFloat(m[1]), parseFloat(m[2]));
  }

  /** "10 6" – two numbers, second plausibly inches (0-11) */
  _parseFeetInchesSpace(s) {
    const m = s.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const inches = parseFloat(m[2]);
    if (inches > 11.99) return null;
    return this._build(parseFloat(m[1]), inches);
  }

  /** Bare number (no symbol) – interpreted by defaultUnit */
  _parseFeetOnly(s) {
    const m = s.match(/^(\d+(?:\.\d+)?)'?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    switch (this.defaultUnit) {
      case 'inches': return this._build(0, n);
      case 'm'     : return this._buildMetric(n);
      case 'cm'    : return this._buildMetric(n / 100);
      case 'mm'    : return this._buildMetric(n / 1000);
      default      : return this._build(n, 0);  // feet
    }
  }

  /** 305cm  |  3.05m  |  3000mm */
  _parseMetric(s) {
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m)$/i);
    if (!m) return null;
    const val  = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const meters = unit === 'mm' ? val / 1000
                 : unit === 'cm' ? val / 100
                 : val;
    return this._buildMetric(meters);
  }

  // ── result builders ─────────────────────────────────────────────────────────

  _build(feet, inches) {
    if (!Number.isFinite(feet) || !Number.isFinite(inches)) {
      return { valid: false, error: 'Non-finite value' };
    }
    const totalInches = feet * 12 + inches;
    const totalFeet   = totalInches / 12;
    const meters      = totalInches * 0.0254;
    if (totalInches > this.maxValue * 12) {
      return { valid: false, error: `Exceeds maxValue (${this.maxValue})` };
    }
    return { valid: true, feet, inches, totalInches, totalFeet, meters };
  }

  _buildMetric(meters) {
    if (!Number.isFinite(meters)) return { valid: false, error: 'Non-finite value' };
    const totalInches = meters / 0.0254;
    const feet        = Math.floor(totalInches / 12);
    const inches      = totalInches % 12;
    const totalFeet   = totalInches / 12;
    return { valid: true, feet, inches, totalInches, totalFeet, meters };
  }

  /** Produce a display string matching the project's existing fmtFtIn style */
  _formatLabel(r) {
    const ft  = Math.floor(r.totalFeet);
    const ins = Math.round((r.totalFeet - ft) * 12 * 8) / 8;
    if (ins === 0)              return `${ft}'`;
    if (Math.abs(ins - 0.5)  < 0.07) return `${ft}'-0 1/2"`;
    if (Math.abs(ins - 0.25) < 0.07) return `${ft}'-0 1/4"`;
    if (Math.abs(ins - 0.75) < 0.07) return `${ft}'-0 3/4"`;
    return `${ft}'-${Math.round(ins)}"`;
  }
}
