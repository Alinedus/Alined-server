// src/utils/measurementParser.js

/**
 * Parses various measurement formats and converts to millimeters
 * Supports: feet (10'), millimeters (3000), meters (3m), feet-inches (12'-6")
 */
export function parseMeasurement(text) {
  if (!text || typeof text !== 'string') {
    return { value: null, unit: null, original: text, success: false };
  }

  // Remove all spaces for easier parsing
  const cleaned = text.trim().replace(/\s+/g, '');
  
  if (cleaned.length === 0) {
    return { value: null, unit: null, original: text, success: false };
  }

  // Define patterns in order of specificity
  const patterns = [
    // Feet and inches: 12'-6" or 12'6" or 12-6 or 12'-6
    {
      regex: /^(\d+(?:\.\d+)?)'?-(\d+(?:\.\d+)?)\"?$/,
      handler: (match) => {
        const feet = parseFloat(match[1]);
        const inches = parseFloat(match[2]);
        return (feet * 304.8) + (inches * 25.4);
      },
      description: "Feet-Inches"
    },
    
    // Feet only: 10' or 10ft
    {
      regex: /^(\d+(?:\.\d+)?)'$|^(\d+(?:\.\d+)?)ft$/i,
      handler: (match) => {
        const feet = parseFloat(match[1] || match[2]);
        return feet * 304.8;
      },
      description: "Feet"
    },
    
    // Meters: 3m or 3.5m
    {
      regex: /^(\d+(?:\.\d+)?)m$/i,
      handler: (match) => {
        const meters = parseFloat(match[1]);
        return meters * 1000;
      },
      description: "Meters"
    },
    
    // Centimeters: 300cm
    {
      regex: /^(\d+(?:\.\d+)?)cm$/i,
      handler: (match) => {
        const cm = parseFloat(match[1]);
        return cm * 10;
      },
      description: "Centimeters"
    },
    
    // Inches: 36" or 36in
    {
      regex: /^(\d+(?:\.\d+)?)\"$|^(\d+(?:\.\d+)?)in$/i,
      handler: (match) => {
        const inches = parseFloat(match[1] || match[2]);
        return inches * 25.4;
      },
      description: "Inches"
    },
    
    // Millimeters (explicit): 3000mm
    {
      regex: /^(\d+(?:\.\d+)?)mm$/i,
      handler: (match) => {
        return parseFloat(match[1]);
      },
      description: "Millimeters"
    },
    
    // Plain number (assume millimeters): 3000
    {
      regex: /^(\d+(?:\.\d+)?)$/,
      handler: (match) => {
        return parseFloat(match[1]);
      },
      description: "Millimeters (default)"
    }
  ];

  // Try each pattern
  for (const pattern of patterns) {
    const match = cleaned.match(pattern.regex);
    if (match) {
      const value = pattern.handler(match);
      
      // Validate result
      if (isNaN(value) || value <= 0 || value > 1000000) {
        continue; // Invalid value, try next pattern
      }
      
      return {
        value: value,
        unit: 'mm',
        original: text,
        success: true,
        format: pattern.description
      };
    }
  }

  // No pattern matched
  return {
    value: null,
    unit: null,
    original: text,
    success: false,
    error: 'Invalid format. Try: 10\', 3000, 3m, 12\'-6"'
  };
}

/**
 * Format millimeters back to readable string
 */
export function formatMeasurement(mm, format = 'mm') {
  if (!mm || isNaN(mm)) return '0mm';
  
  switch (format) {
    case 'ft':
      const feet = mm / 304.8;
      return `${feet.toFixed(2)}'`;
    case 'm':
      const meters = mm / 1000;
      return `${meters.toFixed(2)}m`;
    case 'mm':
    default:
      return `${Math.round(mm)}mm`;
  }
}

/**
 * Test function for validation
 */
export function testParser() {
  const tests = [
    "10'",
    "3000",
    "3m",
    "12'-6\"",
    "3.5m",
    "3000mm",
    "36\"",
    "300cm",
    "12-6",
    "invalid"
  ];
  
  console.log("=== Measurement Parser Tests ===");
  tests.forEach(test => {
    const result = parseMeasurement(test);
    console.log(`${test} →`, result.success ? `${result.value}mm (${result.format})` : result.error);
  });
}