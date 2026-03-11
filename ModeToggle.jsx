// src/components/ModeToggle.jsx
import React from 'react';
import useGeometryStore from '../stores/geometryStore';

export default function ModeToggle() {
  const { viewMode, setViewMode } = useGeometryStore();

  const modes = [
    { id: 'IDEATE', label: 'IDEATE' },
    { id: 'ALINE',  label: 'ALINE'  },
    { id: 'DEFINE', label: 'DEFINE' },
  ];

  return (
    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-white rounded-full shadow-lg border border-gray-200 p-1 flex z-10">
      {modes.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => setViewMode(id)}
          className={`px-6 py-2 rounded-full text-sm font-medium transition-all ${
            viewMode === id
              ? 'bg-gray-900 text-white'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
