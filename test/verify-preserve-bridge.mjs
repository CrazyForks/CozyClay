#!/usr/bin/env node

// Scheduled inpainting, wired end to end (contract C3).
//
// tools/kimodo/preserve-mask.mjs owns the mask itself and is pinned by
// verify-kimodo-preserve.mjs. THIS file pins the wiring around it: what the
// bridge accepts and refuses, how a preserve request reaches the Kimodo box,
// and the one arithmetic rule that decides whether the box accepts the mask at
// all.
//
// The bridge's validator cannot be imported — bridge.mjs binds a socket on
// load — so it is exercised the way a client sees it: a real sidecar on a
// loopback port, one POST per rule, asserting the reason string names the
// field it refused.

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createKimodoRunner, nativeMotionPath, preserveMaskPath } from "../tools/kimodo/runner.mjs";
import { cliGenFrames, generateOnBox } from "../tools/kimodo/generate.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const REPO = new URL("..", import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const READY_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------------- */
/* the generated frame count the mask is sized against                        */
/* ------------------------------------------------------------------------- */
// kimodo/scripts/generate.py does `int(duration_sec * fps)` and then REFUSES a
// mask whose genFrames differs by one. Rounding instead of truncating is the
// single silent way to fail every preserve run on a clip whose length lands on
// a half frame, so the rule is pinned against the CLI's arithmetic, not ours.
{
	assert.equal(cliGenFrames(5, 30), 150, "a whole number of seconds is exact either way");
	assert.equal(cliGenFrames(119 / 24, 30), 148, "148.75 generation frames truncate to 148, not 149");
	assert.notEqual(cliGenFrames(119 / 24, 30), Math.round((119 / 24) * 30), "rounding would disagree with the box");
	// 196 app frames is 8.166666666666666 s, and that times 30 is
	// 244.99999999999997 in IEEE-754 — on BOTH sides. Python's int() takes 244
	// and Math.trunc reproduces it; rounding would ask the box for 245 frames of
	// mask against a 244-frame clip and the run would die there.
	assert.equal(cliGenFrames(196 / 24, 30), 244, "a product a hair below an integer truncates down on both sides");
	assert.equal(Math.round((196 / 24) * 30), 245, "...where rounding lands one frame too high");
	assert.equal(cliGenFrames(2, 30), 60);
	pass("the mask is sized with the CLI's truncation, not with rounding");
}

/* ------------------------------------------------------------------------- */
/* the runner: how preserve reaches the box, and what it keeps for next time   */
/* ------------------------------------------------------------------------- */
const SAVED_ENV = { ...process.env };
const RUNNER_KEYS = ["CCLAY_KIMODO_HOST", "CCLAY_KIMODO_PRESERVE", "CCLAY_KIMODO_NATIVE_OUT"];
function withEnv(env, body) {
	for (const key of RUNNER_KEYS) delete process.env[key];
	Object.assign(process.env, env);
	try {
		return body();
	} finally {
		for (const key of RUNNER_KEYS) delete process.env[key];
		Object.assign(process.env, SAVED_ENV);
	}
}

const PRESERVE = {
	basePath: "/runs/generate-abc/generated.kimodo.npz",
	sigmaS: 500,
	sigmaE: 50,
	editRanges: [{ startFrame: 40, endFrame: 80 }],
};
const OUTPUT = "/runs/generate-xyz/generated.npz";

