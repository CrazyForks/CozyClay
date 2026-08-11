#!/usr/bin/env node
// Follow-camera contracts: the shot must behave like a crew — hold distance,
// survive corners without snapping, live exactly on a drawn rail, and be
// deterministic so scrubbing and Record replay the identical track.
import {
	FOLLOW_DEFAULTS,
	buildFollowTrack,
	buildRailFollowTrack,
	buildRail,
	railPoint,
	simplifyStroke,
	travelDirections,
} from "../src/camera-follow.js";

let failures = 0;
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
	if (!cond) failures += 1;
};

const FPS = 20;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** wrap-safe absolute yaw difference */
const yawDelta = (a, b) => {
	let d = a - b;
	while (d > Math.PI) d -= 2 * Math.PI;
	while (d < -Math.PI) d += 2 * Math.PI;
	return Math.abs(d);
};

/** straight walk down +Z at 1.4 m/s for `seconds` */
function straightWalk(seconds, speed = 1.4) {
	const frames = Math.round(seconds * FPS);
	return Array.from({ length: frames }, (_, f) => ({ x: 0, z: (speed * f) / FPS }));
}

/** walk +Z for 4 s, turn the corner, walk +X for 4 s (the corner case) */
function cornerWalk(speed = 1.4) {
	const leg = Math.round(4 * FPS);
	const track = [];
	for (let f = 0; f < leg; f += 1) track.push({ x: 0, z: (speed * f) / FPS });
	const zEnd = (speed * (leg - 1)) / FPS;
	for (let f = 1; f <= leg; f += 1) track.push({ x: (speed * f) / FPS, z: zEnd });
	return track;
}

/* ------------------------------------------------------- free follow --- */

const walk = straightWalk(8);
const free = buildFollowTrack(walk, FPS);
ok("free follow emits one sample per subject frame", free.length === walk.length);
{
	// after the spring settles, the grip holds the requested distance
	const late = free.slice(60);
	const errs = late.map((s, i) => Math.abs(dist(s.pos, walk[60 + i]) - FOLLOW_DEFAULTS.distance));
	ok("free follow settles to the requested distance (±0.3 m)", Math.max(...errs) < 0.3, `max err ${Math.max(...errs).toFixed(3)}`);
	ok("free follow keeps the requested height", Math.abs(free[100].pos.y - FOLLOW_DEFAULTS.height) < 0.05, String(free[100].pos.y));
	ok(
		"free follow opens already composed (no slide-in at frame 0)",
		Math.abs(dist(free[0].pos, walk[0]) - FOLLOW_DEFAULTS.distance) < 0.05,
		String(dist(free[0].pos, walk[0])),
	);
	// behind means behind: for a +Z walk the camera sits at smaller z
	ok("free follow trails behind the travel direction", free[100].pos.z < walk[100].z, `cam z ${free[100].pos.z} subj z ${walk[100].z}`);
}

{
	const corner = cornerWalk();
	const track = buildFollowTrack(corner, FPS);
	const maxYawStep = Math.max(...track.slice(1).map((s, i) => yawDelta(s.yaw, track[i].yaw)));
	// the raw look-at (undamped) would exceed this on the corner frames
	ok(
		"corner: damped aim never snaps (max yaw step under 3°/frame)",
		maxYawStep < (3 * Math.PI) / 180,
		`${((maxYawStep * 180) / Math.PI).toFixed(2)} deg/frame`,
	);
	const errs = track.slice(40).map((s, i) => Math.abs(dist(s.pos, corner[40 + i]) - FOLLOW_DEFAULTS.distance));
	ok("corner: distance holds through the turn (±1 m)", Math.max(...errs) < 1, `max err ${Math.max(...errs).toFixed(3)}`);
}

{
	// a pause mid-walk: the camera coasts to rest instead of orbiting
	const stopAndGo = [...straightWalk(4), ...Array.from({ length: 40 }, () => ({ x: 0, z: straightWalk(4).at(-1).z }))];
	const track = buildFollowTrack(stopAndGo, FPS);
	const tail = track.slice(-5);
	const drift = Math.max(...tail.slice(1).map((s, i) => dist(s.pos, tail[i].pos)));
	ok("a stopped subject brings the camera to rest", drift < 0.01, `tail drift ${drift.toFixed(4)} m/frame`);
}

{
	const a = buildFollowTrack(cornerWalk(), FPS);
	const b = buildFollowTrack(cornerWalk(), FPS);
	ok("the track is deterministic (same input, same output)", JSON.stringify(a) === JSON.stringify(b));
}

