/**
 * Line editing (ProjFlow, contract C6) — the pure half.
 *
 * The joint's EXISTING screen trajectory is drawn over the viewport and the
 * user grabs a point on it and pulls; the curve deforms under a Gaussian
 * falloff and the deformed curve is what the box is made to follow EXACTLY.
 * (This is the Disney scheduled-inpainting figure-1 interaction: drag the dots
 * on the motion curve.) Everything in this file is the part of that feature
 * that has no DOM, no React and no three.js in it: a projected curve in, a wire
 * payload out. It is kept separate from App.jsx for two reasons —
 *
 *   1. the camera maths below is the one place where a sign error produces a
 *      silently mirrored edit rather than a crash, so it has to be testable
 *      without a browser;
 *   2. App.jsx is 11k lines and the feature's diff there should be wiring,
 *      not arithmetic.
 *
 * NOTHING here imports three.js. Matrices arrive as plain 16-element arrays in
 * three's own column-major `elements` order, which is what `Matrix4.elements`
 * already is — the caller passes `[...m.elements]` and no adapter is needed.
 */

/**
 * The 15 track ids a line edit may name. Deliberately spelled out rather than
 * imported from ./ardy/ik.js: that module pulls in three.js for its contact
 * -radius measurement, and this one must stay loadable in a bare node test.
 *
 * The list IS the union of ik.js's three tables — IK_TRACKS (hands/feet),
 * MID_TRACKS (elbows/knees) and FK_TRACKS (hips/spine/chest/neck/head/
 * shoulders) — and it is also exactly the key set of TRACK_GROUPS in
 * tools/kimodo/preserve-mask.mjs, which is the bridge's own validation table.
 * App.jsx builds the picker's LABELS by looking each id up in those ik.js
 * tables, so a track added there without being added here shows up as a
 * missing option rather than as a silently wrong wire value.
 */
export const LINE_EDIT_TRACK_IDS = Object.freeze([
	// IK_TRACKS — effectors
	"leftHand",
	"rightHand",
	"leftFoot",
	"rightFoot",
	// MID_TRACKS — mid-chain handles
	"leftElbow",
	"rightElbow",
	"leftKnee",
	"rightKnee",
	// FK_TRACKS — torso and head
	"hips",
	"spine",
	"chest",
	"neck",
	"head",
	"leftShoulder",
	"rightShoulder",
]);

/** Upper bound on the polyline the app sends.
 *
 * The box builds TWO affine rows per constrained sample and then factorises an
 * m x m system (Cholesky, per the C7 amendment). 64 points is 128 rows, which
 * is comfortably inside what the sampler solves per ODE step, and it is far
 * more resolution than the deformed trajectory carries. A 200-frame range is
 * 200 curve points; sending them all would cost solve time for detail the
 * Gaussian falloff made smooth on purpose. */
export const MAX_LINE_POINTS = 64;

/** A polyline needs at least a start and an end (C6: `>= 2 points`). */
export const MIN_LINE_POINTS = 2;

/** How many curve points at EACH end are hard-pinned to the original
 * trajectory — never moved by a drag, never grabbable.
 *
 * This is the seam fix, and it is the reason this interaction replaced
 * freehand drawing. Gate GP2 measured it: an arbitrary drawn line pops the
 * take 3.9x/8.0x its own median frame delta at the range edges (the joint
 * teleports to wherever the stroke started), while a line whose ENDPOINTS sit
 * on the joint's own trajectory collapses that to 1.67x/1.09x. A Gaussian
 * never actually reaches zero — at 6 sigma it is still ~1e-8, and at the more
 * realistic "grab three frames from the end with radius 40" it is a very
 * visible fraction — so relying on the falloff alone would leave the endpoint
 * OFF the original trajectory by an amount that depends on where the user
 * happened to grab. Pinning makes the seam property structural instead of
 * probabilistic: points [0, 1] and [n-2, n-1] are returned byte-identical by
 * dragCurve, so the edit's first and last constrained frames are always
 * exactly where the take already put the joint. Two rather than one because a
 * single pinned frame still lets the SLOPE jump at the seam. */
export const PINNED_CURVE_ENDS = 2;

