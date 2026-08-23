#!/usr/bin/env node
// The Camera Block owns one persisted camera instruction per shot; these
// checks pin the craneHeight field's normalization contract: absent stays
// null (legacy shots), patches round-trip, marks clamp to a sane floor, and
// deleting the rail deletes the crane that rode it.
import { createCameraBlock, removeCameraRail, updateCameraBlock } from "../src/camera-block.js";

let failures = 0;
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
	if (!cond) failures += 1;
};

{
	ok("legacy blocks carry no crane", createCameraBlock({}).craneHeight === null);
	ok("stored crane marks survive normalization", (() => {
		const block = createCameraBlock({ craneHeight: { start: 3, end: 1.2 } });
		return block.craneHeight?.start === 3 && block.craneHeight?.end === 1.2;
	})(), JSON.stringify(createCameraBlock({ craneHeight: { start: 3, end: 1.2 } }).craneHeight));
	ok("malformed crane values normalize to null", createCameraBlock({ craneHeight: { start: "high" } }).craneHeight === null);
	ok("crane marks clamp to the 0.1 m floor", (() => {
		const block = createCameraBlock({ craneHeight: { start: -2, end: 0 } });
		return block.craneHeight?.start === 0.1 && block.craneHeight?.end === 0.1;
	})());
}

{
	const base = createCameraBlock({ mode: "rail", cameraRail: [{ x: 0, z: 0 }, { x: 4, z: 0 }] });
	const craned = updateCameraBlock(base, { craneHeight: { start: 3, end: 1.2 } });
	ok("updateCameraBlock round-trips a crane patch", craned.craneHeight?.start === 3 && craned.craneHeight?.end === 1.2);
	ok("unrelated patches keep the crane", updateCameraBlock(craned, { mode: "rail" }).craneHeight?.end === 1.2);
	ok("an explicit null patch levels the crane", updateCameraBlock(craned, { craneHeight: null }).craneHeight === null);
	ok("deleting the rail deletes its crane", removeCameraRail(craned).craneHeight === null);
	ok("blocks never share crane objects", (() => {
		const clone = createCameraBlock(craned);
		return clone.craneHeight !== craned.craneHeight && clone.craneHeight.start === 3;
	})());
}

console.log(failures === 0 ? "all camera-block checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
