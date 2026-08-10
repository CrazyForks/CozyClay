#!/usr/bin/env node
// The camera-move contract: interpolation reproduces its endpoints, an orbit
// stays on the arc instead of cutting the chord, and the classifier only
// claims a move the two framings geometrically prove.
import {
	captureFraming,
	classifyMove,
	easeInOut,
	interpolateFraming,
	moveSlate,
	shortestArc,
} from "../src/camera-move.js";
import { FRAMING_PIVOT_Y, focalMmToFov, fovToFocalMm } from "../src/shot.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const SUBJECT = { x: 0, z: 0, rot: 180 }; // facing +z-ish per shot.js convention
const linear = (t) => t;

/** a framing at (r, azimuthDeg, height) aimed at the subject's framing pivot */
function framingAt(r, azimuthDeg, height, fovDeg = 40) {
	const az = (azimuthDeg * Math.PI) / 180;
	const pos = { x: SUBJECT.x + r * Math.sin(az), y: height, z: SUBJECT.z + r * Math.cos(az) };
	const dx = SUBJECT.x - pos.x;
	const dy = FRAMING_PIVOT_Y - pos.y;
	const dz = SUBJECT.z - pos.z;
	return captureFraming({
		pos,
		yaw: Math.atan2(-dx, -dz),
		pitch: Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1e-6)),
		fovDeg,
	});
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ------------------------------------------------ endpoints are exact --- */
{
	const a = framingAt(4, 10, 1.6);
	const b = framingAt(1.5, 55, 2.4, 28);
	const t0 = interpolateFraming(a, b, SUBJECT, 0, linear);
	const t1 = interpolateFraming(a, b, SUBJECT, 1, linear);
	expect(
		"t=0 reproduces framing A exactly",
		near(t0.pos.x, a.pos.x) && near(t0.pos.y, a.pos.y) && near(t0.pos.z, a.pos.z) && near(t0.yaw, a.yaw, 1e-9) && near(t0.pitch, a.pitch, 1e-9) && near(t0.fovDeg, a.fovDeg, 1e-9),
		JSON.stringify(t0),
	);
	expect(
		"t=1 reproduces framing B exactly",
		near(t1.pos.x, b.pos.x) && near(t1.pos.y, b.pos.y) && near(t1.pos.z, b.pos.z) && near(t1.yaw, b.yaw, 1e-9) && near(t1.pitch, b.pitch, 1e-9) && near(t1.fovDeg, b.fovDeg, 1e-9),
		JSON.stringify(t1),
	);
}

/* --------------------------------------- orbit walks the arc, not chord --- */
{
	const a = framingAt(3, 0, 1.6);
	const b = framingAt(3, 90, 1.6);
	const mid = interpolateFraming(a, b, SUBJECT, 0.5, linear);
	const midR = Math.hypot(mid.pos.x - SUBJECT.x, mid.pos.z - SUBJECT.z);
	expect("orbit midpoint keeps the full 3m radius", near(midR, 3, 1e-6), `r=${midR}`);
	// a straight lerp would cut to r = 3/sqrt(2) ≈ 2.12 and shove the lens at the subject
	const move = classifyMove(a, b, SUBJECT);
	expect("90° same-radius move classifies as orbit", move.id === "orbit", move.id);
	expect("orbit phrase reports the arc", /arcing 90 degrees/.test(move.phrase), move.phrase);
}

/* -------------------------------------------------- azimuth wraps short --- */
{
	expect("shortestArc wraps 170°->-170° to +20°", near(shortestArc((170 * Math.PI) / 180, (-170 * Math.PI) / 180) * (180 / Math.PI), 20, 1e-9));
	const a = framingAt(3, 170, 1.6);
	const b = framingAt(3, -170, 1.6);
	const mid = interpolateFraming(a, b, SUBJECT, 0.5, linear);
	const midAzDeg = (Math.atan2(mid.pos.x, mid.pos.z) * 180) / Math.PI;
	expect("interpolation crosses 180°, not the long way", near(Math.abs(midAzDeg), 180, 1e-6), `az=${midAzDeg}`);
}

