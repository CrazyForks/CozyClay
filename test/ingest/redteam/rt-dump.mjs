/**
 * Red-team: tools/ingest/dump-gvhmr.py (F1 operator script) vs RAWTRACK-
 * CONTRACT.md §5 ("A nonexistent input directory fails cleanly ... and exit
 * 1") and the plan §8.4/§10.1 requirement that the dump never emits a fixture
 * claiming resolved slots it did not observe.
 *
 * Attack inputs: nonexistent path, an existing-but-empty directory, a file
 * where a directory is expected, a directory with partial output, missing
 * required options, and — via the numpy-free stub (rt-dump-stub.py, which
 * drives the REAL resolve_slots/_build_document/canonical_json code with a
 * FakeArray standing in for the numpy reader) — the full/partial emission
 * paths: full-image F1-δ, model-named metadata, mismatched tensor lengths,
 * unknown-tensor-only output, empty trim windows, non-finite values.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newRegistry, sha256Of } from "./rt-common.mjs";
import { validateRawTrackRT } from "./rt-schema.mjs";

const reg = newRegistry();
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const DUMP = join(REPO, "tools/ingest/dump-gvhmr.py");
const STUB = fileURLToPath(new URL("./rt-dump-stub.py", import.meta.url));
const PY = "python3";

const BASE_ARGS = [
	"--output", "/tmp/rt-dump-out.json",
	"--clip-id", "rt-redteam-clip",
	"--source-url", "https://example.invalid/rt-redteam.webm",
	"--licence", "CC0-1.0",
	"--source-sha256", "0".repeat(64),
	"--gvhmr-commit", "0".repeat(40),
	"--weights-sha256", "0".repeat(64),
];

const scratch = mkdtempSync(join(tmpdir(), "ccm-redteam-dump-"));

const runDump = (args) => spawnSync(PY, [DUMP, ...args], { encoding: "utf8", timeout: 60000 });

const recordCli = (id, attack, args, expected, check) => {
	const r = runDump(args);
	const stderr = (r.stderr || "").trim();
	const stdout = (r.stdout || "").trim();
	const ok = check(r.status, stderr, stdout);
	reg.record({
		id, category: "dump-cli", attack,
		input: `python3 dump-gvhmr.py ${args.join(" ")}`.slice(0, 200),
		expected,
		observed: `exit ${r.status}; stderr: ${stderr.slice(0, 160) || "(empty)"}`,
		verdict: ok ? "PASS" : "WEAKNESS",
	});
	return r;
};

// ---------------------------------------------------------------------------
// CLI failure modes
// ---------------------------------------------------------------------------
recordCli(
	"DMP-nonexistent", "nonexistent input directory",
	["--input", join(scratch, "no-such-dir"), ...BASE_ARGS],
	"exit 1 with 'dump-gvhmr: input directory does not exist: ...' on stderr; no fixture written",
	(code, err) => code === 1 && /input directory does not exist/.test(err) && !/Traceback/.test(err),
);
{
	const emptyDir = join(scratch, "empty");
	mkdirSync(emptyDir);
	recordCli(
		"DMP-empty-dir", "directory exists but holds no tensors",
		["--input", emptyDir, ...BASE_ARGS],
		"exit 1 with 'no *.npz or *.pkl GVHMR output found'",
		(code, err) => code === 1 && /no \*\.npz or \*\.pkl GVHMR output found/.test(err),
	);
}
{
	const filePath = join(scratch, "plain-file.txt");
	writeFileSync(filePath, "not a directory\n");
	recordCli(
		"DMP-file-as-dir", "a regular file where a directory is expected",
		["--input", filePath, ...BASE_ARGS],
		"exit 1 with a clean message (wording should not claim the path does not exist when it does)",
		(code, err) => code === 1 && !/Traceback/.test(err) && err.length > 0,
	);
}
{
	const npzDir = join(scratch, "with-npz");
	mkdirSync(npzDir);
	writeFileSync(join(npzDir, "out.npz"), "not really an npz but numpy is absent anyway\n");
	recordCli(
		"DMP-npz-no-numpy", "directory with a .npz but numpy is not installed here",
		["--input", npzDir, ...BASE_ARGS],
		"exit 1 with the clean 'numpy is required to read GVHMR output' message — a fixture must not be emitted",
		(code, err) => code === 1 && /numpy is required/.test(err),
	);
}
{
	const r = runDump([]);
	reg.record({
		id: "DMP-missing-args", category: "dump-cli", attack: "no arguments at all",
		input: "python3 dump-gvhmr.py",
		expected: "argparse usage error, exit 2, naming the missing options",
		observed: `exit ${r.status}; stderr: ${(r.stderr || "").trim().slice(0, 140)}`,
		verdict: r.status === 2 && /missing required option/.test(r.stderr || "") ? "PASS" : "WEAKNESS",
	});
}
{
	const r = runDump(["--input", scratch, "--output", "/tmp/x.json", "--clip-id", "c",
		"--source-url", "u", "--licence", "l", "--source-sha256", "0".repeat(64),
		"--gvhmr-commit", "0".repeat(40), "--weights-sha256", "0".repeat(64),
		"--trim-start", "5", "--trim-end", "1"]);
	reg.record({
		id: "DMP-trim-inverted", category: "dump-cli", attack: "--trim-start > --trim-end",
		input: "--trim-start 5 --trim-end 1",
		expected: "parser.error, exit 2",
		observed: `exit ${r.status}; stderr: ${(r.stderr || "").trim().slice(0, 140)}`,
		verdict: r.status === 2 && /trim-start must be <= --trim-end/.test(r.stderr || "") ? "PASS" : "WEAKNESS",
	});
}
{
	const r = runDump(["--selftest"]);
	reg.record({
		id: "DMP-selftest", category: "dump-cli", attack: "--selftest baseline (numpy-free)",
		input: "python3 dump-gvhmr.py --selftest",
		expected: "exit 0 (the shipped unit tests are the baseline the red team attacks)",
		observed: `exit ${r.status}${r.status !== 0 ? "; " + (r.stdout || "").trim().split("\n").slice(-2).join(" | ") : ""}`,
		verdict: r.status === 0 ? "PASS" : "DEFECT",
	});
}

// ---------------------------------------------------------------------------
// Emission paths via the numpy-free stub (real resolve_slots/_build_document)
// ---------------------------------------------------------------------------
const CROP = { offsetX: 800, offsetY: 400, scale: 2, cropW: 640, cropH: 360, fullW: 1920, fullH: 1080 };
const K3 = [[1000, 0, 320], [0, 1000, 240], [0, 0, 1]];
let fileSeq = 0;
const manifestFile = (name, manifest) => {
	const p = join(scratch, `${name}-${fileSeq++}.json`);
	writeFileSync(p, JSON.stringify(manifest));
	return p;
};
const metaFile = (name, meta) => {
	const p = join(scratch, `${name}-${fileSeq++}.json`);
	writeFileSync(p, JSON.stringify(meta));
	return p;
};
const stub = (scenario, manifest, meta = {}, env = {}) => {
	const r = spawnSync(PY, [STUB, scenario, manifestFile("m", manifest), metaFile("x", meta)],
		{ encoding: "utf8", timeout: 60000, env: { ...process.env, ...env } });
	let parsed = null;
	try { parsed = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { /* fall through */ }
	return { status: r.status, stderr: (r.stderr || "").trim(), parsed };
};

