import * as THREE from "three";
import { findBone, ikEvaluate, solveIk, solveHipsTranslate } from "./ik.js";
import { createGroundSampler } from "./ground.js";
import { objectFootprintBounds } from "../scene-objects.js";
import { copyPhysicsKeys, createSupportSampler, physicsKeyStamp } from "./physics-review.js";

/**
 * Platform fit: lift a flat-ground walk onto the boxes/steps placed in the
 * scene. Each planted-foot contact is measured against the surface under its
 * anchor; climbable rises lift that foot (and, smoothed, the pelvis), too-high
 * rises and walls are reported and left alone. The source key map is never
 * modified; the candidate uses the physics-review key format.
 *
 * stepUp/climb are fractions of the measured hip-to-ankle leg length,
 * clearance is metres, reach is the max fraction of leg length a solved leg
 * may extend (or the source extension, whichever is larger).
 */
export const PLATFORM_FIT_LIMITS = Object.freeze({ stepUp: 0.5, climb: 1.0, clearance: 0.03, reach: 0.995 });

const FEET = [
	{ id: "leftFoot", toe: "mixamorigLeftToeBase" },
	{ id: "rightFoot", toe: "mixamorigRightToeBase" },
];
// A contact within this of its surface is the clip's own contact offset, not a
// platform. Keeps a flat walk on a flat floor (and a re-run on its own output)
// from being re-keyed for millimetres.
const LEVEL_TOLERANCE = 0.02;
const EPS = 1e-6;
const V = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();
const clamp = THREE.MathUtils.clamp;
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const quantile = (a, t) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s[Math.floor((s.length - 1) * t)] ?? 0; };

/** Edge-renormalised Gaussian, truncated at `radius` frames. */
function gaussian(values, sigma, radius = Math.ceil(3 * sigma)) {
	if (!(sigma > 0)) return [...values];
	return values.map((_, f) => {
		let sum = 0, weight = 0;
		for (let i = Math.max(0, f - radius); i <= Math.min(values.length - 1, f + radius); i += 1) {
			const k = Math.exp(-0.5 * ((i - f) / sigma) ** 2);
			sum += k * values[i]; weight += k;
		}
		return sum / weight;
	});
}
function maxFilter(values, radius) {
	return values.map((_, f) => {
		let best = -Infinity;
		for (let i = Math.max(0, f - radius); i <= Math.min(values.length - 1, f + radius); i += 1) best = Math.max(best, values[i]);
		return best;
	});
}
function minFilter(values, radius) {
	return values.map((_, f) => {
		let best = Infinity;
		for (let i = Math.max(0, f - radius); i <= Math.min(values.length - 1, f + radius); i += 1) best = Math.min(best, values[i]);
		return best;
	});
}
/** Smooth upper envelope: max-filter then a Gaussian truncated at the same
 * radius, so every output frame is >= the raw requirement at that frame. */
function envelope(values, sigma) {
	const radius = Math.max(1, Math.ceil(2.5 * sigma));
	return gaussian(maxFilter(values, radius), sigma, radius);
}

/** Per-frame lift from span lifts: exact inside spans, smoothstep between,
 * held before the first and after the last. */
function spanTrack(count, spans) {
	const out = new Array(count).fill(0);
	if (!spans.length) return out;
	for (let f = 0; f < count; f += 1) {
		const next = spans.find((s) => s.end >= f);
		if (!next) { out[f] = spans[spans.length - 1].lift; continue; }
		if (f >= next.start) { out[f] = next.lift; continue; }
		const prev = [...spans].reverse().find((s) => s.end < f);
		out[f] = prev ? THREE.MathUtils.lerp(prev.lift, next.lift, smooth((f - prev.end) / (next.start - prev.end))) : next.lift;
	}
	return out;
}

function snapshot(chains, hips) {
	return { hips: { p: hips.position.clone(), q: hips.quaternion.clone() },
		chains: Object.fromEntries(FEET.map(({ id }) => [id, chains.get(id).bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone() }))])) };
}

/** Planted spans: stationary toe (XZ), at least ~0.1 s, sole no more than a
 * step above the ground below it. Unlike supportIntervals this is not measured
 * against one global floor level, so a foot already standing on a box (a
 * re-run over a previous fit) is still a contact. Deliberately no vertical
 * speed test: a fit only moves feet vertically, so XZ stillness is the signal
 * that detects the SAME spans on the fitted output, which is what makes a
 * re-run idempotent (a one-frame edge shift re-adds swing clearance). */
