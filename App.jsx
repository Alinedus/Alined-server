// src/App.jsx
import React, { useState, useEffect, useRef } from 'react';
import { Download } from 'lucide-react';
import AlignCanvas from './components/AlignCanvas';
import DefineViews from './components/DefineViews';
import IdeateCanvas from './components/IdeateCanvas';
import MinimalToolbar from './components/MinimalToolbar';
import ModeToggle from './components/ModeToggle';
import UnitSelector from './components/UnitSelector';
import useGeometryStore from './stores/geometryStore';
import useBehaviourStore from './stores/behaviourStore';
import { exportGeometryToDXF } from './utils/cadExport';
import { preloadOCR } from './utils/handwritingOCR';
import { syncSession, downloadIntentJSON, startPeriodicSync } from './services/telemetrySync';

export default function App() {
  const {
    walls, doors, windows, generics,
    preferredUnit, setPreferredUnit,
    viewMode
  } = useGeometryStore();

  const { getManifest } = useBehaviourStore();

  const [showUnitSelector, setShowUnitSelector] = useState(false);

  // Pre-warm offline Tesseract OCR worker in the background
  useEffect(() => { preloadOCR(); }, []);

  // Start periodic telemetry sync (every 15 min + on page hide)
  useEffect(() => {
    const stop = startPeriodicSync(getManifest);
    return stop;
  }, [getManifest]);

  useEffect(() => {
    if (!preferredUnit) {
      setShowUnitSelector(true);
    }
  }, [preferredUnit]);

  const handleUnitSelect = (unit) => {
    setPreferredUnit(unit);
    setShowUnitSelector(false);
  };

  const handleExport = () => {
    const hasElements = walls.length > 0 || doors.length > 0 || windows.length > 0 || generics.length > 0;
    if (!hasElements) {
      alert('Please draw at least one line before exporting');
      return;
    }

    // 1. Export DXF as always
    exportGeometryToDXF(walls, doors, windows, generics);

    // 2. Build and export the anonymized intent manifest alongside the DXF
    const manifest = getManifest();
    downloadIntentJSON(manifest, `alined_${manifest.sessionId}`);

    // 3. Sync manifest to telemetry backend (fire-and-forget, silent)
    syncSession(manifest).catch(() => {});
  };

  return (
    <div className="w-screen h-screen bg-white flex flex-col overflow-hidden">
      {showUnitSelector && <UnitSelector onSelect={handleUnitSelect} />}

      {/* Header — hidden in IDEATE to maximise sketch space */}
      {viewMode !== 'IDEATE' && (
        <header className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h1 className="text-2xl font-light tracking-wide text-gray-900">ALINED</h1>
          <div className="flex items-center gap-4">
            {preferredUnit && (
              <button
                onClick={() => setShowUnitSelector(true)}
                className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1 border border-gray-300 rounded-full"
              >
                {preferredUnit === 'feet'        ? 'Feet & Inches' :
                 preferredUnit === 'meters'      ? 'Meters'        : 'Millimeters'}
              </button>
            )}
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-4 py-2 text-gray-700 hover:text-gray-900 transition-colors"
            >
              <Download size={20} />
              <span className="font-medium">Export DXF</span>
            </button>
          </div>
        </header>
      )}

      <div className="flex-1 relative overflow-hidden">
        {/* IDEATE — infinite freehand sketch canvas */}
        {viewMode === 'IDEATE' && <IdeateCanvas />}

        {/* ALINE — structured drawing with wall engine */}
        {viewMode === 'ALINE' && (
          <>
            <AlignCanvas />
            <MinimalToolbar />
          </>
        )}

        {/* DEFINE — rendered architectural view */}
        {viewMode === 'DEFINE' && <DefineViews />}

        <ModeToggle />
      </div>
    </div>
  );
}
