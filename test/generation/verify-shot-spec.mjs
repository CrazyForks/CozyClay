import assert from "node:assert/strict";
import { generationRequestForResult } from "../../src/generation/generation-request.js";
import { compileShotSpec, generationDurationForShot, SHOT_SPEC_VERSION } from "../../src/generation/shot-spec.js";
import { bridgeModelForUiId } from "../../src/shot.js";

const spec = compileShotSpec({ model: "gen4_turbo", prompt: "  dolly toward the subject  ", durationSeconds: 5, seed: "2", startFrame: "data:image/png;base64,abc", shot: { id: "shot-1" }, camera: { mode: "follow" }, subjects: ["actor"] });
assert.equal(spec.version, SHOT_SPEC_VERSION);
assert.equal(spec.prompt, "dolly toward the subject");
assert.equal(spec.seed, 2);
assert.equal(spec.conditioning.startFrame, "data:image/png;base64,abc");
assert.equal(spec.shot.id, "shot-1");
assert.equal(spec.camera.mode, "follow");
assert.deepEqual(spec.subjects, ["actor"]);

const resultRequest = generationRequestForResult({
  prompt: "portrait tracking shot",
  aspectRatio: "9:16",
  frame: "data:image/png;base64,abc",
  frameB: null,
  shot: { id: "shot-portrait", startFrame: 0, endFrame: 99 },
  fps: 20,
  camera: { mode: "follow" },
  subjects: ["actor"],
}, {
  provider: "runway",
  id: "gen4_turbo",
  durations: [5],
  capabilities: { endFrame: false },
});
assert.equal(resultRequest.aspectRatio, "9:16", "a 9:16 studio result reaches the start-result request input");
assert.equal(compileShotSpec(resultRequest).aspectRatio, "9:16", "a 9:16 studio result reaches the compiled generation spec");
assert.equal(compileShotSpec(generationRequestForResult({ ...resultRequest, aspectRatio: "1:1" }, { provider: "runway", id: "gen4_turbo", durations: [5] })).aspectRatio, "16:9", "unsupported studio ratios fall back to 16:9");
assert.equal(compileShotSpec(generationRequestForResult({ ...resultRequest, aspectRatio: undefined }, { provider: "runway", id: "gen4_turbo", durations: [5] })).aspectRatio, "16:9", "missing studio ratios fall back to 16:9");
assert.equal(generationDurationForShot({ startFrame: 20, endFrame: 59 }, 20, [2, 5, 10]), 2);
assert.equal(generationDurationForShot({ startFrame: 20, endFrame: 119 }, 20, [4, 6, 8]), 4);
assert.equal(generationDurationForShot(null, 20, [4, 6, 8]), 4);
assert.throws(() => compileShotSpec({ model: "gen4_turbo", prompt: "", durationSeconds: 5 }), /prompt is required/);
assert.throws(() => compileShotSpec({ model: "gen4_turbo", prompt: "x", durationSeconds: 0 }), /duration/);
assert.deepEqual(bridgeModelForUiId("seedance_2"), { provider: "runway", model: "seedance2" });
assert.deepEqual(bridgeModelForUiId("veo_3_1"), { provider: "runway", model: "veo3.1" });
assert.equal(bridgeModelForUiId("kling_3"), null);
console.log("generation shot spec verified");
