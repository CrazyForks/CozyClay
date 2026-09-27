import { CSKEL27_PARENTS } from "../../../src/ardy/cskel27.js";
import { add, cloneMotion, jointsAt, shiftFrame, smoothstep, sub, vec } from "./motion.mjs";

const FEET = [21, 22, 25, 26], HANDS = [10, 16];
const EPS = 1e-5;

export function validateBoxes(boxes) {
	if (!Array.isArray(boxes) || boxes.some(b => ![b?.min, b?.max].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) || b.min.some((v, k) => v >= b.max[k]))) {
		throw new Error("scene: boxes must be {min:[x,y,z],max:[x,y,z]} with min < max");
	}
	return boxes;
}

/** Smallest translation of an interior POINT to a box face. Boundary is not
 * penetration. Used for hand contact proximity; no skin radius is implied. */
export function boxPenetration(point, box) {
	if (point.some((v, k) => v <= box.min[k] || v >= box.max[k])) return [0, 0, 0];
	const candidates = box.min.flatMap((lo, k) => [[k, lo - point[k]], [k, box.max[k] - point[k]]]);
	candidates.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
	const delta = [0, 0, 0]; delta[candidates[0][0]] = candidates[0][1];
	return delta;
}

/** Open-interior segment/AABB slab intersection catches a bone crossing a
 * box even when both of its joints lie outside (point-only tests miss it). */
export function segmentPenetratesBox(a, b, box) {
	let near = 0, far = 1;
	for (let k = 0; k < 3; k++) {
		const d = b[k] - a[k];
		if (Math.abs(d) < 1e-12) {
			if (a[k] <= box.min[k] || a[k] >= box.max[k]) return false;
		} else {
			const t0 = (box.min[k] - a[k]) / d, t1 = (box.max[k] - a[k]) / d;
			near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1));
			if (near >= far) return false;
		}
	}
	return near < far;
}

function intersects(points, box) {
	return CSKEL27_PARENTS.some((p, j) => p !== null && segmentPenetratesBox(points[p], points[j], box));
}

/** Conservative rigid skeleton projection. On collision, clear the whole
 * skeleton along its nearest feasible separating axis, not independent
 * joint pushes (which would stretch bones). Floor wins over downward pushes.
 * This tests joint/bone segments, NOT mesh/capsule thickness or self-collision.
 * Multiple mutually obstructing boxes fail explicitly instead of silently
 * emitting penetration. Cube/mesh refinement is a separate experiment. */
export function resolveScene(points, boxes, { floorY = 0 } = {}) {
	let placed = points.map(p => p.slice()), total = [0, 0, 0];
	for (let pass = 0; pass < 32; pass++) {
		const floorLift = Math.max(0, floorY + EPS - Math.min(...FEET.map(j => placed[j][1])));
		if (floorLift) { const d = [0, floorLift, 0]; placed = placed.map(p => add(p, d)); total = add(total, d); }
		const box = boxes.find(b => intersects(placed, b));
		if (!box) return { delta: total, positions: placed };
		const candidates = [];
		for (let k = 0; k < 3; k++) {
			const lo = Math.min(...placed.map(p => p[k])), hi = Math.max(...placed.map(p => p[k]));
			for (const amount of [box.min[k] - hi - EPS, box.max[k] - lo + EPS]) {
				if (k === 1 && Math.min(...FEET.map(j => placed[j][1])) + amount < floorY) continue;
				const delta = [0, 0, 0]; delta[k] = amount; candidates.push(delta);
			}
		}
		candidates.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
		placed = placed.map(p => add(p, candidates[0])); total = add(total, candidates[0]);
	}
	throw new Error("scene: no collision-free rigid placement after 32 projections; constraints conflict");
}

function contactTarget(point, joint, boxes, height) {
	if (FEET.includes(joint)) {
		let y = 0;
		for (const box of boxes) if (point[0] >= box.min[0] && point[0] <= box.max[0] && point[2] >= box.min[2] && point[2] <= box.max[2] && Math.abs(point[1] - box.max[1]) <= height) y = Math.max(y, box.max[1]);
		return Math.abs(point[1] - y) <= height ? [point[0], y + EPS, point[2]] : null;
	}
	// A hand may support on any known box face; never invent a hand contact
	// from a low percentile of its own trajectory when there is no surface.
	for (const box of boxes) {
		const clamped = point.map((x, k) => Math.max(box.min[k], Math.min(box.max[k], x)));
		const target = add(clamped, boxPenetration(clamped, box));
		if (Math.hypot(...sub(point, target)) <= height) return target;
	}
	return null;
}

