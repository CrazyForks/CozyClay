/**
 * C1: the §5 schema contracts as executable validators (plan §13 commit C1).
 *
 * Why this test exists: every artifact that crosses the ingest boundary —
 * the provider manifest, RawTrack, FloorFrame and the TakePayload — is a
 * contract document, and a contract written only in prose is a contract
 * that drifts. The plan's canonical RED is "manifest with
 * redistributable:true accepted": the project never bundles weights (plan
 * §16), and a manifest claiming redistributability is a licensing hazard,
 * never a convenience (plan §14.2 DoD 11: every manifest
 * redistributable:false). The validators here are the child-side executable
 * form of plan §5 and §8.1, and the TakePayload validator must agree with
 * the parent door (src/surface-host.js validateTakePayload) code for code —
 * one contract, enforced on both sides of the boundary.
 *
 * What would be circular or wrong to assert: a validator that only checks
 * the good fixtures (it would pass even if every rejection clause were
 * missing); a validator that crashes with a TypeError on malformed input
 * instead of rejecting by name (a crash is not a named behavioural
 * rejection); or a TakePayload validator that diverges from the parent door
 * (the child would happily publish a payload the app refuses to land). So
 * every check has a negative control that must FAIL, and the TakePayload
 * section replays the same battery through BOTH validators.
 */
import { readFileSync } from "node:fs";
import {
	validateProviderManifest,
	validateRawTrack,
	validateFloorFrame,
	validateTakePayload,
} from "../../src/ingest/contracts.js";
// The parent-side publish door (plan §5/S2) enforces the same TakePayload
// contract; section 5 asserts the child validator never diverges from it.
import { validateTakePayload as parentValidateTakePayload } from "../../src/surface-host.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

