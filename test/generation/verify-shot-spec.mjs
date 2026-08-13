import assert from "node:assert/strict";
import { compileShotSpec, SHOT_SPEC_VERSION } from "../../src/generation/shot-spec.js";

const spec = compileShotSpec({ model: "gen4_turbo", prompt: "  dolly toward the subject  ", durationSeconds: 5, seed: "2", startFrame: "data:image/png;base64,abc" });
assert.equal(spec.version, SHOT_SPEC_VERSION);
assert.equal(spec.prompt, "dolly toward the subject");
assert.equal(spec.seed, 2);
assert.equal(spec.conditioning.startFrame, "data:image/png;base64,abc");
assert.throws(() => compileShotSpec({ model: "gen4_turbo", prompt: "", durationSeconds: 5 }), /prompt is required/);
assert.throws(() => compileShotSpec({ model: "gen4_turbo", prompt: "x", durationSeconds: 0 }), /duration/);
console.log("generation shot spec verified");
