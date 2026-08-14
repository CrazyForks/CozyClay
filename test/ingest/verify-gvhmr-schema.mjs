/**
 * F1: RawTrack slot contract plus the §8.4 numeric acceptances (plan §13 commit F1).
 *
 * Why this test exists: F1 is the evidence gate for all of Stage B. The pinned
 * RawTrack fixture must name a tensor (dtype/shape/units) or an explicit
 * derivation for every §8.4 slot, and anything unresolved must be escalated
 * with a reason — never guessed. The validator rejects a fixture in which F1-δ
 * is neither named nor derived (the plan's canonical RED), and the §8.3
 * equations are proven against hand-set verification references.
 *
 * What would be circular: comparing the fixture's data to the fixture's data.
 * Every numeric acceptance compares a quantity RECOMPUTED from the fixture's
 * tensors against the fixture's own hand-measured verification references, and
 * every check also runs against a deliberately corrupted fixture that must
 * FAIL — a check that cannot fail on its negative control proves nothing. The
 * sha256 gate runs first, so a tampered fixture fails before any check
 * replays. The fixture files themselves were authored by a throwaway
 * generator (not by this test), and their slot records come from
 * dump-gvhmr.py's own resolver, pinned again by the script's --selftest.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { solveContactHead } from "../../tools/ingest/feasibility/contact-head.mjs";
import { solveLowestFoot } from "../../tools/ingest/feasibility/lowest-foot.mjs";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/rawtrack/${n}`, import.meta.url), "utf8"));
const good = load("rawtrack-good.json");
const negF1d = load("rawtrack-neg-f1d-missing.json");
const negAlpha = load("rawtrack-neg-alpha-yaw.json");
const negBeta = load("rawtrack-neg-beta-rest.json");
const negGamma = load("rawtrack-neg-gamma-velocity.json");
const negDelta = load("rawtrack-neg-delta-ankle.json");
const negEta = load("rawtrack-neg-eta-roundtrip.json");

// canonical form: JSON.stringify of the parsed document minus the sha256 field —
// exactly what dump-gvhmr.py's canonical_json emits, so the same hash pins both
// the operator-written fixture and these synthetic ones.
const canonical = (doc) => {
	const { sha256, ...rest } = doc;
	return JSON.stringify(rest);
};
const sha256Of = (doc) => createHash("sha256").update(canonical(doc)).digest("hex");
// ---------------------------------------------------------------------------
// the negative fixtures: hash-first, then locked to their intended corruption
// ---------------------------------------------------------------------------
// Every negative is replayed by the acceptances below, so its declared sha256 is
// verified here FIRST, exactly as the good fixture's is -- a drifted negative that
// still carries a stale hash must fail before any check replays it. The lock then
// pins each negative to its slot's probe field: apart from the fixture-identity
// metadata (clipId, provenance.command/sourceUrl -- the fixture names itself) and
// the 30-degree baseline yaw at frame 0 that the checked-in negatives inherited
// and no acceptance reads, a negative may differ from the good fixture ONLY in
// the field its slot's acceptance probes. A negative that drifts -- its corruption
// restored, or a different field corrupted -- fails here with the offending path
// named, instead of quietly passing or failing for the wrong reason.

// every differing leaf path between two documents ("sha256" excluded by the caller)
function leafDiffs(a, b, path = "") {
	const out = [];
	if (a === null || b === null || typeof a !== typeof b) {
		if (JSON.stringify(a) !== JSON.stringify(b)) out.push(path);
		return out;
	}
	if (typeof a !== "object") {
		if (a !== b) out.push(path);
		return out;
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		out.push(path);
		return out;
	}
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	for (const k of keys) {
		const p = path ? `${path}.${k}` : k;
		if (!(k in a) || !(k in b)) out.push(p);
		else out.push(...leafDiffs(a[k], b[k], p));
	}
	return out;
}

const NEGATIVE_LOCKS = [
	// [fixture, label, probe field paths the slot's acceptance reads]
	[negAlpha, "neg-alpha", ["data.global_orient_cam"]],
	[negBeta, "neg-beta", ["data.global_orient_cam"]],
	[negGamma, "neg-gamma", ["data.translation_cam"]],
	[negDelta, "neg-delta", ["data.foot_keypoints_crop"]],
	[negEta, "neg-eta", ["slots.F1-η.crop"]],
	[negF1d, "neg-f1d", ["slots.F1-δ"]],
];
const NEG_IDENTITY = new Set(["clipId", "provenance.command", "provenance.sourceUrl"]);
const NEG_BASELINE = "data.global_orient_cam.0"; // the frozen frame-0 yaw (see above)
for (const [neg, label, probe] of NEGATIVE_LOCKS) {
	ok(`sha256: ${label} hashes to its pinned sha256`, sha256Of(neg) === neg.sha256, neg.sha256.slice(0, 12));
	const diffs = leafDiffs(good, neg).filter((p) => p !== "sha256" && !NEG_IDENTITY.has(p));
	const inProbe = (p) => probe.some((pf) => p === pf || p.startsWith(pf + "."));
	ok(
		`${label}: differs from good in its probe field (${probe.join("/")})`,
		diffs.some(inProbe),
	);
	const elsewhere = diffs.filter((p) => !inProbe(p) && p !== NEG_BASELINE && !p.startsWith(NEG_BASELINE + "."));
	ok(
		`${label}: locked to its intended corruption -- no field outside the probe differs`,
		elsewhere.length === 0,
		`offending paths: ${elsewhere.join("; ")}`,
	);
}

const shapeOf = (v) =>
	Array.isArray(v) ? [v.length, ...(Array.isArray(v[0]) ? shapeOf(v[0]) : [])] : null;

// ---------------------------------------------------------------------------
// the validator: every slot is either resolved (tensor + dtype/shape/units) or
// explicitly escalated; F1-δ additionally needs a name or a derivation
// ---------------------------------------------------------------------------

export class RawTrackContractError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "RawTrackContractError";
		this.code = code;
	}
}

const SLOT_ORDER = ["F1-α", "F1-β", "F1-γ", "F1-δ", "F1-ε", "F1-ζ", "F1-η"];
const LATIN = { "F1-α": "ALPHA", "F1-β": "BETA", "F1-γ": "GAMMA", "F1-δ": "DELTA", "F1-ε": "EPSILON", "F1-ζ": "ZETA", "F1-η": "ETA" };
const CROP_FIELDS = ["offsetX", "offsetY", "scale", "cropW", "cropH", "fullW", "fullH"];

export function validateRawTrack(track) {
	// Returns [{code, slot, message}] — empty when the fixture satisfies the
	// §8.4 slot contract. assertRawTrackValid turns the first violation into
	// the named RawTrackContractError the F1 review expects.
	const violations = [];
	const v = (code, message, slot) => violations.push({ code, message, slot });

	if (typeof track !== "object" || track === null || Array.isArray(track)) {
		v("F1-STRUCTURE", "RawTrack must be a JSON object");
		return violations;
	}

	// the hash gate runs first: a tampered fixture must fail before replay
	if (typeof track.sha256 !== "string" || sha256Of(track) !== track.sha256) {
		v("SHA256-MISMATCH", "fixture sha256 does not match the canonical document");
		return violations;
	}

	// structure: schemaVersion, kind, sync keys, and K (RawTrack supplies K
	// only — §8.1 — so the intrinsics are part of the contract shape)
	const k = shapeOf(track.data && track.data.K);
	const structureOk =
		track.schemaVersion === 1 &&
		track.kind === "RawTrack" &&
		typeof track.clipId === "string" &&
		track.clipId.length > 0 &&
		typeof track.fps === "number" &&
		Number.isFinite(track.fps) &&
		track.fps > 0 &&
		Number.isInteger(track.frames) &&
		track.frames > 0 &&
		Array.isArray(track.frameIndex) &&
		track.frameIndex.length === track.frames &&
		track.frameIndex.every((f) => Number.isInteger(f) && f >= 0) &&
		Array.isArray(track.timeS) &&
		track.timeS.length === track.frames &&
		track.timeS.every((t) => typeof t === "number" && Number.isFinite(t)) &&
		k !== null &&
		k.length === 2 &&
		k[0] === 3 &&
		k[1] === 3;
	if (!structureOk) v("F1-STRUCTURE", "schemaVersion/kind/clipId/fps/frames/frameIndex/timeS/K (§8.1) must match the RawTrack shape");

	// provenance: a real run must pin the GVHMR commit, weights sha256, the
	// licence-tracked source and the trim range; synthetic fixtures say so
	const p = track.provenance;
	if (typeof p !== "object" || p === null) {
		v("PROVENANCE-FIELDS", "provenance must be an object");
	} else if (p.synthetic !== true) {
		if (typeof p.gvhmrCommit !== "string" || !/^[0-9a-f]{40}$/.test(p.gvhmrCommit)) {
			v("PROVENANCE-GVHMR-COMMIT", "non-synthetic RawTrack must pin the GVHMR commit (40 hex) in provenance");
		} else if (typeof p.weightsSha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.weightsSha256)) {
			v("PROVENANCE-WEIGHTS-SHA256", "non-synthetic RawTrack must pin the weights sha256 (64 hex) in provenance");
		} else if ([p.sourceUrl, p.licence, p.sourceSha256, p.command].some((x) => typeof x !== "string" || x.length === 0)) {
			v("PROVENANCE-FIELDS", "provenance must carry sourceUrl, licence, sourceSha256 and command");
		} else if (typeof p.trimStartS !== "number" || typeof p.trimEndS !== "number" || p.trimStartS > p.trimEndS) {
			v("PROVENANCE-TRIM", "provenance trimStartS must be <= trimEndS");
		}
	}

	// the seven slots: resolved means named (with dtype/shape/units) or, for
	// F1-δ, an exact derivation; UNRESOLVED means escalated with a reason
	for (const id of SLOT_ORDER) {
		const lat = LATIN[id];
		const record = track.slots && track.slots[id];
		if (typeof record !== "object" || record === null) {
			v(`F1-${lat}-MISSING`, `${id}: slot record absent from the fixture`, id);
			continue;
		}
		if (record.status !== "resolved" && record.status !== "UNRESOLVED") {
			v(`F1-${lat}-STATUS`, `${id}: status must be "resolved" or "UNRESOLVED", got ${JSON.stringify(record.status)}`, id);
			continue;
		}
		if (record.status === "UNRESOLVED") {
			if (typeof record.reason !== "string" || record.reason.length === 0) {
				v(`F1-${lat}-ESCALATION`, `${id}: UNRESOLVED slot must carry a reason (escalation, not silence)`, id);
			}
			continue;
		}

		// F1-η names conventions rather than a tensor
		if (id === "F1-η") {
			const crop = record.crop;
			const cropOk =
				typeof crop === "object" && crop !== null &&
				CROP_FIELDS.every((key) => typeof crop[key] === "number" && Number.isFinite(crop[key]));
			if (
				typeof record.handedness !== "string" || record.handedness.length === 0 ||
				typeof record.upAxis !== "string" || record.upAxis.length === 0 ||
				typeof record.fps !== "number" || !cropOk
			) {
				v("F1-ETA-FIELDS", "F1-η: resolved slot must name handedness, upAxis, fps and the full crop transform", id);
			}
			continue;
		}

		// F1-δ may resolve by name OR by derivation; neither is the canonical
		// rejection (plan §13: "no full-image foot observation named and no
		// derivation supplied")
		const named = typeof record.tensor === "string" && record.tensor.length > 0;
		if (id === "F1-δ" && !named) {
			const d = record.derivation;
			const derived = typeof d === "object" && d !== null && typeof d.from === "string" && typeof d.via === "string";
			if (!derived) {
				v("F1-DELTA-UNRESOLVED", "F1-δ: no full-image foot observation named and no derivation supplied", id);
			}
			continue;
		}
		if (!named) {
			v(`F1-${lat}-FIELDS`, `${id}: resolved slot must name a tensor`, id);
			continue;
		}

		const shapeOk =
			Array.isArray(record.shape) && record.shape.length > 0 &&
			record.shape.every((s) => Number.isInteger(s) && s > 0);
		if (
			typeof record.dtype !== "string" || record.dtype.length === 0 ||
			!shapeOk ||
			typeof record.units !== "string" || record.units.length === 0
		) {
			v(`F1-${lat}-FIELDS`, `${id}: resolved slot must carry dtype, shape and units alongside the tensor`, id);
			continue;
		}

		// per-slot extras the §8.4 acceptances name explicitly. F1-δ's
		// satisfaction was already decided above: a named tensor is sufficient
		// (plan §8.4: "named, or the exact derivation ..."), so there is no
		// derivation requirement here — only a slot that is NEITHER named nor
		// derived is the plan's canonical F1-DELTA-UNRESOLVED.
		if (id === "F1-ε" && (typeof record.convention !== "string" || typeof record.threshold !== "string")) {
			v(`F1-${lat}-CONVENTION`, "F1-ε: resolved slot must state the logit/probability convention and threshold semantics", id);
		}
		if (id === "F1-ζ" && (typeof record.jointOrder !== "string" || typeof record.restBasis !== "string")) {
			v(`F1-${lat}-MODEL`, "F1-ζ: resolved slot must name the joint ordering and rest basis", id);
		}

		// the named tensor must exist in data with the declared shape
		const actual = track.data && track.data[record.tensor];
		if (!Array.isArray(actual)) {
			v(`F1-${lat}-TENSOR-MISMATCH`, `${id}: named tensor ${record.tensor} is absent from data`, id);
		} else {
			const a = shapeOf(actual);
			const s = record.shape;
			if (a === null || a.length !== s.length || !a.every((dim, i) => dim === s[i])) {
				v(`F1-${lat}-TENSOR-MISMATCH`, `${id}: named tensor ${record.tensor} has shape ${JSON.stringify(a)}, declared ${JSON.stringify(s)}`, id);
			}
		}
	}

	return violations;
}

export function assertRawTrackValid(track) {
	const violations = validateRawTrack(track);
	if (violations.length > 0) {
		const first = violations[0];
		throw new RawTrackContractError(first.code, first.message);
	}
}

// ---------------------------------------------------------------------------
// §8.3 equations, exactly as the operator acceptance uses them. RawTrack is
// camera space and carries K only (§8.1); R_ring_from_cam is a FloorFrame
// input, so this harness pins the synthetic camera to identity — the ring
// frame IS the camera frame, and the equation stays the full §8.3 form.
// ---------------------------------------------------------------------------
const R_RING_FROM_CAM = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const matVec = (m, v) => [
	m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
	m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
	m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
// the acceptances read the tensors the SLOT RECORDS name, not hardcoded data
// keys: the §8.4 acceptances must run against any fixture an operator returns,
// whatever candidate tensor resolved the slot. A missing or malformed tensor
// yields Infinity so the acceptance fails loudly instead of crashing.
const slotTensor = (track, id) => {
	const r = track.slots && track.slots[id];
	if (!r || r.status !== "resolved" || typeof r.tensor !== "string") return null;
	return track.data && track.data[r.tensor];
};
// rotationFrom(<F1-α>), the §8.3 step: (F,3,3) matrices directly, (F,3)
// axis-angle through Rodrigues — both shapes the resolver can legitimately name.
const axisAngleToMat = (aa) => {
	const n = Math.hypot(aa[0], aa[1], aa[2]);
	if (n < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	const [x, y, z] = [aa[0] / n, aa[1] / n, aa[2] / n];
	const c = Math.cos(n), s = Math.sin(n), t = 1 - c;
	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
};
const rotOf = (RbodyCam) => (Array.isArray(RbodyCam[0]) ? RbodyCam : axisAngleToMat(RbodyCam));
const yawWorldDeg = (RbodyCam, facing) => {
	// R_ring_body = R_ring_from_cam · rotationFrom(F1-α); forward_ring = R_ring_body · e_forward
	const forward = matVec(R_RING_FROM_CAM, matVec(rotOf(RbodyCam), facing));
	return (Math.atan2(forward[0], forward[2]) * 180) / Math.PI;
};
const angDistDeg = (a, b) => {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
};
const sub = (a, b) => a.map((x, i) => x - b[i]);
const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const reprojFull = (k, crop) => [k[0] / crop.scale + crop.offsetX, k[1] / crop.scale + crop.offsetY];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const worstYawErrDeg = (track) => {
	const alpha = slotTensor(track, "F1-α");
	const facing = slotTensor(track, "F1-β") || (track.data && track.data.facing_axis);
	const v = track.verification;
	if (!alpha || !facing || !v || !Array.isArray(v.handFacingFrameIndex) || !Array.isArray(v.handFacingYawDeg)) return Infinity;
	let worst = 0;
	for (let i = 0; i < v.handFacingFrameIndex.length; i += 1) {
		const f = v.handFacingFrameIndex[i];
		if (!Array.isArray(alpha[f])) return Infinity;
		const yaw = yawWorldDeg(alpha[f], facing);
		worst = Math.max(worst, angDistDeg(yaw, v.handFacingYawDeg[i]));
	}
	return worst;
};
const restYawDeg = (track) => {
	const alpha = slotTensor(track, "F1-α");
	const facing = slotTensor(track, "F1-β") || (track.data && track.data.facing_axis);
	const v = track.verification;
	if (!alpha || !facing || !v || !Number.isInteger(v.restFrameIndex) || !Array.isArray(alpha[v.restFrameIndex])) return Infinity;
	return yawWorldDeg(alpha[v.restFrameIndex], facing);
};
const gammaErrM = (track) => {
	const gamma = slotTensor(track, "F1-γ");
	const v = track.verification;
	if (!gamma || !v || !Number.isInteger(v.windowStartFrameIndex) || !Number.isInteger(v.windowEndFrameIndex)) return Infinity;
	const { windowStartFrameIndex: ws, windowEndFrameIndex: we, annotatedDisplacementM: annotated } = v;
	// §8.3: v_ring[f] = R_ring_from_cam · (F1-γ[f] − F1-γ[f−1]) · sourceFps. Over a
	// window the per-frame velocities telescope to t[we] − t[ws] (sourceFps cancels).
	if (!Array.isArray(gamma[ws]) || !Array.isArray(gamma[we]) || !Array.isArray(annotated) || annotated.length !== 3) return Infinity;
	const integrated = sub(gamma[we], gamma[ws]);
	return norm(sub(integrated, annotated));
};
const worstAnkleErrPx = (track) => {
	const delta = track.slots && track.slots["F1-δ"];
	const tensor = slotTensor(track, "F1-δ");
	const v = track.verification;
	if (!delta || !tensor || !v || !Array.isArray(v.knownAnkleFullImagePx)) return Infinity;
	const crop = track.data && track.data.crop;
	let worst = 0;
	tensor.forEach((feet, f) => {
		feet.forEach((k, foot) => {
			// F1-δ: named full-image [u, v] columns, or the derivation
			// full = crop / scale + offset
			if (!Array.isArray(k) || k.length < 2 || !Array.isArray(v.knownAnkleFullImagePx[f]) || !Array.isArray(v.knownAnkleFullImagePx[f][foot])) {
				worst = Infinity;
				return;
			}
			const full = delta.derivation && crop ? reprojFull(k, crop) : [k[0], k[1]];
			worst = Math.max(worst, dist(full, v.knownAnkleFullImagePx[f][foot]));
		});
	});
	return worst;
};

// ---- F1-δ contract gate: the plan's canonical RED --------------------------
// A fixture that names no full-image foot observation and supplies no
// derivation must be REJECTED with a named error, before anything else replays.
const throwsWith = (fn, code) => {
	try {
		fn();
	} catch (e) {
		return e instanceof RawTrackContractError && e.code === code
			? null
			: { name: e && e.name, code: e && e.code, message: e && e.message };
	}
	return { name: "no-throw", code: null, message: "validator accepted the fixture" };
};
const deltaErr = throwsWith(() => assertRawTrackValid(negF1d), "F1-DELTA-UNRESOLVED");
ok(
	"F1-δ: no full-image foot observation named and no derivation supplied -> rejected",
	deltaErr === null,
	deltaErr === null ? "" : `got ${deltaErr.name} (${deltaErr.code}): ${deltaErr.message}`,
);
//
// ---- F1-δ named-only: the §8.4 counterpart of the RED above ---------------
// Plan §8.4 F1-δ row: "named, or the exact derivation from crop-space
// keypoints + the crop transform" — a resolved slot that NAMES a full-image
// foot observation needs no derivation, and must be accepted. dump-gvhmr.py
// produces exactly this form when the output carries a full-image foot tensor
// (rt-dump DMP-full-image-slot); rejecting it would break the operator path.
const namedOnlyDelta = JSON.parse(JSON.stringify(good));
delete namedOnlyDelta.slots["F1-δ"].derivation;
namedOnlyDelta.sha256 = sha256Of(namedOnlyDelta);
const namedOnlyViolations = validateRawTrack(namedOnlyDelta);
ok(
	"F1-δ: named-only (full-image foot observation named, no derivation) is accepted per §8.4",
	namedOnlyViolations.length === 0,
	namedOnlyViolations.length ? `${namedOnlyViolations[0].code}: ${namedOnlyViolations[0].message}` : "",
);
let namedOnlyAccepted = false;
let namedOnlyRejectErr = null;
try {
	assertRawTrackValid(namedOnlyDelta);
	namedOnlyAccepted = true;
} catch (e) {
	namedOnlyRejectErr = e;
}
ok(
	"F1-δ: assertRawTrackValid passes the named-only fixture (no F1-DELTA-UNRESOLVED)",
	namedOnlyAccepted,
	namedOnlyRejectErr ? `got ${namedOnlyRejectErr.name} (${namedOnlyRejectErr.code}): ${namedOnlyRejectErr.message}` : "",
);

// ---- good fixture: gate + one PASS line per §8.4 slot ----------------------
const violations = validateRawTrack(good);
ok("good fixture: zero contract violations", violations.length === 0, violations.length ? violations[0].code : "");

const REQUIRE = {
	"F1-α": ["tensor", "dtype", "shape", "units"],
	"F1-β": ["tensor", "dtype", "shape", "units"],
	"F1-γ": ["tensor", "dtype", "shape", "units"],
	"F1-δ": ["tensor", "dtype", "shape", "units", "derivation"],
	"F1-ε": ["tensor", "dtype", "shape", "units", "convention", "threshold"],
	"F1-ζ": ["tensor", "dtype", "shape", "units", "jointOrder", "restBasis"],
	"F1-η": ["handedness", "upAxis", "fps", "crop"],
};
for (const [id, fields] of Object.entries(REQUIRE)) {
	const r = good.slots[id];
	ok(
		`${id}: resolved with ${fields.join("/")}`,
		r && r.status === "resolved" && fields.every((f) => r[f] !== undefined),
		r && r.status === "resolved" ? "" : JSON.stringify(r),
	);
}
ok(
	"F1-δ: derivation is the exact crop-space keypoints + crop transform recipe",
	good.slots["F1-δ"].derivation &&
		typeof good.slots["F1-δ"].derivation.from === "string" &&
		typeof good.slots["F1-δ"].derivation.via === "string" &&
		good.slots["F1-δ"].derivation.crop === "data.crop",
);
ok("sha256: good fixture hashes to its pinned sha256", sha256Of(good) === good.sha256, good.sha256.slice(0, 12));
ok(
	"structure: schemaVersion/kind/clipId/fps/frames/sync keys/K (§8.1)",
	good.schemaVersion === 1 &&
		good.kind === "RawTrack" &&
		typeof good.clipId === "string" &&
		good.frames === good.frameIndex.length &&
		good.frames === good.timeS.length &&
		good.frameIndex.every((f) => Number.isInteger(f)) &&
		JSON.stringify(shapeOf(good.data.K)) === JSON.stringify([3, 3]),
);
ok(
	"provenance: synthetic fixture carries command/trim/annotation, no hex needed",
	typeof good.provenance.command === "string" &&
		good.provenance.trimStartS <= good.provenance.trimEndS &&
		typeof good.provenance.annotationPath === "string" &&
		good.provenance.synthetic === true,
);

// ---- contract probes: each violation must be a named error -----------------
const clone = (track) => JSON.parse(JSON.stringify(track));
const rehash = (track) => {
	track.sha256 = sha256Of(track);
	return track;
};
const probe = (label, mutate, code) => {
	const m = mutate(clone(good));
	const err = throwsWith(() => assertRawTrackValid(m), code);
	ok(label, err === null, err === null ? "" : `got ${err.name} (${err.code}): ${err.message}`);
};

// a resolved slot must carry dtype/shape/units — units are what F1-γ's
// acceptance names explicitly ("named + units")
probe("F1-γ without units rejected", (m) => { delete m.slots["F1-γ"].units; return rehash(m); }, "F1-GAMMA-FIELDS");
// an UNRESOLVED slot must escalate with a reason, not stay silent
probe("F1-ε UNRESOLVED without a reason rejected", (m) => { Object.assign(m.slots["F1-ε"], { status: "UNRESOLVED" }); return rehash(m); }, "F1-EPSILON-ESCALATION");
// a missing slot is a contract violation, not an oversight
probe("F1-ζ absent rejected", (m) => { delete m.slots["F1-ζ"]; return rehash(m); }, "F1-ZETA-MISSING");
// the named tensor must actually exist in data with the declared shape
probe("F1-γ tensor shape mismatch rejected", (m) => { m.data.translation_cam = m.data.translation_cam.slice(0, -1); return rehash(m); }, "F1-GAMMA-TENSOR-MISMATCH");
// a tampered hash fails at the gate before any check replays
probe("tampered sha256 rejected", (m) => { m.sha256 = "0".repeat(64); return m; }, "SHA256-MISMATCH");
// real (non-synthetic) output must pin the GVHMR commit and weights sha256
probe("non-synthetic provenance without gvhmrCommit rejected", (m) => { m.provenance.synthetic = false; return rehash(m); }, "PROVENANCE-GVHMR-COMMIT");

// ---- numeric acceptances (good) and negative controls (must FAIL) ----------
const alphaErr = worstYawErrDeg(good);
ok("F1-α: §8.3 yaw reproduces the hand-measured facing on 10 sampled frames within 5°", alphaErr <= 5, `worst deviation ${alphaErr.toFixed(4)}°`);
ok("NEG F1-α: yaw check fails on the 12°-corrupted fixture", worstYawErrDeg(negAlpha) > 5, `worst deviation ${worstYawErrDeg(negAlpha).toFixed(2)}°`);

const betaErr = restYawDeg(good);
ok("F1-β: neutral rest pose yields yawWorld = 0 within 2°", Math.abs(betaErr) <= 2, `yawWorld(rest) = ${betaErr.toFixed(4)}°`);
ok("NEG F1-β: rest check fails on the 5°-rotated rest pose", Math.abs(restYawDeg(negBeta)) > 2, `yawWorld(rest) = ${restYawDeg(negBeta).toFixed(2)}°`);

const gammaErr = gammaErrM(good);
ok("F1-γ: §8.3 velocity integrates to the annotated displacement over the 20-frame window within 5 cm", gammaErr <= 0.05, `|∫v − annotated| = ${gammaErr.toFixed(4)} m`);
ok("NEG F1-γ: velocity check fails on the 8 cm-off fixture", gammaErrM(negGamma) > 0.05, `|∫v − annotated| = ${gammaErrM(negGamma).toFixed(3)} m`);

const ankleErr = worstAnkleErrPx(good);
ok("F1-δ: reprojected ankle lands within 3 px of the known full-image ankle", ankleErr <= 3, `worst ${ankleErr.toFixed(4)} px`);
ok("NEG F1-δ: ankle check fails on the 10 px-shifted crop keypoints", worstAnkleErrPx(negDelta) > 3, `worst ${worstAnkleErrPx(negDelta).toFixed(2)} px (5 px full-image)`);

const etaCrop = good.slots["F1-η"].crop;
const etaRoundTrip = CROP_FIELDS.every((k) => etaCrop[k] === good.data.crop[k]);
ok("F1-η: named crop transform equals the data crop (round-trip)", etaRoundTrip);
ok(
	"F1-η: fps round-trip — timeS = frameIndex / fps",
	good.timeS.every((t, f) => Math.abs(t - good.frameIndex[f] / good.fps) < 1e-9),
);
ok(
	"F1-η: handedness/up-axis named and consistent with the data",
	good.slots["F1-η"].handedness === good.data.handedness &&
		good.slots["F1-η"].upAxis === good.data.upAxis &&
		good.slots["F1-η"].fps === good.fps,
);
const negEtaRoundTrip = CROP_FIELDS.every((k) => negEta.slots["F1-η"].crop[k] === negEta.data.crop[k]);
ok("NEG F1-η: round-trip fails when the named crop scale disagrees with data", !negEtaRoundTrip, `named scale ${negEta.slots["F1-η"].crop.scale} vs data scale ${negEta.data.crop.scale}`);

// F1-ζ's numeric acceptance (cskel27 FK parity on the real model) is an
// operator-side check that needs the actual body model — it cannot run on a
// synthetic fixture, and the contract above is all that is checkable here.

// ---- the operator tool itself ----------------------------------------------
// the slot-resolution logic lives in dump-gvhmr.py and is unit-tested by its
// own --selftest (numpy-free), which also re-pins the fixture's hash and slot
// records; a missing input directory must fail cleanly with a useful message.
const PY = fileURLToPath(new URL("../../tools/ingest/dump-gvhmr.py", import.meta.url));
const py = (args) => spawnSync("python3", [PY, ...args], { encoding: "utf8" });

const selftest = py(["--selftest"]);
ok(
	"dump-gvhmr.py --selftest green (slot resolution unit tests + fixture drift guard)",
	selftest.status === 0,
	selftest.status === 0
		? selftest.stdout.trim().split("\n").slice(-1)[0]
		: `exit ${selftest.status}: ${(selftest.stdout + selftest.stderr).slice(-300)}`,
);

const missing = py([
	"--input", "/nonexistent/cozyclay-gvhmr-out",
	"--output", "/tmp/ccm-rawtrack-x.json",
	"--clip-id", "x",
	"--source-url", "https://example.invalid/x.webm",
	"--licence", "CC0-1.0",
	"--source-sha256", "0".repeat(64),
	"--gvhmr-commit", "0".repeat(40),
	"--weights-sha256", "0".repeat(64),
]);
ok(
	"dump-gvhmr.py fails cleanly with a useful message on a missing input directory",
	missing.status !== 0 && /does not exist/.test(missing.stderr),
	`exit ${missing.status}: ${missing.stderr.trim()}`,
);
// ---------------------------------------------------------------------------
// the operator path (A2): this file accepts an operator fixture explicitly --
// RAWTRACK_FIXTURE env var or a positional argv path -- and runs the FULL §8.4
// slot contract plus the numeric acceptances against it. The default (no
// argument) stays the synthetic set, so CI is unchanged.
// ---------------------------------------------------------------------------
const OPERATOR_PATH = process.env.RAWTRACK_FIXTURE || process.argv[2];
if (OPERATOR_PATH) {
	const op = JSON.parse(readFileSync(OPERATOR_PATH, "utf8"));
	const label = "operator fixture";
	ok(`${label}: sha256 gate`, sha256Of(op) === op.sha256, op.sha256 ? op.sha256.slice(0, 12) : "no sha256 field");
	const opViolations = validateRawTrack(op);
	ok(`${label}: zero contract violations (§8.4 slot contract)`, opViolations.length === 0, opViolations.length ? opViolations[0].code : "");
	// every slot is either resolved with its §8.4 fields or escalated with a reason
	for (const [id, fields] of Object.entries(REQUIRE)) {
		const r = op.slots && op.slots[id];
		ok(
			`${label}: ${id} carries its §8.4 fields (or escalates with a reason)`,
			r && (r.status === "resolved" ? fields.every((f) => r[f] !== undefined) : typeof r.reason === "string" && r.reason.length > 0),
			r ? "" : "slot record absent",
		);
	}
	// the numeric acceptances need the §6 hand-measured verification block
	const v = op.verification;
	const hasVerification =
		v &&
		Array.isArray(v.handFacingFrameIndex) && Array.isArray(v.handFacingYawDeg) &&
		Number.isInteger(v.restFrameIndex) &&
		Number.isInteger(v.windowStartFrameIndex) && Number.isInteger(v.windowEndFrameIndex) &&
		Array.isArray(v.annotatedDisplacementM) && Array.isArray(v.knownAnkleFullImagePx);
	ok(`${label}: carries the §6 hand-measured verification block`, hasVerification, hasVerification ? "" : "verification missing or incomplete");
	const acceptance = (id, run) => {
		const r = op.slots && op.slots[id];
		if (r && r.status === "resolved") run();
		else ok(`${label}: ${id} numeric acceptance not run (slot escalated per §7)`, true);
	};
	if (hasVerification) {
		acceptance("F1-α", () => {
			const e = worstYawErrDeg(op);
			ok(`${label}: F1-α §8.3 yaw reproduces the hand-measured facing within 5°`, e <= 5, `worst deviation ${e.toFixed(4)}°`);
		});
		acceptance("F1-β", () => {
			const e = restYawDeg(op);
			ok(`${label}: F1-β neutral rest pose yields yawWorld = 0 within 2°`, Math.abs(e) <= 2, `yawWorld(rest) = ${e.toFixed(4)}°`);
		});
		acceptance("F1-γ", () => {
			const e = gammaErrM(op);
			ok(`${label}: F1-γ velocity integrates to the annotated displacement within 5 cm`, e <= 0.05, `|∫v − annotated| = ${e.toFixed(4)} m`);
		});
		acceptance("F1-δ", () => {
			const e = worstAnkleErrPx(op);
			ok(`${label}: F1-δ reprojected ankle lands within 3 px`, e <= 3, `worst ${e.toFixed(4)} px`);
		});
		acceptance("F1-η", () => {
			const etaC = op.slots["F1-η"].crop;
			ok(`${label}: F1-η named crop equals the data crop (round-trip)`, CROP_FIELDS.every((k) => etaC[k] === op.data.crop[k]), "");
			ok(`${label}: F1-η fps round-trip — timeS = frameIndex / fps`, op.timeS.every((t, f) => Math.abs(t - op.frameIndex[f] / op.fps) < 1e-9), "");
			ok(`${label}: F1-η handedness/up-axis/fps consistent with the data`, op.slots["F1-η"].handedness === op.data.handedness && op.slots["F1-η"].upAxis === op.data.upAxis && op.slots["F1-η"].fps === op.fps, "");
		});
	}
}

// ---------------------------------------------------------------------------
// the round trip (A1): an artifact produced the way dump-gvhmr.py produces one
// must be consumable by the F2 feasibility runners. rawtrack-dump-roundtrip.json
// IS dump emission (the script's own _build_document path — see the fixture's
// provenance), so solving it with the plan's camera must recover the scene's
// planted foot: single fighter, LEFT foot planted at (0.5, 0, 0.2) ring metres,
// right foot lifted 0.15 m; plan 9.1 camera centre (0, 2.6, -7.5), look-at
// (0, 0, 0.6), up (0, 1, 0); K = [[1200,0,960],[0,1200,540],[0,0,1]]; floorY = 0.
// ---------------------------------------------------------------------------
const rtFixture = load("rawtrack-dump-roundtrip.json");
const RT = {
	cameraCentre: [0, 2.6, -7.5],
	cameraLookAt: [0, 0, 0.6],
	cameraUp: [0, 1, 0],
	floorY: 0,
	plantedLeft: [0.5, 0, 0.2],
	liftedRight: [0.3, 0.15, 0.0],
};
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize3 = (v) => {
	const n = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / n, v[1] / n, v[2] / n];
};
const cross3 = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const lookAtExtrinsics = (centre, lookAt, up) => {
	// the same convention as make-synthetic.mjs: camera z forward, x image-right,
	// y image-down; R columns are the camera axes in ring coordinates
	const z = normalize3(sub3(lookAt, centre));
	const x = normalize3(cross3(up, z));
	const y = cross3(x, z);
	return { R: [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]], t: centre };
};
const rtCam = lookAtExtrinsics(RT.cameraCentre, RT.cameraLookAt, RT.cameraUp);
const rtFloorFrame = { R_ring_from_cam: rtCam.R, t_ring_from_cam: rtCam.t, floorY: RT.floorY };
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
ok("round trip: the dump-shaped fixture is sha256-pinned", sha256Of(rtFixture) === rtFixture.sha256, rtFixture.sha256.slice(0, 12));
ok(
	"round trip: the dump-shaped fixture is decimated + trimmed (11 frames [6..26])",
	rtFixture.frames === 11 && JSON.stringify(rtFixture.frameIndex) === JSON.stringify([6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26]),
	JSON.stringify(rtFixture.frameIndex),
);
for (const [mode, runner] of [["contact-head", solveContactHead], ["lowest-foot", solveLowestFoot]]) {
	const out = runner(rtFixture, rtFloorFrame);
	const roots = out.subjects[0].rootWorld;
	const worst = Math.max(...roots.map((p) => dist3(p, RT.plantedLeft)));
	const offFloor = Math.max(...roots.map((p) => Math.abs(p[1] - RT.floorY)));
	const onPlantedFoot = roots.every((p) => dist3(p, RT.plantedLeft) < dist3(p, RT.liftedRight));
	ok(
		`round trip: ${mode} consumes the dump artifact and solves the planted foot on all ${rtFixture.frames} emitted frames`,
		roots.length === rtFixture.frames && worst < 1e-4 && offFloor < 1e-9 && onPlantedFoot,
		`worst ${worst.toExponential(3)} m, off floor ${offFloor.toExponential(3)} m`,
	);
}

// ---------------------------------------------------------------------------
// the decimated round trip (A3): build a synthetic GVHMR output, run the dump's
// emission path with stride > 1 AND a trim range, and prove the emitted
// artifact passes the contract validator with declared shapes equal to the
// emitted lengths. The dump is spawned with the same numpy-free stand-ins its
// own --selftest uses, so no numpy is needed on this workstation.
// ---------------------------------------------------------------------------
const A3_SCRIPT = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("dump_gvhmr", ${JSON.stringify(PY)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Fake:
    def __init__(self, v):
        self._v = v
    def __getitem__(self, k):
        return Fake(self._v[k]) if isinstance(k, slice) else self._v[k]
    def tolist(self):
        return self._v

def tensor(shape, leaf):
    def fill(s):
        if not s:
            return leaf()
        return [fill(s[1:]) for _ in range(s[0])]
    return {"dtype": "float32", "shape": list(shape), "itemsize": 4, "array": Fake(fill(shape))}

crop = {"offsetX": 800, "offsetY": 400, "scale": 2, "cropW": 640, "cropH": 360, "fullW": 1920, "fullH": 1080}
artifacts = {
    "global_orient_cam": tensor([30, 3, 3], lambda: 0.0),
    "translation_cam": tensor([30, 3], lambda: 0.0),
    "foot_keypoints_crop": tensor([30, 2, 3], lambda: 1.0),
    "foot_contact_logits": tensor([30, 2], lambda: 2.6),
    "body_pose_smpl": tensor([30, 24, 3], lambda: 0.0),
}
meta = {"fps": 29.97, "crop": crop, "model": "smpl", "K": [[1200, 0, 960], [0, 1200, 540], [0, 0, 1]]}
args = m.argparse.Namespace(clip_id="a3-regen", trim_start=0.2, trim_end=0.9, max_bytes=9000,
    source_url="urn:a3", licence="CC0-1.0", source_sha256="0" * 64, gvhmr_commit="0" * 40,
    weights_sha256="0" * 64, annotation_path="a3-annotation.json")
doc, _ = m._build_document(args, artifacts, meta)
print(json.dumps(m._normalize_numbers(doc), separators=(",", ":")))
`;
const a3 = spawnSync("python3", ["-"], { input: A3_SCRIPT, encoding: "utf8" });
ok("A3: the dump's emission path runs on a synthetic trimmed + decimated output", a3.status === 0, a3.status === 0 ? "" : a3.stderr.slice(-300));
if (a3.status === 0) {
	const emitted = JSON.parse(a3.stdout);
	ok(
		"A3: stride 2 decimation + trim emit 11 frames [6..26]",
		emitted.frames === 11 && JSON.stringify(emitted.frameIndex) === JSON.stringify([6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26]),
		JSON.stringify(emitted.frameIndex),
	);
	const v3 = validateRawTrack(emitted);
	ok("A3: the decimated + trimmed dump passes the contract validator", v3.length === 0, v3.length ? v3[0].code : "");
	const slotByTensor = Object.fromEntries(
		Object.entries(emitted.slots).map(([id, r]) => [r.tensor, id]).filter(([t]) => t),
	);
	const shapesMatch = Object.entries(slotByTensor).every(([t, id]) => {
		const declared = emitted.slots[id].shape;
		const actual = shapeOf(emitted.data[t]);
		return declared.length === actual.length && declared.every((dim, i) => dim === actual[i]);
	});
	ok("A3: every declared shape equals the emitted tensor length", shapesMatch, "");
	ok(
		"A3: top-level K equals data.K and subjects align with the emitted frames",
		JSON.stringify(emitted.K) === JSON.stringify(emitted.data.K) &&
			emitted.subjects.length === 1 &&
			emitted.subjects[0].footObservations2d.left.keypoints.length === 11 &&
			emitted.subjects[0].footObservations2d.right.keypoints.length === 11 &&
			emitted.subjects[0].leftContact.length === 11 &&
			emitted.subjects[0].rightContact.length === 11,
		"",
	);
}
//
// ---------------------------------------------------------------------------
// the named-only F1-δ operator path (A4): an output whose full-image foot
// tensor resolves F1-δ by NAME (no crop derivation — plan §8.4: "named, or
// the exact derivation") must emit a fixture the contract validator accepts.
// This is the exact B1 regression: dump-gvhmr.py emits this form for
// foot_2d_full, and the validator used to reject it with F1-DELTA-UNRESOLVED.
// ---------------------------------------------------------------------------
const A4_SCRIPT = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("dump_gvhmr", ${JSON.stringify(PY)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Fake:
    def __init__(self, v):
        self._v = v
    def __getitem__(self, k):
        return Fake(self._v[k]) if isinstance(k, slice) else self._v[k]
    def tolist(self):
        return self._v

def tensor(shape, leaf):
    def fill(s):
        if not s:
            return leaf()
        return [fill(s[1:]) for _ in range(s[0])]
    return {"dtype": "float32", "shape": list(shape), "itemsize": 4, "array": Fake(fill(shape))}

crop = {"offsetX": 800, "offsetY": 400, "scale": 2, "cropW": 640, "cropH": 360, "fullW": 1920, "fullH": 1080}
artifacts = {
    "global_orient_cam": tensor([30, 3, 3], lambda: 0.0),
    "translation_cam": tensor([30, 3], lambda: 0.0),
    "foot_2d_full": tensor([30, 2, 2], lambda: 1.0),
    "foot_contact_logits": tensor([30, 2], lambda: 2.6),
    "body_pose_smpl": tensor([30, 24, 3], lambda: 0.0),
}
meta = {"fps": 29.97, "crop": crop, "model": "smpl", "K": [[1200, 0, 960], [0, 1200, 540], [0, 0, 1]]}
args = m.argparse.Namespace(clip_id="a4-regen", trim_start=0.2, trim_end=0.9, max_bytes=9000,
    source_url="urn:a4", licence="CC0-1.0", source_sha256="0" * 64, gvhmr_commit="0" * 40,
    weights_sha256="0" * 64, annotation_path="a4-annotation.json")
doc, _ = m._build_document(args, artifacts, meta)
print(json.dumps(m._normalize_numbers(doc), separators=(",", ":")))
`;
const a4 = spawnSync("python3", ["-"], { input: A4_SCRIPT, encoding: "utf8" });
ok("A4: the dump's emission path runs on a full-image named-only output", a4.status === 0, a4.status === 0 ? "" : a4.stderr.slice(-300));
if (a4.status === 0) {
	const namedEmitted = JSON.parse(a4.stdout);
	const namedDelta4 = namedEmitted.slots["F1-δ"];
	ok(
		"A4: F1-δ resolves named-only (no derivation) for a full-image foot tensor",
		namedDelta4.status === "resolved" &&
			namedDelta4.tensor === "foot_2d_full" &&
			namedDelta4.derivation === undefined,
		JSON.stringify(namedDelta4),
	);
	const v4 = validateRawTrack(namedEmitted);
	ok(
		"A4: the named-only F1-δ fixture passes the contract validator (B1 closed)",
		v4.length === 0,
		v4.length ? `${v4[0].code}: ${v4[0].message}` : "",
	);
	ok(
		"A4: all seven slots resolve and subjects carry per-frame observations",
		Object.values(namedEmitted.slots).every((r) => r.status === "resolved") &&
			namedEmitted.subjects.length === 1 &&
			namedEmitted.subjects[0].footObservations2d.left.keypoints[0][0] === 1.0,
		`subjects=${namedEmitted.subjects.length}`,
	);
}

// ---------------------------------------------------------------------------
// the operator path is a real invocation: re-run this file with the fixture as
// an explicit argv path and assert the same §8.4 checks execute on it. Guarded
// so the child run (which carries the fixture arg) does not recurse.
// ---------------------------------------------------------------------------
if (!OPERATOR_PATH) {
	const rtPath = fileURLToPath(new URL("./fixtures/rawtrack/rawtrack-dump-roundtrip.json", import.meta.url));
	const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), rtPath], { encoding: "utf8" });
	const expectedLines = [
		"operator fixture: sha256 gate",
		"operator fixture: zero contract violations",
		"operator fixture: F1-α §8.3 yaw reproduces the hand-measured facing within 5°",
		"operator fixture: F1-β neutral rest pose yields yawWorld = 0 within 2°",
		"operator fixture: F1-γ velocity integrates to the annotated displacement within 5 cm",
		"operator fixture: F1-δ reprojected ankle lands within 3 px",
		"operator fixture: F1-η named crop equals the data crop (round-trip)",
	];
	ok(
		"operator path: verify-gvhmr-schema.mjs <fixture> runs the full §8.4 contract on the supplied fixture and exits 0",
		child.status === 0 && expectedLines.every((line) => child.stdout.includes(line)),
		child.status === 0 ? "" : `exit ${child.status}: ${(child.stdout + child.stderr).slice(-300)}`,
	);
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
