export const SHOT_SPEC_VERSION = 1;
const SUPPORTED_RATIOS = new Set(["16:9", "9:16"]);

export function compileShotSpec({ provider = "runway", model, prompt, durationSeconds = 5, aspectRatio = "16:9", resolution = "720p", seed = null, startFrame = null, endFrame = null, referenceVideo = null, camera = null, subjects = [] }) {
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