/** Influence-radius bounds, in FRAMES, for the panel's slider. 2 is a local
 * nudge (one gesture beat); 40 at 20 fps is two seconds, past which a drag
 * stops being an edit and becomes a different motion. */
export const DRAG_RADIUS_MIN = 2;
export const DRAG_RADIUS_MAX = 40;
export const DRAG_RADIUS_DEFAULT = 8;

/** Below this weight a point is "not really being dragged": used to draw the
 * influenced span in the overlay so the number on the slider has a visible
 * meaning. Not used to zero anything — dragCurve applies the true weight. */
export const DRAG_WEIGHT_EPSILON = 0.05;

/** Grab tolerance for the hit test, in CSS pixels. */
export const CURVE_GRAB_RADIUS_PX = 14;

/** How far the camera may drift under a pulled curve before the pull is thrown
 * away. The captured extrinsics and the authored uv are a MATCHED PAIR: once
 * the user orbits, the same uv names a different ray and the box would solve
 * for a path the user never aimed at. 1e-4 is tighter than any deliberate nudge
 * and looser than float noise from re-deriving the same matrix. */
export const CAMERA_DRIFT_EPSILON = 1e-4;

/**
 * The rendering camera -> the C6 `camera` block: { fx, fy, cx, cy, R, t }.
 *
 * ============================ CONVENTION (read this) ======================
 * This is the contract the box-side driver builds its affine rows against
 *   [fx*R0 - (u - cx)*R2] X = -[fx*t0 - (u - cx)*t2]
 *   [fy*R1 - (v - cy)*R2] X = -[fy*t1 - (v - cy)*t2]
 * so every symbol below has to mean exactly one thing.
 *
 * UNITS. points2d are normalized 0..1 across the render viewport, so fx, fy,
 * cx, cy are in THOSE SAME uv units, not pixels. That is forced, not stylistic:
 * C6's camera block carries no width/height, so the only way (u - cx) can be
 * dimensionally consistent with fx is for both to live in uv. Multiply fx and
 * cx by the viewport width (fy, cy by its height) to recover pixel intrinsics.
 * cx and cy are therefore always exactly 0.5 for a three.js PerspectiveCamera,
 * which has no principal-point offset; they are still emitted so the box never
 * has to assume a centred principal point.
 *
 * AXES. u runs left->right and v runs TOP->BOTTOM, matching both the DOM
 * pointer coordinates the curve is grabbed in and the OpenCV image
 * convention. three.js NDC has y running bottom->top, so v is the flipped one:
 *   u = (x_ndc + 1) / 2
 *   v = (1 - y_ndc) / 2
 *
 * FRAME. R and t map WORLD -> an OPENCV camera frame: x right, y DOWN, z
 * FORWARD (into the screen, positive depth in front of the lens). three.js
 * cameras look down their own -Z with +Y up, so this function applies the
 * standard diag(1, -1, -1) flip to `matrixWorldInverse` — negating rows 1 and
 * 2 of the rotation and components 1 and 2 of the translation. With that flip
 * both fx and fy come out POSITIVE, which is why the flip is done here rather
 * than pushed onto the box as a sign convention it would have to remember.
 * The projection is then plain pinhole:
 *   Xc = R X + t ;  u = cx + fx * Xc0 / Xc2 ;  v = cy + fy * Xc1 / Xc2
 * with Xc2 > 0 for anything in front of the camera.
 *
 * R is 3x3 ROW-MAJOR as a flat 9-array of numbers (R[0..2] is the first row).
 * ==========================================================================
 *
 * @param {object} view
 * @param {number} view.fovDeg   three's VERTICAL field of view, in degrees.
 * @param {number} view.aspect   the camera's own `aspect` — the one baked into
 *   its projection matrix, which is not necessarily width/height (the shot
 *   camera is locked to the export aspect and letterboxed into its pane).
 * @param {number[]} view.matrixWorldInverse  16 numbers, three's column-major
 *   `elements` order, world -> three-camera.
 * @param {number} view.width    render viewport width in CSS px — the exact
 * @param {number} view.height   rectangle the curve's uv are normalized by.
 *   Only used to catch a caller that measured the curve against a different
 *   rectangle than the one the camera actually drew into.
 */
