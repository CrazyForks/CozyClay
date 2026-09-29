// Pure request construction. The caller supplies one rolled seed and sampled
// poses; no rig, store, random source, notification or network is touched here.
import { StudioProtocolError } from '../studio-agent-protocol.js';
import { TIMELINE_FRAME_FPS as FPS } from '../scenes.js';
import { judgeAuthoredPath, alignArdyPath } from '../ardy/waypoints.js';

export function generationRefusal(code, message, uiMessage = message) {
  return Object.assign(new StudioProtocolError(code, message), { uiMessage });
}

export function buildGenerationRequest({ character, prompt, durationSeconds, seed,
  waypoints = [], waypointMode = waypoints.length > 0,
}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw generationRefusal('INVALID_ARGUMENT', 'Motion prompt is required - describe what the subject should do before generating');
  if (text.length > 500) throw generationRefusal('INVALID_ARGUMENT', `Motion prompt is capped at 500 characters (currently ${text.length}) - shorten it before generating`);
  const duration = Number(durationSeconds), clipFrames = Math.round(duration * FPS);
  if (!Number.isFinite(duration) || duration < 1 || duration > 1200) throw generationRefusal('INVALID_RANGE', 'Duration must be between 1 and 1200 seconds');
  if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1) throw generationRefusal('INVALID_ARGUMENT', 'Seed must be an integer in 0..2147483647');
  const warnings = [];
  const rootPath = waypointMode ? [{ frame: 0, x: character.x, z: character.z, heading: null }, ...waypoints] : [];
  if (waypointMode) {
    if (!waypoints.length) throw generationRefusal('INVALID_RANGE', 'Add at least one root destination before generating');
    if (rootPath.length > 32) throw generationRefusal('INVALID_RANGE', 'The root path is capped at 32 sparse waypoints');
    if (waypoints.some(point => point.frame <= 0 || point.frame >= clipFrames)) throw generationRefusal('INVALID_RANGE', `Root waypoint frames must stay inside 1..${clipFrames - 1}`);
    const verdict = judgeAuthoredPath(rootPath, FPS, clipFrames);
    if (verdict.errors.length) throw generationRefusal('INVALID_RANGE', `Not generated - ${verdict.errors[0]}`);
    warnings.push(...verdict.warnings);
  }
  const aligned = waypointMode ? alignArdyPath(rootPath, character.rot, 32) : null;
  const body = { prompt: text, duration, posePin: false, seed };
  if (aligned) Object.assign(body, { waypoints: aligned.waypoints, rootMargin: 0.08, historyFrames: 4 * FPS });
  return { body, rootRotationDeg: aligned?.rotationDeg ?? character.rot, warnings };
}
