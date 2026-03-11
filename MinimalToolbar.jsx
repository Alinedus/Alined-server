// src/components/MinimalToolbar.jsx
import React from 'react';
import { Eraser, Undo2, Redo2, PencilLine, Grid } from 'lucide-react';
import useGeometryStore from '../stores/geometryStore';

export default function MinimalToolbar() {
  const { mode, setMode, undo, redo, past, future, gridEnabled, toggleGrid } = useGeometryStore();

  const tools = [
    { id: 'erase', label: 'Erase', icon: Eraser, color: '#ef4444' },
    { id: 'wall', label: 'Wall', color: '#000000' },
    { id: 'window', label: 'Window', color: '#1e40af' },
    { id: 'door', label: 'Door', color: '#92400e' },
    { id: 'generic', label: 'Generic', color: '#059669' }
  ];

  return (
    <div className="absolute right-6 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-10">

      {/* Undo / Redo Group */}
      <div className="flex flex-col gap-1.5 mb-1 items-center">
        <button
          onClick={undo}
          disabled={past.length === 0}
          className={`p-1.5 rounded-full border bg-white shadow-sm hover:bg-gray-50 flex items-center justify-center transition-all ${past.length === 0 ? 'opacity-50 cursor-not-allowed' : 'active:scale-95'}`}
          title="Undo"
        >
          <Undo2 size={16} color="#4b5563" />
        </button>
        <button
          onClick={redo}
          disabled={future.length === 0}
          className={`p-1.5 rounded-full border bg-white shadow-sm hover:bg-gray-50 flex items-center justify-center transition-all ${future.length === 0 ? 'opacity-50 cursor-not-allowed' : 'active:scale-95'}`}
          title="Redo"
        >
          <Redo2 size={16} color="#4b5563" />
        </button>
      </div>

      <div className="flex flex-col gap-2 items-center mb-1">
        <button
          onClick={() => setMode('freehand')}
          className={`w-9 h-9 rounded-md border-2 transition-all flex items-center justify-center ${mode === 'freehand'
            ? 'scale-105 shadow-md'
            : 'hover:scale-105'
            }`}
          style={{
            backgroundColor: mode === 'freehand' ? '#111827' : 'white',
            borderColor: '#111827'
          }}
          title="Freehand"
        >
          <PencilLine size={18} color={mode === 'freehand' ? 'white' : '#111827'} />
        </button>
        <button
          onClick={toggleGrid}
          className={`w-9 h-9 rounded-md border-2 transition-all flex items-center justify-center ${gridEnabled
            ? 'scale-105 shadow-md'
            : 'hover:scale-105'
            }`}
          style={{
            backgroundColor: gridEnabled ? '#111827' : 'white',
            borderColor: '#111827'
          }}
          title="Toggle grid"
        >
          <Grid size={18} color={gridEnabled ? 'white' : '#111827'} />
        </button>
      </div>

      <div className="w-8 h-px bg-gray-300 mx-auto my-1"></div>

      {tools.map(tool => (
        <button
          key={tool.id}
          onClick={() => setMode(tool.id)}
          className="group flex flex-col items-center gap-1"
          title={tool.label}
        >
          <div
            className={`w-9 h-9 rounded-md border-2 transition-all flex items-center justify-center ${mode === tool.id
              ? 'scale-105 shadow-md'
              : 'hover:scale-105'
              }`}
            style={{
              backgroundColor: mode === tool.id ? tool.color : 'white',
              borderColor: tool.color
            }}
          >
            {tool.icon ? (
              <tool.icon
                size={18}
                color={mode === tool.id ? 'white' : tool.color}
              />
            ) : (
              <div style={{ backgroundColor: mode === tool.id ? 'white' : tool.color }} className={`w-2.5 h-2.5 rounded-full border ${mode === tool.id ? '' : 'border-transparent'}`} />
            )}
          </div>
          <span className="text-xs font-medium text-gray-700">
            {tool.label}
          </span>
        </button>
      ))}
    </div>
  );
}