export function cameraToC6({ fovDeg, aspect, matrixWorldInverse, width, height }) {
	if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) {
		throw new Error(`cameraToC6: fovDeg must be a vertical FOV in (0, 180), got ${JSON.stringify(fovDeg)}`);
	}
	if (!Number.isFinite(aspect) || aspect <= 0) {
		throw new Error(`cameraToC6: aspect must be a positive number, got ${JSON.stringify(aspect)}`);
	}
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error(`cameraToC6: width/height must be positive, got ${JSON.stringify([width, height])}`);
	}
	const e = matrixWorldInverse;
	if (!e || e.length !== 16 || !Array.prototype.every.call(e, Number.isFinite)) {
		throw new Error("cameraToC6: matrixWorldInverse must be 16 finite numbers (three's column-major elements)");
	}
	// The image rectangle the caller normalized against must match the aspect
	// the projection matrix was built with, or u and v are measured in a
	// different space than fx and fy describe and the whole edit lands skewed.
	// The callers fit the pane to the camera's aspect (dualview's fitAspect),
	// so a mismatch here is a wiring bug, not a user action.
	if (Math.abs(width / height - aspect) > 1e-3 * aspect) {
		throw new Error(
			`cameraToC6: viewport aspect ${(width / height).toFixed(4)} does not match camera aspect ${aspect.toFixed(4)} — ` +
			"the curve was measured against a rectangle the camera did not draw into",
		);
	}

	// Vertical FOV -> uv intrinsics. Derivation, from three's own perspective
	// projection: x_ndc = Xc_x / (aspect * tan(fov/2) * -Zc) and
	// y_ndc = Yc_y / (tan(fov/2) * -Zc). Substituting u = (x_ndc + 1)/2 and
	// v = (1 - y_ndc)/2 gives the halves below.
	const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);
	const fx = 0.5 / (aspect * tanHalfFov);
	const fy = 0.5 / tanHalfFov;

	// three's Matrix4.elements is COLUMN-major: element(row, col) = e[col*4+row].
	const m = (row, col) => e[col * 4 + row];
	// diag(1, -1, -1) * [R | t] — the three-camera (y up, -z forward) to
	// OpenCV-camera (y down, +z forward) change of basis described above.
	const R = [
		m(0, 0), m(0, 1), m(0, 2),
		-m(1, 0), -m(1, 1), -m(1, 2),
		-m(2, 0), -m(2, 1), -m(2, 2),
	];
	const t = [m(0, 3), -m(1, 3), -m(2, 3)];
	return { fx, fy, cx: 0.5, cy: 0.5, R, t };
}

/**
 * Project a world point through a C6 camera block into the uv the curve lives
 * in. It is what builds the editable trajectory below, and it is the direct
 * inverse-check of cameraToC6: if a projected joint does not land on the joint
 * the user sees, the convention above is wrong and the curve makes that visible
 * immediately.
 *
 * Returns null for points at or behind the lens (depth <= 0), which have no
 * image.
 */
export function projectPointC6(camera, x, y, z) {
	const { fx, fy, cx, cy, R, t } = camera;
	const xc = R[0] * x + R[1] * y + R[2] * z + t[0];
	const yc = R[3] * x + R[4] * y + R[5] * z + t[1];
	const zc = R[6] * x + R[7] * y + R[8] * z + t[2];
	if (!(zc > 1e-6)) return null;
	return [cx + (fx * xc) / zc, cy + (fy * yc) / zc];
}

/* ===================== the editable trajectory curve =======================
 * A "curve" throughout this file is a DENSE, FRAME-INDEXED array: one entry per
 * frame of the edit range, in order, either `{ frame, u, v }` or `null` for a
 * frame whose joint is behind the lens and therefore has no image.
 *
 * Dense-and-frame-indexed is the load-bearing property. C6 spreads points2d
 * across frameRange, so index i of the curve IS frame startFrame + i; that is
 * what lets a drag mean "move the joint at THIS moment" instead of "move this
 * point of a shape", and it is why the falloff below is measured in frames.
 * Nothing in here compacts the array — nulls keep their slot.
 * ========================================================================== */

