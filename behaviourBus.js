// src/utils/behaviourBus.js
//
// ALINED — Behaviour Event Bus
// Thin helpers used by IdeateCanvas and AlignCanvas to publish
// events to the behaviour worker without importing the Zustand store.
//
// All calls are fire-and-forget. Zero synchronous cost.

import { publishBehaviourEvent } from '../stores/behaviourStore';

// ── Zone ID ───────────────────────────────────────────────────────────────────
// World-space 300px grid — stable across pan/zoom.
const ZONE_CELL = 300;

export function calcZoneId(worldX, worldY) {
  return `${Math.floor(worldX / ZONE_CELL)}_${Math.floor(worldY / ZONE_CELL)}`;
}

// ── Event publishers ──────────────────────────────────────────────────────────

/** Fired when the user touches down to start a new stroke. */
export function pubStrokeStart(worldX, worldY) {
  publishBehaviourEvent({
    type: 'stroke:start',
    x: worldX,
    y: worldY,
    zoneId: calcZoneId(worldX, worldY),
  });
}

/**
 * Fired on pointer-move during an active stroke.
 * Sampled — caller should throttle to ~10fps to avoid flooding the worker.
 */
export function pubStrokeMove(worldX, worldY) {
  publishBehaviourEvent({
    type: 'stroke:move',
    x: worldX,
    y: worldY,
  });
}

/** Fired when the user lifts the pointer (stroke finished, not yet committed). */
export function pubStrokeEnd(worldX, worldY) {
  publishBehaviourEvent({
    type: 'stroke:end',
    x: worldX,
    y: worldY,
  });
}

/**
 * Fired when a stroke is committed to the IDEATE canvas (processAndCommit).
 * This is the IDEATE-level commit, not the ALINE geometry commit.
 */
export function pubStrokeCommitted(worldX, worldY) {
  publishBehaviourEvent({
    type: 'stroke:committed',
    zoneId: calcZoneId(worldX, worldY),
    x: worldX,
    y: worldY,
  });
}

/** Fired when an undo removes a stroke. zoneId identifies which zone. */
export function pubStrokeUndo(zoneId) {
  publishBehaviourEvent({ type: 'stroke:undo', zoneId });
}

/** Fired when the eraser removes a stroke. zoneId identifies which zone. */
export function pubStrokeErased(zoneId) {
  publishBehaviourEvent({ type: 'stroke:erased', zoneId });
}

/**
 * Fired each time a snap adjustment is applied in AlignCanvas
 * (ortho snap, node snap, etc.). Tracked per active stroke.
 */
export function pubSnapAdjustment() {
  publishBehaviourEvent({ type: 'snap:adjusted' });
}

/**
 * Fired when a wall (or door/window) is successfully committed to ALINE geometry.
 * This is the IDEATE→ALINE boundary event — the most important for commit velocity.
 *
 * @param {string} elementType  'wall' | 'door' | 'window' | 'generic'
 * @param {number} worldX       Centre X of the committed element (world coords)
 * @param {number} worldY       Centre Y of the committed element (world coords)
 * @param {number} snapCount    How many snap adjustments occurred during this stroke
 */
export function pubElementCreated(elementType, worldX, worldY, snapCount = 0) {
  publishBehaviourEvent({
    type: 'element:created',
    elementType,
    zoneId: calcZoneId(worldX, worldY),
    snapCount,
    x: worldX,
    y: worldY,
  });
}

/**
 * Fired when an existing committed element is modified (drag, resize, etc.).
 * Used by the classifier to detect REFINING state.
 */
export function pubElementModified(elementType, worldX, worldY) {
  publishBehaviourEvent({
    type: 'element:modified',
    elementType,
    zoneId: calcZoneId(worldX, worldY),
  });
}
