// The §5 schema contracts as executable validators (plan §13 commit C1).
//
// Why validators live here at all: every artifact that crosses the ingest
// boundary — the provider manifest, RawTrack, FloorFrame and the TakePayload
// — is a contract document, and a contract written only in prose is a
// contract that drifts. These are the child-side executable form of plan §5
// and §8.1; the parent-side publish door (src/surface-host.js
// validateTakePayload) enforces the same TakePayload contract, and
// verify-contracts.mjs asserts the two never diverge.
//
// Rejections are named: throw new Error("<kebab-code>"), matching the parent
// door's code style, so a caller can map a rejection to a status without
// parsing prose. The first failing clause wins; nothing is read past it, and
// no validator may crash on malformed input — a crash is not a rejection.
//
// The license block is the one place a document is CLOSED to extra fields:
// an uninterpreted license field could hide redistribution terms, which is
// exactly the hazard C1 exists to stop (plan §14.2 DoD 11: every manifest
// redistributable:false). RawTrack/FloorFrame/TakePayload accept extra
// fixture metadata (clipId, sha256, synthetic flags) because those fields
// are additive process facts, not license posture.

// §12.3: artifact fields are PATHS, never origin-qualified URLs; the parent
// door validates against the identical pattern.
const ARTIFACT_PATH = /^\/ingest\/artifacts\/[0-9a-f]{32}\/[a-z0-9_-]{1,32}$/;
// The §5 provenance block a complete take must carry — the same list the
// parent door (src/surface-host.js) checks, so both sides name the same
// contract.
const PROVENANCE_KEYS = ["command", "sourceUrl", "licence", "sourceSha256", "trimStartS", "trimEndS", "gvhmrCommit", "weightsSha256", "annotationPath"];
// An operator run pins gvhmrCommit/weightsSha256 (plan §10.2); a SYNTHETIC
// fixture declares synthetic:true and legitimately omits them because no
// operator run happened. Everything else is required either way.
const OPERATOR_ONLY_KEYS = ["gvhmrCommit", "weightsSha256"];
// §8.1: the license block is exactly these five fields.
const LICENSE_KEYS = ["spdx", "commercialUse", "redistributable", "source", "note"];

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isHex64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isStringNonEmpty = (v) => typeof v === "string" && v.length > 0;

// K is the full-image intrinsics matrix: 3x3, upper-triangular (skew zero),
// positive focal lengths and a principal point inside the image. A K that
// fails any of these cannot map pixels to rays (§8.2) and must not be
// consumed downstream.
function isIntrinsics(v) {
	if (!Array.isArray(v) || v.length !== 3) return false;
	for (let i = 0; i < 3; i++) {
		if (!Array.isArray(v[i]) || v[i].length !== 3) return false;
		for (let j = 0; j < 3; j++) if (!isFiniteNumber(v[i][j])) return false;
		if (v[i][0] !== 0 && i !== 0) return false; // upper-triangular: v[1][0] and v[2][0] must be 0
	}
	return v[0][0] > 0 && v[1][1] > 0 && v[0][2] > 0 && v[1][2] > 0 && v[2][2] === 1;
}

export function validateProviderManifest(manifest) {
	if (manifest === null || typeof manifest !== "object") throw new Error("manifest-not-object");
	if (!isStringNonEmpty(manifest.providerId)) throw new Error("provider-id-missing");
	if (!isPositiveInt(manifest.schemaVersion)) throw new Error("schema-version-invalid");
	const license = manifest.license;
	if (license === null || typeof license !== "object") throw new Error("license-incomplete");
	// The block is closed: an unknown field could hide terms no validator
	// interprets, which is precisely the licensing hazard C1 stops.
	for (const key of Object.keys(license)) if (!LICENSE_KEYS.includes(key)) throw new Error("license-unknown-field");
	for (const key of LICENSE_KEYS) {
		const v = license[key];
		const okType =
			key === "commercialUse" || key === "redistributable"
				? typeof v === "boolean"
				: key === "note"
					? typeof v === "string"
					: isStringNonEmpty(v);
		if (!okType) throw new Error("license-incomplete");
	}
	if (typeof manifest.weightsBundled !== "boolean") throw new Error("license-weights-bundled");
	// The two MUST-be-false fields are checked last and each gets its own
	// code, so the canonical C1 defect names itself: license-redistributable.
	if (license.redistributable !== false) throw new Error("license-redistributable");
	if (manifest.weightsBundled !== false) throw new Error("license-weights-bundled");
	return manifest;
}

