import assert from "node:assert/strict";
import { normalizeVideoForm, videoFormContract } from "../src/workflow/video-contract.js";

const comfy = videoFormContract("comfy");
assert.ok(comfy.aspects.includes("12:7"), "Comfy H3 keeps its 12:7 canvas");
assert.equal(comfy.minDuration, 1);

const fal = videoFormContract("fal");
assert.ok(fal.aspects.includes("3:4"), "Fal exposes its supported portrait ratio");
assert.equal(fal.aspects.includes("12:7"), false, "Fal does not expose the H3-only 12:7 canvas");
assert.equal(fal.minDuration, 2);
assert.equal(fal.maxDuration, 12);

const normalized = normalizeVideoForm("fal", { aspect: "12:7", duration_seconds: 15, extract_mocap: true });
assert.equal(normalized.aspect, "16:9", "switching to Fal repairs an incompatible saved aspect");
assert.equal(normalized.duration_seconds, 12, "switching to Fal clamps a saved duration");
assert.equal(normalized.extract_mocap, true);
console.log("PASS video form contract: provider-specific Fal framing and duration are normalized");