const FULL = {
	global_orient_cam: [30, 3, 3],
	translation_cam: [30, 3],
	foot_2d_full: [30, 2],
	foot_contact_logits: [30, 2],
	body_pose_smpl: [30, 24, 3],
};
const CROP_MANIFEST = {
	global_orient_cam: [30, 3, 3],
	translation_cam: [30, 3],
	foot_keypoints_crop: [30, 2, 3],
	foot_contact_logits: [30, 2],
	body_pose_smpl: [30, 24, 3],
};

// (a) full-image F1-δ: resolve_slots must record it named-only (no derivation)
{
	const r = stub("slots", FULL, { fps: 29.97, crop: CROP, model: "smpl" });
	const delta = r.parsed && r.parsed.ok ? r.parsed.slots["F1-δ"] : null;
	reg.record({
		id: "DMP-full-image-slot", category: "dump-stub", attack: "full-image foot tensor resolves F1-δ by name only",
		input: "manifest with foot_2d_full (F,2), model smpl",
		expected: "contract §2 F1-δ: 'named, or the exact derivation' — named-only is a legitimate resolution; record must carry tensor/dtype/shape/units",
		observed: delta ? `F1-δ status=${delta.status} tensor=${delta.tensor} derivation=${JSON.stringify(delta.derivation)}` : `stub failed: ${r.parsed ? JSON.stringify(r.parsed).slice(0, 140) : r.stderr.slice(0, 140)}`,
		verdict: delta && delta.status === "resolved" && delta.derivation === undefined ? "PASS" : "DEFECT",
	});
	// No finding here: named-only F1-δ is the §8.4-valid resolution the dump
	// must produce for a full-image foot tensor (plan §8.4: "named, or the
	// exact derivation ..."); the validator-side rejection was blocker B1,
	// closed in verify-gvhmr-schema.mjs (see SCH-f1d-named-only).
}

// (b) model-named metadata: the complete-manifest operator path must emit a
// valid fixture — the previous blocker B2 crashed here with a bare KeyError
// ('facing_axis') and no fixture. The emitted document must hash, validate
// under the contract validator, and resolve all seven slots.
{
	const r = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3, model: "smpl" });
	const doc = r.parsed && r.parsed.ok ? r.parsed.doc : null;
	const hashOk = doc ? sha256Of(doc) === doc.sha256 : false;
	const codes = doc ? validateRawTrackRT(doc).map((x) => x.code) : ["(no doc)"];
	const resolved = doc ? Object.entries(doc.slots).filter(([, v]) => v.status === "resolved").map(([k]) => k) : [];
	const crash = r.parsed && !r.parsed.ok && r.parsed.phase === "exception";
	reg.record({
		id: "DMP-model-crash", category: "dump-stub", attack: "output metadata names a known body model",
		input: "complete manifest + meta {model: smpl}",
		expected: "the complete manifest (the one the shipped --selftest resolves) must emit a fixture with all seven slots resolved, hashing to its sha256 and passing the contract validator",
		observed: crash
			? `phase=${r.parsed.phase} error=${r.parsed.error}`
			: doc
				? `emitted frames=${doc.frames} resolved=${resolved.join(",")} hashOk=${hashOk} validatorViolations=${codes.join("/") || "none"}`
				: JSON.stringify(r.parsed).slice(0, 140),
		verdict: crash || !doc || !hashOk || codes.length > 0 || resolved.length !== 7 ? "DEFECT" : "PASS",
	});
	if (crash || (doc && (codes.length > 0 || resolved.length !== 7))) {
		reg.finding("high", "_build_document fails to emit a valid all-seven-resolved fixture when the metadata names a known model (B2)", ["DMP-model-crash"],
			"F1-β's resolved record names tensor 'facing_axis', a model-table convention rather than an npz/pkl member; _build_document must synthesize it (it used to KeyError with no fixture, and the shipped --selftest never called _build_document, so the shipped tests could not see it). The emitted fixture must hash, validate under RAWTRACK-CONTRACT, and resolve all seven §8.4 slots.");
	}
}

