#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ardy-setup-path-"));
try {
	const outside = join(root, "outside");
	const dest = join(root, "dest");
	mkdirSync(outside);
	mkdirSync(dest);
	symlinkSync(outside, join(dest, "NousResearch"));

	const result = spawnSync("python3", ["tools/ardy/setup-text-encoder.py", "--dest", dest, "--verify-only"], {
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(`${result.stdout}\n${result.stderr}`, /path traversal detected/);
	console.log("setup-text-encoder rejects symlinked manifest paths outside --dest");
} finally {
	rmSync(root, { recursive: true, force: true });
}
