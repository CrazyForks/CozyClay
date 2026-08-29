/**
 * Freehand DRAWING inside line-edit mode — the pure half (src/line-edit.js).
 *
 * The mode used to react to exactly one gesture: a press within
 * CURVE_GRAB_RADIUS_PX of the joint's projected trail. On a take whose trail
 * bunches into a few screen pixels (a person backing up and falling, where the
 * hand barely moves across the image) there is nothing grabbable and the whole
 * mode reads as dead. `strokeToCurve` is the second gesture — draw a path on
 * empty space — and it has to produce a curve INDISTINGUISHABLE from a dragged
 * one, because preview, undo, curveToPoints2d and the camera-drift watcher are
 * all written against that single type.
 *
 * What is actually asserted here, in the order it matters:
 *   1. ARC LENGTH, not sample index — a stroke drawn slow-then-fast lands the
 *      same curve as one drawn at a constant speed. That is the whole claim
 *      that "drawing speed is irrelevant".
 *   2. The pinned ends come back BY REFERENCE from the base curve, so the seam
 *      guarantee is structural rather than a float comparison away.
 *   3. A click (too few samples, no length, below the caller's threshold) is a
 *      no-op — null — because a stray click must not wipe an existing edit.
 *   4. Null gaps survive as nulls, exactly as dragCurve leaves them.
 *   5. Drawing twice: the second stroke wins, and a drag on a drawn curve
 *      refines it like any other curve.
 *
 * Pure node, no DOM: run with `node test/verify-line-edit-draw.mjs`.
 */
import assert from "node:assert/strict";
import {
	DRAW_MIN_STROKE_POINTS,
	DRAW_MIN_STROKE_PX,
	MIN_LINE_POINTS,
	PINNED_CURVE_ENDS,
	curveToPoints2d,
	curvesEqual,
	dragCurve,
	strokeToCurve,
} from "../src/line-edit.js";

let passed = 0;
const test = (name, fn) => {
	try {
		fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`  FAIL  ${name}`);
		console.error(err?.stack || err);
		process.exitCode = 1;
	}
};

/** A base curve is what projectTrailCurve produces: dense, frame-indexed,
 * `{ frame, u, v }` or null. This one is a gentle diagonal so any resampling
 * bug shows up as a visible bend. */
const baseCurve = (count = 24, { nulls = [] } = {}) =>
	Array.from({ length: count }, (_, i) =>
		(nulls.includes(i) ? null : { frame: 100 + i, u: 0.2 + (0.4 * i) / (count - 1), v: 0.7 - (0.2 * i) / (count - 1) }));

/** Sample a polyline at `fraction` of its TOTAL LENGTH — the independent
 * spelling of what strokeToCurve does internally, so the test is not just the
 * implementation read back to itself. */
const alongStroke = (stroke, fraction) => {
	const cum = [0];
	for (let i = 1; i < stroke.length; i += 1) {
		cum.push(cum[i - 1] + Math.hypot(stroke[i][0] - stroke[i - 1][0], stroke[i][1] - stroke[i - 1][1]));
	}
	const target = fraction * cum[cum.length - 1];
	for (let i = 1; i < cum.length; i += 1) {
		if (cum[i] >= target || i === cum.length - 1) {
			const span = cum[i] - cum[i - 1];
			const t = span > 0 ? (target - cum[i - 1]) / span : 0;
			return [
				stroke[i - 1][0] + (stroke[i][0] - stroke[i - 1][0]) * t,
				stroke[i - 1][1] + (stroke[i][1] - stroke[i - 1][1]) * t,
			];
		}
	}
	return stroke[stroke.length - 1];
};

/** Straight strokes make the arc-length claim checkable in closed form; the
 * shape is the same line, only the SAMPLE SPACING differs between these two. */
const uniformStroke = (samples = 40) =>
	Array.from({ length: samples }, (_, i) => {
		const t = i / (samples - 1);
		return [0.15 + 0.7 * t, 0.25 + 0.5 * t];
	});

/** The same line, drawn slowly for its first half and flicked through the
 * second: 30 samples crawl over 20% of the length, 6 cover the other 80%. */