/** Is this curve point inside the drawable viewport?
 *
 * A point can leave 0..1 two ways: it was already offscreen when the trail was
 * projected (the joint is out of frame at that moment), or a drag pushed it
 * out. Both are the same fact for the UI — it cannot be grabbed and it cannot
 * be sent, because the bridge refuses points2d outside 0..1. */
export function isCurvePointOnScreen(point) {
	return !!point && point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1;
}

/** Is this index one of the hard-pinned ends? See PINNED_CURVE_ENDS. */
export function isCurveEndPinned(index, length) {
	return index < PINNED_CURVE_ENDS || index >= length - PINNED_CURVE_ENDS;
}

/**
 * Gaussian falloff weight for a point `distanceFrames` away from the grab.
 *
 * sigma = radius/2, so `radiusFrames` reads as "the span I am pulling": the
 * weight is 1 at the grab, 0.61 at radius/2, 0.135 at the radius itself and
 * ~1e-4 at twice it. Exported (rather than inlined in dragCurve) because the
 * overlay paints the influenced span with the SAME formula — two independent
 * spellings of one falloff is how the drawn highlight drifts from the applied
 * deformation.
 *
 * NOT the smoothstep in motion-trail.js: that one is compact (exactly 0 at the
 * radius) because it edits 3D world positions where a hard boundary is fine.
 * Here a C1 tail is what keeps the deformed trajectory from developing a crease
 * the sampler would then have to follow exactly.
 */
export function dragWeight(distanceFrames, radiusFrames) {
	const radius = Number(radiusFrames);
	const distance = Number(distanceFrames);
	if (!Number.isFinite(distance)) return 0;
	if (!(radius > 0)) return distance === 0 ? 1 : 0;
	const sigma = radius / 2;
	return Math.exp(-(distance * distance) / (2 * sigma * sigma));
}

/**
 * The joint's world-space trail -> the on-screen curve the user grabs.
 *
 * `trail` is the flat Float32Array from motion-trail's jointTrailPoints (3
 * floats per frame of the WHOLE take); `frameRange` is C6's half-open app-clip
 * range; `camera` is the C6 block the range will be sent with. Frames past the
 * end of the trail and frames whose joint is behind the lens come back as
 * null. Points OUTSIDE 0..1 are kept as they are — the joint really is over
 * there, just not in shot, and the caller wants to say so rather than pretend
 * the trajectory stops at the frame edge.
 */
export function projectTrailCurve({ trail, frameRange, camera }) {
	if (!trail || !camera || !frameRange) return null;
	const start = Math.max(0, Math.trunc(frameRange.startFrame));
	const end = Math.trunc(frameRange.endFrame);
	if (!(end > start)) return null;
	const trailFrames = Math.floor(trail.length / 3);
	const curve = [];
	for (let frame = start; frame < end; frame += 1) {
		if (frame >= trailFrames) {
			curve.push(null);
			continue;
		}
		const uv = projectPointC6(camera, trail[frame * 3], trail[frame * 3 + 1], trail[frame * 3 + 2]);
		curve.push(uv ? { frame, u: uv[0], v: uv[1] } : null);
	}
	return curve;
}

/**
 * Pull one point of the curve and let the neighbours follow — a new curve out,
 * the input untouched.
 *
 * `du`/`dv` are the pointer's total travel since the grab, in normalized uv,
 * and they are applied to the curve AS IT WAS AT GRAB TIME (the caller keeps
 * that snapshot). That makes a single drag idempotent: moving the pointer back
 * to where it started restores the curve exactly, and re-running the function
 * with a different radius mid-drag re-derives the whole deformation instead of
 * compounding it. Successive drags stack because each new grab snapshots the
 * curve the previous one produced.
 *
 * Null points stay null (no image, nothing to move) and the outermost
 * PINNED_CURVE_ENDS points on each side are returned by reference, unmoved —
 * the seam guarantee, argued at that constant.
 */
export function dragCurve(curve, grabIndex, du, dv, radiusFrames) {
	if (!Array.isArray(curve)) return curve;
	const deltaU = Number(du);
	const deltaV = Number(dv);
	if (!Number.isFinite(deltaU) || !Number.isFinite(deltaV)) return curve;
	const length = curve.length;
	return curve.map((point, index) => {
		if (!point) return null;
		if (isCurveEndPinned(index, length)) return point;
		const weight = dragWeight(index - grabIndex, radiusFrames);
		// Not an approximation of zero — an untouched point must come back as
		// the SAME object so an unedited stretch of curve compares equal to the
		// original without a float epsilon.
		if (weight === 0) return point;
		return { frame: point.frame, u: point.u + deltaU * weight, v: point.v + deltaV * weight };
	});
}

