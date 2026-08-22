import { generationDurationForShot } from "./shot-spec.js";

export function generationRequestForResult(result, model) {
  return {
    provider: model.provider,
    model: model.id,
    prompt: result.prompt,
    durationSeconds: generationDurationForShot(result.shot, result.fps, model.durations),
    aspectRatio: result.aspectRatio,
    resolution: "720p",
    startFrame: result.frame,
    endFrame: model.capabilities?.endFrame ? result.frameB : null,
    shot: result.shot,
    camera: result.camera,
    subjects: result.subjects,
  };
}