/** F5 uses F4 motion + known floor/boxes ONLY. Low, slow runs nominate one
 * support point (feet first, then a box-contact hand); rigid root offsets
 * lock it without changing pose or bone lengths. Other simultaneous contacts
 * are not an IK solve. Scene feasibility overrides pinning/locks; diagnostics
 * expose every such override instead of claiming incompatible constraints.
 */
export function fitContacts(motion, { boxes = [], contactHeight = 0.04, maxSpeed = 0.18, minStanceSeconds = 0.08 } = {}) {
	validateBoxes(boxes);
	if (![contactHeight, maxSpeed, minStanceSeconds].every(x => Number.isFinite(x) && x > 0)) throw new Error("contact thresholds must be positive");
	const out = cloneMotion(motion), n = motion.frames, sites = [...FEET, ...HANDS];
	const minimum = Math.max(2, Math.ceil(minStanceSeconds * motion.fps));
	const targets = new Map(), candidates = new Map();
	for (const j of sites) {
		const track = Array.from({ length: n }, (_, f) => vec(motion.posedJoints, (f * 27 + j) * 3));
		const target = track.map(p => contactTarget(p, j, boxes, contactHeight));
		const eligible = target.map((p, f) => {
			const lo = Math.max(0, f - 1), hi = Math.min(n - 1, f + 1);
			const speed = Math.max(...[lo, hi].map(t => Math.hypot(...sub(track[f], track[t])) * motion.fps));
			return !!p && speed <= maxSpeed;
		});
		const good = new Uint8Array(n);
		for (let f = 0; f < n;) {
			if (!eligible[f]) { f++; continue; }
			const start = f; while (f < n && eligible[f]) f++;
			if (f - start >= minimum) good.fill(1, start, f);
		}
		targets.set(j, target); candidates.set(j, good);
	}
	const support = new Int8Array(n).fill(-1);
	for (let f = 0; f < n; f++) {
		const previous = f ? support[f - 1] : -1;
		support[f] = previous >= 0 && candidates.get(previous)[f] ? previous : (sites.find(j => candidates.get(j)[f]) ?? -1);
	}
	const offsets = new Array(n).fill(null), anchors = new Array(n).fill(null);
	let carry = [0, 0, 0], runs = 0, lockedFrames = 0;
	for (let f = 0; f < n;) {
		const j = support[f];
		if (j < 0) { f++; continue; }
		const first = f, target = targets.get(j)[f];
		// Keep accumulated horizontal travel across stance changes, but the
		// surface owns contact height. A hand's authored face owns all axes.
		const anchor = FEET.includes(j) ? [target[0] + carry[0], target[1], target[2] + carry[2]] : target;
		while (f < n && support[f] === j) {
			offsets[f] = sub(anchor, vec(motion.posedJoints, (f * 27 + j) * 3)); anchors[f] = anchor; f++;
		}
		carry = offsets[f - 1]; runs++; lockedFrames += f - first;
	}
	// Smooth offset bridges through flight/swing; no reset snap on release.
	for (let f = 0; f < n;) {
		if (offsets[f]) { f++; continue; }
		const start = f; while (f < n && !offsets[f]) f++;
		const a = start ? offsets[start - 1] : [0, 0, 0], b = f < n ? offsets[f] : a;
		for (let t = start; t < f; t++) { const w = smoothstep((t - start + 1) / (f - start + 1)); offsets[t] = a.map((v, k) => v + (b[k] - v) * w); }
	}
	let sceneOverrides = 0, maxLockResidualM = 0, maxCorrectionM = 0;
	for (let f = 0; f < n; f++) {
		shiftFrame(out, f, offsets[f]);
		const { delta } = resolveScene(jointsAt(out, f), boxes);
		if (Math.hypot(...delta) > 1e-6) sceneOverrides++;
		shiftFrame(out, f, delta);
		maxCorrectionM = Math.max(maxCorrectionM, Math.hypot(...add(offsets[f], delta)));
		if (support[f] >= 0) maxLockResidualM = Math.max(maxLockResidualM, Math.hypot(...sub(vec(out.posedJoints, (f * 27 + support[f]) * 3), anchors[f])));
	}
	return { motion: out, diagnostics: { runs, lockedFrames, sceneOverrides, maxLockResidualM, maxCorrectionM, support: Array.from(support), geometry: "cskel27 joint/bone segments; no skin radius", solver: "one rigid support; scene constraints override locks and A/B pins" } };
}