/** How long a freehand stroke has to be before it is a STROKE rather than a
 * click, in CSS pixels. Measured by the caller, which is the only side that
 * knows how big the pane is; a press-and-release with a few pixels of hand
 * tremor is a click, and a click must never wipe an edit that is already there
 * (that exact regression is why the drag commit compares curvesEqual). */
export const DRAW_MIN_STROKE_PX = 8;

/** Fewest samples a stroke needs before it names a shape at all. One point is a
 * dot: it has no direction, no length and nothing to parameterize. */
export const DRAW_MIN_STROKE_POINTS = 2;

/**
 * A freehand stroke -> the same dense frame-indexed curve a drag produces.
 *
 * This is the OTHER half of the interaction: on takes whose projected trail
 * bunches into a handful of screen pixels there is nothing to grab, so a press
 * on empty space draws a new path instead of doing nothing. The result has to
 * be indistinguishable from a dragged curve — same shape, same nulls, same
 * pinned ends — because everything downstream (preview, undo, curveToPoints2d,
 * the drift watcher) is written against that one type.
 *
 * ARC LENGTH, NOT SAMPLE INDEX. Frame at position `index` of the range samples
 * the stroke at the point `index / (length - 1)` of the way along its TOTAL
 * LENGTH, walking the polyline and interpolating inside the segment it lands
 * in. That is what makes drawing SPEED irrelevant: a stroke drawn slowly at the
 * start and flicked at the end carries a crowd of samples near its beginning,
 * and sampling by sample index would hand the crowded part most of the frames
 * and re-time the take. Arc length reads the stroke as a SHAPE, which is the
 * only thing a hand-drawn line honestly carries. (Note the deliberate contrast
 * with curveToPoints2d, which downsamples by index precisely because the curve
 * it is given DOES carry timing — index i is frame startFrame + i.)
 *
 * The parameterization is endpoint-inclusive: index 0 sits at the stroke's
 * start and index length-1 at its end, so the whole drawn shape is used.
 *
 * PINNED ENDS ARE THE SEAM GUARANTEE. The first and last `pinnedEnds` entries
 * come back BY REFERENCE from `baseCurve`, exactly as dragCurve returns them —
 * see PINNED_CURVE_ENDS for the measurement (8.0x median frame delta at the
 * range edge for a free-ended drawn line, 1.09x when the ends sit on the
 * joint's own path). The interior is fully free; the ends are not negotiable.
 *
 * Nulls in `baseCurve` stay null, again like dragCurve: a frame whose joint is
 * behind the lens has no image, and a stroke cannot invent one.
 *
 * @param {Array<[number, number]>} stroke  pointer samples in the SAME
 *   viewport-normalized uv the curve lives in, in the order they were drawn.
 * @param {Array<{frame:number,u:number,v:number}|null>} baseCurve  the dense
 *   frame-indexed curve whose interior this stroke replaces (the curve as it is
 *   right now, so drawing twice means the second drawing wins and a drag after
 *   a draw refines the drawn curve).
 * @param {object} [options]
 * @param {number} [options.pinnedEnds]  how many entries at each end stay put.
 * @param {number} [options.minLength]  refuse strokes shorter than this in uv
 *   units. 0 (the default) still refuses a stroke of zero length — the callers
 *   measure their own threshold in PIXELS, where the user drew it.
 * @returns a new curve, or null when the stroke is a no-op click.
 */