{
	const runner = withEnv({ CCLAY_KIMODO_HOST: "user@kimodo-box" }, () => createKimodoRunner());

	// The wrapper scripts' argv is a frozen contract shared with the ARDY
	// wrappers, so preserve travels in the environment. An unknown flag would be
	// a usage() exit, which is why this is asserted rather than assumed.
	const preserved = runner.singleCommand({ prompt: "A person walks", durationS: 5, preserve: PRESERVE, output: OUTPUT });
	assert.ok(!preserved.args.some((arg) => String(arg).startsWith("--preserve")), "preserve must not be smuggled onto argv");
	const shipped = JSON.parse(preserved.env.CCLAY_KIMODO_PRESERVE);
	assert.equal(shipped.basePath, PRESERVE.basePath);
	assert.equal(shipped.sigmaS, 500);
	assert.equal(shipped.sigmaE, 50);
	assert.deepEqual(shipped.editRanges, PRESERVE.editRanges, "edit ranges reach the mask builder unchanged");
	assert.equal(shipped.maskPath, preserveMaskPath(OUTPUT), "the mask is kept in the run directory");
	assert.equal(shipped.maskPath, "/runs/generate-xyz/preserve-mask.json");
	pass("a preserve request reaches the box through CCLAY_KIMODO_PRESERVE");

	// Kimodo's --base_motion reads the npz its own generator wrote; the cskel27
	// file the bridge serves is a conversion of it. Every whole-clip run keeps
	// the native one beside its output so a LATER run can preserve from it.
	const kept = runner.singleCommand({ prompt: "A person walks", durationS: 5, keepNative: true, output: OUTPUT });
	assert.equal(kept.env.CCLAY_KIMODO_NATIVE_OUT, nativeMotionPath(OUTPUT));
	assert.equal(kept.env.CCLAY_KIMODO_NATIVE_OUT, "/runs/generate-xyz/generated.kimodo.npz");
	assert.equal(kept.env.CCLAY_KIMODO_PRESERVE, undefined, "keeping a base does not turn preservation on");
	pass("a whole-clip run keeps Kimodo's own npz beside its take");

	// An edit SPLICES its regenerated span into the source take, so the npz
	// Kimodo wrote is not the take that comes out and must never become a base.
	const edit = runner.editCommand({
		source: "/runs/generate-abc/generated.npz",
		manifest: "/runs/generate-xyz/edit-manifest.json",
		prompt: "A person waves",
		contextBefore: 8,
		contextAfter: 8,
		preserve: PRESERVE,
		output: "/runs/generate-xyz/constrained.npz",
	});
	assert.equal(edit.env.CCLAY_KIMODO_NATIVE_OUT, undefined, "a spliced take must not be kept as a base motion");
	assert.equal(JSON.parse(edit.env.CCLAY_KIMODO_PRESERVE).basePath, PRESERVE.basePath, "an edit can still preserve");
	pass("an edit run preserves but never keeps a base of its own");

	// The bridge is a long-lived sidecar: a value left over from the previous
	// request would preserve the wrong take on this one, silently.
	const stale = withEnv(
		{
			CCLAY_KIMODO_HOST: "user@kimodo-box",
			CCLAY_KIMODO_PRESERVE: JSON.stringify(PRESERVE),
			CCLAY_KIMODO_NATIVE_OUT: "/runs/stale/generated.kimodo.npz",
		},
		() => createKimodoRunner().singleCommand({ prompt: "A person walks", durationS: 5, output: OUTPUT }),
	);
	assert.equal(stale.env.CCLAY_KIMODO_PRESERVE, undefined, "an inherited preserve must not leak into a plain run");
	assert.equal(stale.env.CCLAY_KIMODO_NATIVE_OUT, undefined, "an inherited native-out must not leak into a plain run");
	pass("a plain generation clears both inherited preserve variables");

	// The base clip refusal is unrelated machinery (autoregressive history) and
	// must survive preserve landing next to it.
	assert.throws(
		() => runner.singleCommand({ prompt: "x", durationS: 1, basePath: "/base.npz", output: OUTPUT }),
		/does not implement base clips/,
		"the base-clip refusal must survive",
	);
	pass("preserve is supported while base clips still refuse by name");

	// Resolving a take back to this backend's base motion.
	const runDir = mkdtempSync(join(tmpdir(), "cclay-preserve-"));
	try {
		const take = join(runDir, "generated.npz");
		writeFileSync(take, "cskel27");
		assert.equal(runner.baseMotionFor(take), null, "a take with no native npz has no base motion");
		writeFileSync(nativeMotionPath(take), "kimodo-native");
		assert.equal(runner.baseMotionFor(take), join(runDir, "generated.kimodo.npz"));
		pass("baseMotionFor finds the native npz beside a take, or reports none");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
}

/* ------------------------------------------------------------------------- */
/* generate.mjs refuses a preserve plan it cannot ship                         */
/* ------------------------------------------------------------------------- */
// Every one of these is caught before any ssh, so a bad plan costs nothing.
{
	const segments = [{ prompt: "A person walks", duration: 4 }];
	const call = (preserve, extra = {}) =>
		generateOnBox({ segments, host: "nobody@nowhere.invalid", preserve, ...extra });

	await assert.rejects(
		() => call({ ...PRESERVE }, { segments: [{ prompt: "A person walks", duration: 2 }, { prompt: "A person waves", duration: 2 }] }),
		/single segment/,
		"the box would refuse a prompt schedule; refuse it before the GPU is booked",
	);
	await assert.rejects(() => call({ ...PRESERVE, basePath: "" }), /basePath/);
	await assert.rejects(() => call({ ...PRESERVE, sigmaS: 1500 }), /sigmaS must be an integer in 0\.\.1000/);
	await assert.rejects(() => call({ ...PRESERVE, sigmaS: 12.5 }), /sigmaS must be an integer in 0\.\.1000/);
	await assert.rejects(() => call({ ...PRESERVE, sigmaE: -1 }), /sigmaE must be an integer in 0\.\.1000/);
	await assert.rejects(() => call({ ...PRESERVE, sigmaS: 400, sigmaE: 600 }), /must be <= preserve\.sigmaS/);
	// A range outside the generated clip reaches the mask builder's own refusal.
	await assert.rejects(() => call({ ...PRESERVE, editRanges: [{ startFrame: 9000, endFrame: 9100 }] }), /buildPreserveMask/);
	pass("generate.mjs refuses an unshippable preserve plan before touching the box");
}

/* ------------------------------------------------------------------------- */
/* the strength -> diffusion-time mapping                                      */
/* ------------------------------------------------------------------------- */
// Server-side by contract, and numeric: a client never speaks in diffusion-time
// units, and the paper's recommended pair is 500/50. Reachable only through a
// real generated take, so the formula is pinned against the source.
{
	const bridgeSource = readFileSync(new URL("tools/ardy/bridge.mjs", REPO), "utf8");
	assert.match(bridgeSource, /const PRESERVE_SIGMA_MAX = 1000;/);
	assert.match(bridgeSource, /const PRESERVE_SIGMA_END_CAP = 50;/);
	// INVERTED mapping: a smaller sigma_s preserves MORE (alpha_time is 1 above
	// sigma_s), measured on the box in gate G3. Full strength floors at the end
	// cap instead of rounding sigma_s to 0, which would read as preserve-off.
	assert.match(
		bridgeSource,
		/const sigmaS = Math\.max\(PRESERVE_SIGMA_END_CAP, Math\.round\(PRESERVE_SIGMA_MAX \* \(1 - strength\)\)\);/,
	);
	assert.match(bridgeSource, /sigmaE: Math\.min\(PRESERVE_SIGMA_END_CAP, sigmaS\)/);
	// The contract's default is unchanged by the inversion: strength 0.5 -> 500/50.
	assert.equal(Math.max(50, Math.round(1000 * (1 - 0.5))), 500);
	assert.equal(Math.min(50, 500), 50);
	// Full preserve is a step schedule, not preserve-off.
	assert.equal(Math.max(50, Math.round(1000 * (1 - 1))), 50);
	pass("strength maps to sigma_s = max(50, round(1000*(1-s))) with sigma_e capped at 50");
}

/* ------------------------------------------------------------------------- */
/* the bridge validator, over the wire                                         */
/* ------------------------------------------------------------------------- */

function freePort() {
	return new Promise((resolvePromise, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close((error) => (error ? reject(error) : resolvePromise(port)));
		});
	});
}

