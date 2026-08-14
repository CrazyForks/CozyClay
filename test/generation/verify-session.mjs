import assert from "node:assert/strict";
import { runGeneration } from "../../src/generation/session.js";

const updates = [];
let polls = 0;
const completed = await runGeneration({ model: "fake" }, {
  validate: async () => ({ ok: true }),
  submit: async () => ({ id: "job-1", status: "processing" }),
  poll: async () => (++polls === 1 ? { id: "job-1", status: "processing" } : { id: "job-1", status: "succeeded", outputUrl: "/output" }),
  sleep: async () => {},
  onUpdate: (state) => updates.push(state.status),
});
assert.equal(completed.status, "succeeded");
assert.deepEqual(updates, ["validating", "submitting", "processing", "processing", "succeeded"]);

const controller = new AbortController();
await assert.rejects(runGeneration({}, {
  signal: controller.signal,
  validate: async () => ({ ok: true }),
  submit: async () => ({ id: "job-2", status: "processing" }),
  sleep: async () => { controller.abort(new Error("stop")); throw controller.signal.reason; },
}), /stop/);
console.log("generation session polling and cancellation verified");
