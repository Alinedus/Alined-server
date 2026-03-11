// src/services/telemetrySync.js
//
// ALINED — Telemetry Sync Service
//
// Sends anonymized behavioral manifests to Alined's analytics backend.
// Runs silently — the user never sees this. No PII. No geometry coordinates.
//
// Sync triggers
// ─────────────
//  1. On DXF export  (primary — architect is already "sending something out")
//  2. On page hidden (tab backgrounded or app closed)
//  3. Periodic flush every 15 min (protects against data loss)
//
// Privacy guarantees
// ─────────────────
//  • Raw coordinates are never sent — only zone IDs (grid cell names)
//  • Floor plan geometry is never included
//  • All data is timing patterns, ratios, and sequence metadata
//  • Queued locally in sessionStorage if offline; drained on next success
//
// Usage
// ─────
//  import { syncSession, startPeriodicSync } from './telemetrySync';
//  syncSession(manifest);          // fire-and-forget, returns promise
//  const stop = startPeriodicSync(getManifest); // pass a manifest getter fn

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
// Set VITE_TELEMETRY_ENDPOINT in your .env file.
// Example: VITE_TELEMETRY_ENDPOINT=https://api.alined.io/telemetry/session
const ENDPOINT = import.meta.env?.VITE_TELEMETRY_ENDPOINT ?? null;

const QUEUE_KEY     = 'alined_telemetry_queue';
const MAX_QUEUE     = 20;   // max queued manifests if offline
const TIMEOUT_MS    = 8000; // request timeout

// ── Queue helpers ─────────────────────────────────────────────────────────────
function readQueue() {
  try {
    return JSON.parse(sessionStorage.getItem(QUEUE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function writeQueue(q) {
  try {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE)));
  } catch { /* storage full — silently drop */ }
}

function enqueue(manifest) {
  const q = readQueue();
  q.push(manifest);
  writeQueue(q);
}

function clearQueue() {
  try { sessionStorage.removeItem(QUEUE_KEY); } catch { /**/ }
}

// ── Core POST ─────────────────────────────────────────────────────────────────
async function postManifest(manifest) {
  if (!ENDPOINT) {
    // No endpoint configured — queue locally for when it is
    enqueue(manifest);
    return;
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(manifest),
      signal:  controller.signal,
      // No cookies, no credentials — purely anonymous telemetry
      credentials: 'omit',
      mode:        'cors',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    clearTimeout(timer);
    // Network failure — queue for next session
    enqueue(manifest);
    return false;
  }
}

// ── Drain queued manifests ────────────────────────────────────────────────────
async function drainQueue() {
  if (!ENDPOINT) return;
  const q = readQueue();
  if (q.length === 0) return;

  const successes = [];
  for (const manifest of q) {
    const ok = await postManifest(manifest);
    if (ok) successes.push(manifest);
    else break; // still offline — stop trying
  }

  if (successes.length > 0) {
    const remaining = readQueue().filter(m => !successes.find(s => s.sessionId === m.sessionId));
    writeQueue(remaining);
  }
}

// ── Intent JSON download helper ───────────────────────────────────────────────
// Called alongside DXF export so the manifest file lives next to the drawing.
export function downloadIntentJSON(manifest, filename = 'alined_session') {
  const blob = new Blob(
    [JSON.stringify(manifest, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `${filename}.intent.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sync a session manifest to the telemetry backend.
 * Fire-and-forget — safe to call without await.
 * Also attempts to drain any previously queued manifests.
 *
 * @param {object} manifest  Output of behaviourStore.getManifest()
 */
export async function syncSession(manifest) {
  if (!manifest || !manifest.sessionId) return;

  // Drain stale queue first (from previous offline sessions)
  drainQueue().catch(() => {});

  // Send this session's manifest
  await postManifest(manifest).catch(() => {});
}

/**
 * Start a periodic sync timer (every 15 minutes).
 * Protects against data loss if the tab closes without an export.
 *
 * @param {function} getManifest  Function that returns the current manifest
 * @returns {function}  Call to stop the timer
 */
export function startPeriodicSync(getManifest) {
  const INTERVAL_MS = 15 * 60 * 1000;

  const id = setInterval(() => {
    try {
      const manifest = getManifest();
      if (manifest?.totalStrokes > 0) {
        syncSession(manifest).catch(() => {});
      }
    } catch { /**/ }
  }, INTERVAL_MS);

  // Also sync on page hide (tab switch, browser close, app background)
  const onHide = () => {
    try {
      const manifest = getManifest();
      if (manifest?.totalStrokes > 0) {
        // Use sendBeacon for guaranteed delivery on page close
        if (navigator.sendBeacon && ENDPOINT) {
          navigator.sendBeacon(ENDPOINT, JSON.stringify(manifest));
        } else {
          enqueue(manifest);
        }
      }
    } catch { /**/ }
  };

  document.addEventListener('visibilitychange', onHide);

  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', onHide);
  };
}
