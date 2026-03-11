// src/workers/behaviourWorker.js
//
// ALINED — Behaviour & Intent Worker
// Runs entirely off the main thread. Observes the event stream from
// IdeateCanvas and AlignCanvas. Never writes back to geometry.
//
// Message protocol
// ─────────────────────────────────────────────────────────────────
//  Main → Worker  { type: 'event', payload: BehaviourEvent }
//  Worker → Main  { type: 'intentUpdate', payload: IntentContext }
//  Worker → Main  { type: 'conflictZone',  payload: { zoneId, score } }
//  Worker → Main  { type: 'hesitation',    payload: HesitationEvent }

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const RING_SIZE              = 512;   // max events in ring buffer
const HESITATION_PRE_MS      = 800;   // pointer down → first move threshold
const HESITATION_MID_PX_MS   = 5;    // px per 100ms below = mid-stroke hesitation
const HESITATION_MID_DUR_MS  = 600;  // how long velocity must stay low
const HESITATION_POST_MS     = 2000; // stroke:end → stroke:committed threshold
const CONFLICT_SCORE_THRESH  = 0.5;  // iterationScore above this = conflict
const CONFLICT_MIN_DRAWS     = 3;    // minimum draws before scoring
const CLASSIFIER_WINDOW_MS   = 5 * 60 * 1000; // look at last 5 minutes
const CLASSIFIER_DEBOUNCE_MS = 300;  // don't reclassify more than 3x/sec

// ── Ring buffer ──────────────────────────────────────────────────────────────
const ring   = new Array(RING_SIZE);
let ringHead = 0;   // next write slot
let ringSize = 0;   // how many valid entries

function pushRing(evt) {
  ring[ringHead] = evt;
  ringHead = (ringHead + 1) % RING_SIZE;
  if (ringSize < RING_SIZE) ringSize++;
}

/** Iterate ring newest-first, up to `maxAge` ms old. */
function iterRing(callback, maxAgeMs = Infinity) {
  const cutoff = Date.now() - maxAgeMs;
  const count  = ringSize;
  for (let i = 0; i < count; i++) {
    const idx = (ringHead - 1 - i + RING_SIZE) % RING_SIZE;
    const evt = ring[idx];
    if (!evt || evt.t < cutoff) break;
    callback(evt, i);
  }
}

// ── Zone utilities ────────────────────────────────────────────────────────────
// World-space zone: stable across pan/zoom. Each cell = 300 world-px.
const ZONE_CELL = 300;

function zoneId(x, y) {
  return `${Math.floor(x / ZONE_CELL)}_${Math.floor(y / ZONE_CELL)}`;
}

// ── State ─────────────────────────────────────────────────────────────────────

// Per-zone draw/delete counters
const zoneStats = new Map(); // zoneId → { draws, deletes }

function zoneGet(id) {
  if (!zoneStats.has(id)) zoneStats.set(id, { draws: 0, deletes: 0 });
  return zoneStats.get(id);
}

// Sequence log (ALINE element:created events in order)
const sequenceLog = [];

// Hesitation tracking (mutable state per stroke)
const strokeState = {
  startT:        null,   // time of stroke:start
  firstMoveT:    null,   // time of first stroke:move
  lastMoveT:     null,
  lastMoveX:     null,
  lastMoveY:     null,
  midSlowStartT: null,   // when velocity first dropped
  endT:          null,   // time of stroke:end
  zoneId:        null,
  snapCount:     0,
};

// ALINE commit tracking
const alineState = {
  lastStrokeEndT: null,
};

// Session-level aggregates
const session = {
  hesitationCount:      0,
  totalStrokes:         0,
  fastCommits:          0,   // commitTime < 1000ms
  slowCommits:          0,   // commitTime > 2000ms
  commitVelocities:     [],  // confidence scores
  hesitationEvents:     [],  // last 50
  conflictZones:        new Set(),
  sequencePattern:      [],  // element types in commit order
  lastClassifyT:        0,
};

// ── Detectors ─────────────────────────────────────────────────────────────────