export function strokeToCurve(stroke, baseCurve, { pinnedEnds = PINNED_CURVE_ENDS, minLength = 0 } = {}) {
	if (!Array.isArray(baseCurve) || baseCurve.length < MIN_LINE_POINTS) return null;
	if (!Array.isArray(stroke)) return null;
	// Non-finite samples are dropped rather than poisoning the arc length: a
	// pointer event outside a settled pane can produce one, and a single NaN
	// would otherwise turn the whole curve into NaN and be refused much later
	// with a message about the wire format.
	const points = [];
	for (const sample of stroke) {
		if (!Array.isArray(sample) || sample.length < 2) continue;
		const x = Number(sample[0]);
		const y = Number(sample[1]);
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		points.push([x, y]);
	}
	if (points.length < DRAW_MIN_STROKE_POINTS) return null;
	const cumulative = [0];
	for (let i = 1; i < points.length; i += 1) {
		cumulative.push(cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
	}
	const total = cumulative[cumulative.length - 1];
	// A stroke that never moved is a click, and a click changes nothing.
	if (!(total > 0) || total < minLength) return null;

	const length = baseCurve.length;
	// Never pin away the whole curve: a range shorter than 2 x pinnedEnds would
	// otherwise come back byte-identical and read as "the user drew nothing".
	const pinned = Math.max(0, Math.min(Math.trunc(pinnedEnds) || 0, Math.floor(length / 2)));
	// One monotone walk along the stroke for the whole curve: the targets only
	// ever increase with index, so the cursor never rewinds and a 200-frame
	// range costs one pass over the samples rather than 200 searches.
	let cursor = 1;
	const out = new Array(length);
	for (let index = 0; index < length; index += 1) {
		const base = baseCurve[index];
		if (index < pinned || index >= length - pinned) {
			// BY REFERENCE, like dragCurve — an untouched point must compare
			// equal with no epsilon to choose.
			out[index] = base;
			continue;
		}
		if (!base) {
			out[index] = null;
			continue;
		}
		const target = (index / (length - 1)) * total;
		while (cursor < cumulative.length - 1 && cumulative[cursor] < target) cursor += 1;
		const span = cumulative[cursor] - cumulative[cursor - 1];
		const fraction = span > 0 ? Math.min(1, Math.max(0, (target - cumulative[cursor - 1]) / span)) : 0;
		const a = points[cursor - 1];
		const b = points[cursor];
		out[index] = {
			frame: base.frame,
			u: a[0] + (b[0] - a[0]) * fraction,
			v: a[1] + (b[1] - a[1]) * fraction,
		};
	}
	return out;
}

/**
 * The edited curve -> the `points2d` C6 sends, or a refusal.
 *
 * Returns `{ points2d }` or `{ error }` where error is one of:
 *   "empty"     — fewer than 2 points have an image at all
 *   "offscreen" — some point sits outside 0..1, which the bridge refuses
 *
 * DOWNSAMPLING IS EVEN BY INDEX, i.e. even IN TIME, and that is the opposite
 * of what the old freehand path did (even by arc length). The reason is that
 * the two inputs mean different things. A freehand stroke carries no timing —
 * the only sane reading is "constant speed along the shape", so arc-length
 * spacing was right there. This curve is the joint's own trajectory: index i is
 * frame startFrame + i, and the box spreads the points evenly across
 * frameRange. Arc-length resampling would therefore RE-TIME the take — it
 * would hand the slow parts of the motion fewer samples and the box would
 * stretch them back out to equal duration, turning a pause into a glide. Even
 * index sampling keeps every sent point on the frame it was projected from.
 *
 * The first and last kept points are always included, so the pinned endpoints
 * from dragCurve survive into the payload rather than being resampled away.
 */
export function curveToPoints2d(curve) {
	const visible = Array.isArray(curve) ? curve.filter(Boolean) : [];
	if (visible.length < MIN_LINE_POINTS) return { error: "empty" };
	for (const point of visible) {
		if (!isCurvePointOnScreen(point)) return { error: "offscreen" };
	}
	const count = Math.min(MAX_LINE_POINTS, visible.length);
	const last = visible.length - 1;
	const points2d = [];
	for (let i = 0; i < count; i += 1) {
		// Rounded rather than floored so the sampling is symmetric about the
		// middle; i = count-1 lands exactly on `last`, i = 0 exactly on 0.
		const source = count === 1 ? 0 : Math.round((i * last) / (count - 1));
		const point = visible[source];
		points2d.push([point.u, point.v]);
	}
	return { points2d };
}

/**
 * Which curve point is under the pointer? `{ index, dist }` or null.
 *
 * The hit test is in PIXELS, not uv, because uv distance is anisotropic: on a
 * 16:9 pane one unit of u is nearly twice one unit of v, so a uv-radius grab
 * zone is a visible ellipse and the curve is hardest to grab exactly where it
 * runs vertically. paneW/paneH convert once, here.
 *
 * Points with no image, points outside the viewport and the pinned ends are
 * all skipped — a marker the user can grab but that cannot move is worse than
 * no marker, so the overlay does not draw those as draggable either.
 */
export function nearestCurvePoint(curve, u, v, maxDistPx, paneW, paneH) {
	if (!Array.isArray(curve) || !(paneW > 0) || !(paneH > 0)) return null;
	let best = null;
	for (let index = 0; index < curve.length; index += 1) {
		const point = curve[index];
		if (!isCurvePointOnScreen(point)) continue;
		if (isCurveEndPinned(index, curve.length)) continue;
		const dx = (point.u - u) * paneW;
		const dy = (point.v - v) * paneH;
		const dist = Math.hypot(dx, dy);
		if (dist > maxDistPx) continue;
		if (!best || dist < best.dist) best = { index, dist };
	}
	return best;
}

/** Are these two curves the same curve? The "has the user actually pulled
 * anything yet?" test, and the reason dragCurve returns untouched points by
 * reference: an unmoved curve compares equal exactly, with no tolerance to
 * choose. Compared on value anyway so a rebuilt-but-identical curve (a camera
 * re-projection that landed in the same place) also reads as unedited. */
export function curvesEqual(a, b) {
	if (a === b) return true;
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		const pa = a[i];
		const pb = b[i];
		if (pa === pb) continue;
		if (!pa || !pb) return false;
		if (pa.frame !== pb.frame || pa.u !== pb.u || pa.v !== pb.v) return false;
	}
	return true;
}