export function validateRawTrack(rawTrack) {
	if (rawTrack === null || typeof rawTrack !== "object") throw new Error("rawtrack-not-object");
	if (!isPositiveInt(rawTrack.schemaVersion)) throw new Error("rawtrack-schema-version");
	if (rawTrack.kind !== undefined && rawTrack.kind !== "RawTrack") throw new Error("rawtrack-kind");
	if (!isStringNonEmpty(rawTrack.clipId)) throw new Error("rawtrack-clip-id");
	if (!isFiniteNumber(rawTrack.fps) || rawTrack.fps <= 0) throw new Error("rawtrack-fps");
	if (!isPositiveInt(rawTrack.frames)) throw new Error("rawtrack-frames");
	// §5: frameIndex (source frame numbers) and timeS (seconds from take
	// start) are the synchronization keys — both must align with `frames`,
	// or every downstream per-frame tensor reads at the wrong offset.
	if (!Array.isArray(rawTrack.frameIndex) || rawTrack.frameIndex.length !== rawTrack.frames) throw new Error("rawtrack-frame-index");
	for (let i = 0; i < rawTrack.frameIndex.length; i++) {
		if (!Number.isInteger(rawTrack.frameIndex[i]) || rawTrack.frameIndex[i] < 0) throw new Error("rawtrack-frame-index");
		if (i > 0 && rawTrack.frameIndex[i] <= rawTrack.frameIndex[i - 1]) throw new Error("rawtrack-frame-index");
	}
	if (!Array.isArray(rawTrack.timeS) || rawTrack.timeS.length !== rawTrack.frames) throw new Error("rawtrack-time");
	if (rawTrack.timeS[0] !== 0) throw new Error("rawtrack-time");
	for (let i = 0; i < rawTrack.timeS.length; i++) {
		if (!isFiniteNumber(rawTrack.timeS[i]) || rawTrack.timeS[i] < 0) throw new Error("rawtrack-time");
		if (i > 0 && rawTrack.timeS[i] < rawTrack.timeS[i - 1]) throw new Error("rawtrack-time");
	}
	if (rawTrack.K !== undefined && !isIntrinsics(rawTrack.K)) throw new Error("rawtrack-k");
	// §8.1: "RawTrack supplies K only; R,t come from FloorFrame." A RawTrack
	// carrying R/t creates two suppliers for the same quantity — the failure
	// mode that forks coordinate systems — so it is rejected by name.
	if (rawTrack.R_ring_from_cam !== undefined || rawTrack.t_ring_from_cam !== undefined) throw new Error("rawtrack-carries-rt");
	if (rawTrack.subjects !== undefined) {
		if (!Array.isArray(rawTrack.subjects)) throw new Error("rawtrack-subjects");
		for (const subject of rawTrack.subjects) {
			if (subject === null || typeof subject !== "object" || !isStringNonEmpty(subject.trackId)) throw new Error("rawtrack-subjects");
			if (subject.footObservations2d === null || typeof subject.footObservations2d !== "object") throw new Error("rawtrack-subjects");
			for (const side of ["left", "right"]) {
				const foot = subject.footObservations2d[side];
				// The foot field is the guard against a swapped left/right
				// projection, which would poison contact and foot placement.
				if (foot === null || typeof foot !== "object" || foot.foot !== side || foot.observationSpace !== "full-image") throw new Error("rawtrack-subjects");
				if (!Array.isArray(foot.keypoints) || foot.keypoints.length !== rawTrack.frames) throw new Error("rawtrack-subjects");
				for (const kp of foot.keypoints) {
					if (!Array.isArray(kp) || kp.length !== 2 || !isFiniteNumber(kp[0]) || !isFiniteNumber(kp[1])) throw new Error("rawtrack-subjects");
				}
			}
			for (const key of ["leftContact", "rightContact"]) {
				if (!Array.isArray(subject[key]) || subject[key].length !== rawTrack.frames) throw new Error("rawtrack-subjects");
				for (const p of subject[key]) if (!isFiniteNumber(p) || p < 0 || p > 1) throw new Error("rawtrack-subjects");
			}
			if (subject.confidence !== undefined) {
				if (!Array.isArray(subject.confidence) || subject.confidence.length !== rawTrack.frames) throw new Error("rawtrack-subjects");
				for (const c of subject.confidence) if (!isFiniteNumber(c) || c < 0 || c > 1) throw new Error("rawtrack-subjects");
			}
		}
	}
	if (rawTrack.provenance !== undefined) {
		if (rawTrack.provenance === null || typeof rawTrack.provenance !== "object") throw new Error("rawtrack-provenance");
		if (rawTrack.provenance.synthetic !== undefined && typeof rawTrack.provenance.synthetic !== "boolean") throw new Error("rawtrack-provenance");
		const required = rawTrack.provenance.synthetic === true ? PROVENANCE_KEYS.filter((k) => !OPERATOR_ONLY_KEYS.includes(k)) : PROVENANCE_KEYS;
		for (const key of required) if (rawTrack.provenance[key] === undefined) throw new Error("rawtrack-provenance");
	}
	if (!isHex64(rawTrack.sha256)) throw new Error("rawtrack-sha256");
	return rawTrack;
}