function handleStrokeStart(evt) {
  strokeState.startT        = evt.t;
  strokeState.firstMoveT    = null;
  strokeState.lastMoveT     = null;
  strokeState.lastMoveX     = evt.x;
  strokeState.lastMoveY     = evt.y;
  strokeState.midSlowStartT = null;
  strokeState.endT          = null;
  strokeState.zoneId        = zoneId(evt.x, evt.y);
  strokeState.snapCount     = evt.snapCount ?? 0;
  session.totalStrokes++;
}

function handleStrokeMove(evt) {
  const t = evt.t;

  // Pre-stroke hesitation: first move arrived late
  if (!strokeState.firstMoveT && strokeState.startT) {
    strokeState.firstMoveT = t;
    const gap = t - strokeState.startT;
    if (gap > HESITATION_PRE_MS) {
      emitHesitation('pre', strokeState.zoneId, gap);
    }
  }

  // Mid-stroke hesitation: velocity tracking
  if (strokeState.lastMoveT !== null) {
    const dt = t - strokeState.lastMoveT;
    if (dt > 0) {
      const dx  = evt.x - strokeState.lastMoveX;
      const dy  = evt.y - strokeState.lastMoveY;
      const vel = Math.hypot(dx, dy) / dt * 100; // px per 100ms

      if (vel < HESITATION_MID_PX_MS) {
        if (!strokeState.midSlowStartT) strokeState.midSlowStartT = t;
        else if (t - strokeState.midSlowStartT > HESITATION_MID_DUR_MS) {
          emitHesitation('mid', strokeState.zoneId, t - strokeState.midSlowStartT);
          strokeState.midSlowStartT = null; // reset so we don't spam
        }
      } else {
        strokeState.midSlowStartT = null;
      }
    }
  }

  strokeState.lastMoveT = t;
  strokeState.lastMoveX = evt.x;
  strokeState.lastMoveY = evt.y;
}

function handleStrokeEnd(evt) {
  strokeState.endT   = evt.t;
  alineState.lastStrokeEndT = evt.t;
}

function handleStrokeCommitted(evt) {
  // Post-stroke hesitation (IDEATE commit)
  if (strokeState.endT !== null) {
    const gap = evt.t - strokeState.endT;
    if (gap > HESITATION_POST_MS) {
      emitHesitation('post', strokeState.zoneId ?? evt.zoneId, gap);
    }
  }

  // Repetition tracking
  const zid = evt.zoneId ?? strokeState.zoneId;
  if (zid) {
    const s = zoneGet(zid);
    s.draws++;
    checkConflict(zid, s);
  }
}

function handleStrokeUndo(evt) {
  const zid = evt.zoneId;
  if (zid) {
    const s = zoneGet(zid);
    s.deletes++;
    checkConflict(zid, s);
  }
}

function handleStrokeErased(evt) {
  const zid = evt.zoneId;
  if (zid) {
    const s = zoneGet(zid);
    s.deletes++;
    checkConflict(zid, s);
  }
}

function handleSnapAdjustment() {
  strokeState.snapCount = (strokeState.snapCount || 0) + 1;
}

function handleElementCreated(evt) {
  // Commit velocity score (IDEATE→ALINE boundary)
  if (alineState.lastStrokeEndT !== null) {
    const commitTime   = evt.t - alineState.lastStrokeEndT;
    const snapAdj      = evt.snapCount ?? 0;
    const confidence   = computeConfidence(commitTime, snapAdj);

    if (commitTime < 1000)  session.fastCommits++;
    else if (commitTime > 2000) session.slowCommits++;

    session.commitVelocities.push(confidence);
    alineState.lastStrokeEndT = null;
  }

  // Sequence log
  const entry = { elementType: evt.elementType ?? 'wall', zoneId: evt.zoneId, t: evt.t };
  sequenceLog.push(entry);
  session.sequencePattern.push(evt.elementType ?? 'wall');
}

// ── Confidence formula ────────────────────────────────────────────────────────
function computeConfidence(commitTimeMs, snapAdjustments) {
  const timeFactor = 1 / (1 + Math.log(Math.max(1, commitTimeMs) / 1000));
  const snapFactor = 1 / (1 + (snapAdjustments || 0));
  return Math.round(timeFactor * snapFactor * 1000) / 1000;
}

