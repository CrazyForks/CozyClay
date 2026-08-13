#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shotBlockGeometry } from "../src/ardy/timeline-coordinates.js";

const shots = [
	{ id: "a", name: "Wide", startFrame: 0 },
	{ id: "b", name: "Medium", startFrame: 40 },
	{ id: "c", name: "Close", startFrame: 70 },
];
assert.deepEqual(shotBlockGeometry(shots, 0, 100), { startFrame: 0, endFrame: 40, startPct: 0, endPct: 40 / 99 });
assert.deepEqual(shotBlockGeometry(shots, 1, 100), { startFrame: 40, endFrame: 70, startPct: 40 / 99, endPct: 70 / 99 });
assert.deepEqual(shotBlockGeometry(shots, 2, 100), { startFrame: 70, endFrame: 99, startPct: 70 / 99, endPct: 1 });
assert.equal(shotBlockGeometry(shots, 5, 100), null);

const timeline = readFileSync(new URL("../src/ardy/timeline.jsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
assert.ok(timeline.includes('const SHOTS_LANE = "Shots"'));
assert.ok(timeline.includes('className={"tl-shot-block"'));
assert.ok(timeline.includes("onShotBoundaryMove"));
assert.ok(timeline.includes("onShotRename"));
assert.ok(timeline.includes("onShotRemove"));
assert.ok(timeline.includes("onShotDuplicate"));
assert.ok(timeline.includes("onShotCut"));
assert.ok(timeline.includes('ko("+ Add shot", "+ 샷 추가")'));
assert.ok(timeline.includes("durationS.toFixed(1)"));
assert.ok(timeline.includes('className="tl-shot-edge end"'));
assert.ok(timeline.includes("onShotEndResize"));
assert.ok(timeline.includes("onShotMove"));
assert.ok(app.includes("shots={shots}"));
assert.ok(app.includes("moveBoundary(current, index, frame, tlFrameCount)"));
assert.ok(css.includes("width: calc((var(--tl-f-end) - var(--tl-f-start)) * 100%);"));
assert.ok(!css.includes("width: max(8px, calc((var(--tl-f-end) - var(--tl-f-start)) * 100%));"));

console.log("timeline shots lane verified");
