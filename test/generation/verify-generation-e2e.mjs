import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGenerationServer } from "../../tools/generation/bridge.mjs";
import { createJobStore } from "../../tools/generation/job-store.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const dir = await mkdtemp(join(tmpdir(), "cozyclay-e2e-"));
const video = Buffer.from("fake-mp4-result");
const outputServer = createServer((req, res) => { res.writeHead(200, { "content-type": "video/mp4" }); res.end(video); });
await listen(outputServer);
const outputUrl = `http://127.0.0.1:${outputServer.address().port}/result.mp4`;
let polls = 0;
let canceledProviderJob = null;
const fake = {
  available: () => true,
  models: [{ id: "fake-video", label: "Fake Video", durations: [5], capabilities: { startFrame: true } }],
  validate: (spec) => ({ ok: Boolean(spec.prompt && spec.conditioning?.startFrame), errors: [], warnings: [] }),
  estimateCost: () => 0,
  submit: async () => ({ providerJobId: "provider-1", warnings: [] }),
  poll: async () => (++polls === 1 ? { status: "processing", progress: 0.5 } : { status: "succeeded", progress: 1, outputUrl }),
  cancel: async (providerJobId) => { canceledProviderJob = providerJobId; },
};
const storeOptions = { file: join(dir, "jobs.json"), resultDir: join(dir, "results") };
let bridge = createGenerationServer({ store: createJobStore(storeOptions), providers: { fake } });
await listen(bridge);
try {
  let base = `http://127.0.0.1:${bridge.address().port}`;
  const spec = { provider: "fake", model: "fake-video", prompt: "tracking shot", durationSeconds: 5, shot: { id: "shot-1", name: "Arrival" }, camera: { mode: "rail" }, subjects: ["actor"], conditioning: { startFrame: "data:image/png;base64,abc" } };
  let response = await fetch(`${base}/generation/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
  assert.equal(response.status, 202);
  const submitted = await response.json();
  assert.equal(submitted.shot.id, "shot-1");
  assert.equal(submitted.camera.mode, "rail");
  assert.equal((await (await fetch(`${base}/generation/jobs/${submitted.id}`)).json()).status, "processing");
  const completed = await (await fetch(`${base}/generation/jobs/${submitted.id}`)).json();
  assert.equal(completed.status, "succeeded");
  assert.match(completed.outputUrl, /\/output$/);
  assert.deepEqual(Buffer.from(await (await fetch(base + completed.outputUrl)).arrayBuffer()), video);

  response = await fetch(`${base}/generation/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
  const cancelable = await response.json();
  response = await fetch(`${base}/generation/jobs/${cancelable.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "canceled");
  assert.equal(canceledProviderJob, "provider-1");

  await close(bridge);
  bridge = createGenerationServer({ store: createJobStore(storeOptions), providers: { fake } });
  await listen(bridge);
  base = `http://127.0.0.1:${bridge.address().port}`;
  const history = await (await fetch(`${base}/generation/jobs`)).json();
  const restoredSuccess = history.jobs.find((job) => job.status === "succeeded");
  assert.ok(restoredSuccess);
  assert.deepEqual(Buffer.from(await (await fetch(base + restoredSuccess.outputUrl)).arrayBuffer()), video);
  console.log("mock submit, poll, download, and restart recovery E2E verified");
} finally {
  await close(bridge).catch(() => {});
  await close(outputServer);
  await rm(dir, { recursive: true, force: true });
}