const slowThenFastStroke = () => {
	const points = [];
	for (let i = 0; i < 30; i += 1) {
		const t = (i / 29) * 0.2;
		points.push([0.15 + 0.7 * t, 0.25 + 0.5 * t]);
	}
	for (let i = 1; i <= 6; i += 1) {
		const t = 0.2 + (i / 6) * 0.8;
		points.push([0.15 + 0.7 * t, 0.25 + 0.5 * t]);
	}
	return points;
};

console.log("strokeToCurve — arc-length parameterization");

test("a drawn stroke replaces the interior with points sampled along its LENGTH", () => {
	const base = baseCurve();
	const stroke = uniformStroke();
	const drawn = strokeToCurve(stroke, base);
	assert.ok(drawn, "a real stroke must produce a curve");
	assert.equal(drawn.length, base.length, "the curve stays dense and frame-indexed");
	for (let i = PINNED_CURVE_ENDS; i < base.length - PINNED_CURVE_ENDS; i += 1) {
		const [u, v] = alongStroke(stroke, i / (base.length - 1));
		assert.ok(Math.abs(drawn[i].u - u) < 1e-9, `interior point ${i} u`);
		assert.ok(Math.abs(drawn[i].v - v) < 1e-9, `interior point ${i} v`);
		assert.equal(drawn[i].frame, base[i].frame, "the frame index is carried through untouched");
	}
});

test("drawing speed is irrelevant: slow-then-fast lands the same curve as uniform", () => {
	const base = baseCurve(48);
	const uniform = strokeToCurve(uniformStroke(), base);
	const uneven = strokeToCurve(slowThenFastStroke(), base);
	assert.ok(uniform && uneven);
	// Same geometry, sampled from wildly different sample DENSITIES. Anything
	// index-based here would drag the crowded first fifth across most of the
	// range and re-time the take.
	for (let i = 0; i < base.length; i += 1) {
		if (!uniform[i] || !uneven[i]) continue;
		assert.ok(Math.abs(uniform[i].u - uneven[i].u) < 1e-9, `point ${i} u drifted with drawing speed`);
		assert.ok(Math.abs(uniform[i].v - uneven[i].v) < 1e-9, `point ${i} v drifted with drawing speed`);
	}
});

test("a two-sample stroke is a straight line, evenly spaced in space", () => {
	const base = baseCurve(11);
	const drawn = strokeToCurve([[0.2, 0.2], [0.8, 0.8]], base);
	assert.ok(drawn);
	for (let i = PINNED_CURVE_ENDS; i < base.length - PINNED_CURVE_ENDS; i += 1) {
		const t = i / (base.length - 1);
		assert.ok(Math.abs(drawn[i].u - (0.2 + 0.6 * t)) < 1e-12, `point ${i} is not evenly spaced`);
	}
});

test("a stroke drawn backwards is not the same curve as one drawn forwards", () => {
	// Direction is meaning: a path is walked from its first frame to its last.
	// An ODD length so there is an exact middle index, which is the one place a
	// stroke and its reverse must agree.
	const base = baseCurve(25);
	const forward = strokeToCurve(uniformStroke(), base);
	const backward = strokeToCurve([...uniformStroke()].reverse(), base);
	assert.ok(!curvesEqual(forward, backward));
	const mid = (base.length - 1) / 2;
	assert.ok(Math.abs(forward[mid].u - backward[mid].u) < 1e-9, "the midpoint is the one place they agree");
	assert.ok(forward[PINNED_CURVE_ENDS].u < backward[PINNED_CURVE_ENDS].u);
});

console.log("strokeToCurve — the pinned ends");

test("the first and last PINNED_CURVE_ENDS points come back BY REFERENCE", () => {
	const base = baseCurve();
	const drawn = strokeToCurve(uniformStroke(), base);
	for (let i = 0; i < PINNED_CURVE_ENDS; i += 1) {
		assert.equal(drawn[i], base[i], `head point ${i} must be the same object, not a copy`);
		const tail = base.length - 1 - i;
		assert.equal(drawn[tail], base[tail], `tail point ${tail} must be the same object, not a copy`);
	}
});

