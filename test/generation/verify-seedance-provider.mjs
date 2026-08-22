import assert from "node:assert/strict";
import { cancelSeedance, mapSeedanceRequest, pollSeedance, submitSeedance, validateSeedanceSpec } from "../../tools/generation/providers/seedance.mjs";

const spec = {
  provider: "seedance",
  model: "dreamina-seedance-2-0-260128",
  prompt: "follow the staged actor along the rail",
  durationSeconds: 6,
  aspectRatio: "16:9",
  resolution: "720p",
  seed: 7,
  camera: { mode: "rail" },
  conditioning: { startFrame: "data:image/png;base64,abc", endFrame: "data:image/png;base64,def", referenceVideo: null },
};

const verdict = validateSeedanceSpec(spec);
assert.equal(verdict.ok, true);
assert.equal(verdict.warnings.length, 2);
const mapped = mapSeedanceRequest(spec);
assert.deepEqual(mapped.content.slice(1).map(({ role }) => role), ["first_frame", "last_frame"]);
assert.equal(mapped.duration, 6);
assert.equal(mapped.ratio, "16:9");
assert.equal(mapSeedanceRequest({ ...spec, aspectRatio: "9:16" }).ratio, "9:16");
assert.equal("seed" in mapped, false, "unsupported Seedance 2.0 seed is not guessed into the request");

let submitted;
const submit = await submitSeedance(spec, { apiKey: "test", fetchImpl: async (url, init) => {
  submitted = { url, body: JSON.parse(init.body), authorization: init.headers.Authorization };
  return new Response(JSON.stringify({ id: "seedance-task-1" }), { status: 200 });
} });
assert.equal(submit.providerJobId, "seedance-task-1");
assert.match(submitted.url, /contents\/generations\/tasks$/);
assert.equal(submitted.authorization, "Bearer test");
assert.equal(submitted.body.content[2].role, "last_frame");

const polled = await pollSeedance("seedance-task-1", { apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({ status: "succeeded", content: { video_url: "https://example.test/seedance.mp4" } }), { status: 200 }) });
assert.equal(polled.status, "succeeded");
assert.equal(polled.outputUrl, "https://example.test/seedance.mp4");

let cancelMethod;
await cancelSeedance("seedance-task-1", { apiKey: "test", fetchImpl: async (_url, init) => { cancelMethod = init.method; return new Response("{}", { status: 200 }); } });
assert.equal(cancelMethod, "DELETE");
assert.equal(validateSeedanceSpec({ ...spec, durationSeconds: 3 }).ok, false);
assert.equal(validateSeedanceSpec({ ...spec, conditioning: { ...spec.conditioning, referenceVideo: "https://example.test/ref.mp4" } }).ok, false);
console.log("Seedance provider mapping, polling, and cancellation verified");