{
	const dirs = travelDirections(straightWalk(2), FPS);
	ok("pre-move frames already face the coming walk (probe, not snap)", Math.abs(dirs[0].z - 1) < 1e-6 && Math.abs(dirs[0].x) < 1e-6);
}

/* ------------------------------------------------------ stroke + rail --- */

{
	// a noisy straight stroke collapses to its two endpoints
	const noisy = Array.from({ length: 120 }, (_, i) => ({ x: i * 0.1, z: (i % 2) * 0.04 }));
	const simple = simplifyStroke(noisy, 0.12);
	ok("RDP collapses pointer jitter on a straight stroke", simple.length <= 4, `${simple.length} points`);
	const corner = [
		...Array.from({ length: 50 }, (_, i) => ({ x: i * 0.1, z: 0 })),
		...Array.from({ length: 50 }, (_, i) => ({ x: 5, z: (i + 1) * 0.1 })),
	];
	const simpleCorner = simplifyStroke(corner, 0.12);
	ok(
		"RDP keeps the corner point",
		simpleCorner.some((p) => Math.abs(p.x - 4.9) < 0.2 && Math.abs(p.z) < 0.2),
		JSON.stringify(simpleCorner),
	);
}

{
	const rail = buildRail([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }]);
	ok("rail measures a plausible arc length", rail.length > 7.5 && rail.length < 9.2, String(rail.length));
	ok("railPoint clamps at both ends", dist(railPoint(rail, -5), { x: 0, z: 0 }) < 1e-6 && dist(railPoint(rail, 999), { x: 4, z: 4 }) < 1e-6);
	ok("degenerate strokes yield no rail", buildRail([{ x: 1, z: 1 }]) === null && buildRail([]) === null);
}

{
	// rail alongside a straight walk: dolly pushes parallel, holds distance
	const walkLong = straightWalk(10);
	const rail = buildRail([{ x: -2.5, z: -2 }, { x: -2.5, z: 16 }]);
	const track = buildRailFollowTrack(walkLong, FPS, rail);
	ok("rail follow emits one sample per subject frame", track.length === walkLong.length);
	const onRail = track.every((s) => Math.abs(s.pos.x - -2.5) < 1e-6);
	ok("the camera never leaves the rail", onRail);
	const late = track.slice(80);
	const errs = late.map((s, i) => Math.abs(dist(s.pos, walkLong[80 + i]) - FOLLOW_DEFAULTS.distance));
	ok("rail follow holds distance where the rail allows it (±0.5 m)", Math.max(...errs) < 0.5, `max err ${Math.max(...errs).toFixed(3)}`);
	const sSteps = track.slice(1).map((s, i) => s.s - track[i].s);
	ok(
		"the dolly respects its speed cap",
		Math.max(...sSteps.map(Math.abs)) <= 4 / FPS + 1e-6,
		`${(Math.max(...sSteps.map(Math.abs)) * FPS).toFixed(2)} m/s`,
	);
}

{
	// subject walks past the rail's end: s clamps, no teleport, aim keeps up
	const walkLong = straightWalk(12);
	const rail = buildRail([{ x: -2, z: 0 }, { x: -2, z: 4 }]);
	const track = buildRailFollowTrack(walkLong, FPS, rail);
	// the spring converges asymptotically, so "pinned" means within a hand's
	// width of the buffer, not bit-exact
	ok("a too-short rail pins the dolly at its end", track.at(-1).s > rail.length - 0.1, String(track.at(-1).s));
	const maxYawStep = Math.max(...track.slice(1).map((s, i) => yawDelta(s.yaw, track[i].yaw)));
	ok("panning from a pinned dolly still never snaps", maxYawStep < (3 * Math.PI) / 180, `${((maxYawStep * 180) / Math.PI).toFixed(2)} deg/frame`);
}

{
	const a = buildRailFollowTrack(cornerWalk(), FPS, buildRail([{ x: -2, z: -2 }, { x: -2, z: 8 }, { x: 8, z: 8 }]));
	const b = buildRailFollowTrack(cornerWalk(), FPS, buildRail([{ x: -2, z: -2 }, { x: -2, z: 8 }, { x: 8, z: 8 }]));
	ok("rail track is deterministic", JSON.stringify(a) === JSON.stringify(b));
}

console.log(failures === 0 ? "all camera-follow checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
