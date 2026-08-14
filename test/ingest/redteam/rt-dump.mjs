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