/**
 * Has the camera moved out from under the curve?
 *
 * Compared on the C6 block itself rather than on three's camera object, so the
 * test is on exactly the numbers that were sent — a re-derived but identical
 * pose reads as "not moved" even after a matrix rebuild. A true means the curve
 * must be re-projected from the new camera and any deformation on it dropped,
 * never re-interpreted: there is no correct way to read 2D offsets authored
 * through one lens as offsets through another.
 */
export function cameraDrifted(a, b, epsilon = CAMERA_DRIFT_EPSILON) {
	if (!a || !b) return true;
	if (Math.abs(a.fx - b.fx) > epsilon || Math.abs(a.fy - b.fy) > epsilon) return true;
	if (Math.abs(a.cx - b.cx) > epsilon || Math.abs(a.cy - b.cy) > epsilon) return true;
	for (let i = 0; i < 9; i += 1) if (Math.abs(a.R[i] - b.R[i]) > epsilon) return true;
	for (let i = 0; i < 3; i += 1) if (Math.abs(a.t[i] - b.t[i]) > epsilon) return true;
	return false;
}

/**
 * Last gate before a line edit goes on the wire (contract C6).
 *
 * Returns `null` when the payload is good, otherwise
 * `{ code, message }` — `code` is a stable token the UI maps to localized copy
 * and `message` is the English detail worth putting in a log or a test name.
 * Structured the same way as the bridge's own validateGenerate: one specific
 * reason, named field first, and the first failure wins.
 *
 * `clipFrames` is the loaded take's frame count on the APP timeline clock —
 * C6's frameRange is in app clip frames, and unlike waypoints/motionEdit it is
 * NOT converted to the bridge clock here.
 */
