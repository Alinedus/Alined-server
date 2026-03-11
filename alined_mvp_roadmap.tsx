import React, { useState } from 'react';
import { Calendar, Code, Layers, Download, CheckCircle, Circle } from 'lucide-react';

export default function ALINEDRoadmap() {
  const [expandedWeek, setExpandedWeek] = useState(null);
  
  const roadmap = [
    {
      week: 1,
      phase: "Foundation & Setup",
      days: "Days 1-7",
      color: "bg-blue-500",
      tasks: [
        { id: 1, title: "Tech Stack Setup", details: "React + Vite, Zustand for state, Tailwind CSS", critical: true },
        { id: 2, title: "Core Data Models", details: "Wall, Door, Window classes with methods", critical: true },
        { id: 3, title: "Basic Canvas Setup", details: "SVG canvas with zoom/pan controls", critical: false },
        { id: 4, title: "State Management", details: "GeometryStore with Zustand, single source of truth", critical: true }
      ],
      deliverable: "Empty canvas with state structure ready"
    },
    {
      week: 2,
      phase: "ALIGN - Wall Tool",
      days: "Days 8-14",
      color: "bg-green-500",
      tasks: [
        { id: 5, title: "Wall Drawing Logic", details: "Click-drag to create wall, store start/end points", critical: true },
        { id: 6, title: "Wall Rendering", details: "Draw wall as rectangle (not line), show thickness", critical: true },
        { id: 7, title: "Basic Snapping", details: "Snap to grid, snap to other wall endpoints", critical: true },
        { id: 8, title: "Wall Selection", details: "Click to select, show handles, edit endpoints", critical: false }
      ],
      deliverable: "Can draw and edit multiple walls"
    },
    {
      week: 3,
      phase: "ALIGN - Door/Window Tools",
      days: "Days 15-21",
      color: "bg-green-500",
      tasks: [
        { id: 9, title: "Wall-Hosted Elements", details: "Door/Window references wallId + offset", critical: true },
        { id: 10, title: "Door Placement", details: "Click wall, place door at click position", critical: true },
        { id: 11, title: "Window Placement", details: "Similar to door, but with sill height", critical: true },
        { id: 12, title: "Opening Visualization", details: "Show door swing, window in elevation view", critical: false }
      ],
      deliverable: "Walls with doors and windows"
    },
    {
      week: 4,
      phase: "ALIGN - Polish & Constraints",
      days: "Days 22-28",
      color: "bg-green-500",
      tasks: [
        { id: 13, title: "Dimension Input", details: "Double-click wall to input exact length/thickness", critical: true },
        { id: 14, title: "Orthogonal Lock", details: "Hold shift for 90° angles only", critical: true },
        { id: 15, title: "Wall Joins", details: "Auto-clean corners where walls meet", critical: true },
        { id: 16, title: "Delete & Undo", details: "Delete selected elements, basic undo/redo", critical: false }
      ],
      deliverable: "Polished ALIGN authoring experience"
    },
    {
      week: 5,
      phase: "DEFINE - Plan View",
      days: "Days 29-35",
      color: "bg-purple-500",
      tasks: [
        { id: 17, title: "Plan Generator", details: "Top-down view from geometry state", critical: true },
        { id: 18, title: "Clean Line Weights", details: "Walls thick, doors/windows thin", critical: true },
        { id: 19, title: "Dimensions", details: "Auto-dimension walls in plan view", critical: false },
        { id: 20, title: "Plan Edits → ALIGN", details: "Move wall in plan updates source geometry", critical: true }
      ],
      deliverable: "Auto-generated plan view with sync"
    },
    {
      week: 6,
      phase: "DEFINE - Elevation View",
      days: "Days 36-42",
      color: "bg-purple-500",
      tasks: [
        { id: 21, title: "Elevation Projection", details: "Project walls by orientation (N/S/E/W)", critical: true },
        { id: 22, title: "Door/Window Heights", details: "Show openings at correct heights", critical: true },
        { id: 23, title: "Multiple Elevations", details: "Generate all 4 sides", critical: false },
        { id: 24, title: "Elevation Edits → ALIGN", details: "Stretch wall height updates source", critical: true }
      ],
      deliverable: "Working elevation views with sync"
    },
    {
      week: 7,
      phase: "DEFINE - Section View",
      days: "Days 43-49",
      color: "bg-purple-500",
      tasks: [
        { id: 25, title: "Section Cut Line", details: "User draws cut line on plan", critical: true },
        { id: 26, title: "Section Generator", details: "Boolean cut + projection along line", critical: true },
        { id: 27, title: "Wall Thickness", details: "Show cut wall thickness in section", critical: true },
        { id: 28, title: "Section Edits → ALIGN", details: "Basic height adjustments sync back", critical: false }
      ],
      deliverable: "Basic section view with cut line"
    },
    {
      week: 8,
      phase: "CAD Export Pipeline",
      days: "Days 50-56",
      color: "bg-orange-500",
      tasks: [
        { id: 29, title: "DXF Writer Setup", details: "Integrate dxf-writer library", critical: true },
        { id: 30, title: "Polyline Conversion", details: "Convert all geometry to closed polylines", critical: true },
        { id: 31, title: "Layer Structure", details: "A-WALL-BRICK, A-DOOR, A-WINDOW, etc.", critical: true },
        { id: 32, title: "Scale & Units", details: "Correct mm/inch scaling in export", critical: true }
      ],
      deliverable: "Working DXF export with layers"
    },
    {
      week: 9,
      phase: "Testing & Polish",
      days: "Days 57-60",
      color: "bg-red-500",
      tasks: [
        { id: 33, title: "Bug Fixing", details: "Fix wall join issues, sync bugs", critical: true },
        { id: 34, title: "Performance", details: "Optimize for 50+ walls", critical: false },
        { id: 35, title: "UI Polish", details: "Tooltips, keyboard shortcuts", critical: false },
        { id: 36, title: "Demo Preparation", details: "Create sample project, record demo", critical: true }
      ],
      deliverable: "MVP ready for demo"
    }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            ALINED MVP Roadmap
          </h1>
          <p className="text-slate-400 text-lg">60-Day Execution Plan • Solo Developer Track</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-4">
            <Code className="w-8 h-8 text-blue-400 mb-2" />
            <div className="text-2xl font-bold">9 Weeks</div>
            <div className="text-slate-400 text-sm">Total Sprint</div>
          </div>
          <div className="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-4">
            <Layers className="w-8 h-8 text-green-400 mb-2" />
            <div className="text-2xl font-bold">36 Tasks</div>
            <div className="text-slate-400 text-sm">Core Features</div>
          </div>
          <div className="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-4">
            <Download className="w-8 h-8 text-orange-400 mb-2" />
            <div className="text-2xl font-bold">CAD Export</div>
            <div className="text-slate-400 text-sm">DXF/DWG</div>
          </div>
          <div className="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-4">
            <Calendar className="w-8 h-8 text-purple-400 mb-2" />
            <div className="text-2xl font-bold">Real-time</div>
            <div className="text-slate-400 text-sm">Sync Engine</div>
          </div>
        </div>

        <div className="space-y-4">
          {roadmap.map((week) => (
            <div 
              key={week.week}
              className="bg-slate-800/30 backdrop-blur border border-slate-700 rounded-lg overflow-hidden hover:border-slate-600 transition-all"
            >
              <div 
                className="p-4 cursor-pointer"
                onClick={() => setExpandedWeek(expandedWeek === week.week ? null : week.week)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 ${week.color} rounded-lg flex items-center justify-center font-bold text-white`}>
                      W{week.week}
                    </div>
                    <div>
                      <div className="font-semibold text-lg">{week.phase}</div>
                      <div className="text-slate-400 text-sm">{week.days}</div>
                    </div>
                  </div>
                  <div className="text-slate-400 text-sm bg-slate-700/50 px-3 py-1 rounded-full">
                    {week.tasks.length} tasks
                  </div>
                </div>
              </div>

              {expandedWeek === week.week && (
                <div className="border-t border-slate-700 p-4 bg-slate-900/20">
                  <div className="space-y-3 mb-4">
                    {week.tasks.map((task) => (
                      <div 
                        key={task.id}
                        className="flex items-start gap-3 p-3 bg-slate-800/40 rounded-lg hover:bg-slate-800/60 transition-all"
                      >
                        <Circle className="w-5 h-5 text-slate-500 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium">{task.title}</span>
                            {task.critical && (
                              <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full border border-red-500/30">
                                Critical
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-slate-400">{task.details}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-3">
                    <div className="text-xs text-slate-400 mb-1">Week Deliverable</div>
                    <div className="font-medium text-green-400">{week.deliverable}</div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-8 bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20 rounded-lg p-6">
          <h3 className="text-xl font-bold mb-3">Success Criteria</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              <span>Draw walls, doors, windows in ALIGN</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              <span>Auto-generate plan, elevation, section</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              <span>Edit in DEFINE updates ALIGN instantly</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              <span>Export clean DXF with proper layers</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}