// (c) partial output with no model named: honest UNRESOLVED emission
{
	const r = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3 });
	const doc = r.parsed && r.parsed.ok ? r.parsed.doc : null;
	const hashOk = doc ? sha256Of(doc) === doc.sha256 : false;
	const codes = doc ? validateRawTrackRT(doc).map((x) => x.code) : ["(no doc)"];
	const resolved = doc ? Object.entries(doc.slots).filter(([, v]) => v.status === "resolved").map(([k]) => k) : [];
	reg.record({
		id: "DMP-partial-emission", category: "dump-stub", attack: "partial output without a model name",
		input: "complete tensor manifest, meta without model (fps/crop/K present)",
		expected: "α/γ/δ/ε resolve and are cited from actual tensors; β/ζ/η honestly UNRESOLVED with reasons; fixture hashes; validator passes it",
		observed: doc ? `resolved=${resolved.join(",")} hashOk=${hashOk} validatorViolations=${codes.join("/") || "none"}` : `stub failed: ${JSON.stringify(r.parsed).slice(0, 120)}`,
		verdict: doc && hashOk && codes.length === 0 && resolved.length === 4 ? "PASS" : "WEAKNESS",
	});
	// (c2) the same output WITHOUT K in the metadata: the dump emits, the gate rejects
	{
		const r2 = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP });
		const doc2 = r2.parsed && r2.parsed.ok ? r2.parsed.doc : null;
		const codesNoK = doc2 ? validateRawTrackRT(doc2).map((x) => x.code) : ["(no doc)"];
		reg.record({
			id: "DMP-no-K", category: "dump-stub", attack: "output metadata lacks K",
			input: "meta without K",
			expected: "K is part of the RawTrack contract shape (§8.1, validator F1-STRUCTURE); a fixture the operator gate rejects should not be emitted silently — either escalate or fail cleanly",
			observed: doc2 ? `fixture emitted with validator violations: ${codesNoK.join("/")}` : `stub failed: ${JSON.stringify(r2.parsed).slice(0, 120)}`,
			verdict: doc2 && codesNoK.length > 0 ? "WEAKNESS" : "PASS",
		});
		if (doc2 && codesNoK.length > 0) {
			reg.finding("low", "dump-gvhmr.py emits K-less fixtures that verify-gvhmr-schema.mjs rejects", ["DMP-no-K"],
				`Same family as B1/B2: the dump's emission and the validator disagree about what a RawTrack requires. ${codesNoK.join("/")}`);
		}
	}
}

// (d) mismatched tensor lengths across resolved slots
{
	const r = stub("emit", {
		global_orient_cam: [30, 3, 3],
		translation_cam: [40, 3],
		foot_keypoints_crop: [40, 2, 3],
		foot_contact_logits: [40, 2],
		body_pose_smpl: [40, 24, 3],
	}, { fps: 29.97, crop: CROP });
	const doc = r.parsed && r.parsed.ok ? r.parsed.doc : null;
	const orientRows = doc ? doc.data.global_orient_cam.length : null;
	const codes = doc ? validateRawTrackRT(doc).map((x) => x.code) : ["(no doc)"];
	reg.record({
		id: "DMP-length-mismatch", category: "dump-stub", attack: "resolved tensors with different frame counts (30 vs 40)",
		input: "global_orient_cam (F,3,3) with F=30, other resolved tensors F=40",
		expected: "either reject the inconsistent output or decimate consistently — never emit frameIndex/timeS that do not align with a resolved tensor",
		observed: doc
			? `frames=${doc.frames} frameIndex=${doc.frameIndex.length} data.global_orient_cam rows=${orientRows} — the (F,3,3) tensor no longer aligns with the sync keys; validatorViolations=${codes.join("/") || "none (validator accepts the misalignment)"}`
			: `stub failed: ${JSON.stringify(r.parsed).slice(0, 120)}`,
		verdict: doc && orientRows !== null && orientRows !== doc.frames ? "WEAKNESS" : "PASS",
	});
	if (doc && orientRows !== null && orientRows !== doc.frames) {
		reg.finding("low", "dump-gvhmr.py emits misaligned data tensors for inconsistent frame counts, and the validator accepts them", ["DMP-length-mismatch", "SCH-tensor-length-vs-frames"],
			`frames=${doc.frames} with data.global_orient_cam of ${orientRows} rows: the tensor shorter than frame_count is emitted whole, breaking the frameIndex synchronization the RawTrack contract is built on. Neither dump-gvhmr.py nor verify-gvhmr-schema.mjs cross-checks tensor length vs frames.`);
	}
}