// Named rejection: the call must throw an Error whose message IS the code.
// A validator that crashes instead (TypeError from a null deref) fails here,
// because a crash cannot be mapped to a status by a caller.
const throwsCode = (label, fn, code) => {
	let err = null;
	try {
		fn();
	} catch (e) {
		err = e;
	}
	ok(label, err !== null && err.message === code, err === null ? "no error thrown" : `got ${err.message}`);
	return err;
};
const accepts = (label, fn, detail = "") => {
	let err = null;
	try {
		fn();
	} catch (e) {
		err = e;
	}
	ok(label, err === null, err ? err.message : detail);
};

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/contracts/${n}`, import.meta.url), "utf8"));
const loadSolver = (n) =>
	JSON.parse(readFileSync(new URL(`./fixtures/solver-output/synthetic-boxing-01/${n}`, import.meta.url), "utf8"));
const loadRawtrackFixture = (n) =>
	JSON.parse(readFileSync(new URL(`./fixtures/rawtrack/${n}`, import.meta.url), "utf8"));

const manifestGood = load("manifest-good.json");
const manifestRedistributable = load("manifest-redistributable.json");
const takePayloadGood = load("take-payload-good.json");
// The pinned Phase-0 artifacts: the validators must accept exactly what the
// pipeline already ships (plan §14.2 DoD 12: the validators agree).
const rawtrackGateFixture = loadRawtrackFixture("rawtrack-good.json");
const rawtrackRunnerFixture = loadSolver("rawtrack.json");
const floorFramePinned = loadSolver("floorframe.json");

// the §5 provenance block a complete take must carry (same list as the parent door)
const PROVENANCE_KEYS = ["command", "sourceUrl", "licence", "sourceSha256", "trimStartS", "trimEndS", "gvhmrCommit", "weightsSha256", "annotationPath"];

// payload builders for the negative battery: one field flipped on the good payload
const withClip = (payload, side, patch) => ({ ...payload, [side]: { ...payload[side], ...patch } });
const withProvenance = (payload, side, patch) =>
	withClip(payload, side, { provenance: { ...payload[side].provenance, ...patch } });

// ---------------------------------------------------------------------------
// 1. Provider manifest — the plan's canonical RED first
// ---------------------------------------------------------------------------
// The RED: "manifest with redistributable:true accepted". A manifest that
// claims the footage may be redistributed must be rejected BY NAME, and the
// license block is closed to extra fields — an uninterpreted license field
// could hide redistribution terms, which is exactly the hazard this commit
// exists to stop. Extra TOP-LEVEL manifest fields stay legal (provider
// metadata is open-ended); only the license posture is closed.
accepts("manifest with a complete license block accepted", () => validateProviderManifest(manifestGood));
throwsCode(
	"manifest with redistributable:true is rejected",
	() => validateProviderManifest(manifestRedistributable),
	"license-redistributable"
);
throwsCode(
	"manifest with weightsBundled:true is rejected",
	() => validateProviderManifest({ ...manifestGood, weightsBundled: true }),
	"license-weights-bundled"
);
throwsCode(
	"license block missing a field is rejected",
	() => validateProviderManifest({ ...manifestGood, license: { ...manifestGood.license, note: undefined } }),
	"license-incomplete"
);
throwsCode(
	"license block with an unknown field is rejected",
	() => validateProviderManifest({ ...manifestGood, license: { ...manifestGood.license, "redistributionTerms": "see note" } }),
	"license-unknown-field"
);
throwsCode(
	"license block that is not an object is rejected",
	() => validateProviderManifest({ ...manifestGood, license: null }),
	"license-incomplete"
);
throwsCode(
	"manifest without a providerId is rejected",
	() => validateProviderManifest({ ...manifestGood, providerId: "" }),
	"provider-id-missing"
);
throwsCode(
	"manifest with a bad schemaVersion is rejected",
	() => validateProviderManifest({ ...manifestGood, schemaVersion: "1" }),
	"schema-version-invalid"
);
throwsCode(
	"manifest that is not an object is rejected",
	() => validateProviderManifest(null),
	"manifest-not-object"
);

// ---------------------------------------------------------------------------
// 2. RawTrack — §5/§8.1: RawTrack supplies K only
// ---------------------------------------------------------------------------
// §8.1: "RawTrack supplies K only; R,t come from FloorFrame." That sentence
// is the contract: a RawTrack smuggling R_ring_from_cam/t_ring_from_cam
// creates two suppliers for the same quantity, which is how coordinate
// systems silently fork. Both pinned artifacts must pass; the F1 gate
// fixture (slots/verification, subjects []) and the runner-facing fixture
// (K, subjects) are the two real shapes the pipeline ships.
accepts("pinned F1 gate RawTrack accepted", () => validateRawTrack(rawtrackGateFixture));
accepts("pinned runner-facing RawTrack accepted", () => validateRawTrack(rawtrackRunnerFixture));
throwsCode(
	"RawTrack carrying R_ring_from_cam is rejected",
	() => validateRawTrack({ ...rawtrackRunnerFixture, R_ring_from_cam: floorFramePinned.R_ring_from_cam }),
	"rawtrack-carries-rt"
);
throwsCode(
	"RawTrack carrying t_ring_from_cam is rejected",
	() => validateRawTrack({ ...rawtrackRunnerFixture, t_ring_from_cam: floorFramePinned.t_ring_from_cam }),
	"rawtrack-carries-rt"
);
throwsCode(
	"RawTrack with a malformed K is rejected",
	() => validateRawTrack({ ...rawtrackRunnerFixture, K: [[1200, 0, 960], [0, 1200, 540]] }),
	"rawtrack-k"
);
throwsCode(
	"RawTrack with misaligned frameIndex is rejected",
	() => validateRawTrack({ ...rawtrackRunnerFixture, frameIndex: rawtrackRunnerFixture.frameIndex.slice(0, -1) }),
	"rawtrack-frame-index"
);
throwsCode(
	"RawTrack with a broken timeS key is rejected",
	() => validateRawTrack({ ...rawtrackRunnerFixture, timeS: [0.5, ...rawtrackRunnerFixture.timeS.slice(1)] }),
	"rawtrack-time"
);
throwsCode(
	"RawTrack with a malformed subject is rejected",
	() => validateRawTrack({ ...rawtrackRunnerFixture, subjects: [{ trackId: "p0" }] }),
	"rawtrack-subjects"
);
throwsCode(
	"RawTrack with incomplete provenance is rejected",
	() => validateRawTrack({ ...rawtrackGateFixture, provenance: { ...rawtrackGateFixture.provenance, sourceUrl: undefined } }),
	"rawtrack-provenance"
);
throwsCode(
	"RawTrack with a bad sha256 is rejected",
	() => validateRawTrack({ ...rawtrackRunnerFixture, sha256: "deadbeef" }),
	"rawtrack-sha256"
);
throwsCode(
	"RawTrack with a wrong kind is rejected",
	() => validateRawTrack({ ...rawtrackGateFixture, kind: "SomethingElse" }),
	"rawtrack-kind"
);

// ---------------------------------------------------------------------------
// 3. FloorFrame — §8.1 shape, direction encoded in the names
// ---------------------------------------------------------------------------
// §8.1 pins floorY:0.0, planeNormal_ring:[0,1,0] and metresPerUnit:1.0 as
// VALUES, not just fields, and R_ring_from_cam is a rotation by name — a
// non-orthonormal R distorts every ray it rotates, so it must be rejected
// before C4b consumes it.
accepts("pinned FloorFrame accepted", () => validateFloorFrame(floorFramePinned));
throwsCode(
	"FloorFrame with a non-orthonormal R is rejected",
	() => validateFloorFrame({ ...floorFramePinned, R_ring_from_cam: floorFramePinned.R_ring_from_cam.map((row, i) => row.map((v) => (i === 0 ? v * 1.1 : v))) }),
	"floorframe-rotation"
);
throwsCode(
	"FloorFrame with a broken t is rejected",
	() => validateFloorFrame({ ...floorFramePinned, t_ring_from_cam: [0, 2.6] }),
	"floorframe-t"
);
throwsCode(
	"FloorFrame with floorY != 0 is rejected",
	() => validateFloorFrame({ ...floorFramePinned, floorY: 0.02 }),
	"floorframe-floor-y"
);
throwsCode(
	"FloorFrame with a wrong plane normal is rejected",
	() => validateFloorFrame({ ...floorFramePinned, planeNormal_ring: [0, 0, 1] }),
	"floorframe-plane-normal"
);
throwsCode(
	"FloorFrame with metresPerUnit != 1 is rejected",
	() => validateFloorFrame({ ...floorFramePinned, metresPerUnit: 100 }),
	"floorframe-metres-per-unit"
);
throwsCode(
	"FloorFrame with a missing quality field is rejected",
	() => validateFloorFrame({ ...floorFramePinned, quality: { ...floorFramePinned.quality, conditionNumber: undefined } }),
	"floorframe-quality"
);
throwsCode(
	"FloorFrame with an out-of-range inlierRatio is rejected",
	() => validateFloorFrame({ ...floorFramePinned, quality: { ...floorFramePinned.quality, inlierRatio: 1.5 } }),
	"floorframe-quality"
);
throwsCode(
	"FloorFrame with a bad K is rejected",
	() => validateFloorFrame({ ...floorFramePinned, K: [[-1200, 0, 960], [0, 1200, 540], [0, 0, 1]] }),
	"floorframe-k"
);

// ---------------------------------------------------------------------------
// 4. TakePayload — §5 assertions, mirrored from the parent door
// ---------------------------------------------------------------------------
// a.rotationDeg === b.rotationDeg === 0, a.fps === b.fps === 20, equal frame
// counts, complete provenance, artifact fields are PATHS not URLs (§12.3).
// A good payload passes and is returned unchanged.
accepts("complete §5 TakePayload accepted", () => validateTakePayload(takePayloadGood));
throwsCode(
	"a.rotationDeg != 0 is rejected",
	() => validateTakePayload(withClip(takePayloadGood, "a", { rotationDeg: 5 })),
	"rotation-deg-mismatch"
);
throwsCode(
	"b.fps != 20 is rejected",
	() => validateTakePayload(withClip(takePayloadGood, "b", { fps: 29.97 })),
	"fps-not-20"
);
throwsCode(
	"unequal frame counts are rejected",
	() => validateTakePayload(withClip(takePayloadGood, "a", { frames: 119 })),
	"frame-count-mismatch"
);
throwsCode(
	"incomplete provenance is rejected",
	() => validateTakePayload(withProvenance(takePayloadGood, "a", { weightsSha256: undefined })),
	"provenance-incomplete"
);
throwsCode(
	"an artifact URL is rejected (fields are paths, §12.3)",
	() => validateTakePayload(withClip(takePayloadGood, "a", { artifactPath: "https://example.com/ingest/artifacts/x" })),
	"artifact-path-invalid"
);
throwsCode(
	"an annotation URL is rejected (fields are paths, §12.3)",
	() => validateTakePayload(withProvenance(takePayloadGood, "b", { annotationPath: "https://example.com/ann.json" })),
	"artifact-path-invalid"
);
throwsCode(
	"an empty requestId is rejected",
	() => validateTakePayload({ ...takePayloadGood, requestId: "" }),
	"request-id-missing"
);
throwsCode(
	"a payload without clips is rejected",
	() => validateTakePayload({ ...takePayloadGood, a: null }),
	"clips-missing"
);
throwsCode(
	"a non-object payload is rejected",
	() => validateTakePayload(null),
	"payload-not-object"
);

// ---------------------------------------------------------------------------
// 5. Parent-door parity: one contract, two validators
// ---------------------------------------------------------------------------
// The §5 TakePayload contract is enforced on both sides of the boundary:
// the child validator (this commit) and the parent publish door
// (src/surface-host.js, S2). If the two ever disagree — the child accepts a
// payload the door rejects, or names a different code — a take lands
// nowhere and the operator cannot tell why. The same battery must produce
// the same verdict and the same code through both.
const battery = [
	["good payload", takePayloadGood],
	["rotationDeg on a", withClip(takePayloadGood, "a", { rotationDeg: 5 })],
	["fps on b", withClip(takePayloadGood, "b", { fps: 29.97 })],
	["frame count on a", withClip(takePayloadGood, "a", { frames: 119 })],
	["frames not an integer", withClip(takePayloadGood, "a", { frames: 1.5 })],
	["provenance missing key", withProvenance(takePayloadGood, "a", { gvhmrCommit: undefined })],
	["provenance not an object", withClip(takePayloadGood, "a", { provenance: null })],
	["artifactPath URL", withClip(takePayloadGood, "a", { artifactPath: "https://example.com/x" })],
	["artifactPath foreign prefix", withClip(takePayloadGood, "a", { artifactPath: "/other/artifacts/x" })],
	["annotationPath URL", withProvenance(takePayloadGood, "b", { annotationPath: "https://example.com/ann.json" })],
	["empty requestId", { ...takePayloadGood, requestId: "" }],
	["missing clips", { ...takePayloadGood, a: null }],
	["null payload", null],
	["non-object payload", 42],
];
for (const [name, payload] of battery) {
	let child = null;
	let parent = null;
	try {
		validateTakePayload(payload);
	} catch (e) {
		child = e.message;
	}
	try {
		parentValidateTakePayload(payload);
	} catch (e) {
		parent = e.message;
	}
	ok(
		`child and parent door agree on: ${name}`,
		child === parent,
		`child ${child ?? "accepts"}, door ${parent ?? "accepts"}`
	);
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