test("the pinned ends stay on the ORIGINAL trail even when the stroke is far away", () => {
	// The seam guarantee, stated the way GP2 measured it: wherever the stroke
	// starts, the range's first and last constrained frames are exactly where
	// the take already put the joint.
	const base = baseCurve();
	const drawn = strokeToCurve([[0.9, 0.05], [0.95, 0.1]], base);
	assert.equal(drawn[0].u, base[0].u);
	assert.equal(drawn[0].v, base[0].v);
	assert.equal(drawn[base.length - 1].u, base[base.length - 1].u);
	assert.equal(drawn[base.length - 1].v, base[base.length - 1].v);
	// ...and the interior really did move, i.e. the pinning is not just "it did
	// nothing at all".
	assert.ok(Math.abs(drawn[10].u - base[10].u) > 0.2, "the interior must be free");
});

test("pinnedEnds is honoured when overridden, and can never eat the whole curve", () => {
	const base = baseCurve(9);
	const wide = strokeToCurve(uniformStroke(), base, { pinnedEnds: 3 });
	for (let i = 0; i < 3; i += 1) assert.equal(wide[i], base[i]);
	assert.notEqual(wide[3], base[3]);
	// A pathological pinnedEnds must not silently return the base curve — half
	// the length is the cap, so there is always something in the middle.
	const capped = strokeToCurve(uniformStroke(), base, { pinnedEnds: 99 });
	assert.ok(capped, "an over-wide pin must still produce a curve");
	assert.ok(!curvesEqual(capped, base), "the middle point still moves");
});

console.log("strokeToCurve — the no-op click");

test("fewer than 2 samples is a click, not a stroke", () => {
	const base = baseCurve();
	assert.equal(strokeToCurve([], base), null);
	assert.equal(strokeToCurve([[0.5, 0.5]], base), null);
	assert.equal(DRAW_MIN_STROKE_POINTS, 2);
});

test("a stroke of zero length is a click", () => {
	const base = baseCurve();
	// A press and release with no movement still reports several samples on a
	// real pointer; every one of them is the same point.
	assert.equal(strokeToCurve([[0.4, 0.4], [0.4, 0.4], [0.4, 0.4]], base), null);
});

test("minLength refuses a stroke below the caller's threshold", () => {
	const base = baseCurve();
	// The app measures DRAW_MIN_STROKE_PX in PIXELS and converts; here the same
	// refusal is exercised directly in uv.
	const tremor = [[0.5, 0.5], [0.5025, 0.5], [0.505, 0.5008]];
	assert.equal(strokeToCurve(tremor, base, { minLength: 0.02 }), null);
	assert.ok(strokeToCurve(tremor, base, { minLength: 0.001 }), "above the threshold it is a real stroke");
	assert.equal(DRAW_MIN_STROKE_PX, 8);
});

test("a no-op refusal is null, never a mutated or emptied base curve", () => {
	// This is the "a stray click must not wipe an existing edit" rule at the
	// geometry level: the caller keeps its curve exactly when this returns null.
	const base = baseCurve();
	const snapshot = base.map((point) => (point ? { ...point } : null));
	assert.equal(strokeToCurve([[0.4, 0.4]], base), null);
	assert.ok(curvesEqual(base, snapshot), "the base curve must not be touched");
});

test("a garbage stroke is refused rather than producing NaN points", () => {
	const base = baseCurve();
	assert.equal(strokeToCurve(null, base), null);
	assert.equal(strokeToCurve("nope", base), null);
	assert.equal(strokeToCurve([[Number.NaN, 0.2], [0.3, Number.NaN]], base), null);
	// One good sample among the rubbish is still only one sample.
	assert.equal(strokeToCurve([[Number.NaN, 0.2], [0.3, 0.4]], base), null);
	// Two good samples among rubbish DO draw — the bad ones are dropped, not
	// allowed to poison the arc length.
	const mixed = strokeToCurve([[0.2, 0.2], [Number.POSITIVE_INFINITY, 0.5], [0.8, 0.8]], base);
	assert.ok(mixed && mixed.every((point) => !point || (Number.isFinite(point.u) && Number.isFinite(point.v))));
});

test("a base curve that is not a curve is refused", () => {
	assert.equal(strokeToCurve(uniformStroke(), null), null);
	assert.equal(strokeToCurve(uniformStroke(), []), null);
	assert.equal(strokeToCurve(uniformStroke(), [{ frame: 0, u: 0.5, v: 0.5 }]), null);
	assert.equal(MIN_LINE_POINTS, 2);
});

