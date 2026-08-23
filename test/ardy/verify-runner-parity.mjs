#!/usr/bin/env node
/**
 * Local/remote runner option parity for sequenceCommand.
 *
 * The bridge (tools/ardy/bridge.mjs) forwards rootMargin, contactThreshold
 * and historyFrames from the request body into runner.sequenceCommand for
 * BOTH backends. The remote runner (run-sequence-on-box.sh) translates them
 * into the Python generator's argparse flags, one of which is spelled with
 * an underscore rather than a dash:
 *
 *   --root-margin <float>       (postprocess_kwargs.root_margin)
 *   --contact-threshold <float> (postprocess_kwargs.contact_threshold)
 *   --history_frames <int>      (args.history_frames; underscore, matches
 *                                cclay_sequence_generate.py's argparse dest)
 *
 * run-local.mjs passes unknown flags straight through to the same Python
 * generator (no shell-side renaming layer), so the local runner must emit
 * the identical Python-facing flag spelling. This test pins that both
 * runners' sequenceCommand() include --history_frames 80 when
 * historyFrames:80 is passed, and omit it (letting Python's
 * _default_history_frames() dynamic default apply) when it is absent.
 *
 * No real generation and no network: the local runner's sequenceCommand
 * never spawns the generator itself (it only returns a command descriptor
 * for the bridge to spawn later), so the only side effects to neutralize
 * are its setup check (requireSetup) and its worker-readiness probe
 * (ensureBackends -> ensureWorker -> workerStatus, a loopback TCP ping).
 * Both are satisfied here with a fake venv path and a stub TCP server
 * answering the worker ping locally, in-process. The remote runner's
 * sequenceCommand is synchronous and does no I/O at all.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

// --- stand up a fake local ARDY checkout so requireSetup() passes -------
const fakeDir = mkdtempSync(join(tmpdir(), "cozyclay-ardy-fake-"));
const fakeVenvPy = join(fakeDir, "fake-python");
writeFileSync(fakeVenvPy, "#!/usr/bin/env node\n"); // existence is all requireSetup checks
chmodSync(fakeVenvPy, 0o755); // never actually spawned (the worker stub answers first), but keep it a valid executable

// --- stub worker: answers the ping local.mjs's workerStatus() sends, so
// ensureWorker() short-circuits without spawning anything -----------------
const WORKER_PORT = 19552; // fixed, unlikely-collision port for this test only
const stubWorker = createServer((sock) => {
	sock.on("data", () => sock.write("worker: pong"));
	sock.on("error", () => {}); // client-side destroy() after reading the reply is expected
});
stubWorker.on("error", (err) => {
	throw new Error(`stub worker TCP listener failed: ${err.message}`);
});
await new Promise((resolveListen) => stubWorker.listen(WORKER_PORT, "127.0.0.1", resolveListen));

process.env.CCLAY_ARDY_LOCAL_DIR = fakeDir;
process.env.CCLAY_ARDY_LOCAL_VENV = fakeVenvPy;
process.env.CCLAY_ARDY_WORKER_PORT = String(WORKER_PORT);
process.env.CCLAY_ARDY_PREWARM = "0"; // no background prewarm spawn at import time

const { createLocalRunner } = await import("../../tools/ardy/runners/local.mjs");
const localRunner = createLocalRunner();

const baseRequest = {
	segments: [{ prompt: "walk forward", durationS: 2 }],
	waypoints: [],
	seed: 7,
	cpu: false,
	output: "/tmp/out.npz",
};

const localWith = await localRunner.sequenceCommand({ ...baseRequest, historyFrames: 80 });
const localWithout = await localRunner.sequenceCommand({ ...baseRequest });

expect(
	"local sequenceCommand includes --history_frames 80 when historyFrames:80 is passed",
	(() => {
		const idx = localWith.args.indexOf("--history_frames");
		return idx !== -1 && localWith.args[idx + 1] === "80";
	})()
);
expect(
	"local sequenceCommand omits --history_frames when historyFrames is absent",
	!localWith.args.includes("--history-frames") && // never the dashed spelling
	!localWithout.args.includes("--history_frames") &&
	!localWithout.args.includes("--history-frames")
);
const localWithMargins = await localRunner.sequenceCommand({
	...baseRequest,
	rootMargin: 0.05,
	contactThreshold: 0.6,
});
stubWorker.close();
expect(
	"local sequenceCommand forwards --root-margin and --contact-threshold when present",
	(() => {
		const mIdx = localWithMargins.args.indexOf("--root-margin");
		const cIdx = localWithMargins.args.indexOf("--contact-threshold");
		return mIdx !== -1 && localWithMargins.args[mIdx + 1] === "0.05" &&
			cIdx !== -1 && localWithMargins.args[cIdx + 1] === "0.6";
	})()
);

// --- remote runner: sequenceCommand is synchronous and does no I/O -------
process.env.CCLAY_ARDY_HOST = "test-user@test-host";
const { createRemoteRunner } = await import("../../tools/ardy/runners/remote.mjs");
const remoteRunner = createRemoteRunner();

const remoteWith = remoteRunner.sequenceCommand({ ...baseRequest, historyFrames: 80 });
const remoteWithout = remoteRunner.sequenceCommand({ ...baseRequest });

expect(
	"remote sequenceCommand includes --history-frames 80 (shell-facing flag) when historyFrames:80 is passed",
	(() => {
		const idx = remoteWith.args.indexOf("--history-frames");
		return idx !== -1 && remoteWith.args[idx + 1] === "80";
	})()
);
expect(
	"remote sequenceCommand omits --history-frames when historyFrames is absent",
	!remoteWithout.args.includes("--history-frames")
);

// --- the shell wrapper is the layer that renames --history-frames (shell
// flag) to --history_frames (Python argparse dest) on its way to the box;
// pin that translation so remote's Python-facing argv matches local's. ---
import { readFileSync } from "node:fs";
const runnerScript = readFileSync(
	new URL("../../tools/ardy/run-sequence-on-box.sh", import.meta.url),
	"utf8"
);
expect(
	"run-sequence-on-box.sh translates --history-frames into Python's --history_frames",
	runnerScript.includes('--history-frames)') &&
	runnerScript.includes('cmd+=" --history_frames $(printf \'%q\' "$HISTORY_FRAMES")"')
);

if (failures) {
	console.log(`${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("all ARDY runner parity checks PASS");
