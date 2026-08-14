export const SHOT_SPEC_VERSION = 1;
const SUPPORTED_RATIOS = new Set(["16:9", "9:16"]);

export function generationDurationForShot(shot, fps = 20, supportedDurations = [5]) {
  const rawSeconds = shot
    ? Math.max(1, (Number(shot.endFrame) - Number(shot.startFrame) + 1) / Math.max(Number(fps) || 1, 1))
    : 5;
  const durations = (Array.isArray(supportedDurations) ? supportedDurations : [])
    .map(Number)
    .filter((duration) => Number.isInteger(duration) && duration > 0);
  if (!durations.length) return Math.max(1, Math.min(30, Math.round(rawSeconds)));
  return durations.reduce((closest, duration) => (
    Math.abs(duration - rawSeconds) < Math.abs(closest - rawSeconds) ? duration : closest
  ));
}

export function compileShotSpec({ provider = "runway", model, prompt, durationSeconds = 5, aspectRatio = "16:9", resolution = "720p", seed = null, startFrame = null, endFrame = null, referenceVideo = null, shot = null, camera = null, subjects = [] }) {
  const duration = Math.round(Number(durationSeconds));
  const spec = {
    version: SHOT_SPEC_VERSION,
    provider,
    model,
    prompt: String(prompt || "").trim(),
    durationSeconds: duration,
    aspectRatio: SUPPORTED_RATIOS.has(aspectRatio) ? aspectRatio : "16:9",
    resolution,
    seed: seed === "" || seed == null ? null : Number(seed),
    shot: shot || null,
    camera: camera || null,
    subjects: Array.isArray(subjects) ? subjects : [],
    conditioning: { startFrame, endFrame, referenceVideo },
  };
  const errors = [];
  if (!spec.model) errors.push("model is required");
  if (!spec.prompt) errors.push("prompt is required");
  if (!Number.isInteger(spec.durationSeconds) || spec.durationSeconds < 1 || spec.durationSeconds > 30) errors.push("duration must be an integer between 1 and 30 seconds");
  if (spec.seed !== null && (!Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 4294967295)) errors.push("seed must be an integer in 0..4294967295");
  if (errors.length) throw new Error(errors[0]);
  return spec;
}