// ── Conflict zone detection ───────────────────────────────────────────────────
function checkConflict(zid, stats) {
  if (stats.draws < CONFLICT_MIN_DRAWS) return;
  const score = stats.deletes / stats.draws;
  if (score > CONFLICT_SCORE_THRESH) {
    session.conflictZones.add(zid);
    self.postMessage({ type: 'conflictZone', payload: { zoneId: zid, score } });
  }
}

// ── Hesitation emitter ────────────────────────────────────────────────────────
function emitHesitation(phase, zid, durationMs) {
  session.hesitationCount++;
  const evt = { phase, zoneId: zid, durationMs, t: Date.now() };
  session.hesitationEvents = [...session.hesitationEvents.slice(-49), evt];
  self.postMessage({ type: 'hesitation', payload: evt });
}

// ── Intent Classifier ─────────────────────────────────────────────────────────
function classify() {
  const now = Date.now();
  if (now - session.lastClassifyT < CLASSIFIER_DEBOUNCE_MS) return;
  session.lastClassifyT = now;

  // Gather recent events
  let recentStrokes      = 0;
  let recentHesitations  = 0;
  let recentModifications = 0;

  iterRing((evt) => {
    if (evt.type === 'stroke:committed') recentStrokes++;
    if (evt.type === 'hesitation')       recentHesitations++;
    if (evt.type === 'element:modified') recentModifications++;
  }, CLASSIFIER_WINDOW_MS);

  const hesitationRate = recentStrokes > 0 ? recentHesitations / recentStrokes : 0;
  const activeConflicts = session.conflictZones.size;

  const recentVelocities = session.commitVelocities.slice(-10);
  const avgConfidence    = recentVelocities.length > 0
    ? recentVelocities.reduce((a, b) => a + b, 0) / recentVelocities.length
    : 0;

  const totalEvents = recentStrokes + recentModifications;
  const modRatio    = totalEvents > 0 ? recentModifications / totalEvents : 0;

  let intentState = 'EXPLORING';

  if (activeConflicts >= 2) {
    intentState = 'CONFLICTED';
  } else if (modRatio > 0.6) {
    intentState = 'REFINING';
  } else if (avgConfidence > 0.6 && hesitationRate < 0.15) {
    intentState = 'COMMITTING';
  } else {
    intentState = 'EXPLORING';
  }

  const ctx = buildIntentContext(intentState, hesitationRate, avgConfidence, activeConflicts);
  self.postMessage({ type: 'intentUpdate', payload: ctx });
}

function buildIntentContext(state, hesitationRate, avgConfidence, conflictCount) {
  return {
    intentState:         state,
    hesitationRate:      Math.round(hesitationRate * 1000) / 1000,
    avgConfidence:       Math.round(avgConfidence * 1000) / 1000,
    conflictZoneCount:   conflictCount,
    conflictZones:       [...session.conflictZones],
    totalStrokes:        session.totalStrokes,
    hesitationCount:     session.hesitationCount,
    fastCommits:         session.fastCommits,
    slowCommits:         session.slowCommits,
    sequencePattern:     [...session.sequencePattern].slice(-20),
    sessionTs:           Date.now(),
  };
}

// ── Main message handler ──────────────────────────────────────────────────────
self.onmessage = function (msg) {
  const { type, payload } = msg.data;
  if (type !== 'event') return;

  pushRing(payload);

  switch (payload.type) {
    case 'stroke:start':     handleStrokeStart(payload);    break;
    case 'stroke:move':      handleStrokeMove(payload);     break;
    case 'stroke:end':       handleStrokeEnd(payload);      break;
    case 'stroke:committed': handleStrokeCommitted(payload); break;
    case 'stroke:undo':      handleStrokeUndo(payload);     break;
    case 'stroke:erased':    handleStrokeErased(payload);   break;
    case 'snap:adjusted':    handleSnapAdjustment();        break;
    case 'element:created':  handleElementCreated(payload); break;
    default: break;
  }

  classify();
};
