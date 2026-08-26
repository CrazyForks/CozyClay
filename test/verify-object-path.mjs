// Object travel paths: schema repair, arc-length sampling and the frame →
// transform answer that playback, export and MCP all share.
import { createObjectPath, pathMetrics, objectTransformAt, MAX_PATH_POINTS } from "../src/object-path.js";

let failures = 0;
const ok = (name, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` — ${detail}`}`);
	if (!pass) failures += 1;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/* --- schema ---------------------------------------------------------------- */

ok("a path needs two points", createObjectPath({ points: [{ x: 0, z: 0 }] }) === null);
ok("junk is not a path", createObjectPath(null) === null && createObjectPath({}) === null);
ok("a stroke that never moves is not a path", createObjectPath({ points: [{ x: 1, z: 1 }, { x: 1, z: 1 }] }) === null);
ok("repeated drag samples collapse", (() => {
	const path = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 4, z: 0 }] });
	return path?.points.length === 2;
})());
ok("points are clamped into the room and above the floor", (() => {
	const path = createObjectPath({ points: [{ x: -9999, y: -5, z: 0 }, { x: 9999, y: 9999, z: 0 }] });
	return path.points[0].x === -240 && path.points[0].y === 0 && path.points[1].x === 240 && path.points[1].y === 60;
})());
ok("point count is capped", (() => {
	const many = Array.from({ length: 200 }, (_, i) => ({ x: i, z: 0 }));
	return createObjectPath({ points: many }).points.length === MAX_PATH_POINTS;
})());
ok("faceTravel defaults on, loop and extend default off", (() => {
	const path = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] });
	return path.faceTravel === true && path.loop === false && path.extend === false;
})());
ok("a negative or absurd speed falls back to fill-the-timeline", (() => {
	const slow = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], speed: -3 });
	const fast = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], speed: 999 });
	return slow.speed === 0 && fast.speed === 50;
})());

/* --- arc length ------------------------------------------------------------ */

{
	const path = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 4 }] });
	const metrics = pathMetrics(path);
	ok("cumulative length walks the stroke", near(metrics.length, 7) && near(metrics.cumulative[1], 3), JSON.stringify(metrics));
}

/* --- sampling -------------------------------------------------------------- */

const take = { frameCount: 25, fps: 24 }; // exactly one second of travel

{
	// 24 m across 1 s with no speed set: the path fills the timeline
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 24, z: 0 }] } };
	const start = objectTransformAt(object, 0, take);
	const mid = objectTransformAt(object, 12, take);
	const end = objectTransformAt(object, 24, take);
	ok("frame 0 sits at the stroke's start", near(start.x, 0) && near(start.z, 0));
	ok("the middle frame is halfway along", near(mid.x, 12, 1e-3), JSON.stringify(mid));
	ok("the last frame lands on the end", near(end.x, 24, 1e-3), JSON.stringify(end));
}
{
	// an explicit speed overrides the fill
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 24, z: 0 }], speed: 1 } };
	const end = objectTransformAt(object, 24, take);
	ok("an explicit speed travels metres per second", near(end.x, 1, 1e-3), JSON.stringify(end));
}
{
	// without extend the object parks at the end
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 2, z: 0 }], speed: 10 } };
	const parked = objectTransformAt(object, 24, take);
	ok("travel stops at the last point by default", near(parked.x, 2, 1e-3), JSON.stringify(parked));
}
{
	// extend keeps going in the final direction — the "just keep moving" case
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 2, z: 0 }], speed: 10, extend: true } };
	const past = objectTransformAt(object, 24, take);
	ok("extend keeps travelling past the end", past.x > 9, JSON.stringify(past));
}
{
	// loop wraps instead of parking
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 4, z: 0 }], speed: 8, loop: true } };
	const wrapped = objectTransformAt(object, 24, take);
	ok("loop wraps back onto the stroke", wrapped.x >= 0 && wrapped.x <= 4, JSON.stringify(wrapped));
}
{
	// heading: travelling +x faces +x (yaw 90°), travelling +z faces +z (yaw 0)
	const east = objectTransformAt({ path: { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] } }, 5, take);
	const north = objectTransformAt({ path: { points: [{ x: 0, z: 0 }, { x: 0, z: 10 }] } }, 5, take);
	ok("faceTravel yaws toward the direction of travel", near(east.rot, 90, 1e-6) && near(north.rot, 0, 1e-6), `${east.rot} / ${north.rot}`);
	const free = objectTransformAt({ path: { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], faceTravel: false } }, 5, take);
	ok("faceTravel off leaves rotation to the author", free.rot === null);
}
{
	// height rides along: a plane can climb as it travels
	const object = { path: { points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 5, z: 0 }] } };
	const mid = objectTransformAt(object, 12, take);
	ok("a lifted path carries the object's height", mid.y > 2 && mid.y < 3, JSON.stringify(mid));
}
{
	ok("an object without a path samples to nothing", objectTransformAt({ x: 1, z: 2 }, 5, take) === null);
	ok("a frame beyond the take clamps", (() => {
		const object = { path: { points: [{ x: 0, z: 0 }, { x: 24, z: 0 }] } };
		const beyond = objectTransformAt(object, 9999, take);
		return near(beyond.x, 24, 1e-3);
	})());
}

console.log(failures === 0 ? "all object-path checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