export function validateLineEdit(lineEdit, { clipFrames } = {}) {
	const fail = (code, message) => ({ code, message });
	if (!lineEdit || typeof lineEdit !== "object" || Array.isArray(lineEdit)) {
		return fail("shape", "lineEdit must be an object");
	}
	if (typeof lineEdit.sourceMotion !== "string" || !lineEdit.sourceMotion) {
		// A line edit REWRITES a take; without the bridge-side source npz there
		// is nothing to rewrite and the box would silently generate from scratch.
		return fail("sourceMotion", "field 'lineEdit.sourceMotion' must be a non-empty motion url");
	}
	if (!LINE_EDIT_TRACK_IDS.includes(lineEdit.track)) {
		return fail("track", `field 'lineEdit.track' must be one of the ${LINE_EDIT_TRACK_IDS.length} ik track ids, got ${JSON.stringify(lineEdit.track)}`);
	}
	const range = lineEdit.frameRange;
	if (!range || typeof range !== "object" || !Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame)) {
		return fail("frameRange", "field 'lineEdit.frameRange' must be { startFrame, endFrame } integers");
	}
	if (range.startFrame < 0 || range.endFrame <= range.startFrame) {
		return fail("frameRange", `field 'lineEdit.frameRange' must satisfy 0 <= startFrame < endFrame, got ${range.startFrame}..${range.endFrame}`);
	}
	// endFrame is EXCLUSIVE, like every other half-open range crossing this
	// boundary (preserve.editRanges, the prompt schedule), so it may equal the
	// clip length but never exceed it.
	if (Number.isFinite(clipFrames) && range.endFrame > clipFrames) {
		return fail("frameRange", `field 'lineEdit.frameRange.endFrame' must be <= the clip's ${clipFrames} frames, got ${range.endFrame}`);
	}
	// One constrained frame cannot follow a LINE; two points need two frames.
	if (Number.isFinite(clipFrames) && range.endFrame - range.startFrame < MIN_LINE_POINTS) {
		return fail("frameRange", "field 'lineEdit.frameRange' must span at least 2 frames");
	}
	const points = lineEdit.points2d;
	if (!Array.isArray(points) || points.length < MIN_LINE_POINTS) {
		return fail("points", `field 'lineEdit.points2d' needs at least ${MIN_LINE_POINTS} points`);
	}
	if (points.length > MAX_LINE_POINTS) {
		return fail("points", `field 'lineEdit.points2d' is capped at ${MAX_LINE_POINTS} points, got ${points.length}`);
	}
	for (let i = 0; i < points.length; i += 1) {
		const point = points[i];
		if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
			return fail("points", `field 'lineEdit.points2d[${i}]' must be [u, v] finite numbers`);
		}
		if (point[0] < 0 || point[0] > 1 || point[1] < 0 || point[1] > 1) {
			return fail("points", `field 'lineEdit.points2d[${i}]' must be viewport-normalized into 0..1, got ${JSON.stringify(point)}`);
		}
	}
	const camera = lineEdit.camera;
	if (!camera || typeof camera !== "object") return fail("camera", "field 'lineEdit.camera' is required");
	for (const key of ["fx", "fy", "cx", "cy"]) {
		if (!Number.isFinite(camera[key])) return fail("camera", `field 'lineEdit.camera.${key}' must be a finite number`);
	}
	// A non-positive focal length means the uv/NDC flip was applied twice (or
	// not at all) and every solved position would be mirrored.
	if (camera.fx <= 0 || camera.fy <= 0) {
		return fail("camera", "field 'lineEdit.camera' has a non-positive focal length — the uv convention is inverted");
	}
	if (!Array.isArray(camera.R) || camera.R.length !== 9 || !camera.R.every(Number.isFinite)) {
		return fail("camera", "field 'lineEdit.camera.R' must be 9 finite numbers (3x3 row-major)");
	}
	if (!Array.isArray(camera.t) || camera.t.length !== 3 || !camera.t.every(Number.isFinite)) {
		return fail("camera", "field 'lineEdit.camera.t' must be 3 finite numbers");
	}
	if (lineEdit.prompt !== undefined && typeof lineEdit.prompt !== "string") {
		return fail("prompt", "field 'lineEdit.prompt' must be a string when present");
	}
	return null;
}

/**
 * Does this generate failure mean "the bridge does not know about lineEdit
 * yet"? Wave 2 lands the routing; until then a request either 400s on the
 * unknown field or is refused by the capability preflight. Both deserve the
 * same calm "not connected yet" answer rather than a red error card, so the
 * classification lives here where it can be tested against real reason
 * strings.
 */
export function isLineEditUnsupported(message) {
	if (typeof message !== "string" || !message) return false;
	if (/HTTP\s*400/i.test(message)) return true;
	return /line\s*edit/i.test(message) && /unknown|unsupported|not supported|unrecognis|unrecogniz|must not|invalid field/i.test(message);
}
