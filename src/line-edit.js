/**
 * Line editing (ProjFlow, contract C6) — the pure half.
 *
 * The user draws a 2D polyline over the render viewport and one joint is made
 * to follow it EXACTLY. Everything in this file is the part of that feature
 * that has no DOM, no React and no three.js in it: pointer samples in, a wire
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
 * more resolution than a hand-drawn stroke on a ~1000 px viewport carries. A
 * raw pointer drag easily produces 300+ samples; sending them would cost solve
 * time for sub-pixel detail nobody drew on purpose. */
export const MAX_LINE_POINTS = 64;

/** A polyline needs at least a start and an end (C6: `>= 2 points`). */
export const MIN_LINE_POINTS = 2;

/** Consecutive samples closer than this in normalized uv are the same point.
 * At 1e-3 of a 1000 px viewport that is one pixel — below it the stroke is
 * pointer jitter while the finger is still, not drawn intent. */
export const MIN_POINT_GAP = 1e-3;

/** How far the camera may drift after a stroke was committed before the stroke
 * is thrown away. The captured extrinsics and the drawn uv are a MATCHED PAIR:
 * once the user orbits, the same uv names a different ray and the box would
 * solve for a line the user never drew. 1e-4 is tighter than any deliberate
 * nudge and looser than float noise from re-deriving the same matrix. */
export const CAMERA_DRIFT_EPSILON = 1e-4;

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Raw pointer samples -> the `points2d` C6 sends.
 *
 * Input is `[[u, v], ...]` already normalized into the RENDER viewport (0..1,
 * u left->right, v top->bottom — see cameraToC6 for why v points down). Output
 * is the same convention, deduped and resampled.
 *
 * Resampling is EVEN BY ARC LENGTH, not by sample index, and that choice is
 * semantic rather than cosmetic: the box distributes the points across
 * frameRange, so evenly-spaced-in-space points mean constant speed along the
 * drawn line. Index-even resampling would instead encode how fast the user's
 * hand happened to move, which is noise — a slow corner would become a
 * slow-motion beat in the take.
 *
 * Returns null when there is no line: fewer than two distinct points, or a
 * stroke of zero total length (a tap).
 */
export function normalizePointerPoints(points, { maxPoints = MAX_LINE_POINTS, minGap = MIN_POINT_GAP } = {}) {
	if (!Array.isArray(points)) return null;
	// Pass 1: keep only finite pairs, clamp into the viewport, and drop any
	// sample that has not moved away from the one before it. Pointer events
	// repeat at the same coordinate whenever the finger pauses, and a run of
	// identical points would make the arc-length walk below divide by zero.
	const cleaned = [];
	for (const point of points) {
		if (!Array.isArray(point) || point.length < 2) continue;
		const u = Number(point[0]);
		const v = Number(point[1]);
		if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
		const next = [clamp01(u), clamp01(v)];
		const previous = cleaned[cleaned.length - 1];
		if (previous && Math.hypot(next[0] - previous[0], next[1] - previous[1]) < minGap) continue;
		cleaned.push(next);
	}
	if (cleaned.length < MIN_LINE_POINTS) return null;

	// Cumulative arc length. `total` is also the "was this a tap?" test: a
	// stroke that never left its start has nothing to resample along.
	const cumulative = [0];
	for (let i = 1; i < cleaned.length; i += 1) {
		const dx = cleaned[i][0] - cleaned[i - 1][0];
		const dy = cleaned[i][1] - cleaned[i - 1][1];
		cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
	}
	const total = cumulative[cumulative.length - 1];
	if (!(total > 0)) return null;

	// Never UPSAMPLE: inventing points between two drawn samples would tell the
	// box the user constrained frames they never touched. The cap is the only
	// thing that ever reduces the count.
	const count = Math.max(MIN_LINE_POINTS, Math.min(maxPoints, cleaned.length));
	const out = [];
	let cursor = 0;
	for (let i = 0; i < count; i += 1) {
		const target = (total * i) / (count - 1);
		while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < target) cursor += 1;
		const spanStart = cumulative[cursor];
		const spanEnd = cumulative[cursor + 1];
		const span = spanEnd - spanStart;
		// A zero-length span cannot happen after the dedupe above, but the guard
		// keeps a NaN out of the wire if minGap is ever configured to 0.
		const t = span > 0 ? (target - spanStart) / span : 0;
		const a = cleaned[cursor];
		const b = cleaned[cursor + 1];
		out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
	}
	// The endpoints are what the user actually aimed at; floating-point walking
	// can leave them a hair short. Pin them back exactly.
	out[0] = cleaned[0].slice();
	out[out.length - 1] = cleaned[cleaned.length - 1].slice();
	return out;
}

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
 * pointer coordinates the stroke was captured in and the OpenCV image
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
 * @param {number} view.height   rectangle the stroke's uv were normalized by.
 *   Only used to catch a caller that measured the stroke against a different
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
			"the stroke was measured against a rectangle the camera did not draw into",
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
 * Project a world point through a C6 camera block into the same uv the stroke
 * lives in. Used for the drawing overlay's "here is where this joint goes
 * today" ghost line, and it is the direct inverse-check of cameraToC6: if a
 * projected joint does not land on the joint the user sees, the convention
 * above is wrong and the ghost makes that visible immediately.
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

/**
 * Has the camera moved out from under a committed stroke?
 *
 * Compared on the C6 block itself rather than on three's camera object, so the
 * test is on exactly the numbers that were sent — a re-derived but identical
 * pose reads as "not moved" even after a matrix rebuild. A true means the
 * stroke must be discarded, never re-interpreted: there is no correct way to
 * re-project a 2D line drawn through a different lens.
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
