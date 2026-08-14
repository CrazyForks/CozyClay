import assert from "node:assert/strict";
import { estimateRunwayCost, pollRunway, submitRunway, validateRunwaySpec } from "../../tools/generation/providers/runway.mjs";

const spec = { provider: "runway", model: "gen4_turbo", prompt: "a tracking shot", durationSeconds: 5, aspectRatio: "16:9", seed: 2, conditioning: { startFrame: "data:image/png;base64,abc", endFrame: "data:image/png;base64,def" } };
const verdict = validateRunwaySpec(spec);
assert.equal(verdict.ok, true);
assert.equal(verdict.warnings.length, 1);
assert.equal(estimateRunwayCost(spec), 0.25);
let submitted;
const submit = await submitRunway(spec, { apiKey: "test", fetchImpl: async (url, init) => { submitted = { url, body: JSON.parse(init.body), headers: init.headers }; return new Response(JSON.stringify({ id: "task-1" }), { status: 200 }); } });
assert.equal(submit.providerJobId, "task-1");
assert.equal(submitted.body.promptImage, spec.conditioning.startFrame);
assert.equal(submitted.body.ratio, "1280:720");
const polled = await pollRunway("task-1", { apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({ status: "SUCCEEDED", output: ["https://example.test/out.mp4"] }), { status: 200 }) });
assert.equal(polled.status, "succeeded");
assert.equal(polled.outputUrl, "https://example.test/out.mp4");
console.log("Runway provider verified");

const failed = await pollRunway("task-2", { apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({ status: "FAILED", failure: "bad input" }), { status: 200 }) });
assert.equal(failed.status, "failed");
assert.equal(failed.failure, "bad input");
const canceled = await pollRunway("task-3", { apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({ status: "CANCELED" }), { status: 200 }) });
assert.equal(canceled.status, "failed");
await assert.rejects(() => submitRunway(spec, { apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({ message: "secret upstream detail" }), { status: 401 }) }), /HTTP 401/);
await assert.rejects(() => submitRunway(spec, { apiKey: "test", fetchImpl: async () => new Response("not-json", { status: 500 }) }), /HTTP 500/);
assert.throws(() => validateRunwaySpec({ ...spec, model: undefined }), /model is required/);
console.log("Runway provider error paths verified");