// (e) unknown tensor only: never emit a fixture claiming resolved slots
{
	const r = stub("emit", { pred_foo: [30, 3] }, {});
	reg.record({
		id: "DMP-unknown-only", category: "dump-stub", attack: "output holds only an unknown tensor",
		input: "pred_foo (F,3) only",
		expected: "all slots UNRESOLVED; _fail('no per-frame tensor resolved') — no fixture may be emitted",
		observed: r.parsed && !r.parsed.ok ? `phase=${r.parsed.phase} exit=${r.parsed.exit}` : `EMITTED (${JSON.stringify(r.parsed).slice(0, 120)})`,
		verdict: r.parsed && !r.parsed.ok && r.parsed.phase === "fail" ? "PASS" : "DEFECT",
	});
}

// (f) trim window selecting no frames (and clamping behaviour)
{
	const r = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3 }, { RT_TRIM_START: "1000", RT_TRIM_END: "1001" });
	reg.record({
		id: "DMP-trim-empty", category: "dump-stub", attack: "trim window selects no frames",
		input: "trim [1000 s, 1001 s] against a 30-frame take at 29.97 fps",
		expected: "_fail('trim [1000.0, 1001.0] selects no frames') — clean exit, no fixture",
		observed: r.parsed && !r.parsed.ok ? `phase=${r.parsed.phase} exit=${r.parsed.exit} stderr=${r.stderr.slice(0, 120)}` : `EMITTED (${JSON.stringify(r.parsed).slice(0, 120)})`,
		verdict: r.parsed && !r.parsed.ok && r.parsed.phase === "fail" ? "PASS" : "WEAKNESS",
	});
	const r2 = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3 }, { RT_TRIM_START: "0.5", RT_TRIM_END: "1.1" });
	const doc2 = r2.parsed && r2.parsed.ok ? r2.parsed.doc : null;
	reg.record({
		id: "DMP-trim-clamp", category: "dump-stub", attack: "trim window partially beyond the take clamps to the take",
		input: "trim [0.5 s, 1.1 s] against a 30-frame take (1.001 s)",
		expected: "start/end clamp into [0, frame_count]: slice covers frames 15..29; provenance records the requested trim",
		observed: doc2 ? `frames=${doc2.frames} (${doc2.frameIndex[0]}..${doc2.frameIndex[doc2.frameIndex.length - 1]}), trimEndS=${doc2.provenance.trimEndS} (requested 1.1, take is 1.001 s)` : `stub failed: ${JSON.stringify(r2.parsed).slice(0, 120)}`,
		verdict: doc2 && doc2.frames === 15 && doc2.frameIndex[0] === 15 && doc2.frameIndex[14] === 29 ? "PASS" : "WEAKNESS",
	});
}