const port = await freePort();
const bridge = fork(join(HERE, "..", "tools", "ardy", "bridge.mjs"), [], {
	cwd: REPO,
	env: {
		...process.env,
		CCLAY_MOTION_BACKEND: "kimodo",
		CCLAY_KIMODO_HOST: "test@kimodo",
		COZYCLAY_BRIDGE_PORT: String(port),
	},
	stdio: ["ignore", "ignore", "ignore", "ipc"],
});

let failures = 0;
try {
	const ready = await Promise.race([
		once(bridge, "message"),
		new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not report readiness")), READY_TIMEOUT_MS).unref()),
	]);
	assert.deepEqual(ready[0], { type: "cozyclay-bridge-ready", port });

	// duration 5 s on the bridge's 24 fps clock = a 120-frame clip.
	const CLIP_FRAMES = 120;
	const MOTION = "/ardy/motions/1700000000000-abcdef";
	const POSE = { schema: "cozyclay.pose.v1", root: [0, 0.9, 0] };
	const FREE = { prompt: "A person walks", duration: 5, posePin: false };
	const PINNED = { prompt: "A person walks", duration: 5, poses: [{ frame: 0, pose: POSE }] };
	const OK_PRESERVE = { sourceMotion: MOTION, strength: 0.5, editRanges: [{ startFrame: 40, endFrame: 80 }] };

	async function post(body) {
		const response = await fetch(`http://127.0.0.1:${port}/ardy/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		// A refused request answers JSON; an accepted one opens an NDJSON stream.
		const text = await response.text();
		const first = text.split("\n").find(Boolean) ?? "";
		return { status: response.status, ...JSON.parse(first) };
	}

	async function refuses(label, body, pattern) {
		const { status, reason, message } = await post(body);
		const said = reason ?? message ?? "";
		try {
			assert.equal(status, 400, `${label} must be refused with 400, got ${status} (${said})`);
			assert.match(said, pattern, label);
			pass(label);
		} catch (error) {
			failures += 1;
			console.error(`FAIL ${error.message}`);
		}
	}

	// ---- shape ------------------------------------------------------------
	await refuses("preserve must be an object", { ...FREE, preserve: [] }, /field 'preserve' must be an object/);
	await refuses("preserve must not be a string", { ...FREE, preserve: "yes" }, /field 'preserve' must be an object/);
	await refuses("preserve must not be null", { ...FREE, preserve: null }, /field 'preserve' must be an object/);

	// ---- sourceMotion: the same URL shape every other take reference uses ---
	await refuses("sourceMotion is required", { ...FREE, preserve: { strength: 0.5, editRanges: [] } }, /'preserve\.sourceMotion'/);
	await refuses(
		"sourceMotion must be a motion URL",
		{ ...FREE, preserve: { ...OK_PRESERVE, sourceMotion: "/etc/passwd" } },
		/'preserve\.sourceMotion' must be a generated \/ardy\/motions\/<run-id> URL/,
	);
	await refuses(
		"sourceMotion must carry a well-formed run id",
		{ ...FREE, preserve: { ...OK_PRESERVE, sourceMotion: "/ardy/motions/../../etc" } },
		/'preserve\.sourceMotion'/,
	);

	// ---- strength ---------------------------------------------------------
	await refuses("strength is required", { ...FREE, preserve: { sourceMotion: MOTION, editRanges: [] } }, /'preserve\.strength'/);
	await refuses("strength 0 means omit the field", { ...FREE, preserve: { ...OK_PRESERVE, strength: 0 } }, /'preserve\.strength'/);
	await refuses("strength above 1", { ...FREE, preserve: { ...OK_PRESERVE, strength: 1.5 } }, /'preserve\.strength'/);
	await refuses("strength must be a number", { ...FREE, preserve: { ...OK_PRESERVE, strength: "0.5" } }, /'preserve\.strength'/);
	await refuses("strength must be finite", { ...FREE, preserve: { ...OK_PRESERVE, strength: Number.NaN } }, /'preserve\.strength'/);

	// ---- editRanges -------------------------------------------------------
	await refuses("editRanges is required", { ...FREE, preserve: { sourceMotion: MOTION, strength: 0.5 } }, /'preserve\.editRanges' must be an array/);
	await refuses("editRanges must be an array", { ...FREE, preserve: { ...OK_PRESERVE, editRanges: {} } }, /'preserve\.editRanges' must be an array/);
	await refuses(
		"a range must be an object",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [40] } },
		/'preserve\.editRanges\[0\]' must be an object/,
	);
	await refuses(
		"range frames must be integers",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40.5, endFrame: 80 }] } },
		/'preserve\.editRanges\[0\]' startFrame and endFrame must be integers/,
	);
	await refuses(
		"a range must be non-empty",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40, endFrame: 40 }] } },
		/'preserve\.editRanges\[0\]' must be a non-empty half-open range inside 0\.\.120/,
	);
	await refuses(
		"a range must not be inverted",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 80, endFrame: 40 }] } },
		/'preserve\.editRanges\[0\]'/,
	);
	await refuses(
		"a range must not start before the clip",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: -1, endFrame: 40 }] } },
		/'preserve\.editRanges\[0\]'/,
	);
	await refuses(
		"a range must not run past the clip",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 100, endFrame: 121 }] } },
		/'preserve\.editRanges\[0\]' must be a non-empty half-open range inside 0\.\.120/,
	);
	await refuses(
		"the offending range is named by index",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 0, endFrame: 10 }, { startFrame: 10, endFrame: 10 }] } },
		/'preserve\.editRanges\[1\]'/,
	);

	// ---- exclusivity ------------------------------------------------------
	await refuses(
		"preserve cannot ride with a prompt schedule",
		{
			...FREE,
			segments: [
				{ startFrame: 0, endFrame: 60, prompt: "A person walks" },
				{ startFrame: 60, endFrame: CLIP_FRAMES, prompt: "A person waves" },
			],
			preserve: OK_PRESERVE,
		},
		/scheduled inpainting v1 supports a single segment/,
	);
	await refuses(
		"preserve cannot ride with waypoints",
		{
			...FREE,
			waypoints: [
				{ frame: 0, x: 0, z: 0, heading: null },
				{ frame: 60, x: 3, z: 0, heading: null },
			],
			preserve: OK_PRESERVE,
		},
		/'preserve' cannot be combined with waypoints/,
	);
	await refuses(
		"preserve cannot ride with regenerateSegments",
		{
			...PINNED,
			sourceMotion: MOTION,
			regenerateSegments: [{ startFrame: 0, endFrame: 60, prompt: "A person walks" }],
			preserve: OK_PRESERVE,
		},
		/'preserve' cannot be combined with regenerateSegments/,
	);

	// ---- accepted ---------------------------------------------------------
	// Validation passing is proved by WHICH refusal comes next: the request gets
	// past validateGenerate and dies resolving the take it names, which no
	// synthetic run id can satisfy.
	{
		const { status, reason } = await post({ ...FREE, preserve: OK_PRESERVE });
		assert.equal(status, 400);
		assert.match(reason, /field 'preserve\.sourceMotion': unknown or expired motion "1700000000000-abcdef"/);
		pass("a well-formed preserve passes validation and is resolved against the motion allowlist");
	}
	{
		// An empty edit list is the whole-take reconstruction case (gate G1) and
		// must not be mistaken for a missing field.
		const { status, reason } = await post({ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [] } });
		assert.equal(status, 400);
		assert.match(reason, /unknown or expired motion/);
		pass("an empty edit list is valid: preserve the whole take");
	}
	{
		// Overlapping ranges are legal; the mask combines them by minimum.
		const overlapping = [{ startFrame: 20, endFrame: 60 }, { startFrame: 40, endFrame: 80 }];
		const { reason } = await post({ ...FREE, preserve: { ...OK_PRESERVE, editRanges: overlapping } });
		assert.match(reason, /unknown or expired motion/);
		pass("overlapping edit ranges are accepted");
	}
	{
		// The one combination the contract explicitly allows: an IK edit
		// regenerates a span of the very take preserve is reconstructing.
		const { status, reason } = await post({
			...PINNED,
			poses: undefined,
			motionEdit: {
				sourceMotion: MOTION,
				startFrame: 10,
				endFrame: 40,
				contextBefore: 8,
				contextAfter: 8,
				edits: [{ frame: 20, tracks: ["hips"], pose: POSE }],
			},
			preserve: OK_PRESERVE,
		});
		assert.equal(status, 400);
		assert.doesNotMatch(reason, /cannot be combined/, "motionEdit + preserve is the combination the feature exists for");
		assert.match(reason, /unknown or expired motion/);
		pass("preserve rides with motionEdit");
	}
	{
		// Nothing above may have disturbed a request that carries no preserve.
		const { status, reason } = await post({ ...FREE, duration: 0.05 });
		assert.equal(status, 400);
		assert.match(reason, /field 'duration' must be in /, "unrelated validation is unchanged");
		pass("requests without preserve validate exactly as before");
	}
} finally {
	bridge.kill("SIGTERM");
}

if (failures > 0) {
	console.error(`${failures} preserve bridge check(s) failed`);
	process.exit(1);
}
console.log("OK verify-preserve-bridge");
