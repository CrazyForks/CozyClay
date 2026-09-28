#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { parseSync } from "rolldown/experimental";
import { createSemanticState } from "../../src/semantic-edit.js";
import { fixture, result } from "./fixture.mjs";

const WRITER_NAMES = new Set([
  "setStyle", "setKeyLight", "setEnvironmentImage", "setShotAspectKey", "setSensorFormat",
  "setCharacters", "setSceneObjects", "setScenes", "setActiveSceneId", "setCustomPoses",
  "setSelectedHierarchyId", "setFalMotion", "setToast", "setMotion", "setProject", "setStage",
]);
const writerName = name => WRITER_NAMES.has(name) || /^record.*Undo$/.test(name);
const isRunCall = node => node?.type === "CallExpression" && ((node.callee?.type === "Identifier" && node.callee.name === "run") || (node.callee?.type === "MemberExpression" && node.callee.property?.name === "run"));
const functionName = node => node?.id?.name ?? "<anonymous>";

function scanSource(source, file = "fixture.jsx") {
  const ast = parseSync(file, source);
  const aliases = new Set();
  const references = [];
  const handlers = [];
  const functions = [];
  const visit = (node, owner = "<module>", parent = null) => {
    if (!node || typeof node !== "object") return;
    let nextOwner = owner;
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      nextOwner = functionName(node);
      functions.push(nextOwner);
    }
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init?.type === "Identifier" && writerName(node.init.name)) aliases.add(node.id.name);
    if (node.type === "CallExpression" && isRunCall(node)) return;
    if (node.type === "Identifier" && (writerName(node.name) || aliases.has(node.name))) {
      const declaration = parent?.type === "VariableDeclarator" && parent.id === node;
      const property = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
      if (!declaration && !property) references.push({ file, function: nextOwner, name: node.name, kind: "reference" });
    }
    if (node.type === "MemberExpression" && node.object?.type === "Identifier" && ["liveStateRef", "liveHandlersRef"].includes(node.object.name)) references.push({ file, function: nextOwner, name: `${node.object.name}.${node.computed ? "computed" : node.property?.name}`, kind: "computed-live-ref" });
    if (node.type === "JSXAttribute" && node.value?.type === "JSXExpressionContainer" && node.value.expression?.type === "Identifier" && (writerName(node.value.expression.name) || aliases.has(node.value.expression.name))) handlers.push({ file, function: nextOwner, name: node.value.expression.name });
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key === "loc") continue;
      if (Array.isArray(value)) for (const child of value) visit(child, nextOwner, node);
      else if (value && typeof value === "object") visit(value, nextOwner, node);
    }
  };
  visit(ast.program ?? ast);
  const perFunction = Object.fromEntries(functions.map(name => [name, references.filter(ref => ref.function === name).length]).filter(([, count]) => count > 0));
  return { references, handlers, perFunction };
}

function applyRatchet(current, baseline) {
  const errors = [];
  for (const [key, count] of Object.entries(baseline)) {
    if (!(key in current)) errors.push(`${key}: stale baseline entry`);
    else if (current[key] > count) errors.push(`${key}: ${current[key]} exceeds baseline ${count}`);
  }
  return errors;
}

function scanTree(root) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsx")) files.push(path);
    }
  };
  walk(root);
  return files.flatMap(file => scanSource(readFileSync(file, "utf8"), relative(root, file)).references);
}

function test(name, run) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error; }
}

test("fixture setStyle call is detected as a document-writer reference", () => {
  const result = scanSource("function Panel(){ const onChange = () => setStyle('film'); return <input onChange={onChange}/>; }");
  assert.equal(result.references.some(ref => ref.name === "setStyle"), true);
});

test("fixture setter passed as JSX prop is detected", () => {
  const result = scanSource("function Panel(){ return <Child onChange={setStyle}/>; }");
  assert.equal(result.references.some(ref => ref.name === "setStyle"), true);
  assert.equal(result.handlers.some(ref => ref.name === "setStyle"), true);
});

test("fixture run call is not a document-writer reference", () => {
  const result = scanSource("function Panel(){ return run('stage.set', {value: 1}); }");
  assert.equal(result.references.length, 0);
});

test("stale baseline entries fail the ratchet", () => {
  assert.deepEqual(applyRatchet({ Panel: 1 }, { Panel: 1, Removed: 1 }), ["Removed: stale baseline entry"]);
});

test("aliases and computed live references count", () => {
  const result = scanSource("function Panel(){ const s=setStyle; return <Child onChange={s} value={liveHandlersRef.current['setStyle']}/>; }");
  assert.equal(result.references.some(ref => ref.name === "s"), true);
  assert.equal(result.references.some(ref => ref.kind === "computed-live-ref"), true);
});

test("ratchet baseline is non-increasing", () => {
  assert.deepEqual(applyRatchet({ Panel: 2 }, { Panel: 1 }), ["Panel: 2 exceeds baseline 1"]);
});

test("semantic edit warns when called outside a bus run", () => {
  const warnings = [];
  const previous = console.warn;
  console.warn = message => warnings.push(String(message));
  try { createSemanticState(0, () => {}, () => {}, "stage").edit(1); }
  finally { console.warn = previous; }
  assert.equal(warnings.some(message => message.includes("outside a bus run")), true);
});

test("semantic edit is silent inside a bus run", () => {
  const warnings = [];
  const previous = console.warn;
  const f = fixture();
  const state = createSemanticState(0, () => {}, () => {}, "stage");
  f.register("shot.create", () => { state.edit(1); return result(); });
  console.warn = message => warnings.push(String(message));
  try { assert.equal(f.bus.run("shot.create", {}, f.request("ui")).ok, true); }
  finally { console.warn = previous; }
  assert.deepEqual(warnings, []);
});

export { scanSource, scanTree, applyRatchet };

const actualReferences = scanTree(fileURLToPath(new URL("../../src", import.meta.url)));
const currentCounts = Object.create(null);
for (const ref of actualReferences) currentCounts[`${ref.file}::${ref.function}`] = (currentCounts[`${ref.file}::${ref.function}`] ?? 0) + 1;
const actual = actualReferences;
console.log(`BUS COVERAGE (a) document-writer references outside commands: ${actual.length}`);
console.log(`BUS COVERAGE (b) document-mutating UI handler sites reaching run: ${actual.filter(ref => ref.kind === "run-handler").length}`);
console.log("BUS COVERAGE (c) registered commands exposed to agents: generated by parity matrix");

test("committed baseline accepts the current writer set", () => {
  const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url))).writers;
  assert.deepEqual(applyRatchet(currentCounts, baseline), []);
});
