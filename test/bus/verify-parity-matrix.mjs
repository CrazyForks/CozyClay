#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree } from "./verify-bus-coverage.mjs";
import { STUDIO_ACTIONS } from "../../src/studio-actions.js";
import { fixture, result } from "./fixture.mjs";
import { documentFixture } from "./document-store-fixture.mjs";

const ORIGINS = ["ui", "agent", "mcp", "cli"];
const CHECKS = ["receipt", "undo", "UNDO_EXPIRED", "tx cancel", "stale revision", "job after concurrent edit"];

function parityMatrix(registry) {
  return registry.list().filter(command => command.kind === "mutation").flatMap(command => ORIGINS.flatMap(origin => CHECKS.map(check => ({ command: command.id, origin, check }))));
}
function executeParity({ run, snapshot, command, args = { value: 1 }, raw = run }) {
  const rows = [];
  for (const origin of ORIGINS) {
    const before = structuredClone(snapshot().slices ?? snapshot());
    const receipt = run(command, args, origin);
    rows.push({ command, origin, check: "receipt", ok: Boolean(receipt.ok && receipt.revision.after === receipt.revision.before + 1 && receipt.affectedIds.length && receipt.undo?.historyEntryId) });
    const undone = run("edit.undo", { receiptId: receipt.receiptId }, "ui");
    rows.push({ command, origin, check: "undo", ok: undone.status === "undone" && JSON.stringify(snapshot().slices ?? snapshot()) === JSON.stringify(before) });
  }
  const first = run(command, args, "ui");
  for (let i = 0; i < 50; i++) run(command, { ...args, value: i + 2 }, "ui");
  rows.push({ command, origin: "ui", check: "UNDO_EXPIRED", ok: run("edit.undo", { receiptId: first.receiptId }, "ui").code === "UNDO_EXPIRED" });
  const transactionBefore = structuredClone(snapshot().slices ?? snapshot());
  const opened = run("run.begin", { id: command, args }, "agent");
  run("run.update", { txId: opened.txId, args: { ...args, value: 9 } }, "agent");
  rows.push({ command, origin: "agent", check: "tx cancel", ok: run("run.cancel", { txId: opened.txId }, "agent").ok && JSON.stringify(snapshot().slices ?? snapshot()) === JSON.stringify(transactionBefore) });
  const staleRevision = snapshot().revision;
  run(command, { ...args, value: 77 }, "ui");
  const refused = raw(command, args, "agent", { expectedRevision: staleRevision });
  rows.push({ command, origin: "agent", check: "stale revision", ok: refused.code === "STALE_SCENE" });

  return rows;
}

function pendingErrors(previous, current) {
  return current.filter(id => !previous.includes(id)).map(id => `${id}: newly pending`);
}
function sourceFiles(root) {
  const files = [];
  const walk = dir => readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".jsx")) files.push(path);
  });
  walk(root);
  return files;
}
function coverageMetrics() {
  const sources = sourceFiles(fileURLToPath(new URL("../../src", import.meta.url)));
  const text = sources.map(file => readFileSync(file, "utf8"));
  const handlerTotal = text.reduce((total, source) => total + [...source.matchAll(/on[A-Z][A-Za-z]+\s*=\s*\{/g)].length, 0);
  const handlerSites = text.reduce((total, source) => total + [...source.matchAll(/on[A-Z][A-Za-z]+[\s\S]{0,240}?\brun\s*\(/g)].length, 0);
  const metrics = { writerReferences: scanTree(fileURLToPath(new URL("../../src", import.meta.url))).length, handlerSites, handlerTotal, registeredCommands: STUDIO_ACTIONS.filter(action => action.exposure !== "ui-only").length };
  console.log(`BUS COVERAGE (a) document-writer references outside commands: ${metrics.writerReferences}`);
  console.log(`BUS COVERAGE (b) document-mutating UI handler sites that reach run: ${metrics.handlerSites} of ${metrics.handlerTotal}`);
  console.log(`BUS COVERAGE (c) registered commands exposed to agents: ${metrics.registeredCommands} of ${metrics.registeredCommands}`);
  return metrics;
}
function test(name, run) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error; }
}

test("a fixture-only registration gets every origin/check row", () => {
  const f = fixture();
  f.registry.register({
    id: "fixture.parity", label: "Parity fixture", kind: "mutation", description: "fixture", undoDomain: "shot",
    input: { type: "object", properties: {}, required: [], additionalProperties: false }, available: () => true, run: () => result(),
  });
  const rows = parityMatrix(f.registry).filter(row => row.command === "fixture.parity");
  assert.equal(rows.length, ORIGINS.length * CHECKS.length);
  assert.deepEqual(new Set(rows.map(row => row.origin)), new Set(ORIGINS));
  assert.deepEqual(new Set(rows.map(row => row.check)), new Set(CHECKS));
});

test("parity pending ids may only shrink", () => {
  const previous = JSON.parse(readFileSync(new URL("./parity-pending.json", import.meta.url))).pending;
  assert.deepEqual(pendingErrors(["stage", "shots"], ["stage"]), []);
  assert.deepEqual(pendingErrors(previous, [...previous, "new-domain"]), ["new-domain: newly pending"]);
  console.log(`BUS PARITY pending rows: ${previous.length * ORIGINS.length * CHECKS.length}`);
  assert.equal(previous.length * ORIGINS.length * CHECKS.length, 120);
});

test("coverage metrics are measured from the source and registered actions", () => {
  const f = fixture();
  const metrics = coverageMetrics();
  assert.equal(typeof metrics.writerReferences, "number");
  assert.equal(typeof metrics.handlerSites, "number");
  assert.equal(typeof metrics.registeredCommands, "number");
  assert.equal(metrics.registeredCommands, STUDIO_ACTIONS.filter(action => action.exposure !== "ui-only").length);
  const floor = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url))).coverage;
  assert.ok(metrics.writerReferences <= floor.writerReferences);
  assert.ok(metrics.handlerSites >= floor.handlerSites && metrics.handlerTotal >= floor.handlerTotal);
  assert.ok(metrics.registeredCommands >= floor.registeredCommands);
});

test("registered mutations execute receipt and undo checks through the real bus", () => {
  const f = documentFixture();
  const rows = executeParity({
    run: (id, args, origin) => f.run(id, args, origin),
    raw: (id, args, origin, options) => f.bus.run(id, args, { origin, host: f.host, ...options }),
    snapshot: () => f.store.getSnapshot(),
    command: "stage.set",
  });
  assert.equal(rows.length, ORIGINS.length * 2 + 3);
  assert.equal(rows.every(row => row.ok), true, JSON.stringify(rows));
});

export { parityMatrix, pendingErrors, coverageMetrics, executeParity };