export function validateFloorFrame(floorFrame) {
	if (floorFrame === null || typeof floorFrame !== "object") throw new Error("floorframe-not-object");
	if (!isPositiveInt(floorFrame.schemaVersion)) throw new Error("floorframe-schema-version");
	if (!isIntrinsics(floorFrame.K)) throw new Error("floorframe-k");
	// R_ring_from_cam is a rotation by name: a non-orthonormal R distorts
	// every ray §8.2 rotates, so it must fail here, before any consumer.
	const R = floorFrame.R_ring_from_cam;
	if (!Array.isArray(R) || R.length !== 3) throw new Error("floorframe-rotation");
	for (let i = 0; i < 3; i++) {
		if (!Array.isArray(R[i]) || R[i].length !== 3) throw new Error("floorframe-rotation");
		for (let j = 0; j < 3; j++) if (!isFiniteNumber(R[i][j])) throw new Error("floorframe-rotation");
	}
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			let dot = 0;
			for (let k = 0; k < 3; k++) dot += R[k][i] * R[k][j];
			if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-6) throw new Error("floorframe-rotation");
		}
	}
	const t = floorFrame.t_ring_from_cam;
	if (!Array.isArray(t) || t.length !== 3 || !t.every(isFiniteNumber)) throw new Error("floorframe-t");
	// §8.1 pins these as VALUES: the ring frame is Y-up at floor level with
	// metres as the unit, and the direction is encoded in the names
	// (p_ring = R · p_cam + t_ring_from_cam).
	if (floorFrame.floorY !== 0) throw new Error("floorframe-floor-y");
	if (!Array.isArray(floorFrame.planeNormal_ring) || floorFrame.planeNormal_ring.length !== 3) throw new Error("floorframe-plane-normal");
	if (floorFrame.planeNormal_ring[0] !== 0 || floorFrame.planeNormal_ring[1] !== 1 || floorFrame.planeNormal_ring[2] !== 0) throw new Error("floorframe-plane-normal");
	if (floorFrame.metresPerUnit !== 1) throw new Error("floorframe-metres-per-unit");
	const q = floorFrame.quality;
	if (q === null || typeof q !== "object") throw new Error("floorframe-quality");
	const ERROR_FIELDS = ["heldOutErrorM", "uncertainty1SigmaM", "reprojRmsPx", "ropeStraightnessPx"];
	for (const key of ERROR_FIELDS) if (!isFiniteNumber(q[key]) || q[key] < 0) throw new Error("floorframe-quality");
	if (!isFiniteNumber(q.inlierRatio) || q.inlierRatio < 0 || q.inlierRatio > 1) throw new Error("floorframe-quality");
	if (!isFiniteNumber(q.conditionNumber) || q.conditionNumber < 1) throw new Error("floorframe-quality");
	if (floorFrame.clipId !== undefined && !isStringNonEmpty(floorFrame.clipId)) throw new Error("floorframe-clip-id");
	if (floorFrame.sha256 !== undefined && !isHex64(floorFrame.sha256)) throw new Error("floorframe-sha256");
	return floorFrame;
}

export function validateTakePayload(payload) {
	// Mirrors the parent door (src/surface-host.js) clause for clause and
	// code for code: the §5 contract is ONE contract, and verify-contracts.mjs
	// section 5 proves the two sides cannot drift apart.
	if (payload === null || typeof payload !== "object") throw new Error("payload-not-object");
	if (typeof payload.requestId !== "string" || payload.requestId.length === 0) throw new Error("request-id-missing");
	const a = payload.a;
	const b = payload.b;
	if (a === null || typeof a !== "object" || b === null || typeof b !== "object") throw new Error("clips-missing");
	if (a.rotationDeg !== 0 || b.rotationDeg !== 0) throw new Error("rotation-deg-mismatch");
	if (a.fps !== 20 || b.fps !== 20) throw new Error("fps-not-20");
	if (!Number.isInteger(a.frames) || a.frames <= 0 || a.frames !== b.frames) throw new Error("frame-count-mismatch");
	for (const clip of [a, b]) {
		if (clip.provenance === null || typeof clip.provenance !== "object") throw new Error("provenance-incomplete");
		for (const key of PROVENANCE_KEYS) {
			if (clip.provenance[key] === undefined) throw new Error("provenance-incomplete");
		}
		if (typeof clip.artifactPath !== "string" || !ARTIFACT_PATH.test(clip.artifactPath)) throw new Error("artifact-path-invalid");
		if (typeof clip.provenance.annotationPath !== "string" || !ARTIFACT_PATH.test(clip.provenance.annotationPath)) throw new Error("artifact-path-invalid");
	}
	return payload;
}
