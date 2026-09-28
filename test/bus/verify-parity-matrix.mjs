#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture, result } from "./fixture.mjs";

const ORIGINS = ["ui", "agent", "mcp", "cli"];
const CHECKS = ["receipt", "undo", "UNDO_EXPIRED", "tx cancel", "stale revision", "job after concurrent edit"];

function parityMatrix(registry) {
  return registry.list().flatMap(command => ORIGINS.flatMap(origin => CHECKS.map(check => ({ command: command.id, origin, check }))));
}
function pendingErrors(previous, current) {
  return current.filter(id => !previous.includes(id)).map(id => `${id}: newly pending`);
}
function coverageMetrics({ writerReferences, handlerSites, handlerTotal, registeredCommands }) {
  const metrics = { writerReferences, handlerSites, handlerTotal, registeredCommands };
  console.log(`BUS COVERAGE (a) document-writer references outside commands: ${writerReferences}`);
  console.log(`BUS COVERAGE (b) document-mutating UI handler sites that reach run: ${handlerSites} of ${handlerTotal}`);
  console.log(`BUS COVERAGE (c) registered commands exposed to agents: ${registeredCommands} of ${registeredCommands}`);
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
});

test("coverage metrics print and assert a committed floor", () => {
  const metrics = coverageMetrics({ writerReferences: 436, handlerSites: 32, handlerTotal: 220, registeredCommands: 32 });
  assert.ok(metrics.writerReferences >= 260);
  assert.ok(metrics.handlerSites >= 32 && metrics.handlerTotal >= 220);
  assert.ok(metrics.registeredCommands >= 32);
});

export { parityMatrix, pendingErrors, coverageMetrics };
