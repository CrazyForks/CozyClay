import assert from "node:assert/strict";
import { mapVeoRequest, pollVeo, submitVeo, validateVeoSpec } from "../../tools/generation/providers/veo.mjs";

const spec = {
  provider: "veo",
  model: "veo-3.1-generate-001",
  prompt: "dolly from the staged first frame to the last frame",
  durationSeconds: 8,
  aspectRatio: "9:16",
  resolution: "720p",
  seed: 42,
  camera: { mode: "keys" },
  conditioning: { startFrame: "data:image/png;base64,YWJj", endFrame: "data:image/jpeg;base64,ZGVm", referenceVideo: null },
};

assert.equal(validateVeoSpec(spec).ok, true);
const mapped = mapVeoRequest(spec);
assert.deepEqual(mapped.instances[0].image, { bytesBase64Encoded: "YWJj", mimeType: "image/png" });
assert.deepEqual(mapped.instances[0].lastFrame, { bytesBase64Encoded: "ZGVm", mimeType: "image/jpeg" });
assert.deepEqual(mapped.parameters, { aspectRatio: "9:16", durationSeconds: 8, resolution: "720p", sampleCount: 1, generateAudio: true, seed: 42 });

let request;
const submitted = await submitVeo(spec, { token: "oauth", project: "cozy-project", location: "us-central1", fetchImpl: async (url, init) => {
  request = { url, body: JSON.parse(init.body), authorization: init.headers.Authorization };
  return new Response(JSON.stringify({ name: "projects/cozy-project/operations/veo-1" }), { status: 200 });
} });
assert.equal(submitted.providerJobId, "projects/cozy-project/operations/veo-1");
assert.match(request.url, /veo-3\.1-generate-001:predictLongRunning$/);
assert.equal(request.authorization, "Bearer oauth");

const polled = await pollVeo(submitted.providerJobId, { token: "oauth", project: "cozy-project", model: spec.model, fetchImpl: async (_url, init) => {
  assert.deepEqual(JSON.parse(init.body), { operationName: submitted.providerJobId });
  return new Response(JSON.stringify({ done: true, response: { videos: [{ bytesBase64Encoded: "bXA0", mimeType: "video/mp4" }] } }), { status: 200 });
} });
assert.equal(polled.status, "succeeded");
assert.equal(polled.outputUrl, "data:video/mp4;base64,bXA0");
assert.equal(validateVeoSpec({ ...spec, durationSeconds: 5 }).ok, false);
assert.equal(validateVeoSpec({ ...spec, conditioning: { startFrame: "https://example.test/frame.png" } }).ok, false);
console.log("Veo provider mapping and long-running operation polling verified");
