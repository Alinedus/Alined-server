ALINED - Architectural Drawing App
Enabling architects to realize their vision from sketch to space
Transform hand-drawn 2D sketches into comprehensive architectural documentation with automatic plan, section, and elevation generation. Seamlessly export to AutoCAD with proper layers.

 Project Overview
ALINED is an application that bridges the gap between conceptual sketching and professional CAD workflows. Draw floor plans naturally, annotate with handwritten measurements, and export production-ready DXF/DWG files.
Core Innovation
2D Sketch → 3D Understanding: Draw a simple floor plan, automatically generate elevations and sections
Handwriting Recognition: Write measurements by hand ("10'", "3m"), scales lines automatically
CAD-Ready Export: Professional DXF/DWG files with proper layers for AutoCAD


 Current Status: Milestone 1 (Days 1-15)
 Completed Features
ALINE Mode (Drawing Canvas)

 Multi-layer drawing system (Wall, Door, Window, Generic)
 Apple Pencil / touch optimized input
 Line drawing with color-coded layers
 Handwriting recognition for measurements
 Auto-scaling based on written dimensions
 Google Cloud Vision API integration

Export System

 DXF export with proper layer structure
 Measurement annotations
 Wall thickness representation
 AutoCAD compatibility testing in progress

 Visual Workflow
Draw Line → Write "10'" → OCR Recognizes → Line Scales → Export to CAD

 Tech Stack

Frontend: React 19, Vite
State Management: Zustand
Styling: Tailwind CSS
OCR: Google Cloud Vision API
Export: Custom DXF writer


 Installation & Setup
Prerequisites
Node.js 16+
npm or yarn
Google Cloud Vision API key

Step 1: Clone Repository
bashgit clone https://github.com/namanalex/alined.git
cd alined
Step 2: Install Dependencies
bashnpm install
Step 3: Set Up Environment Variables
Create a .env.local file in the project root:
bashVITE_GOOGLE_VISION_API_KEY=your_google_vision_api_key_here
Get your API key:
Go to Google Cloud Console
Copy the key to .env.local

Step 4: Run Development Server
bashnpm run dev
Open http://localhost:5173 in your browser.

 How to Use
Drawing Lines

Select a tool from the right toolbar:
Wall (black)
Window (blue)
Door (brown)
Generic (green)


Draw a line:
Click/tap and drag to draw
Line appears when you release


Add measurement:
Write a number near the line (e.g., "10", "3m", "10'")
Wait 1 second
Line automatically scales to that dimension



Supported Measurement Formats
10 - Meters (default)
10m - Meters
10' - Feet
3000mm - Millimeters
300cm - Centimeters

Exporting to CAD
Click Export button (top right)
DXF file downloads automatically
Open in AutoCAD/AutoCAD Web


 Project Structure
alined-mvp/
├── src/
│   ├── components/
│   │   ├── AlignCanvas.jsx       # Main drawing canvas
│   │   ├── MinimalToolbar.jsx    # Tool selection UI
│   │   └── ModeToggle.jsx        # ALINE/DEFINE mode switcher
│   ├── stores/
│   │   └── geometryStore.js      # Zustand state management
│   ├── utils/
│   │   ├── cadExport.js          # DXF export logic
│   │   ├── handwritingOCR.js     # Google Vision integration
│   │   └── measurementParser.js  # Measurement parsing
│   ├── App.jsx                   # Root component
│   ├── main.jsx                  # Entry point
│   └── index.css                 # Global styles
├── public/                       # Static assets
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
└── .env.local                    # API keys (not in repo)

 Architecture
State Management (Zustand)
javascript{
  walls: [],      // Array of wall objects
  doors: [],      // Array of door objects
  windows: [],    // Array of window objects
  generics: [],   // Array of generic line objects
  mode: 'wall',   // Current drawing mode
  selectedId: null,
  lastDrawnId: null
}
Drawing Flow
User draws line → addWall/addDoor/addWindow/addGeneric()
Stores line with start, end, originalLength
User writes measurement → Handwriting recognition
Parsed measurement → addMeasurementToWall()
Line rescales based on actual length

Export Flow
Collect all geometry from store
Convert to DXF format with layers:

WALL (color 7 - white/black)
DOOR (color 1 - red)
WINDOW (color 5 - blue)
GENERIC (color 3 - green)
DIMENSIONS (color 2 - yellow)


Generate DXF file
Trigger browser download


 Development Roadmap
Milestone 1 (Days 1-15) 
Status: In Progress 

 Core drawing functionality
 Multi-layer system
 Handwriting recognition
 DXF export structure
 AutoCAD layer compatibility verification
 LAYISO command testing
 Line editing verification (MOVE, TRIM)


 Support:
Developer: Naman Alex
GitHub: @namanalex
Gmail: namanalex@gmail.com
Project: ALINED MVP Development

Last Updated: January 2025
Version: 0.1.0 (Milestone 1 in progress)