function contactSpans(samples, id, fps, groundAt, maxHeight) {
	const count = samples.length, minLength = Math.max(3, Math.round(fps * 0.1)), spans = [];
	const flags = samples.map((row, i) => {
		const lo = Math.max(0, i - 2), hi = Math.min(count - 1, i + 2), a = samples[lo].feet[id], b = samples[hi].feet[id], c = row.feet[id];
		const dt = (hi - lo) / fps || 1 / fps;
		const below = groundAt(c.toe.x, c.toe.z, c.sole + LEVEL_TOLERANCE);
		return c.sole - below <= maxHeight
			&& Math.hypot(b.toe.x - a.toe.x, b.toe.z - a.toe.z) / dt < 0.16;
	});
	let start = -1;
	for (let f = 0; f <= count; f += 1) {
		if (flags[f] && start < 0) start = f;
		if ((f === count || !flags[f]) && start >= 0) {
			if (f - start >= minLength) {
				const rows = samples.slice(start, f).map((r) => r.feet[id]);
				const toe = new THREE.Vector3(quantile(rows.map((r) => r.toe.x), 0.5), 0, quantile(rows.map((r) => r.toe.z), 0.5));
				const ankle = new THREE.Vector3(quantile(rows.map((r) => r.ankle.x), 0.5), 0, quantile(rows.map((r) => r.ankle.z), 0.5));
				const wander = Math.max(...rows.map((r) => Math.hypot(r.toe.x - toe.x, r.toe.z - toe.z)));
				if (wander <= 0.10) spans.push({ start, end: f - 1, toe, ankle, currentY: quantile(rows.map((r) => r.sole), 0.25) });
			}
			start = -1;
		}
	}
	return spans;
}

