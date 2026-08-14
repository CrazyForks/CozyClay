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

		// per-slot extras the §8.4 acceptances name explicitly
		if (id === "F1-δ") {
			const d = record.derivation;
			if (typeof d !== "object" || d === null || typeof d.from !== "string" || typeof d.via !== "string") {
				v("F1-DELTA-UNRESOLVED", "F1-δ: no full-image foot observation named and no derivation supplied", id);
			}
		}
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
const yawWorldDeg = (RbodyCam, facing) => {
	// R_ring_body = R_ring_from_cam · rotationFrom(F1-α); forward_ring = R_ring_body · e_forward
	const forward = matVec(R_RING_FROM_CAM, matVec(RbodyCam, facing));
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
	let worst = 0;
	track.verification.handFacingFrameIndex.forEach((f, i) => {
		const yaw = yawWorldDeg(track.data.global_orient_cam[f], track.data.facing_axis);
		worst = Math.max(worst, angDistDeg(yaw, track.verification.handFacingYawDeg[i]));
	});
	return worst;
};
const restYawDeg = (track) =>
	yawWorldDeg(track.data.global_orient_cam[track.verification.restFrameIndex], track.data.facing_axis);
const gammaErrM = (track) => {
	const { windowStartFrameIndex: ws, windowEndFrameIndex: we, annotatedDisplacementM: annotated } = track.verification;
	// §8.3: v_ring[f] = R_ring_from_cam · (F1-γ[f] − F1-γ[f−1]) · sourceFps. Over a
	// window the per-frame velocities telescope to t[we] − t[ws] (sourceFps cancels).
	const integrated = sub(track.data.translation_cam[we], track.data.translation_cam[ws]);
	return norm(sub(integrated, annotated));
};
const worstAnkleErrPx = (track) => {
	let worst = 0;
	track.data.foot_keypoints_crop.forEach((feet, f) => {
		feet.forEach((k, foot) => {
			// F1-δ derivation: full = crop / scale + offset
			worst = Math.max(worst, dist(reprojFull(k, track.data.crop), track.verification.knownAnkleFullImagePx[f][foot]));
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

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
