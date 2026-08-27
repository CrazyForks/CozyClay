#!/usr/bin/env node
/**
 * Research-only harness (autoresearch mission kimodo-segment-continuity).
 * Generates one two-segment Kimodo take and prints seam-continuity METRIC lines.
 * Never touches product code; imports CozyClay tooling read-only.
 *
 * usage: harness.mjs --seg "<prompt>" <seconds> --seg "<prompt>" <seconds> \
 *          [--seed N] [--transition N] [--out /path.npz]
 * exit 0 on success, non-zero on failure.
 */
import { spawn } from "node:child_process";
import { readNpz } from "/Users/yun/test3/CozyClay/tools/kimodo/read-npz.mjs";
import { seamReport } from "/Users/yun/test3/CozyClay/tools/kimodo/compare-seam.mjs";

const args = process.argv.slice(2);
const segs = [];
let seed = 7;
let transition = 5;
let out = `/tmp/kimodo-research/take-${Date.now()}.npz`;
for (let i = 0; i < args.length; i += 1) {
	if (args[i] === "--seg") { segs.push({ prompt: args[i + 1], s: Number(args[i + 2]) }); i += 2; }
	else if (args[i] === "--seed") seed = Number(args[++i]);
	else if (args[i] === "--transition") transition = Number(args[++i]);
	else if (args[i] === "--out") out = args[++i];
	else { console.error(`unknown arg ${args[i]}`); process.exit(2); }
}
if (segs.length < 1) { console.error("need at least one --seg"); process.exit(2); }

const cmd = ["/Users/yun/test3/CozyClay/tools/kimodo/run-sequence-on-box.mjs"];
for (const seg of segs) cmd.push("--segment", seg.prompt, String(seg.s));
cmd.push("--seed", String(seed), "--output", out);

const child = spawn(process.execPath, cmd, {
	env: {
		...process.env,
		CCLAY_KIMODO_HOST: process.env.CCLAY_KIMODO_HOST || "yun@ubuntu-baremetal",
		CCLAY_KIMODO_TRANSITION_FRAMES: String(transition),
	},
	stdio: ["ignore", "pipe", "inherit"],
});
let stdout = "";
child.stdout.on("data", (c) => { stdout += c; });
const code = await new Promise((resolve) => child.on("close", resolve));
if (code !== 0) { console.error(`generation failed (exit ${code})`); process.exit(1); }

const meta = JSON.parse(stdout.split("\n").filter((l) => l.startsWith("{")).pop());
const members = readNpz(out);
const root = members.root_positions;
const frames = root.shape[0];
const fps = meta.fps;
const boundary = segs.length > 1 ? meta.boundaries[0] : Math.round(frames / 2);
const report = seamReport(root.data, frames, fps, boundary);

// Whole-clip worst per-frame jump in metres (teleport detector).
let maxJump = 0;
for (let f = 1; f < frames; f += 1) {
	const a = f * 3, b = (f - 1) * 3;
	maxJump = Math.max(maxJump, Math.hypot(
		root.data[a] - root.data[b], root.data[a + 1] - root.data[b + 1], root.data[a + 2] - root.data[b + 2]));
}

console.log(`ASI file=${out} frames=${frames} fps=${fps} boundary=${boundary} transition=${transition} seed=${seed}`);
console.log(`METRIC stall_ratio=${report.stall_ratio === null ? "nan" : report.stall_ratio.toFixed(4)}`);
console.log(`METRIC seam_min_mps=${report.seam_min_speed_mps.toFixed(4)}`);
console.log(`METRIC seam_max_mps=${report.seam_max_speed_mps.toFixed(4)}`);
console.log(`METRIC cruise_mps=${report.cruise_speed_mps.toFixed(4)}`);
console.log(`METRIC max_jump_m=${maxJump.toFixed(4)}`);
process.exit(0);