// (g) non-finite values in a tensor: no fixture, but how clean is the failure?
{
	// FakeArray fills 0.0; inject NaN via the emit path by patching the stub
	// is not possible — instead use the canonical_json path directly
	const r = spawnSync(PY, ["-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("d", ${JSON.stringify(DUMP)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
try:
    m.canonical_json({"a": float("nan")})
    print(json.dumps({"ok": True}))
except Exception as e:
    print(json.dumps({"ok": False, "error": type(e).__name__ + ": " + str(e)}))
`], { encoding: "utf8", timeout: 60000 });
	const parsed = JSON.parse((r.stdout || "").trim().split("\n").pop());
	reg.record({
		id: "DMP-nonfinite", category: "dump-stub", attack: "NaN value in a tensor payload",
		input: "canonical_json of a document containing NaN",
		expected: "no fixture may be emitted; a named, clean failure is the contract style (_fail), not a bare traceback",
		observed: parsed.ok ? "NaN stringified (fixture would contain non-finite JSON!)" : `rejected: ${parsed.error}`,
		verdict: parsed.ok ? "WEAKNESS" : "PASS",
	});
	if (parsed.ok) {
		reg.finding("medium", "canonical_json rejects NaN/Infinity (ValueError) but only with a bare traceback", ["DMP-nonfinite"],
			"JSON.stringify in Node would emit null for NaN — the Python side must reject, and it does (ValueError), but the failure is an uncaught traceback rather than the script's clean _fail convention; no fixture is written either way.");
	}
}

// ---------------------------------------------------------------------------
// Pass-2: the operator path end to end. Partial manifests, an unknown body
// model, contradictory handedness/up-axis metadata, fps of 0/negative/
// string/NaN, decimation budgets that would prefer a stride above the frame
// count, zero-length and negative trim windows, a corrupt .npz (reader
// failure), and a mixed valid+corrupt output directory on the real CLI.
// numpy is absent here, so tensor-reading runs go through rt-dump-stub.py
// (the REAL resolve_slots/_build_document); the npz reader itself is attacked
// with an injected numpy whose np.load raises the BadZipFile real numpy
// raises for a truncated archive.
// ---------------------------------------------------------------------------

// (h) fps: 0 / negative must fail cleanly via _fail; string / NaN metadata
//     values are trusted by _build_document without a type check
{
	const f = (meta) => stub("emit", CROP_MANIFEST, { fps: meta, crop: CROP, K: K3, model: "smpl" });
	const r0 = f(0);
	const rNeg = f(-5);
	const rStr = f("29.97");
	const rNan = (() => {
		// JSON.stringify would fold NaN into null, so the meta file is written
		// by hand with the non-standard NaN token Python's json.load parses.
		const nanMetaPath = join(scratch, `meta-nan-${fileSeq++}.json`);
		writeFileSync(nanMetaPath, `{"fps": NaN, "crop": ${JSON.stringify(CROP)}, "K": ${JSON.stringify(K3)}, "model": "smpl"}`);
		const rr = spawnSync(PY, [STUB, "emit", manifestFile("m", CROP_MANIFEST), nanMetaPath],
			{ encoding: "utf8", timeout: 60000, env: { ...process.env } });
		let parsed = null;
		try { parsed = JSON.parse((rr.stdout || "").trim().split("\n").pop()); } catch { /* fall through */ }
		return { status: rr.status, stderr: (rr.stderr || "").trim(), parsed };
	})();
	reg.record({
		id: "DMP-fps-zero", category: "dump-stub", attack: "output metadata fps = 0",
		input: "meta fps 0",
		expected: "_fail('output metadata names no fps ...') — clean exit, no fixture (RAWTRACK-CONTRACT §5)",
		observed: r0.parsed && !r0.parsed.ok ? `phase=${r0.parsed.phase} exit=${r0.parsed.exit}` : `EMITTED (${JSON.stringify(r0.parsed).slice(0, 110)})`,
		verdict: r0.parsed && !r0.parsed.ok && r0.parsed.phase === "fail" ? "PASS" : "WEAKNESS",
	});
	reg.record({
		id: "DMP-fps-negative", category: "dump-stub", attack: "output metadata fps = -5",
		input: "meta fps -5",
		expected: "_fail('output metadata names no fps ...') — clean exit, no fixture",
		observed: rNeg.parsed && !rNeg.parsed.ok ? `phase=${rNeg.parsed.phase} exit=${rNeg.parsed.exit}` : `EMITTED (${JSON.stringify(rNeg.parsed).slice(0, 110)})`,
		verdict: rNeg.parsed && !rNeg.parsed.ok && rNeg.parsed.phase === "fail" ? "PASS" : "WEAKNESS",
	});
	reg.record({
		id: "DMP-fps-string", category: "dump-stub", attack: "output metadata fps = \"29.97\" (string)",
		input: "meta fps \"29.97\" (a metadata json may carry it as a string)",
		expected: "fail cleanly with _fail — fps is trusted with `not fps or fps <= 0`, which raises TypeError on a string",
		observed: rStr.parsed && rStr.parsed.phase === "exception" ? `UNCAUGHT ${rStr.parsed.error}` : `phase=${rStr.parsed && rStr.parsed.phase} (${JSON.stringify(rStr.parsed).slice(0, 110)})`,
		verdict: rStr.parsed && rStr.parsed.phase === "exception" ? "WEAKNESS" : "PASS",
	});
	reg.record({
		id: "DMP-fps-nan", category: "dump-stub", attack: "output metadata fps = NaN (json NaN)",
		input: "meta fps NaN — Python json.load parses the non-standard NaN token",
		expected: "fail cleanly with _fail; NaN fps must not reach frame arithmetic",
		observed: rNan.parsed && rNan.parsed.phase === "exception" ? `UNCAUGHT ${rNan.parsed.error}` : `phase=${rNan.parsed && rNan.parsed.phase} (${JSON.stringify(rNan.parsed).slice(0, 110)})`,
		verdict: rNan.parsed && rNan.parsed.phase === "exception" ? "WEAKNESS" : "PASS",
	});
	if ((rStr.parsed && rStr.parsed.phase === "exception") || (rNan.parsed && rNan.parsed.phase === "exception")) {
		reg.finding("low", "dump-gvhmr.py trusts fps from metadata without a type check: string/NaN fps crash with an uncaught traceback", ["DMP-fps-string", "DMP-fps-nan"],
			`fps comes from the operator's metadata json; 'not fps or fps <= 0' raises TypeError for a string and NaN passes the check to die later in round()/int(). No fixture is emitted (safe), but the failure is a traceback, not the script's _fail convention: observed ${rStr.parsed.error} / ${rNan.parsed.error}.`);
	}
}

// (i) unknown / whitespace body model: the facing_axis fix's boundary. A
//     model outside MODEL_TABLE must NEVER synthesize facing_axis; β/ζ/η
//     escalate with reasons naming the string, and the fixture stays honest.
{
	const r = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3, model: "smplx" });
	const doc = r.parsed && r.parsed.ok ? r.parsed.doc : null;
	const resolved = doc ? Object.entries(doc.slots).filter(([, v]) => v.status === "resolved").map(([k]) => k) : [];
	const betaReason = doc ? doc.slots["F1-β"].reason : "";
	const hashOk = doc ? sha256Of(doc) === doc.sha256 : false;
	const codes = doc ? validateRawTrackRT(doc).map((x) => x.code) : ["(no doc)"];
	reg.record({
		id: "DMP-unknown-model", category: "dump-stub", attack: "output metadata names an unknown body model",
		input: "complete manifest + meta {model: smplx}",
		expected: "β/ζ/η honestly UNRESOLVED with reasons naming 'smplx' (the facing_axis fix must not guess a model outside the table); α/γ/δ/ε resolved; fixture hashes and passes the validator",
		observed: doc ? `resolved=${resolved.join(",")} hashOk=${hashOk} validatorViolations=${codes.join("/") || "none"} F1-β reason=${JSON.stringify(betaReason).slice(0, 80)}` : `stub failed: ${JSON.stringify(r.parsed).slice(0, 120)}`,
		verdict: doc && hashOk && codes.length === 0 && resolved.join(",") === "F1-α,F1-γ,F1-δ,F1-ε" && /smplx/.test(betaReason) ? "PASS" : "DEFECT",
	});
	const r2 = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3, model: " smpl " });
	const doc2 = r2.parsed && r2.parsed.ok ? r2.parsed.doc : null;
	const betaReason2 = doc2 ? doc2.slots["F1-β"].reason : "";
	reg.record({
		id: "DMP-model-whitespace", category: "dump-stub", attack: "output metadata model = ' smpl ' (whitespace-padded)",
		input: "meta model ' smpl ' — an operator typo the fix must not silently absorb",
		expected: "the padded string is not in MODEL_TABLE; β/ζ/η escalate with reasons naming ' smpl ' — honest, never a guessed synthesis",
		observed: doc2 ? `resolved=${Object.entries(doc2.slots).filter(([, v]) => v.status === "resolved").map(([k]) => k).join(",")} F1-β reason=${JSON.stringify(betaReason2).slice(0, 80)}` : `stub failed: ${JSON.stringify(r2.parsed).slice(0, 120)}`,
		verdict: doc2 && / smpl /.test(betaReason2) && doc2.slots["F1-β"].status === "UNRESOLVED" ? "PASS" : "WEAKNESS",
	});
}

// (j) contradictory handedness/up-axis in the operator metadata: the dump
//     reads only fps/crop/model/K from metadata jsons, so operator-supplied
//     handedness/upAxis keys are silently dropped and the fixture asserts the
//     MODEL TABLE's values — a contradiction the operator cannot see.
{
	const r = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3, model: "smpl", handedness: "left-handed", upAxis: "Z" });
	const doc = r.parsed && r.parsed.ok ? r.parsed.doc : null;
	reg.record({
		id: "DMP-meta-handedness-ignored", category: "dump-stub", attack: "operator metadata hands conflicting handedness/up-axis",
		input: "meta {handedness: 'left-handed', upAxis: 'Z'} alongside model smpl (table says right-handed/Y)",
		expected: "the round-trip contract (F1-η 'named and asserted by fixture round-trip') cannot be satisfied by contradicting operator records: either surface the conflict or name the table as the authority",
		observed: doc ? `emitted F1-η handedness=${doc.slots["F1-η"].handedness} upAxis=${doc.slots["F1-η"].upAxis} data.handedness=${doc.data.handedness} — operator's left-handed/Z silently dropped` : `stub failed: ${JSON.stringify(r.parsed).slice(0, 120)}`,
		verdict: doc && doc.slots["F1-η"].handedness === "right-handed" && doc.slots["F1-η"].upAxis === "Y" ? "WEAKNESS" : "PASS",
	});
	if (doc) {
		reg.finding("low", "dump-gvhmr.py silently ignores operator metadata handedness/upAxis and asserts the model-table values", ["DMP-meta-handedness-ignored"],
			`_load_artifacts copies only fps/crop/model/K from metadata jsons. A run record that says handedness 'left-handed'/upAxis 'Z' (here alongside model smpl) leaves no trace in the emitted fixture, which asserts the table's right-handed/Y — the F1-η round-trip claim is made without recording the operator's contradicting record.`);
	}
}

