import assert from "node:assert/strict";
import { buildPreserveMask, preserveMaskStats, PRESERVE_MASK_VERSION } from "../tools/kimodo/preserve-mask.mjs";

function pass(label) { console.log(`PASS ${label}`); }
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// Scheduled inpainting preserves an existing take and regenerates only what the
// user edited. The mask is the ONLY thing standing between "the edit is smoothly
// blended into the old take" and "the character snaps at the seam", so every
// assertion below pins one property the blend depends on: frame space, the shape
// of the shoulder, how overlaps combine, and the clip's own edges.
const APP_FPS = 20;
const GEN_FPS = 30;

// The Gaussian the module builds, restated independently so the tests compare
// against the CONTRACT rather than against whatever the implementation did.
const shoulder = (distance, radius) => 1 - Math.exp(-(distance * distance) / (2 * (radius / 2) ** 2));

// ---- no edits at all: pure reconstruction ---------------------------------
// This is acceptance gate G1 (no edits + strength 0.5 must reproduce the base
// take). An empty edit list is therefore VALID input, not an error, and must
// mean "preserve everything".
{
	const mask = buildPreserveMask([], { appFps: APP_FPS, genFps: GEN_FPS, genFrames: 180 });
	assert.equal(mask.version, PRESERVE_MASK_VERSION, "the emitted mask must declare the v1 schema");
	assert.equal(mask.version, 1);
	assert.equal(mask.genFps, GEN_FPS);
	assert.equal(mask.genFrames, 180);
	assert.equal(mask.weights.length, 180, "weights must be dense, one per generation frame");
	assert.ok(mask.weights.every((weight) => weight === 1), "with no edits every frame is fully preserved");
	assert.deepEqual(preserveMaskStats(mask), { freeFrames: 0, preservedFrames: 180, rampFrames: 0 });
	pass("an empty edit list preserves the whole take");
}

// ---- one edit zeroes its span and grows symmetric shoulders ----------------
// Inside the edit the model must be completely free (weight 0) or the user's
// change cannot happen; outside it the influence has to decay smoothly and
// identically in both directions, or the seam is asymmetric and the character
// leans into one side of the edit.
{
	const mask = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 180,
	});
	// The edit is free end to end.
	for (let frame = 60; frame < 120; frame += 1) {
		assert.equal(mask.weights[frame], 0, `frame ${frame} is inside the edit and must be free`);
	}
	// The shoulders match the documented Gaussian exactly, one step out and ten.
	assert.ok(near(mask.weights[59], shoulder(1, 10)), `leading shoulder at d=1, got ${mask.weights[59]}`);
	assert.ok(near(mask.weights[120], shoulder(1, 10)), `trailing shoulder at d=1, got ${mask.weights[120]}`);
	assert.ok(near(mask.weights[50], shoulder(10, 10)), `leading shoulder at d=10, got ${mask.weights[50]}`);
	assert.ok(near(mask.weights[129], shoulder(10, 10)), `trailing shoulder at d=10, got ${mask.weights[129]}`);
	// SYMMETRY: frame `start - k` must equal frame `(end - 1) + k`. The exclusive
	// end is the classic off-by-one here; asymmetry means the trailing shoulder
	// is shifted a frame relative to the leading one.
	for (let step = 1; step <= 40; step += 1) {
		assert.ok(
			near(mask.weights[60 - step], mask.weights[119 + step]),
			`shoulders must be symmetric at step ${step}: ${mask.weights[60 - step]} vs ${mask.weights[119 + step]}`
		);
	}
	// The shoulder is monotone: influence only ever fades as you move away.
	for (let frame = 120; frame < 179; frame += 1) {
		assert.ok(
			mask.weights[frame + 1] >= mask.weights[frame],
			`the shoulder must not rise and fall; frame ${frame} -> ${frame + 1}`
		);
	}
	// Far from the edit the base take is preserved untouched.
	assert.equal(mask.weights[0], 1, "a frame far from the edit must be fully preserved");
	assert.equal(mask.weights[179], 1, "a frame far from the edit must be fully preserved");
	pass("a single edit zeroes its span and tapers symmetrically on both sides");
}

