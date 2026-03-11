// src/stores/behaviourStore.js
//
// ALINED — Behaviour & Intent Store
// Completely isolated from geometryStore. Receives IntentContext from
// the Web Worker and stores the current session's behavioral telemetry.
// The UI never reads from this store — it is data-only.

import { create } from 'zustand';

// ── Session ID ────────────────────────────────────────────────────────────────
function makeSessionId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Worker singleton ──────────────────────────────────────────────────────────
// Created once per app session. Imported by behaviourBus.js too.
let _worker = null;

function getWorker() {
  if (_worker) return _worker;
  try {
    _worker = new Worker(
      new URL('../workers/behaviourWorker.js', import.meta.url),
      { type: 'module' }
    );
  } catch (e) {
    console.warn('[behaviour] Worker failed to start:', e);
  }
  return _worker;
}

// ── Store ─────────────────────────────────────────────────────────────────────
const useBehaviourStore = create((set, get) => {
  // Boot the worker and wire its output to this store
  const worker = getWorker();
  if (worker) {
    worker.onmessage = (msg) => {
      const { type, payload } = msg.data;
      switch (type) {
        case 'intentUpdate':
          set({
            intentState:       payload.intentState,
            hesitationRate:    payload.hesitationRate,
            avgConfidence:     payload.avgConfidence,
            conflictZoneCount: payload.conflictZoneCount,
            conflictZones:     payload.conflictZones,
            totalStrokes:      payload.totalStrokes,
            hesitationCount:   payload.hesitationCount,
            fastCommits:       payload.fastCommits,
            slowCommits:       payload.slowCommits,
            sequencePattern:   payload.sequencePattern,
            lastUpdated:       payload.sessionTs,
          });
          break;

        case 'hesitation':
          set(s => ({
            hesitationEvents: [...s.hesitationEvents.slice(-49), payload],
          }));
          break;

        case 'conflictZone':
          set(s => ({
            conflictZones: [...new Set([...s.conflictZones, payload.zoneId])],
          }));
          break;

        default: break;
      }
    };

    worker.onerror = (e) => {
      console.warn('[behaviour] Worker error:', e.message);
    };
  }

  return {
    // Session identity
    sessionId:       makeSessionId(),
    sessionStartMs:  Date.now(),

    // Classifier output
    intentState:       'EXPLORING',   // EXPLORING | COMMITTING | CONFLICTED | REFINING
    hesitationRate:    0,
    avgConfidence:     0,
    conflictZoneCount: 0,
    conflictZones:     [],

    // Aggregates
    totalStrokes:    0,
    hesitationCount: 0,
    fastCommits:     0,
    slowCommits:     0,
    sequencePattern: [],
    hesitationEvents: [],

    lastUpdated: null,

    // ── Actions ──────────────────────────────────────────────────────────────

    /** Returns the fully anonymized intent manifest ready for telemetry / export. */
    getManifest() {
      const s = get();
      return {
        sessionId:         s.sessionId,
        sessionStartMs:    s.sessionStartMs,
        durationMs:        Date.now() - s.sessionStartMs,
        intentState:       s.intentState,
        hesitationRate:    s.hesitationRate,
        avgConfidence:     s.avgConfidence,
        conflictZones:     s.conflictZones,   // zone IDs only — no coordinates
        conflictZoneCount: s.conflictZoneCount,
        hesitationCount:   s.hesitationCount,
        fastCommits:       s.fastCommits,
        slowCommits:       s.slowCommits,
        totalStrokes:      s.totalStrokes,
        sequencePattern:   s.sequencePattern,
        hesitationEvents:  s.hesitationEvents.map(h => ({
          phase:      h.phase,
          zoneId:     h.zoneId,
          durationMs: h.durationMs,
          // t is omitted — not needed for analysis, reduces re-identification risk
        })),
        exportedAt: new Date().toISOString(),
      };
    },

    /** Publish a raw event to the worker (fire-and-forget). */
    publishEvent(event) {
      if (!worker) return;
      worker.postMessage({ type: 'event', payload: { ...event, t: Date.now() } });
    },
  };
});

export default useBehaviourStore;

/** Convenience: publish without calling the hook (usable outside React). */
export function publishBehaviourEvent(event) {
  const worker = getWorker();
  if (!worker) return;
  worker.postMessage({ type: 'event', payload: { ...event, t: Date.now() } });
}