// (k) partial manifest, epsilon only: the honest UNRESOLVED cascade with a
//     single resolved per-frame tensor — and the same manifest without K.
{
	const r = stub("emit", { foot_contact_logits: [30, 2] }, { fps: 29.97, crop: CROP, K: K3, model: "smpl" });
	const doc = r.parsed && r.parsed.ok ? r.parsed.doc : null;
	const resolved = doc ? Object.entries(doc.slots).filter(([, v]) => v.status === "resolved").map(([k]) => k) : [];
	const hashOk = doc ? sha256Of(doc) === doc.sha256 : false;
	const codes = doc ? validateRawTrackRT(doc).map((x) => x.code) : ["(no doc)"];
	reg.record({
		id: "DMP-epsilon-only", category: "dump-stub", attack: "partial manifest with only the contact-logits tensor",
		input: "manifest {foot_contact_logits (F,2)} + full meta (fps/crop/K/model)",
		expected: "ε resolves (plus model-table β/η); α/γ/δ/ζ honestly UNRESOLVED with reasons; fixture hashes and passes the validator — no fabricated resolution",
		observed: doc ? `resolved=${resolved.join(",")} frames=${doc.frames} hashOk=${hashOk} validatorViolations=${codes.join("/") || "none"}` : `stub failed: ${JSON.stringify(r.parsed).slice(0, 120)}`,
		verdict: doc && hashOk && codes.length === 0 && resolved.join(",") === "F1-β,F1-ε,F1-η" ? "PASS" : "WEAKNESS",
	});
	const r2 = stub("emit", { foot_contact_logits: [30, 2] }, { fps: 29.97, crop: CROP, model: "smpl" });
	reg.record({
		id: "DMP-epsilon-only-noK", category: "dump-stub", attack: "partial manifest without K in the metadata",
		input: "manifest {foot_contact_logits} + meta without K",
		expected: "_fail('output metadata names no K ...') — clean exit, no fixture",
		observed: r2.parsed && !r2.parsed.ok ? `phase=${r2.parsed.phase} exit=${r2.parsed.exit}` : `EMITTED (${JSON.stringify(r2.parsed).slice(0, 110)})`,
		verdict: r2.parsed && !r2.parsed.ok && r2.parsed.phase === "fail" ? "PASS" : "WEAKNESS",
	});
}

