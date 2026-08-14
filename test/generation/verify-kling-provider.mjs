import assert from "node:assert/strict";
import { mapKlingRequest, pollKling, submitKling, validateKlingSpec } from "../../tools/generation/providers/kling.mjs";

const spec = {
  provider: "kling",
  model: "kling-v3",
  prompt: "a continuous follow-camera move",
  durationSeconds: 5,
  aspectRatio: "16:9",
  resolution: "1080p",
  camera: { mode: "follow" },
  conditioning: { startFrame: "data:image/png;base64,abc", endFrame: "data:image/png;base64,def", referenceVideo: null },
};

assert.equal(validateKlingSpec(spec).ok, true);
assert.deepEqual(mapKlingRequest(spec), {
  model_name: "kling-v3",
  image: spec.conditioning.startFrame,
  prompt: spec.prompt,
  mode: "pro",
  duration: "5",
  sound: "on",
  image_tail: spec.conditioning.endFrame,
});

let request;
const submitted = await submitKling(spec, { token: "test-token", fetchImpl: async (url, init) => {
  request = { url, body: JSON.parse(init.body), authorization: init.headers.Authorization };
  return new Response(JSON.stringify({ data: { task_id: "kling-task-1" } }), { status: 200 });
} });
assert.equal(submitted.providerJobId, "kling-task-1");
assert.equal(request.authorization, "Bearer test-token");
assert.equal(request.body.image_tail, spec.conditioning.endFrame);

const polled = await pollKling("kling-task-1", { token: "test-token", fetchImpl: async () => new Response(JSON.stringify({ data: { task_status: "succeed", task_result: { videos: [{ url: "https://example.test/kling.mp4" }] } } }), { status: 200 }) });
assert.equal(polled.status, "succeeded");
assert.equal(polled.outputUrl, "https://example.test/kling.mp4");
assert.equal(validateKlingSpec({ ...spec, resolution: "4k" }).ok, false);
assert.throws(() => mapKlingRequest({ ...spec, conditioning: {} }), /requires a staged start frame/);
console.log("Kling provider mapping and polling verified");