export async function fitPlatforms({ rig, motion, chains, fkJoints, sourceKeys, applyRaw, sceneObjects = [], floorY = 0, onProgress = () => {}, yieldFrame = () => Promise.resolve() }) {
	const hipsJoint = fkJoints?.get("hips"), hips = hipsJoint?.bone;
	if (!hips || !motion || !FEET.every(({ id }) => chains?.get(id))) throw new Error("A loaded motion and complete rig are required");
	const count = motion.frames, fps = motion.fps || 24, limits = PLATFORM_FIT_LIMITS;
	const sourceStamp = physicsKeyStamp(sourceKeys);
	const source = { keys: copyPhysicsKeys(sourceKeys), tracked: new Set([...sourceKeys.values()].flatMap((e) => [...e.keys()])) };
	const candidate = { keys: copyPhysicsKeys(sourceKeys), tracked: new Set(source.tracked) };
	const groundAt = createGroundSampler(sceneObjects, { floorY });
	const owners = groundAt.surfaces.map((s) => sceneObjects.find((o) => {
		const b = objectFootprintBounds(o);
		return b.minX === s.minX && b.maxX === s.maxX && b.minZ === s.minZ && b.maxZ === s.maxZ && b.topY === s.topY && b.baseY === s.baseY;
	})?.id ?? null);
	const surfaceAt = (p, y) => groundAt.surfaces.findIndex((s) => s.topY === y && p.x >= s.minX && p.x <= s.maxX && p.z >= s.minZ && p.z <= s.maxZ);
	const support = createSupportSampler(rig);
	const toeBones = Object.fromEntries(FEET.map(({ id, toe }) => [id, findBone(rig, toe)]));
	const applyBase = (f) => { applyRaw(f); ikEvaluate(chains, source, f, fkJoints, 6); rig.updateMatrixWorld(true); };

	// 1. Sample the current pose (raw clip + source IK keys) at every frame.
	const samples = [];
	for (let f = 0; f < count; f += 1) {
		applyRaw(f); rig.updateMatrixWorld(true);
		const raw = snapshot(chains, hips);
		applyBase(f);
		const surfaces = support();
		samples.push({ raw, hips: hips.getWorldPosition(V()), feet: Object.fromEntries(FEET.map(({ id }) => {
			const chain = chains.get(id), p = chain.bones.map((b) => b.getWorldPosition(V()));
			return [id, { sole: surfaces[id].floor, ankle: surfaces[id].position.clone(), rotation: surfaces[id].rotation.clone(),
				toe: (toeBones[id] ?? chain.bones[2]).getWorldPosition(V()), hip: p[0], leg: p[0].distanceTo(p[1]) + p[1].distanceTo(p[2]), extension: p[0].distanceTo(p[2]) }];
		})) });
		if (f % 12 === 0) { onProgress(Math.round(50 * f / Math.max(1, count))); await yieldFrame(); }
	}
	const legLengths = Object.fromEntries(FEET.map(({ id }) => [id, quantile(samples.map((r) => r.feet[id].leg), 0.5)]));
	const leg = (legLengths.leftFoot + legLengths.rightFoot) / 2;
	const stepUp = limits.stepUp * leg, climb = limits.climb * leg;

	// 2-3. Contacts, surfaces, classification.
	const steps = [], spansByFoot = {};
	for (const { id } of FEET) {
		const spans = contactSpans(samples, id, fps, groundAt, stepUp);
		for (const span of spans) {
			const onToe = groundAt(span.toe.x, span.toe.z), onAnkle = groundAt(span.ankle.x, span.ankle.z);
			const surfaceY = Math.max(onToe, onAnkle), point = onToe >= onAnkle ? span.toe : span.ankle;
			const index = surfaceY > floorY ? surfaceAt(point, surfaceY) : -1;
			const rise = surfaceY - span.currentY;
			const status = rise <= stepUp ? "ok" : rise <= climb ? "tooHigh" : "wall";
			let lift = 0;
			if (status === "ok" && Math.abs(rise) > LEVEL_TOLERANCE) {
				let target = surfaceY;
				if (rise < 0) {
					// Lowering undoes an earlier fit whose box moved away. Never
					// push a contact below the raw clip's own height: an elevated
					// performance (a generated stair climb) is not a fit to undo.
					const rawSoles = [];
					for (let f = span.start; f <= span.end; f += 1) { applyRaw(f); rawSoles.push(support()[id].floor); }
					target = Math.max(surfaceY, Math.min(span.currentY, quantile(rawSoles, 0.25)));
				}
				if (Math.abs(target - span.currentY) > LEVEL_TOLERANCE) lift = target - span.currentY;
			}
			Object.assign(span, { surfaceY, rise, status, lift, objectId: index >= 0 ? owners[index] : null });
		}
		spansByFoot[id] = spans;
		steps.push(...spans.map((s) => ({ id: `${id}:${s.start}`, foot: id, start: s.start, end: s.end, surfaceY: s.surfaceY, rise: s.rise, status: s.status, objectId: s.objectId, lift: s.lift })));
	}
	// The pelvis walking into something taller than a climb is a wall even
	// when no planted foot lands on it.
	groundAt.surfaces.forEach((s, index) => {
		const objectId = owners[index];
		if (steps.some((step) => step.status === "wall" && step.objectId === objectId)) return;
		let start = -1;
		for (let f = 0; f <= count; f += 1) {
			const row = samples[f];
			const standing = row && Math.min(row.feet.leftFoot.sole, row.feet.rightFoot.sole);
			const inside = row && row.hips.x >= s.minX && row.hips.x <= s.maxX && row.hips.z >= s.minZ && row.hips.z <= s.maxZ && s.topY - standing > climb;
			if (inside && start < 0) start = f;
			if (!inside && start >= 0) {
				const entry = samples[start], center = { x: (s.minX + s.maxX) / 2, z: (s.minZ + s.maxZ) / 2 };
				const foot = FEET.map(({ id }) => id).sort((a, b) => Math.hypot(entry.feet[a].toe.x - center.x, entry.feet[a].toe.z - center.z) - Math.hypot(entry.feet[b].toe.x - center.x, entry.feet[b].toe.z - center.z))[0];
				const standY = Math.min(entry.feet.leftFoot.sole, entry.feet.rightFoot.sole);
				steps.push({ id: `pelvis:${objectId ?? index}:${start}`, foot, start, end: f - 1, surfaceY: s.topY, rise: s.topY - standY, status: "wall", objectId, lift: 0 });
				break;
			}
		}
	});
	steps.sort((a, b) => a.start - b.start || a.foot.localeCompare(b.foot));
	onProgress(55); await yieldFrame();

	// 4. Per-foot lift: span lifts with smoothstep transitions, plus swing toe
	// clearance over raised surfaces. The clearance ramps in from each contact
	// by time, not by the source's own toe height, so a re-run on the fitted
	// output measures the same requirement and adds nothing.
	const lifts = {};
	for (const { id } of FEET) {
		const spans = spansByFoot[id], base = spanTrack(count, spans);
		const inSpan = new Array(count).fill(false);
		for (const s of spans) for (let f = s.start; f <= s.end; f += 1) inSpan[f] = true;
		const offsets = spans.flatMap((s) => samples.slice(s.start, s.end + 1).map((r) => r.feet[id].toe.y - r.feet[id].sole));
		const toeOffset = quantile(offsets.length ? offsets : samples.map((r) => r.feet[id].toe.y - r.feet[id].sole), 0.5);
		const ramp = Math.max(2, Math.round(fps * 0.15));
		const excess = samples.map((row, f) => {
			if (inSpan[f]) return 0;
			const toe = row.feet[id].toe, ground = groundAt(toe.x, toe.z);
			if (ground <= floorY + EPS) return 0;
			const under = toe.y - toeOffset;
			if (ground - under > stepUp) return 0; // a wall: reported, never vaulted
			const prev = [...spans].reverse().find((s) => s.end < f), next = spans.find((s) => s.start > f);
			const gap = Math.min(prev ? f - prev.end : Infinity, next ? next.start - f : Infinity);
			return Math.max(0, ground + limits.clearance * smooth(gap / ramp) - under - base[f]);
		});
		const clearance = envelope(excess, 0.06 * fps);
		// The envelope spreads clearance right up to a contact; cutting it off
		// on the lift-off/landing frame is a one-frame foot jump that the leg IK
		// turns into a visible knee pop. Fade the spread to zero at every contact
		// edge, but never below the frame's own requirement (which itself ramps
		// in from the contact), so a re-run still measures nothing left to add.
		const taper = samples.map((_, f) => {
			if (inSpan[f]) return 0;
			const prev = [...spans].reverse().find((s) => s.end < f), next = spans.find((s) => s.start > f);
			return smooth(Math.min(prev ? f - prev.end : Infinity, next ? next.start - f : Infinity) / ramp);
		});
		lifts[id] = base.map((v, f) => inSpan[f] ? v : v + Math.max(excess[f], clearance[f] * taper[f]));
	}

	// 5. Pelvis: follow the supporting feet, smoothed, never lifted where no
	// foot is lifted, then lowered wherever a leg would over-reach.
	const planted = (id, f) => spansByFoot[id].some((s) => f >= s.start && f <= s.end);
	const supportLift = samples.map((_, f) => {
		const values = FEET.filter(({ id }) => planted(id, f)).map(({ id }) => lifts[id][f]);
		return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
	});
	const known = supportLift.map((v, f) => Number.isFinite(v) ? f : -1).filter((f) => f >= 0);
	const filled = supportLift.map((v, f) => {
		if (Number.isFinite(v)) return v;
		if (!known.length) return 0;
		const next = known.find((k) => k > f), prev = [...known].reverse().find((k) => k < f);
		if (prev === undefined) return supportLift[next];
		if (next === undefined) return supportLift[prev];
		return THREE.MathUtils.lerp(supportLift[prev], supportLift[next], (f - prev) / (next - prev));
	});
	const pelvis = gaussian(filled, 0.15 * fps).map((v, f) => {
		const values = FEET.map(({ id }) => lifts[id][f]);
		return clamp(v, Math.min(0, ...values), Math.max(0, ...values));
	});
	// Highest pelvis lift at which every leg still reaches its foot target.
	// Smoothing the over-reach and subtracting it spread the correction into
	// frames that did not need it: the leg locked straight at a step-down and
	// the body then sank below the source (a squat). Instead take a smooth
	// LOWER envelope of min(desired, reachable): it never exceeds either, and
	// never drops below the lowest value within its window.
	// Only a planted foot (or one about to land / just lifting off) holds the
	// pelvis down: a trailing swing leg would otherwise keep the body low while
	// the other foot already stands on the box - a squat. Mid-swing feet are
	// raised to stay within reach instead (below).
	const edgeFrames = Math.max(2, Math.round(fps * 0.15));
	const contactGap = (id, f) => Math.min(...spansByFoot[id].map((s) => f < s.start ? s.start - f : f > s.end ? f - s.end : 0), Infinity);
	const slack = (id, f) => {
		const foot = samples[f].feet[id], reach = Math.max(limits.reach * legLengths[id], foot.extension);
		const horizontal = Math.hypot(foot.ankle.x - foot.hip.x, foot.ankle.z - foot.hip.z);
		return foot.ankle.y - foot.hip.y + Math.sqrt(Math.max(0, reach * reach - horizontal * horizontal));
	};
	const reachable = samples.map((_, f) => Math.min(...FEET.filter(({ id }) => contactGap(id, f) <= edgeFrames).map(({ id }) => lifts[id][f] + slack(id, f)), Infinity));
	const sigma = 0.08 * fps, radius = Math.max(1, Math.ceil(2.5 * sigma));
	const capped = gaussian(minFilter(pelvis.map((p, f) => Math.min(p, reachable[f])), radius), sigma, radius);
	capped.forEach((p, f) => { pelvis[f] = Math.abs(p) > EPS ? p : 0; });
	for (const { id } of FEET) for (let f = 0; f < count; f += 1) {
		if (contactGap(id, f) > edgeFrames) lifts[id][f] = Math.max(lifts[id][f], pelvis[f] - slack(id, f));
	}
	onProgress(65); await yieldFrame();

	// 6. Solve and key every changed frame plus one unchanged frame each side.
	const changed = samples.map((_, f) => f).filter((f) => Math.abs(pelvis[f]) > EPS || FEET.some(({ id }) => Math.abs(lifts[id][f]) > EPS));
	const changedSet = new Set(changed);
	const keyed = [...new Set(changed.flatMap((f) => [f - 1, f, f + 1]))].filter((f) => f >= 0 && f < count).sort((a, b) => a - b);
	for (let n = 0; n < keyed.length; n += 1) {
		const f = keyed[n], row = samples[f];
		applyBase(f);
		if (changedSet.has(f)) {
			solveHipsTranslate(hipsJoint, new THREE.Vector3(0, pelvis[f], 0), hips.position.clone()); rig.updateMatrixWorld(true);
			for (const { id } of FEET) {
				const chain = chains.get(id), foot = row.feet[id];
				solveIk(chain, foot.ankle.clone().setY(foot.ankle.y + lifts[id][f]), { exactHinge: true }); rig.updateMatrixWorld(true);
				// The foot keeps its source world orientation: a lift is a
				// translation of the planted sole, never a toe dip.
				const end = chain.bones[2];
				end.quaternion.copy(end.parent.getWorldQuaternion(Q()).invert().multiply(foot.rotation)); rig.updateMatrixWorld(true);
			}
		}
		const entry = candidate.keys.get(f) ?? new Map();
		entry.set("hips", { q: [hips.quaternion.clone()], p: hips.position.clone(), baseQ: [row.raw.hips.q.clone()], basePos: row.raw.hips.p.clone() });
		candidate.tracked.add("hips");
		for (const { id } of FEET) {
			const bones = chains.get(id).bones, raw = row.raw.chains[id];
			const key = { q: bones.map((b) => b.quaternion.clone()), p: null, baseQ: raw.map((b) => b.q.clone()), keepTranslations: true };
			// Island-edge keys carry translations only when the source changed
			// them; otherwise their ease ramp would smear this frame's bone
			// lengths onto the untouched neighbours.
			if (changedSet.has(f) || bones.some((b, i) => !b.position.equals(raw[i].p))) key.chainP = bones.map((b) => b.position.clone());
			entry.set(id, key); candidate.tracked.add(id);
		}
		candidate.keys.set(f, entry);
		if (n % 12 === 0) { onProgress(65 + Math.round(35 * n / keyed.length)); await yieldFrame(); }
	}
	onProgress(100);
	const summary = { ok: 0, tooHigh: 0, wall: 0, lifted: 0 };
	for (const step of steps) { summary[step.status] += 1; if (step.lift !== 0) summary.lifted += 1; }
	return { candidate, steps, summary, changedFrames: changed, sourceStamp, lifts: { ...lifts, pelvis }, legLength: leg };
}
