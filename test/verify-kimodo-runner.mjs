import assert from "node:assert/strict";
import { createRunner } from "../tools/ardy/runners/index.mjs";
import { createKimodoRunner } from "../tools/kimodo/runner.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const SAVED = { ...process.env };
function withEnv(env, body) {
	for (const key of ["CCLAY_MOTION_BACKEND", "CCLAY_ARDY_HOST", "CCLAY_ARDY_MODE", "CCLAY_KIMODO_HOST"]) {
		delete process.env[key];
	}
	Object.assign(process.env, env);
	try {
		return body();
	} finally {
		for (const key of ["CCLAY_MOTION_BACKEND", "CCLAY_ARDY_HOST", "CCLAY_ARDY_MODE", "CCLAY_KIMODO_HOST"]) {
			delete process.env[key];
		}
		Object.assign(process.env, SAVED);
	}
}

const BOX = { CCLAY_ARDY_HOST: "user@box" };

// ---- ARDY stays the default -----------------------------------------------
// The whole point of the seam is that an existing install is untouched until
// the operator opts in, so this is the assertion that must never regress.
assert.equal(withEnv(BOX, () => createRunner().mode), "remote");
assert.equal(withEnv({ CCLAY_ARDY_MODE: "local" }, () => createRunner().mode), "local");
assert.equal(withEnv({ ...BOX, CCLAY_MOTION_BACKEND: "ardy" }, () => createRunner().mode), "remote");
pass("ARDY remains the default backend and its local/remote choice is unchanged");

// ---- opting in ------------------------------------------------------------
assert.equal(withEnv({ ...BOX, CCLAY_MOTION_BACKEND: "kimodo" }, () => createRunner().mode), "kimodo");
assert.equal(withEnv({ ...BOX, CCLAY_MOTION_BACKEND: "KIMODO" }, () => createRunner().mode), "kimodo");
pass("CCLAY_MOTION_BACKEND=kimodo selects the Kimodo runner");

// ---- a typo must not silently fall back to ARDY ---------------------------
assert.throws(
	() => withEnv({ ...BOX, CCLAY_MOTION_BACKEND: "kimono" }, () => createRunner()),
	/unknown CCLAY_MOTION_BACKEND "kimono"/
);
pass("an unknown backend name is refused instead of silently using ARDY");

// ---- the Kimodo runner satisfies the interface the bridge calls -----------
const runner = withEnv({ ...BOX, CCLAY_MOTION_BACKEND: "kimodo" }, () => createRunner());
for (const method of ["probeHealth", "listBases", "singleCommand", "sequenceCommand", "editCommand"]) {
	assert.equal(typeof runner[method], "function", `runner must expose ${method}`);
}
assert.equal(typeof runner.describe(), "string");
pass("the Kimodo runner exposes every method bridge.mjs calls");

// ---- sequenceCommand is spawnable and matches its own doneRe --------------
const cmd = runner.sequenceCommand({
	segments: [
		{ prompt: "A person runs forward", durationS: 3 },
		{ prompt: "A person walks", durationS: 2 },
	],
	seed: 7,
	output: "/tmp/out.npz",
});
assert.ok(cmd.args.includes("--segment"));
assert.ok(cmd.args.includes("A person runs forward"));
assert.ok(cmd.args.includes("--output") && cmd.args.includes("/tmp/out.npz"));
assert.ok(cmd.args.includes("--seed") && cmd.args.includes("7"));
assert.match("run-kimodo-sequence: done - /tmp/out.npz (12 bytes)", cmd.doneRe);
// The bridge parses the path and byte count out of that line.
const parsed = cmd.doneRe.exec("run-kimodo-sequence: done - /tmp/out.npz (12 bytes)");
assert.equal(parsed[1], "/tmp/out.npz");
assert.equal(parsed[2], "12");
pass("sequenceCommand builds a spawnable command whose done line the bridge can parse");

// ---- root waypoints are forwarded, not refused ----------------------------
// They become a Kimodo root2d constraint downstream. The --root-2d tokens must
// match the ARDY wrapper's shape so the bridge stays backend-agnostic, and a
// null heading must serialise as the literal "none" rather than "null".
const pathed = runner.sequenceCommand({
	segments: [{ prompt: "A person walks", durationS: 3 }],
	waypoints: [
		{ frame: 0, x: 0, z: 0, heading: null },
		{ frame: 30, x: 1.5, z: 2, heading: 0.5 },
	],
	output: "/tmp/o.npz",
});
const rootFlagAt = pathed.args.indexOf("--root-2d");
assert.ok(rootFlagAt >= 0, "waypoints must reach the CLI as --root-2d");
assert.deepEqual(pathed.args.slice(rootFlagAt, rootFlagAt + 5), ["--root-2d", "0", "0", "0", "none"]);
assert.equal(pathed.args.filter((a) => a === "--root-2d").length, 2, "every waypoint must be forwarded");
assert.ok(pathed.args.includes("0.5"), "an authored heading must survive as a number");
pass("root waypoints are forwarded as --root-2d instead of refused");

// ---- unsupported paths STILL refuse by name -------------------------------
// Silently generating a take that ignored a pinned pose would be worse than
// refusing. This guards the waypoint work from unlocking constraint paths that
// were never built.
assert.throws(() => runner.editCommand({}), /does not implement motion edit/);
assert.throws(
	() => runner.singleCommand({ prompt: "x", durationS: 1, basePath: "/base.npz", output: "/tmp/o.npz" }),
	/does not implement base clips/
);
pass("ARDY-only features refuse by name rather than generating a wrong take");

// ---- pinned poses are forwarded, not refused ------------------------------
// They become Kimodo `fullbody` constraints downstream. Each pose reaches the
// CLI as its npz path plus the clip frame to pin it at.
const pinned = runner.singleCommand({
	prompt: "A person kneels",
	durationS: 4,
	poseFroms: [
		{ npz: "/tmp/pose-a.npz", srcFrame: 0, dstFrame: 40 },
		{ npz: "/tmp/pose-b.npz", srcFrame: 0, dstFrame: 70 },
	],
	output: "/tmp/o.npz",
});
const poseAt = pinned.args.indexOf("--pose");
assert.ok(poseAt >= 0, "pinned poses must reach the CLI as --pose");
assert.deepEqual(pinned.args.slice(poseAt, poseAt + 3), ["--pose", "/tmp/pose-a.npz", "40"]);
assert.equal(pinned.args.filter((a) => a === "--pose").length, 2, "every pinned pose must be forwarded");
assert.ok(pinned.args.includes("/tmp/pose-b.npz") && pinned.args.includes("70"));
pass("pinned poses are forwarded as --pose instead of refused");

// ---- a single prompt is a one-segment sequence ----------------------------
const single = runner.singleCommand({ prompt: "A person waves", durationS: 2, output: "/tmp/o.npz" });
assert.ok(single.args.includes("A person waves"));
assert.equal(single.args.filter((a) => a === "--segment").length, 1);
pass("singleCommand degenerates to a one-segment sequence");

// ---- the backend needs a host ---------------------------------------------
assert.throws(
	() => withEnv({ CCLAY_MOTION_BACKEND: "kimodo" }, () => createKimodoRunner()),
	/CCLAY_KIMODO_HOST \(or CCLAY_ARDY_HOST\) is required/
);
pass("the Kimodo backend refuses to start without a configured box");

console.log("OK verify-kimodo-runner");
