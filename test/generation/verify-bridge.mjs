import assert from "node:assert/strict";
import { createGenerationServer } from "../../tools/generation/bridge.mjs";

const server = createGenerationServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const request = (path, options) => fetch(base + path, options);
try {
  let response = await request("/generation/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);

  response = await request("/generation/models");
  assert.equal(response.status, 200);
  assert.ok((await response.json()).models.length >= 1);

  response = await request("/generation/validate", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(response.status, 400);

  response = await request("/generation/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gen4_turbo" }) });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).reason, "provider is required");

  response = await request("/generation/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "runway" }) });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).reason, "model is required");

  response = await request("/generation/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "other", model: "x" }) });
  assert.equal(response.status, 422);

  response = await request("/generation/jobs/missing");
  assert.equal(response.status, 404);

  response = await request("/missing");
  assert.equal(response.status, 404);
  console.log("generation bridge endpoints verified");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