console.log("strokeToCurve — null gaps");

test("frames with no image stay null, exactly as dragCurve leaves them", () => {
	const nulls = [5, 6, 7, 20];
	const base = baseCurve(24, { nulls });
	const drawn = strokeToCurve(uniformStroke(), base);
	assert.ok(drawn);
	for (const index of nulls) assert.equal(drawn[index], null, `frame ${index} has no image and cannot gain one`);
	// The same shape as dragCurve's null policy, side by side.
	const dragged = dragCurve(base, 12, 0.05, -0.02, 8);
	for (let i = 0; i < base.length; i += 1) {
		assert.equal(drawn[i] === null, dragged[i] === null, `null layout diverges at ${i}`);
	}
});

test("a null gap does not shift the arc-length mapping of the points around it", () => {
	// The gap is a hole in the IMAGE, not in the timeline: index i is still
	// frame start+i, so the visible points must land where they would have
	// landed with no gap at all.
	const stroke = uniformStroke();
	const dense = strokeToCurve(stroke, baseCurve(24));
	const gapped = strokeToCurve(stroke, baseCurve(24, { nulls: [8, 9, 10] }));
	for (let i = 0; i < 24; i += 1) {
		if (!gapped[i]) continue;
		assert.ok(Math.abs(gapped[i].u - dense[i].u) < 1e-12, `point ${i} moved because of a gap elsewhere`);
	}
});

test("pinned ends that are themselves null stay null", () => {
	const base = baseCurve(24, { nulls: [0, 23] });
	const drawn = strokeToCurve(uniformStroke(), base);
	assert.equal(drawn[0], null);
	assert.equal(drawn[23], null);
	assert.equal(drawn[1], base[1]);
});

console.log("strokeToCurve — the drawn curve is an ordinary curve");

test("drawing twice: the second stroke wins", () => {
	const base = baseCurve();
	const first = strokeToCurve([[0.2, 0.8], [0.8, 0.8]], base);
	const second = strokeToCurve([[0.2, 0.2], [0.8, 0.2]], first);
	assert.ok(second);
	for (let i = PINNED_CURVE_ENDS; i < base.length - PINNED_CURVE_ENDS; i += 1) {
		assert.ok(Math.abs(second[i].v - 0.2) < 1e-12, `point ${i} still carries the first stroke`);
	}
	// ...and the ends are STILL the original trail, not the first stroke's ends:
	// redrawing cannot walk the seam away one stroke at a time.
	for (let i = 0; i < PINNED_CURVE_ENDS; i += 1) assert.equal(second[i], base[i]);
});

test("a drag after a draw refines the drawn curve like any other", () => {
	const base = baseCurve();
	const drawn = strokeToCurve(uniformStroke(), base);
	const dragged = dragCurve(drawn, 12, 0.1, 0.0, 8);
	assert.ok(!curvesEqual(dragged, drawn), "the pull must move something");
	assert.ok(Math.abs(dragged[12].u - (drawn[12].u + 0.1)) < 1e-12, "the grabbed point follows the pointer exactly");
	for (let i = 0; i < PINNED_CURVE_ENDS; i += 1) assert.equal(dragged[i], base[i], "the pins survive draw-then-drag");
});

test("a drawn curve goes on the wire like a dragged one", () => {
	const base = baseCurve(40);
	const drawn = strokeToCurve(uniformStroke(), base);
	const { points2d, error } = curveToPoints2d(drawn);
	assert.equal(error, undefined);
	assert.equal(points2d.length, 40);
	assert.ok(points2d.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1));
	// First and last sent points are the pinned ends, byte for byte.
	assert.deepEqual(points2d[0], [base[0].u, base[0].v]);
	assert.deepEqual(points2d[39], [base[39].u, base[39].v]);
});

test("a stroke drawn off the image is refused by the wire gate, not silently clamped", () => {
	const base = baseCurve();
	const drawn = strokeToCurve([[0.5, 0.5], [1.4, 0.5]], base);
	assert.ok(drawn, "the curve itself is real — the joint really is out there");
	assert.equal(curveToPoints2d(drawn).error, "offscreen");
});

console.log(`\n${passed} checks passed`);
