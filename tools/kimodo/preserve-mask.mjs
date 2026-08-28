/**
 * preserve-mask.mjs — user edit ranges → Kimodo's `--preserve_mask` JSON (C1 v1).
 *
 * Scheduled inpainting (Disney, "Interactive Generative Motion Editing via
 * Scheduled Inpainting", 2026) blends a preserved base take back into the
 * evolving sample inside the denoising loop:
 *
 *   x_blended = alpha_t * noise(base, t) + (1 - alpha_t) * x_gen
 *   alpha_t   = alpha_time(t) * alpha_mask(frame)
 *
 * This file builds ONLY alpha_mask: one float per GENERATION frame, 1 = keep the
 * base take exactly, 0 = let the model generate freely. Everything about
 * diffusion time (sigma_s / sigma_e) lives on the Python side; the mask is a
 * pure function of "which frames did the user edit".
 *
 * Three things are silent-bug shaped here, so each is pinned by
 * test/verify-kimodo-preserve.mjs:
 *
 * 1. FRAME SPACE. Edit ranges arrive in the app's clip space, which runs at
 *    ARDY's 20 fps (src/App.jsx ARDY_FPS). Kimodo generates at 30. An unscaled
 *    range would free the wrong 2/3 of the clip — the user edits seconds 2..4
 *    and the model regenerates seconds 1.33..2.67. The scaling rule is copied
 *    verbatim from buildRoot2dConstraints in ./constraints.mjs (frame * genFps /
 *    appFps, Math.round, clamped into the generated clip) so a waypoint and an
 *    edit range authored on the same app frame always land on the same
 *    generation frame. If that rule ever changes, it must change in both files.
 *
 * 2. THE FALLOFF MUST NOT BE A STEP. The paper's own ablation is explicit: a
 *    square (hard-edged) kernel breaks motion at the seam — the preserved side
 *    is frozen on the base pose and the free side is generated with no knowledge
 *    of it, so the character snaps. The edit's influence therefore decays as a
 *    Gaussian shoulder over `influenceRadius` generation frames:
 *
 *      weight(f) = 1 - exp( -(d^2) / (2 * sigma^2) ),  sigma = influenceRadius/2
 *
 *    where d is the distance in generation frames from f to the NEAREST frame of
 *    the edit range (so d = 0 anywhere inside it, giving weight 0 = fully free).
 *    sigma = radius/2 is chosen so the named radius is 2 sigma: weight is ~0.86
 *    at exactly `influenceRadius` frames out and reaches float-exact 1.0 around
 *    4.3 radii, i.e. "the radius is where the edit has mostly stopped mattering",
 *    not where it is cut off. The first step away from a boundary is only
 *    1 - exp(-1/(2*sigma^2)) (0.0198 for the default radius 10), which is the
 *    smoothness the tests assert.
 *
 * 3. OVERLAPS TAKE THE MINIMUM. Two edits whose shoulders meet must not add up
 *    to MORE preservation in the gap between them than either edit asked for on
 *    its own. Combining by min means "any edit that wants this frame free wins",
 *    which is the only rule that keeps the mask monotone in the number of edits:
 *    adding an edit can never preserve a frame harder than before.
 *
 * Reserved for v2 and deliberately NOT emitted: `jointWeights` (per-joint
 * masking). Kimodo's denoiser input contract is per-frame in v1.
 */

export const PRESERVE_MASK_VERSION = 1;

/** Default shoulder width in GENERATION frames (~0.33 s at 30 fps). */
export const DEFAULT_INFLUENCE_RADIUS = 10;

function requireFinite(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`buildPreserveMask: ${label} must be a finite number, got ${JSON.stringify(value)}`);
	}
	return value;
}

