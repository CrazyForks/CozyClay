import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStore } from "../../tools/generation/job-store.mjs";

const dir = await mkdtemp(join(tmpdir(), "cozyclay-store-"));
try {
  const file = join(dir, "jobs.json");
  const resultDir = join(dir, "results");
  const current = Date.parse("2026-08-13T00:00:00Z");
  const store = createJobStore({ file, resultDir, completedTtlMs: 1000, now: () => current });
  await store.load();
  await store.set({ id: "active", status: "processing", createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" });
  await store.set({ id: "done", status: "succeeded", createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" });
  const restored = createJobStore({ file, resultDir, completedTtlMs: 1000, now: () => current });
  await restored.load();
  assert.equal(restored.get("active").status, "processing");
  assert.equal(restored.get("done"), null);
  assert.equal(JSON.parse(await readFile(file, "utf8")).jobs.length, 1);
  console.log("generation job persistence, recovery, and TTL cleanup verified");
} finally {
  await rm(dir, { recursive: true, force: true });
}
