#!/usr/bin/env node
/**
 * The ingest host (plan §11, §12, §14.1 phase 3, commit H1).
 *
 * The conformance suite (test/providers/verify-envelope-conformance.mjs) runs
 * the shared envelope clauses against this host as a registered bridge. This
 * file covers what is host-specific and what the registry cannot express:
 *
 *  - the export-by-export audit that the host MOUNTS the envelope rather than
 *    reimplementing it. That is not pedantry: the ARDY bridge was twice caught
 *    re-deriving behaviour the envelope owned -- a lexical containment check a
 *    hard link walked past, and its own detached-child tracking -- and each fix
 *    had to be made twice. A second conformer that copies instead of mounting
 *    silently forfeits every fix the first one earned.
 *  - `--dry-run` opening ZERO connections. §14.1 words it that way deliberately:
 *    "no job ran" is a weaker claim than "no socket was opened", so this watches
 *    net.Server.listen and http.request rather than looking for side effects.
 *  - refusing to work with no GPU box instead of producing a confident empty
 *    result, which is the failure the whole Phase-0 decision record exists to
 *    prevent.
 */
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = [];
function ok(label, cond, detail = "") {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
}
const freePort = () =>
	new Promise((res) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// the host MOUNTS the envelope: export-by-export audit
// ---------------------------------------------------------------------------
{
	const src = readFileSync(join(REPO, "tools/ingest/host.mjs"), "utf8");
	const envelope = readFileSync(join(REPO, "tools/providers/envelope.mjs"), "utf8");
	const exports = [...envelope.matchAll(/^export (?:function|class|const) (\w+)/gm)].map((m) => m[1]);
	ok("the envelope still exports the clause set this audit walks", exports.length >= 10, exports.join(", "));

	const imported = new Set(
		(src.match(/import \{([^}]+)\} from "\.\.\/providers\/envelope\.mjs"/s)?.[1] ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	// Non-applicable clauses are declared, never silently skipped: this host is
	// same-origin-only on loopback and issues no session token of its own.
	const NOT_APPLICABLE = new Set(["requireSessionToken"]);
	for (const name of exports) {
		if (NOT_APPLICABLE.has(name)) {
			ok(`envelope ${name}: documented non-applicable`, true);
			continue;
		}
		ok(`envelope ${name} is imported, not reimplemented`, imported.has(name), [...imported].join(", "));
	}
	// The stronger half of the claim: no local clone of a mounted capability.
	ok("the host defines no local CORS writer", !/access-control-allow/i.test(src));
	ok("the host never builds a shell string for the box", !/exec\(|execSync|\{ *shell: *true/.test(src));
	ok("the host never joins a request path onto the artifact base", !/join\([^)]*req\.|join\([^)]*url\.pathname/.test(src));
}

// ---------------------------------------------------------------------------
// --dry-run opens ZERO connections
// ---------------------------------------------------------------------------
{
	const port = await freePort();
	// Instrument via a preload so host.mjs is still the MAIN module: running it
	// under `node -e` would leave process.argv[1] as the eval script, the
	// invoked-directly guard would never fire, and the probe would report zero
	// connections for a dry-run that never actually ran.
	const preload = join(tmpdir(), `cc-dryrun-${process.pid}.mjs`);
	writeFileSync(
		preload,
		[
			'import net from "node:net";',
			'import http from "node:http";',
			'let opened = 0;',
			'const origListen = net.Server.prototype.listen;',
			'net.Server.prototype.listen = function (...a) { opened += 1; return origListen.apply(this, a); };',
			'const origReq = http.request;',
			'http.request = function (...a) { opened += 1; return origReq.apply(this, a); };',
			'process.on("exit", () => { process.stdout.write("\\nOPENED=" + opened + "\\n"); });',
		].join("\n"),
	);
	const proc = spawn(process.execPath, ["--import", preload, "tools/ingest/host.mjs", "--dry-run", "--port", String(port)], {
		cwd: REPO,
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	proc.stdout.on("data", (c) => (out += c));
	proc.stderr.on("data", (c) => (out += c));
	const code = await new Promise((r) => proc.on("exit", r));
	rmSync(preload, { force: true });
	const opened = Number(/OPENED=(\d+)/.exec(out)?.[1] ?? -1);
	ok("--dry-run exits cleanly", code === 0, `code=${code}`);
	ok("--dry-run reports what it would do", /"dryRun":\s*true/.test(out), out.slice(0, 160));
	ok("--dry-run opened ZERO connections (no listen, no outbound request)", opened === 0, `opened=${opened}`);
}

// ---------------------------------------------------------------------------
// the live host: identity, health, refusal without a GPU box
// ---------------------------------------------------------------------------
{
	const port = await freePort();
	const home = mkdtempSync(join(tmpdir(), "cc-host-home-"));
	const proc = spawn(process.execPath, ["tools/ingest/host.mjs", "--port", String(port), "--home", home, "--app-origin", "http://127.0.0.1:5180"], {
		cwd: REPO,
		env: { ...process.env, CCLAY_INGEST_BOX: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let banner = "";
	proc.stdout.on("data", (c) => (banner += c));
	for (let i = 0; i < 50 && !/listening on/.test(banner); i += 1) await sleep(100);
	ok("the host announces a loopback origin", /listening on http:\/\/127\.0\.0\.1:/.test(banner), banner.trim().slice(0, 120));

	const base = `http://127.0.0.1:${port}`;
	const get = async (path, init) => {
		const res = await fetch(base + path, init);
		const text = await res.text();
		return { status: res.status, headers: res.headers, text };
	};

	const idRes = await get("/ingest/surface-origin");
	ok("surface-origin answers with its OWN origin (identity, not mere liveness)",
		idRes.status === 200 && JSON.parse(idRes.text).origin === base, idRes.text);

	const health = await get("/ingest/health");
	ok("health reports the GPU box as absent rather than claiming readiness",
		health.status === 200 && JSON.parse(health.text).gpu === false, health.text);

	// Stage a file, then ask to extract: the refusal must be explicit.
	const stage = await fetch(`${base}/ingest/stage`, { method: "POST", body: Buffer.from("fake-footage-bytes") });
	const stageBody = await stage.json();
	ok("a stage upload returns an opaque id", stage.status === 200 && /^[0-9a-f]{32}$/.test(stageBody.stageId), JSON.stringify(stageBody));

	const extract = await fetch(`${base}/ingest/extract`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ stageId: stageBody.stageId }),
	});
	const extractText = await extract.text();
	ok("extract REFUSES with no GPU box instead of faking a result",
		extract.status === 503 && /no GPU box configured/.test(extractText), `${extract.status} ${extractText.slice(0, 120)}`);

	// Unknown stage ids and malformed ids are distinguishable and both safe.
	const bad = await get("/ingest/stage/../../etc/passwd");
	ok("a traversal stage path never reaches the filesystem", bad.status === 400 || bad.status === 404, String(bad.status));

	const unknown = await get(`/ingest/artifacts/${"0".repeat(32)}`);
	ok("an unregistered artifact id is a clean 404", unknown.status === 404, String(unknown.status));

	// Discovery record, as the app-side consumers read it.
	const record = JSON.parse(readFileSync(join(home, ".config", "cozyclay", "ingest-host.json"), "utf8"));
	ok("the published discovery record carries origin, pid and appOrigin",
		record.origin === base && record.pid > 0 && record.appOrigin === "http://127.0.0.1:5180", JSON.stringify(record));

	proc.kill("SIGTERM");
	await new Promise((r) => proc.on("exit", r));
	rmSync(home, { recursive: true, force: true });
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
