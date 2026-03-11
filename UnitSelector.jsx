// src/components/UnitSelector.jsx - Unit selection popup
import React, { useState } from 'react';

export default function UnitSelector({ onSelect }) {
  const [selectedUnit, setSelectedUnit] = useState('feet');

  const units = [
    { id: 'feet', label: 'Feet & Inches', symbol: '\' "', description: 'e.g., 5\'-4"' },
    { id: 'meters', label: 'Meters', symbol: 'm', description: 'e.g., 3m, 3.5m' },
    { id: 'millimeters', label: 'Millimeters', symbol: 'mm', description: 'e.g., 3000mm' }
  ];

  const handleConfirm = () => {
    onSelect(selectedUnit);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl w-[90%] max-w-md p-8">
        <h2 className="text-2xl font-semibold text-gray-900 mb-2">
          Choose Measurement Unit
        </h2>
        <p className="text-sm text-gray-500 mb-6">
          This will be used for all measurements in your drawing
        </p>

        <div className="space-y-3 mb-8">
          {units.map((unit) => (
            <button
              key={unit.id}
              onClick={() => setSelectedUnit(unit.id)}
              className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
                selectedUnit === unit.id
                  ? 'border-purple-600 bg-purple-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-gray-900">{unit.label}</div>
                  <div className="text-sm text-gray-500 mt-1">{unit.description}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg text-gray-400">{unit.symbol}</span>
                  {selectedUnit === unit.id && (
                    <div className="w-5 h-5 bg-purple-600 rounded-full flex items-center justify-center">
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={handleConfirm}
          className="w-full bg-purple-600 text-white py-3 rounded-xl font-semibold hover:bg-purple-700 transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
}