// (l) decimation budgets that would prefer a stride above the frame count:
//     _choose_stride clamps stride to frame_count by construction (never
//     above), and the document size gate then fails cleanly when the whole
//     document still exceeds the cap.
{
	const r = spawnSync(PY, ["-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("d", ${JSON.stringify(DUMP)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
descs = [{"shape":[30,3,3],"itemsize":4},{"shape":[30,3],"itemsize":4},{"shape":[30,2,3],"itemsize":4},{"shape":[30,2],"itemsize":4},{"shape":[30,24,3],"itemsize":4}]
out = {}
for budget in (1, 100, 1024, 5520):
    s, est = m._choose_stride(30, descs, budget)
    out[str(budget)] = [s, est]
print(json.dumps(out))
`], { encoding: "utf8", timeout: 60000 });
	const strides = JSON.parse((r.stdout || "").trim().split("\n").pop());
	const overCap = Object.entries(strides).filter(([, [s]]) => s > 30);
	const rEmit = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3, model: "smpl" }, { RT_MAX_BYTES: "1024" });
	reg.record({
		id: "DMP-decimation-stride-cap", category: "dump-stub", attack: "byte budgets that would prefer a stride larger than the frame count",
		input: "max_bytes 1/100/1024/5520 against 30-frame tensors; emit with max_bytes=1024",
		expected: "stride never exceeds frame_count (the loop clamps); the whole-document size gate fails cleanly (_fail) when the decimated slice still exceeds the cap",
		observed: `_choose_stride: ${JSON.stringify(strides)} ${overCap.length ? "— STRIDE ABOVE FRAME COUNT!" : "(never above 30)"}; emit with 1024 -> ${rEmit.parsed && !rEmit.parsed.ok ? `phase=${rEmit.parsed.phase} exit=${rEmit.parsed.exit}` : "EMITTED"}`,
		verdict: overCap.length === 0 && rEmit.parsed && !rEmit.parsed.ok && rEmit.parsed.phase === "fail" ? "PASS" : "WEAKNESS",
	});
}

// (m) trim windows: zero-length (start == end) and negative start. The
//     parser rejects inverted windows (DMP-trim-inverted); these reach the
//     trim logic itself.
{
	const r = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3, model: "smpl" }, { RT_TRIM_START: "1", RT_TRIM_END: "1" });
	reg.record({
		id: "DMP-trim-equal", category: "dump-stub", attack: "zero-length trim window (start == end)",
		input: "trim [1 s, 1 s]",
		expected: "_fail('trim [1.0, 1.0] selects no frames') — clean exit, no fixture",
		observed: r.parsed && !r.parsed.ok ? `phase=${r.parsed.phase} exit=${r.parsed.exit}` : `EMITTED (${JSON.stringify(r.parsed).slice(0, 110)})`,
		verdict: r.parsed && !r.parsed.ok && r.parsed.phase === "fail" ? "PASS" : "WEAKNESS",
	});
	const r2 = stub("emit", CROP_MANIFEST, { fps: 29.97, crop: CROP, K: K3, model: "smpl" }, { RT_TRIM_START: "-5" });
	const doc2 = r2.parsed && r2.parsed.ok ? r2.parsed.doc : null;
	reg.record({
		id: "DMP-trim-negative", category: "dump-stub", attack: "negative trim start",
		input: "trim start -5 s (before take start)",
		expected: "start clamps to frame 0; the slice is honest (provenance keeps the requested -5.0 so the clamp is visible)",
		observed: doc2 ? `frames=${doc2.frames} first=${doc2.frameIndex[0]} provenance.trimStartS=${doc2.provenance.trimStartS}` : `stub failed: ${JSON.stringify(r2.parsed).slice(0, 110)}`,
		verdict: doc2 && doc2.frameIndex[0] === 0 && doc2.provenance.trimStartS === -5 ? "PASS" : "WEAKNESS",
	});
}

// (n) corrupt .npz: real numpy raises BadZipFile for a truncated archive; the
//     reader path must fail cleanly (the script's _fail convention), not with
//     an uncaught traceback. numpy is injected here — the code under attack is
//     _load_artifacts's error handling; only the third-party reader is faked.
{
	const corruptDir = join(scratch, "corrupt-npz");
	mkdirSync(corruptDir);
	writeFileSync(join(corruptDir, "corrupt.npz"), "not a zip archive at all\n");
	writeFileSync(join(corruptDir, "meta.json"), JSON.stringify({ fps: 29.97 }));
	const r = spawnSync(PY, ["-c", `
import importlib.util, json, sys, zipfile
spec = importlib.util.spec_from_file_location("d", ${JSON.stringify(DUMP)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class FakeNumpy:
    def load(self, path, allow_pickle=False):
        raise zipfile.BadZipFile("File is not a zip file: " + str(path))
sys.modules["numpy"] = FakeNumpy()
try:
    arts, meta = m._load_artifacts(${JSON.stringify(corruptDir)})
    print(json.dumps({"ok": True, "artifacts": sorted(arts.keys())}))
except SystemExit as e:
    print(json.dumps({"ok": False, "phase": "fail", "exit": e.code}))
except Exception as e:
    print(json.dumps({"ok": False, "phase": "exception", "error": type(e).__name__ + ": " + str(e)}))
`], { encoding: "utf8", timeout: 60000 });
	const parsed = JSON.parse((r.stdout || "").trim().split("\n").pop());
	reg.record({
		id: "DMP-corrupt-npz", category: "dump-stub", attack: "a corrupt .npz member (reader raises BadZipFile)",
		input: "output directory with corrupt.npz + meta.json; injected numpy.load raises BadZipFile (what real numpy raises for a truncated archive)",
		expected: "clean _fail naming the unreadable file, exit 1, no fixture — the RAWTRACK-CONTRACT §5 failure style",
		observed: parsed.phase === "exception" ? `UNCAUGHT ${parsed.error}` : JSON.stringify(parsed).slice(0, 120),
		verdict: parsed.phase === "fail" ? "PASS" : "WEAKNESS",
	});
	if (parsed.phase === "exception") {
		reg.finding("low", "_load_artifacts lets np.load failures (corrupt/truncated .npz) escape as an uncaught traceback", ["DMP-corrupt-npz"],
			`np.load(path, allow_pickle=False) is not wrapped: a truncated or renamed .npz raises zipfile.BadZipFile (observed ${parsed.error}) and the operator sees a traceback instead of the script's _fail convention. No fixture is emitted (safe), but the failure mode is unclean.`);
	}
}

// (o) the real CLI on a mixed output directory (valid-looking npz + corrupt
//     npz + metadata): on this box numpy is absent, so the reader gate must
//     fail first, cleanly, and no fixture may be written.
{
	const mixedDir = join(scratch, "mixed-npz");
	mkdirSync(mixedDir);
	writeFileSync(join(mixedDir, "out.npz"), "valid-looking placeholder\n");
	writeFileSync(join(mixedDir, "corrupt.npz"), "not a zip archive at all\n");
	writeFileSync(join(mixedDir, "meta.json"), JSON.stringify({ fps: 29.97, crop: CROP, model: "smpl" }));
	const r = runDump(["--input", mixedDir, ...BASE_ARGS]);
	reg.record({
		id: "DMP-mixed-npz-dir", category: "dump-cli", attack: "output directory with a valid-looking npz plus a corrupt one (real CLI)",
		input: "out.npz + corrupt.npz + meta.json, python3 dump-gvhmr.py (real CLI)",
		expected: "exit 1, clean message, no fixture — here the numpy-absent reader gate fires first; the corrupt-read path itself is DMP-corrupt-npz",
		observed: `exit ${r.status}; stderr: ${(r.stderr || "").trim().slice(0, 120)}`,
		verdict: r.status === 1 && /numpy is required/.test(r.stderr || "") && !/Traceback/.test(r.stderr || "") ? "PASS" : "WEAKNESS",
	});
}

// (p) the real CLI on a metadata-only directory: no tensors -> the
//     no-npz/pkl gate fires before any metadata is read
{
	const metaOnlyDir = join(scratch, "meta-only");
	mkdirSync(metaOnlyDir);
	writeFileSync(join(metaOnlyDir, "meta.json"), JSON.stringify({ fps: 29.97, crop: CROP, model: "smpl" }));
	const r = runDump(["--input", metaOnlyDir, ...BASE_ARGS]);
	reg.record({
		id: "DMP-meta-only-dir", category: "dump-cli", attack: "output directory holds only a metadata json (partial manifest)",
		input: "meta.json only, python3 dump-gvhmr.py (real CLI)",
		expected: "exit 1 with 'no *.npz or *.pkl GVHMR output found' — no fixture may be built from metadata alone",
		observed: `exit ${r.status}; stderr: ${(r.stderr || "").trim().slice(0, 120)}`,
		verdict: r.status === 1 && /no \*\.npz or \*\.pkl GVHMR output found/.test(r.stderr || "") ? "PASS" : "WEAKNESS",
	});
}

// (q) a body-model tensor present with the wrong rank: resolve_slots must
//     escalate F1-ζ, never resolve it with guessed semantics
{
	const r = stub("emit", {
		global_orient_cam: [30, 3, 3],
		translation_cam: [30, 3],
		foot_keypoints_crop: [30, 2, 3],
		foot_contact_logits: [30, 2],
		body_pose_smpl: [30, 24], // wrong rank: (F,24) instead of (F,24,3)
	}, { fps: 29.97, crop: CROP, K: K3, model: "smpl" });
	const doc = r.parsed && r.parsed.ok ? r.parsed.doc : null;
	reg.record({
		id: "DMP-zeta-wrong-rank", category: "dump-stub", attack: "body-pose tensor exists with the wrong rank",
		input: "body_pose_smpl shape (F,24) under model smpl (table requires (F,24,3))",
		expected: "F1-ζ UNRESOLVED with a reason naming the shape mismatch; the fixture stays honest (α/γ/δ/ε resolved)",
		observed: doc ? `F1-ζ status=${doc.slots["F1-ζ"].status} reason=${JSON.stringify(doc.slots["F1-ζ"].reason).slice(0, 90)}` : `stub failed: ${JSON.stringify(r.parsed).slice(0, 120)}`,
		verdict: doc && doc.slots["F1-ζ"].status === "UNRESOLVED" && /shape/.test(doc.slots["F1-ζ"].reason) ? "PASS" : "WEAKNESS",
	});
}

rmSync(scratch, { recursive: true, force: true });

export const run = async () => {
	console.log("== rt-dump: dump-gvhmr.py CLI + emission attacks ==");
	return { cases: reg.cases, findings: reg.findings };
};

const isMain = process.argv[1] && process.argv[1].endsWith("rt-dump.mjs");
if (isMain) {
	await run();
	for (const c of reg.cases) console.log(`${c.verdict.padEnd(9)} ${c.id.padEnd(24)} ${c.observed.slice(0, 120)}`);
	console.log(`\nrt-dump: ${reg.cases.length} cases, ${reg.findings.length} findings`);
}
