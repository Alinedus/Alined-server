// src/components/HandwritingCanvas.jsx - Handwriting Recognition for Measurements
//
// Primary path  : HandwritingCanvasCore (pointer-events + pressure) →
//                 MeasurementRecognizer (hybrid geometry + 13-class CNN) →
//                 DimensionParser (measurement assembly)
// Fallback path : Tesseract.js OCR via handwritingOCR.js
//   (triggered automatically when primary recognition emits an error)
//
// The MeasurementRecognizer runs 100% offline:
//   • Stroke geometry handles ' " - instantly (< 0.5 ms, no model needed)
//   • CNN handles digits using weights from public/models/measurement-recognizer/
//   • Tesseract fallback handles any remaining edge cases

import React, { useRef, useState, useEffect } from 'react';
import { X } from 'lucide-react';
import useGeometryStore from '../stores/geometryStore';
import MeasurementRecognizer from '../utils/measurementRecognizer';
import HandwritingCanvasCore from '../utils/handwritingCanvasCore';
import DimensionParser from '../utils/dimensionParser';
import { recognizeHandwriting, parseRecognizedMeasurement } from '../utils/handwritingOCR';

// Module-level singletons — created once, reused across open/close cycles.
// MeasurementRecognizer owns the CNN singleton internally.
const _recognizer = new MeasurementRecognizer();
const _parser     = new DimensionParser({ defaultUnit: 'feet' });

export default function HandwritingCanvas({ onClose, nearestLine, lineType }) {
  const canvasRef = useRef(null);
  const coreRef   = useRef(null);

  const [detectedText, setDetectedText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg]         = useState('');
  const [hasStrokes, setHasStrokes]     = useState(false);

  const { updateElementMeasurement, preferredUnit } = useGeometryStore();

  // Keep the latest prop values reachable inside the stable useEffect closure
  // without re-mounting the canvas core on every render.
  const nearestLineRef = useRef(nearestLine);
  const lineTypeRef    = useRef(lineType);
  const updateRef      = useRef(updateElementMeasurement);
  const unitRef        = useRef(preferredUnit);
  const onCloseRef     = useRef(onClose);
  useEffect(() => { nearestLineRef.current = nearestLine;           }, [nearestLine]);
  useEffect(() => { lineTypeRef.current    = lineType;              }, [lineType]);
  useEffect(() => { updateRef.current      = updateElementMeasurement; }, [updateElementMeasurement]);
  useEffect(() => { unitRef.current        = preferredUnit;         }, [preferredUnit]);
  useEffect(() => { onCloseRef.current     = onClose;               }, [onClose]);

  // ── canvas core setup ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Start loading the TF model in the background so it's ready when the
    // user finishes writing.  The app still works if this fails.
    _recognizer.init().catch(() => {});

    const core = new HandwritingCanvasCore(canvas, _recognizer, _parser);
    coreRef.current = core;

    // Track whether there's anything to recognise
    core.on('strokeEnd', () => setHasStrokes(true));
    core.on('clear',     () => {
      setHasStrokes(false);
      setDetectedText('');
      setErrorMsg('');
    });

    // ── TF recognition succeeded ─────────────────────────────────────────────
    core.on('dimension', ({ parsed }) => {
      setIsProcessing(false);
      const measurement = _parser.toAppMeasurement(parsed);
      if (!measurement) {
        setErrorMsg('Digits recognised but could not form a valid measurement.');
        return;
      }
      setDetectedText(measurement.displayText);
      setErrorMsg('');
      const line = nearestLineRef.current;
      const type = lineTypeRef.current;
      if (line && type) {
        updateRef.current(type, line.id, measurement);
        setTimeout(() => onCloseRef.current?.(), 900);
      }
    });

    // ── TF recognition failed → Tesseract fallback ──────────────────────────
    core.on('error', async () => {
      try {
        const raw = await recognizeHandwriting(canvas);
        if (!raw) {
          setIsProcessing(false);
          setErrorMsg('Could not recognise — write larger and more clearly.');
          return;
        }
        const measurement = parseRecognizedMeasurement(raw, unitRef.current);
        if (!measurement) {
          setIsProcessing(false);
          setErrorMsg(`Recognised "${raw}" but could not parse as a measurement.`);
          return;
        }
        setDetectedText(measurement.displayText);
        setErrorMsg('');
        setIsProcessing(false);
        const line = nearestLineRef.current;
        const type = lineTypeRef.current;
        if (line && type) {
          updateRef.current(type, line.id, measurement);
          setTimeout(() => onCloseRef.current?.(), 900);
        }
      } catch {
        setIsProcessing(false);
        setErrorMsg('Recognition error — please try again.');
      }
    });

    return () => core.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── handlers ───────────────────────────────────────────────────────────────
  const handleClear = () => coreRef.current?.clear();

  const handleRecognize = () => {
    if (!hasStrokes) {
      setErrorMsg('Please write a measurement first.');
      return;
    }
    setIsProcessing(true);
    setErrorMsg('');
    // Cancels the auto-recognition timer and runs immediately.
    // Result arrives via the 'dimension' or 'error' event listeners above.
    coreRef.current?.recognizeNow();
  };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[90%] max-w-2xl p-6">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold">Write Measurement</h3>
            <p className="text-sm text-gray-500">Write a number like "10'", "3000mm", or "5m"</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Canvas – drawing is managed by HandwritingCanvasCore, not React state */}
        <div className="border-2 border-gray-200 rounded-lg mb-4">
          <canvas
            ref={canvasRef}
            className="w-full touch-none cursor-crosshair"
            style={{ height: '300px', touchAction: 'none' }}
          />
        </div>

        {/* Detected text */}
        {detectedText && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-sm text-green-800"><strong>Detected:</strong> {detectedText}</p>
          </div>
        )}

        {/* Error message */}
        {errorMsg && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700">{errorMsg}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={handleClear}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Clear
          </button>
          <button
            onClick={handleRecognize}
            disabled={isProcessing || !hasStrokes}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isProcessing ? 'Processing…' : 'Recognise & Apply'}
          </button>
        </div>

        {/* Formats */}
        <div className="mt-4 text-xs text-gray-500">
          <p><strong>Supported formats:</strong> 10' · 3000mm · 3m · 300cm · 5'-4"</p>
        </div>
      </div>
    </div>
  );
}