function requirePositive(value, label) {
	requireFinite(value, label);
	if (value <= 0) {
		throw new Error(`buildPreserveMask: ${label} must be greater than 0, got ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * Turn APP-space edit ranges into the dense per-frame preserve mask (C1 v1).
 *
 * @param {Array<{startFrame:number,endFrame:number}>} editRanges
 *   Half-open [startFrame, endFrame) ranges in APP frame space (20 fps clip).
 *   An EMPTY array is valid and means "nothing was edited": the result is all
 *   ones, i.e. pure reconstruction of the base take. That case is the project's
 *   G1 acceptance gate, so it must be expressible, not an error.
 * @param {{appFps:number, genFps:number, genFrames:number, influenceRadius?:number}} options
 * @returns {{version:1, genFps:number, genFrames:number, weights:number[]}}
 */
export function buildPreserveMask(
	editRanges,
	{ appFps, genFps, genFrames, influenceRadius = DEFAULT_INFLUENCE_RADIUS } = {}
) {
	if (!Array.isArray(editRanges)) {
		throw new Error(`buildPreserveMask: editRanges must be an array, got ${JSON.stringify(editRanges)}`);
	}
	requirePositive(appFps, "appFps");
	requirePositive(genFps, "genFps");
	requirePositive(genFrames, "genFrames");
	if (genFrames < 1) throw new Error(`buildPreserveMask: genFrames must be >= 1, got ${genFrames}`);
	// influenceRadius 0 is EXPLICITLY ALLOWED and means a hard-edged square
	// kernel. The paper measured that as the broken case, so it is never the
	// default — but a caller that has already smoothed its own seam (or is
	// measuring the ablation, tools/kimodo/measure-preserve.mjs) needs the opt
	// out, and silently substituting a ramp would falsify their measurement.
	if (!Number.isInteger(influenceRadius) || influenceRadius < 0) {
		throw new Error(
			`buildPreserveMask: influenceRadius must be a non-negative integer, got ${JSON.stringify(influenceRadius)}`
		);
	}

	const scale = genFps / appFps;
	const frameCount = Math.round(genFrames);
	const lastFrame = frameCount - 1;

	// Validate and scale every range in author order first, so a bad edit list is
	// refused before any of it shapes the mask.
	const scaled = editRanges.map((range, index) => {
		if (!range || typeof range !== "object") {
			throw new Error(`buildPreserveMask: editRanges[${index}] must be an object`);
		}
		const { startFrame, endFrame } = range;
		if (!Number.isInteger(startFrame) || startFrame < 0) {
			throw new Error(
				`buildPreserveMask: editRanges[${index}].startFrame must be a non-negative integer, got ${JSON.stringify(startFrame)}`
			);
		}
		if (!Number.isInteger(endFrame) || endFrame < 0) {
			throw new Error(
				`buildPreserveMask: editRanges[${index}].endFrame must be a non-negative integer, got ${JSON.stringify(endFrame)}`
			);
		}
		// Ranges are half-open, so an empty or inverted one edits nothing. It is
		// almost always an off-by-one in the caller rather than intent, and
		// accepting it would produce an all-ones mask that looks like a working
		// reconstruction while silently ignoring the user's edit.
		if (endFrame <= startFrame) {
			throw new Error(
				`buildPreserveMask: editRanges[${index}] must be a non-empty half-open range, got [${startFrame}, ${endFrame})`
			);
		}

		const rawStart = Math.round(startFrame * scale);
		const rawEnd = Math.round(endFrame * scale);
		// A range that misses the generated clip entirely cannot be clamped into
		// anything meaningful — clamping it would free a frame at one end that the
		// user never touched. Refuse it by name, quoting the clip length, because
		// the usual cause is a mask built against a different take's duration.
		if (rawStart >= frameCount || rawEnd <= 0) {
			throw new Error(
				`buildPreserveMask: editRanges[${index}] [${startFrame}, ${endFrame}) scales to generation frames [${rawStart}, ${rawEnd}) which lies outside the ${frameCount}-frame clip`
			);
		}

		// Partial overlap CLAMPS rather than throwing: an edit that runs off the
		// end of the clip still asks for the frames it shares with it.
		const start = Math.min(lastFrame, Math.max(0, rawStart));
		// The exclusive end clamps to frameCount, not frameCount - 1: the last
		// index this frees is end - 1, which is still inside [0, frameCount - 1].
		// Clamping the END index itself would silently preserve the clip's final
		// frame even when the user edited right up to it.
		// A downscale (e.g. 60 fps app -> 30 fps generation) can also round both
		// ends onto one frame; forcing at least one free frame keeps the edit
		// visible instead of collapsing it to nothing.
		const end = Math.min(frameCount, Math.max(start + 1, rawEnd));
		return { start, end };
	});

	// 1.0 everywhere = preserve the whole base take. Edits only ever subtract.
	const weights = new Array(frameCount).fill(1);
	// sigma = radius/2; see the header for why the named radius is 2 sigma.
	const sigma = influenceRadius / 2;
	const twoSigmaSquared = 2 * sigma * sigma;

	for (const { start, end } of scaled) {
		for (let frame = 0; frame < frameCount; frame += 1) {
			// Distance to the NEAREST frame of the range. `end` is exclusive, so the
			// last free frame is end - 1 and the first frame past the range is one
			// step away from it, not zero — getting this wrong would shift the whole
			// trailing shoulder by a frame.
			let distance = 0;
			if (frame < start) distance = start - frame;
			else if (frame > end - 1) distance = frame - (end - 1);

			let weight;
			if (distance === 0) {
				weight = 0; // inside the edit: fully free generation
			} else if (influenceRadius === 0) {
				weight = 1; // opt-in hard edge: no shoulder at all
			} else {
				weight = 1 - Math.exp(-(distance * distance) / twoSigmaSquared);
			}

			// MIN, not sum or product: any edit that wants this frame free wins, so
			// adding an edit can never preserve a frame harder than before.
			if (weight < weights[frame]) weights[frame] = weight;
		}
	}

	// Clamp defensively. The Gaussian is analytically inside [0, 1), but the mask
	// is fed straight into a blend coefficient and a value outside [0, 1] there
	// would amplify rather than mix, so the invariant is enforced, not assumed.
	for (let frame = 0; frame < frameCount; frame += 1) {
		weights[frame] = Math.min(1, Math.max(0, weights[frame]));
	}

	return { version: PRESERVE_MASK_VERSION, genFps, genFrames: frameCount, weights };
}

/**
 * Summarise a mask for the UI and for run reporting: how much of the take is
 * being regenerated, how much is held, and how much is the blend in between.
 * A run whose rampFrames dwarf its freeFrames is a warning sign — the shoulders
 * are wider than the edit, so the "preserved" take will drift almost everywhere.
 *
 * Accepts either the mask object from buildPreserveMask or a bare weights array.
 *
 * @param {{weights:number[]}|number[]} mask
 * @returns {{freeFrames:number, preservedFrames:number, rampFrames:number}}
 */
export function preserveMaskStats(mask) {
	const weights = Array.isArray(mask) ? mask : mask && mask.weights;
	if (!Array.isArray(weights)) {
		throw new Error("preserveMaskStats: mask must be a preserve mask object or a weights array");
	}
	let freeFrames = 0;
	let preservedFrames = 0;
	let rampFrames = 0;
	for (let index = 0; index < weights.length; index += 1) {
		const weight = weights[index];
		if (typeof weight !== "number" || !Number.isFinite(weight)) {
			throw new Error(`preserveMaskStats: weights[${index}] must be a finite number, got ${JSON.stringify(weight)}`);
		}
		if (weight === 0) freeFrames += 1;
		else if (weight === 1) preservedFrames += 1;
		else rampFrames += 1;
	}
	return { freeFrames, preservedFrames, rampFrames };
}