// ---- app frames scale onto the generation clock ---------------------------
// CozyClay authors edits against the app's 20 fps clip; Kimodo generates at 30.
// Skipping the scale would free the wrong two thirds of the take, and the rule
// must be the SAME one buildRoot2dConstraints uses or a waypoint and an edit
// authored on the same app frame land on different generation frames.
{
	const mask = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 180,
	});
	// app [40, 80) @ 20 fps -> gen [60, 120) @ 30 fps, half-open at both ends.
	assert.notEqual(mask.weights[59], 0, "gen frame 59 is before the edit and must not be free");
	assert.equal(mask.weights[60], 0, "app frame 40 @20fps must free gen frame 60 @30fps");
	assert.equal(mask.weights[119], 0, "the last frame of the edit is end-1 = 119");
	assert.notEqual(mask.weights[120], 0, "the range is half-open: gen frame 120 is outside the edit");
	// A 1:1 clock must not move anything at all.
	const unscaled = buildPreserveMask([{ startFrame: 10, endFrame: 20 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(unscaled.weights[9] === 0, false);
	assert.equal(unscaled.weights[10], 0, "with appFps == genFps the frames pass through unchanged");
	assert.equal(unscaled.weights[19], 0);
	assert.equal(unscaled.weights[20] === 0, false);
	pass("20 fps app ranges scale onto 30 fps generation frames");
}

// ---- overlapping edits take the MINIMUM weight -----------------------------
// Two shoulders meeting in a gap must not add up to more preservation than
// either edit asked for on its own. Min is the only rule that keeps the mask
// monotone in the number of edits: adding an edit can never preserve a frame
// harder than it was before.
{
	const options = { appFps: 30, genFps: 30, genFrames: 120 };
	const first = buildPreserveMask([{ startFrame: 30, endFrame: 40 }], options);
	const second = buildPreserveMask([{ startFrame: 50, endFrame: 60 }], options);
	const both = buildPreserveMask(
		[{ startFrame: 30, endFrame: 40 }, { startFrame: 50, endFrame: 60 }],
		options
	);
	for (let frame = 0; frame < 120; frame += 1) {
		assert.ok(
			near(both.weights[frame], Math.min(first.weights[frame], second.weights[frame])),
			`frame ${frame} must take the minimum of the two edits, got ${both.weights[frame]}`
		);
		assert.ok(both.weights[frame] <= first.weights[frame], `adding an edit must never raise frame ${frame}`);
	}
	// Both spans are still fully free, and the gap between them is a blend, not a
	// preserved island.
	for (const frame of [30, 39, 50, 59]) assert.equal(both.weights[frame], 0, `frame ${frame} is inside an edit`);
	assert.ok(both.weights[45] > 0 && both.weights[45] < 1, "the gap between two edits stays a partial blend");
	// Literally overlapping ranges collapse into one continuous free span.
	const merged = buildPreserveMask(
		[{ startFrame: 30, endFrame: 45 }, { startFrame: 40, endFrame: 60 }],
		options
	);
	for (let frame = 30; frame < 60; frame += 1) {
		assert.equal(merged.weights[frame], 0, `overlapping edits must free the whole union, frame ${frame}`);
	}
	pass("overlapping edits combine by minimum weight");
}

// ---- an edit on the clip's first frame ------------------------------------
// The shoulder would like to extend before frame 0. There is nothing there to
// preserve, so it must simply be absent rather than shifted inward (which would
// preserve frames the user actually edited).
{
	const mask = buildPreserveMask([{ startFrame: 0, endFrame: 10 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(mask.weights.length, 60, "a clipped shoulder must not change the mask length");
	for (let frame = 0; frame < 10; frame += 1) assert.equal(mask.weights[frame], 0, `frame ${frame} is edited`);
	assert.ok(near(mask.weights[10], shoulder(1, 10)), "only the trailing shoulder exists");
	assert.ok(mask.weights.every((weight) => Number.isFinite(weight)), "clipping must not produce NaN");
	pass("an edit touching frame 0 has no leading shoulder and no out-of-range frames");
}

// ---- an edit on the clip's last frame -------------------------------------
// The exclusive end is the trap: clamping it to genFrames - 1 would silently
// preserve the final frame even though the user edited right up to it.
{
	const mask = buildPreserveMask([{ startFrame: 50, endFrame: 60 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(mask.weights.length, 60);
	assert.equal(mask.weights[59], 0, "an edit running to the clip end must free the LAST frame");
	assert.equal(mask.weights[50], 0);
	assert.ok(near(mask.weights[49], shoulder(1, 10)), "only the leading shoulder exists");
	// An edit that runs PAST the end still owns the frames it shares with the
	// clip; clamping is the honest reading, dropping it would ignore the edit.
	const overrun = buildPreserveMask([{ startFrame: 55, endFrame: 999 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(overrun.weights.length, 60);
	for (let frame = 55; frame < 60; frame += 1) assert.equal(overrun.weights[frame], 0, `frame ${frame} is edited`);
	pass("an edit touching the last frame frees it and never ramps past the clip");
}

// ---- a range that rounds down to nothing still frees a frame --------------
// A 60 fps app clock halves onto a 30 fps generation clock, so a one-frame edit
// can round to an empty span. Collapsing it would drop the user's edit while
// reporting success.
{
	const mask = buildPreserveMask([{ startFrame: 10, endFrame: 11 }], {
		appFps: 60,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(mask.weights[5], 0, "a collapsed range must still free at least one generation frame");
	assert.equal(preserveMaskStats(mask).freeFrames, 1);
	pass("a range that rounds onto a single generation frame is not dropped");
}

// ---- the boundary must never be a hard step -------------------------------
// The paper's ablation is explicit: a square kernel breaks motion at the seam.
// The per-frame delta at a range boundary is the direct measure of that, so it
// is asserted rather than assumed.
{
	const mask = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 180,
	});
	let maxDelta = 0;
	for (let frame = 0; frame < mask.weights.length - 1; frame += 1) {
		maxDelta = Math.max(maxDelta, Math.abs(mask.weights[frame + 1] - mask.weights[frame]));
	}
	assert.ok(maxDelta < 0.5, `the default radius must never step; max per-frame delta was ${maxDelta}`);
	// The step ACROSS the boundary itself is the smallest one in the whole ramp:
	// the Gaussian is flattest at d = 0 and steepest around d = sigma, which is
	// exactly the property that stops the character snapping where the edit ends.
	const boundaryDelta = Math.abs(mask.weights[120] - mask.weights[119]);
	assert.ok(near(boundaryDelta, shoulder(1, 10)), `the boundary step must be the Gaussian at d=1, got ${boundaryDelta}`);
	assert.ok(boundaryDelta < 0.05, `the boundary step must be gentle, got ${boundaryDelta}`);
	assert.ok(boundaryDelta < maxDelta, "the ramp must be steepest away from the seam, not at it");
	// A narrow radius is steeper but still not a step.
	const narrow = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 180,
		influenceRadius: 2,
	});
	let narrowMax = 0;
	for (let frame = 0; frame < narrow.weights.length - 1; frame += 1) {
		narrowMax = Math.max(narrowMax, Math.abs(narrow.weights[frame + 1] - narrow.weights[frame]));
	}
	assert.ok(narrowMax < 0.5, `even a 2-frame radius must taper, max delta ${narrowMax}`);
	pass("the boundary tapers: max per-frame delta stays well under a step");
}

// ---- influenceRadius 0 is the opt-in hard edge ----------------------------
// The broken case from the paper is kept REACHABLE so it can be measured
// (tools/kimodo/measure-preserve.mjs) and so a caller that smooths its own seam
// can opt out. It is never the default, and this test documents what it costs.
{
	const mask = buildPreserveMask([{ startFrame: 30, endFrame: 40 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 90,
		influenceRadius: 0,
	});
	assert.ok(
		mask.weights.every((weight) => weight === 0 || weight === 1),
		"radius 0 must produce a binary mask with no ramp at all"
	);
	assert.deepEqual(preserveMaskStats(mask), { freeFrames: 10, preservedFrames: 80, rampFrames: 0 });
	// ...and this is exactly the full step the default radius avoids.
	assert.equal(Math.abs(mask.weights[30] - mask.weights[29]), 1, "radius 0 steps a full 1.0 at the boundary");
	pass("influenceRadius 0 gives the documented hard edge (caller opt-out)");
}

// ---- structural invariants the Python side relies on -----------------------
// generate.py reads this file straight off disk; a short array or a value
// outside [0,1] would become a blend coefficient that amplifies instead of
// mixing, which is a silent corruption rather than a crash.
{
	for (const genFrames of [1, 7, 60, 181]) {
		const mask = buildPreserveMask([{ startFrame: 0, endFrame: 1 }], { appFps: 30, genFps: 30, genFrames });
		assert.equal(mask.weights.length, genFrames, `weights must be exactly genFrames long for ${genFrames}`);
		assert.equal(mask.genFrames, genFrames, "the declared genFrames must match the array length");
		assert.ok(
			mask.weights.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1),
			`every weight must be finite in [0,1] for genFrames ${genFrames}`
		);
	}
	const mask = buildPreserveMask([{ startFrame: 10, endFrame: 20 }], { appFps: 20, genFps: 30, genFrames: 120 });
	const roundTrip = JSON.parse(JSON.stringify(mask));
	assert.deepEqual(roundTrip, mask, "the mask must survive a JSON round trip unchanged");
	assert.deepEqual(
		Object.keys(roundTrip).sort(),
		["genFps", "genFrames", "version", "weights"],
		"v1 emits exactly the C1 keys; jointWeights is reserved for v2 and must not appear"
	);
	pass("the emitted mask matches the C1 v1 schema and round trips through JSON");
}

// ---- preserveMaskStats reports what the run will actually do --------------
// The UI needs to tell the user how much of their take is being regenerated. A
// run whose ramp dwarfs its free span means the shoulders are wider than the
// edit and the "preserved" take will drift almost everywhere.
{
	const mask = buildPreserveMask([{ startFrame: 100, endFrame: 110 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 300,
	});
	const stats = preserveMaskStats(mask);
	assert.equal(stats.freeFrames, 10, "exactly the edited frames are free");
	assert.ok(stats.rampFrames > 0, "a default-radius edit must produce a blend region");
	assert.ok(stats.preservedFrames > 0, "frames far from the edit must stay fully preserved");
	assert.equal(
		stats.freeFrames + stats.rampFrames + stats.preservedFrames,
		300,
		"every frame must be counted exactly once"
	);
	// The bare array form is accepted too, so callers holding only the weights
	// (the Python-side reader, the measurement tool) need not rebuild the object.
	assert.deepEqual(preserveMaskStats(mask.weights), stats);
	assert.throws(() => preserveMaskStats(null), /weights array/);
	assert.throws(() => preserveMaskStats({ weights: [0, Number.NaN] }), /finite/);
	pass("preserveMaskStats counts free, ramp and preserved frames");
}

// ---- every validation path fails loudly and by name ------------------------
// A malformed mask does not crash Kimodo — it produces a plausible-looking take
// that quietly ignores the user's edit, so bad input must never reach the file.
{
	const opts = { appFps: APP_FPS, genFps: GEN_FPS, genFrames: 180 };
	const range = [{ startFrame: 10, endFrame: 20 }];

	// editRanges itself
	assert.throws(() => buildPreserveMask(undefined, opts), /editRanges must be an array/);
	assert.throws(() => buildPreserveMask(null, opts), /editRanges must be an array/);
	assert.throws(() => buildPreserveMask("40:80", opts), /editRanges must be an array/);
	assert.throws(() => buildPreserveMask({ startFrame: 0, endFrame: 5 }, opts), /editRanges must be an array/);

	// individual entries
	assert.throws(() => buildPreserveMask([null], opts), /editRanges\[0\] must be an object/);
	assert.throws(() => buildPreserveMask([{ startFrame: -1, endFrame: 5 }], opts), /startFrame/);
	assert.throws(() => buildPreserveMask([{ startFrame: 1.5, endFrame: 5 }], opts), /startFrame/);
	assert.throws(() => buildPreserveMask([{ startFrame: 0, endFrame: null }], opts), /endFrame/);
	assert.throws(() => buildPreserveMask([{ startFrame: 0, endFrame: 2.5 }], opts), /endFrame/);
	assert.throws(() => buildPreserveMask([{ startFrame: 0, endFrame: -3 }], opts), /endFrame/);
	// inverted and empty half-open ranges edit nothing; accepting them would look
	// like a working reconstruction while dropping the user's edit.
	assert.throws(() => buildPreserveMask([{ startFrame: 80, endFrame: 40 }], opts), /non-empty half-open range/);
	assert.throws(() => buildPreserveMask([{ startFrame: 40, endFrame: 40 }], opts), /non-empty half-open range/);

	// a range with no overlap at all names the clip length so the caller can see
	// it built the mask against the wrong take's duration.
	assert.throws(
		() => buildPreserveMask([{ startFrame: 500, endFrame: 600 }], opts),
		/outside the 180-frame clip/
	);
	assert.throws(
		() => buildPreserveMask([{ startFrame: 0, endFrame: 4 }], { appFps: 1000, genFps: 1, genFrames: 180 }),
		/outside the 180-frame clip/
	);

	// clocks and clip length
	assert.throws(() => buildPreserveMask(range, { ...opts, appFps: 0 }), /appFps/);
	assert.throws(() => buildPreserveMask(range, { ...opts, appFps: -20 }), /appFps/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFps: Number.NaN }), /genFps/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFps: "30" }), /genFps/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFrames: 0 }), /genFrames/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFrames: Number.POSITIVE_INFINITY }), /genFrames/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFrames: undefined }), /genFrames/);

	// influence radius
	assert.throws(() => buildPreserveMask(range, { ...opts, influenceRadius: -1 }), /influenceRadius/);
	assert.throws(() => buildPreserveMask(range, { ...opts, influenceRadius: 2.5 }), /influenceRadius/);
	assert.throws(() => buildPreserveMask(range, { ...opts, influenceRadius: null }), /influenceRadius/);
	pass("every malformed edit list, clock and radius is refused by name");
}

console.log("OK verify-kimodo-preserve");