/* ------------------------------------------------------- classification --- */
{
	const push = classifyMove(framingAt(4, 20, 1.6), framingAt(1.6, 20, 1.6), SUBJECT);
	expect("straight approach classifies as push-in", push.id === "push-in", push.id);
	expect("push-in phrase names both shot sizes", /from a .+ to a /.test(push.phrase), push.phrase);

	const pull = classifyMove(framingAt(1.6, 20, 1.6), framingAt(4, 20, 1.6), SUBJECT);
	expect("the reverse classifies as pull-out", pull.id === "pull-out", pull.id);

	const crane = classifyMove(framingAt(3, 20, 0.8), framingAt(3, 20, 2.8), SUBJECT);
	expect("vertical rise classifies as crane up", crane.id === "crane-up", crane.id);

	const still = classifyMove(framingAt(3, 20, 1.6), framingAt(3, 20, 1.6), SUBJECT);
	expect("identical framings classify as static", still.id === "static", still.id);
	expect("static phrase matches composePrompt's default", still.phrase === "static, locked-off shot", still.phrase);
}

/* ------------------------------------------------------------- pan/tilt --- */
{
	const a = framingAt(3, 0, 1.6);
	const b = { ...a, yaw: a.yaw + (25 * Math.PI) / 180 };
	const pan = classifyMove(a, b, SUBJECT);
	expect("rotation-only move classifies as a pan", pan.id === "pan-left", pan.id);
	const c = { ...a, pitch: a.pitch + (25 * Math.PI) / 180 };
	const tilt = classifyMove(a, c, SUBJECT);
	expect("pitch-only move classifies as a tilt up", tilt.id === "tilt-up", tilt.id);
}

/* ----------------------------------------------------------- dolly-zoom --- */
{
	// double the distance and double the focal length: the subject's screen
	// size holds while the background compresses — the textbook vertigo.
	const fovA = (focalMmToFov(35) * 180) / Math.PI;
	const fovB = (focalMmToFov(70) * 180) / Math.PI;
	const a = framingAt(2, 0, FRAMING_PIVOT_Y, fovA);
	const b = framingAt(4, 0, FRAMING_PIVOT_Y, fovB);
	const move = classifyMove(a, b, SUBJECT);
	expect("distance x2 + focal x2 classifies as dolly-zoom", move.id === "dolly-zoom", `${move.id} drift=${move.deltas.sizeDrift}`);
	expect("dolly-zoom kept subject size within drift budget", move.deltas.sizeDrift <= 0.15, `${move.deltas.sizeDrift}`);
}

/* -------------------------------------------------------------- zooming --- */
{
	const a = framingAt(3, 0, 1.6, (focalMmToFov(24) * 180) / Math.PI);
	const b = { ...a, fovDeg: (focalMmToFov(85) * 180) / Math.PI };
	const zoom = classifyMove(a, b, SUBJECT);
	expect("focal-only change classifies as zoom in", zoom.id === "zoom-in", zoom.id);
}

/* ---------------------------------------------------- lens interpolation --- */
{
	const a = framingAt(3, 0, 1.6, (focalMmToFov(20) * 180) / Math.PI);
	const b = framingAt(3, 0, 1.6, (focalMmToFov(80) * 180) / Math.PI);
	const mid = interpolateFraming(a, b, SUBJECT, 0.5, linear);
	const midMm = fovToFocalMm((mid.fovDeg * Math.PI) / 180);
	expect("lens interpolates in millimetres (20->80 mid is 50)", near(midMm, 50, 1e-6), `${midMm}mm`);
}

/* ------------------------------------------------------------------ ease --- */
{
	expect("easeInOut pins both ends", near(easeInOut(0), 0) && near(easeInOut(1), 1));
	expect("easeInOut midpoint is halfway", near(easeInOut(0.5), 0.5));
	expect("easeInOut starts gently", easeInOut(0.1) < 0.1);
}

/* ----------------------------------------------------------------- slate --- */
{
	const move = classifyMove(framingAt(4, 20, 1.6), framingAt(1.6, 20, 1.6), SUBJECT);
	const slate = moveSlate(move);
	expect("move slate reads A → B · MOVE", /^[A-Z0-9 -]+ \d+MM → [A-Z0-9 -]+ \d+MM · PUSH-IN/.test(slate), slate);
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll camera-move checks passed");
