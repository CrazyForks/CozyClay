#!/usr/bin/env node
/**
 * End-to-end proof that tools/ardy/npz.mjs writes bytes real numpy accepts.
 *
 * 1. A known-values npz (4-D non-symmetric member plus (n,) and () shapes)
 *    is written, then round-tripped through an INDEPENDENT parser written
 *    here from the zip/npy specs (EOCD -> central dir -> local header ->
 *    CRC-32 -> npy header -> payload), comparing every float exactly.
 * 2. The production shape -- fixtures/ardy-frame0.json via
 *    poseArraysToNpzMembers -- round-trips the same way.
 * 3. Both files are scp'd to /tmp on the ARDY box and np.load'd there with
 *    the real venv numpy; the reported shape/dtype and a position-weighted
 *    checksum must match. The box is part of the check: if it is
 *    unreachable the check FAILS loudly, it is never skipped.
 *
 * env:
 *   CCLAY_ARDY_HOST  ssh host of the ARDY box     (default 100.90.2.101)
 *   CCLAY_ARDY_VENV  venv python on the box       (default ~/ardy/.venv/bin/python)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { poseArraysToNpzMembers, writeNpz } from "../../tools/ardy/npz.mjs";

const HOST = process.env.CCLAY_ARDY_HOST || "100.90.2.101";
const VENV_PY = process.env.CCLAY_ARDY_VENV || "~/ardy/.venv/bin/python";
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

let failures = 0;
const ok = (label, cond, detail) => {
	if (cond) {
		console.log(`PASS  ${label}`);
	} else {
		failures += 1;
		console.log(`FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
	}
};

// --- independent reader (spec-derived, not imported from npz.mjs) -----------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Parse a STORED zip: EOCD -> central directory -> local header -> payload. */
function parseZip(bytes) {
	let eocd = -1;
	const scanStart = Math.max(0, bytes.length - 22 - 65535);
	for (let i = bytes.length - 22; i >= scanStart; i -= 1) {
		if (bytes.readUInt32LE(i) === ZIP_EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("no end-of-central-directory record");
	const count = bytes.readUInt16LE(eocd + 10);
	const members = new Map();
	let off = bytes.readUInt32LE(eocd + 16);
	for (let n = 0; n < count; n += 1) {
		if (bytes.readUInt32LE(off) !== ZIP_CENTRAL_SIG) {
			throw new Error(`central directory header ${n}: bad signature`);
		}
		const method = bytes.readUInt16LE(off + 10);
		const crc = bytes.readUInt32LE(off + 16);
		const size = bytes.readUInt32LE(off + 20);
		const nameLen = bytes.readUInt16LE(off + 28);
		const extraLen = bytes.readUInt16LE(off + 30);
		const commentLen = bytes.readUInt16LE(off + 32);
		const name = bytes.toString("ascii", off + 46, off + 46 + nameLen);
		const localOff = bytes.readUInt32LE(off + 42);
		if (method !== 0) throw new Error(`member ${name}: not STORED`);
		if (bytes.readUInt32LE(localOff) !== ZIP_LOCAL_SIG) {
			throw new Error(`member ${name}: bad local header signature`);
		}
		const localNameLen = bytes.readUInt16LE(localOff + 26);
		const localExtraLen = bytes.readUInt16LE(localOff + 28);
		const payload = bytes.subarray(
			localOff + 30 + localNameLen + localExtraLen,
			localOff + 30 + localNameLen + localExtraLen + size
		);
		if (crc32(payload) !== crc) throw new Error(`member ${name}: CRC-32 mismatch`);
		members.set(name, parseNpy(payload));
		off += 46 + nameLen + extraLen + commentLen;
	}
	if (members.size !== count) throw new Error("duplicate member names");
	return members;
}

/** Parse one .npy v1.0 payload into { shape, data: Float32Array }. */
function parseNpy(buf) {
	if (buf.length < 10 || buf[0] !== 0x93 || buf.toString("ascii", 1, 6) !== "NUMPY") {
		throw new Error("bad npy magic");
	}
	if (buf[6] !== 1 || buf[7] !== 0) throw new Error(`unsupported npy version ${buf[6]}.${buf[7]}`);
	const headerLen = buf.readUInt16LE(8);
	if ((10 + headerLen) % 64 !== 0) {
		throw new Error(`npy prefix (magic+version+len+header) is not 64-aligned: ${10 + headerLen}`);
	}
	const header = buf.toString("ascii", 10, 10 + headerLen);
	const m =
		/^\{'descr': '(<f4)', 'fortran_order': (True|False), 'shape': \((.*)\), \} *\n$/.exec(
			header
		);
	if (!m) throw new Error(`unparseable npy header: ${header.trim()}`);
	if (m[2] !== "False") throw new Error("fortran_order True is not supported");
	// group 3 is the tuple body; strip the trailing comma Python repr adds
	// for single-element shapes before splitting.
	const inner = m[3].replace(/,\s*$/, "");
	const shape = inner === "" ? [] : inner.split(",").map((s) => Number(s.trim()));
	const size = shape.reduce((n, d) => n * d, 1);
	const dataBytes = buf.subarray(10 + headerLen, 10 + headerLen + size * 4);
	if (dataBytes.length !== size * 4) {
		throw new Error(`npy payload truncated: want ${size * 4} bytes, have ${dataBytes.length}`);
	}
	// ArrayBuffer.slice copies, so the view never aliases the file buffer and
	// its byteOffset is 0 (typed-array views also require 4-byte alignment,
	// which a subarray into the zip stream does not guarantee).
	return { shape, data: new Float32Array(dataBytes.buffer.slice(dataBytes.byteOffset, dataBytes.byteOffset + dataBytes.byteLength)) };
}

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;

// --- helpers ----------------------------------------------------------------

const fmtShape = (s) =>
	s.length === 0 ? "()" : `(${s.join(", ")}${s.length === 1 ? "," : ""})`;

function exactMatch(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}

/** Sequential float64 sum of data[i] * (i + 1) -- same order and arithmetic
 * as the Python builtin sum over float(x) * i, so the box comparison is
 * expected to be bit-identical. */
function weightedSum(data) {
	let s = 0;
	for (let i = 0; i < data.length; i += 1) s += data[i] * (i + 1);
	return s;
}

const throws = (fn) => {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
};

// --- check 1: known-values npz, local round-trip -----------------------------

const QUAD = [2, 3, 4, 5];
const quadValues = [];
for (let i0 = 0; i0 < QUAD[0]; i0 += 1) {
	for (let i1 = 0; i1 < QUAD[1]; i1 += 1) {
		for (let i2 = 0; i2 < QUAD[2]; i2 += 1) {
			for (let i3 = 0; i3 < QUAD[3]; i3 += 1) {
				// Distinct coefficient per axis, sign flips with i3: no axis
				// can be swapped without changing the flat C-order sequence.
				quadValues.push((i0 + 7 * i1 + 13 * i2 + 29 * i3) * (i3 % 2 ? -1 : 1) + 0.25);
			}
		}
	}
}
const expected = {
	quad: { data: Float32Array.from(quadValues), shape: QUAD },
	single: { data: Float32Array.from([42.5]), shape: [1] }, // exercises (n,)
	scalar: { data: Float32Array.from([7.25]), shape: [] }, // exercises ()
};

	const dir = mkdtempSync(join(tmpdir(), "cozyclay-npz-verify-"));
const smallPath = join(dir, "known.npz");
const posePath = join(dir, "pose.npz");

let parsedSmall = null;
try {
	writeNpz(smallPath, expected);
	parsedSmall = parseZip(readFileSync(smallPath));
	ok("known npz: write + independent local round-trip", true);
} catch (err) {
	ok("known npz: write + independent local round-trip", false, err.message);
}
if (parsedSmall) {
	for (const key of ["quad", "single", "scalar"]) {
		const got = parsedSmall.get(`${key}.npy`);
		const want = expected[key];
		ok(
			`known npz: member ${key} (shape ${fmtShape(want.shape)}) matches exactly`,
			got !== undefined &&
				got.shape.length === want.shape.length &&
				got.shape.every((v, i) => v === want.shape[i]) &&
				exactMatch(got.data, want.data),
			got ? `parsed shape=${fmtShape(got.shape)}` : "member missing from zip"
		);
	}
}

// --- check 2: real production shape, local round-trip ------------------------

let poseMembers = null;
let parsedPose = null;
try {
	const fixture = JSON.parse(
		readFileSync(new URL("./fixtures/ardy-frame0.json", import.meta.url), "utf8")
	);
	poseMembers = poseArraysToNpzMembers(fixture);
	writeNpz(posePath, poseMembers);
	parsedPose = parseZip(readFileSync(posePath));
	ok("pose npz: fixture via poseArraysToNpzMembers + round-trip", true);
	const rot = parsedPose.get("local_rot_mats.npy");
	const pos = parsedPose.get("posed_joints.npy");
	ok(
		"pose npz: member shapes are [1,27,3,3] and [1,27,3]",
		rot !== undefined &&
			pos !== undefined &&
			rot.shape.join() === "1,27,3,3" &&
			pos.shape.join() === "1,27,3",
		rot && pos ? `rot=${fmtShape(rot.shape)} pos=${fmtShape(pos.shape)}` : "member missing"
	);
	ok(
		"pose npz: values match the writer input exactly",
		rot !== undefined &&
			pos !== undefined &&
			exactMatch(rot.data, poseMembers.local_rot_mats.data) &&
			exactMatch(pos.data, poseMembers.posed_joints.data)
	);
	// Pin the flatten direction against the raw fixture JSON: the first
	// float32 of each member must be the float32 rounding of the JSON's
	// first value, so a row/column transpose cannot hide.
	ok(
		"pose npz: flatten order matches the fixture JSON",
		rot !== undefined &&
			pos !== undefined &&
			rot.data[0] === Math.fround(fixture.local_rot_mats[0][0][0]) &&
			pos.data[0] === Math.fround(fixture.posed_joints[0][0]),
		rot && pos
			? `rot[0]=${rot.data[0]} pos[0]=${pos.data[0]}`
			: "member missing"
	);
} catch (err) {
	ok("pose npz: fixture via poseArraysToNpzMembers + round-trip", false, err.message);
}

// --- check 3: loud throws -----------------------------------------------------

ok("throws: empty member set", throws(() => writeNpz(join(dir, "empty.npz"), {})));
ok(
	"throws: shape/data length mismatch",
	throws(() =>
		writeNpz(join(dir, "bad-length.npz"), {
			x: { data: Float32Array.from([1, 2]), shape: [3] },
		})
	)
);
ok(
	"throws: non-finite value",
	throws(() =>
		writeNpz(join(dir, "bad-finite.npz"), {
			x: { data: Float32Array.from([1, NaN]), shape: [2] },
		})
	)
);
{
	const badRot = Array.from({ length: 27 }, () =>
		Array.from({ length: 3 }, () => [0, 0, 0])
	);
	badRot[10][1][2] = Infinity;
	ok(
		"throws: non-finite pose input",
		throws(() =>
			poseArraysToNpzMembers({
				local_rot_mats: badRot,
				posed_joints: Array.from({ length: 27 }, () => [0, 0, 0]),
			})
		)
	);
}

// --- check 4: real numpy on the box -------------------------------------------

	const remoteTag = `cozyclay-npz-verify-${process.pid}-${Date.now()}`;
const remoteSmall = `/tmp/${remoteTag}-known.npz`;
const remotePose = `/tmp/${remoteTag}-pose.npz`;
let remoteRan = false;
let remoteTable = "";
try {
	execFileSync("scp", [...SSH, smallPath, `${HOST}:${remoteSmall}`], { stdio: "pipe" });
	execFileSync("scp", [...SSH, posePath, `${HOST}:${remotePose}`], { stdio: "pipe" });
	// Sequential float64 weighted sum on the numpy side: same left-to-right
	// order as weightedSum() above, so the comparison is bit-for-bit.
	const script = [
		"import sys",
		"import numpy as np",
		"for path in sys.argv[1:]:",
		"    with np.load(path) as z:",
		"        for name in z.files:",
		"            a = z[name]",
		"            w = sum((float(x) * i) for i, x in enumerate(a.ravel(), 1))",
		'            print(f"{path}\\t{name}\\t{a.shape}\\t{a.dtype}\\t{w:.17g}")',
	].join("\n");
	const out = execFileSync(
		"ssh",
		[...SSH, HOST, `${VENV_PY} - ${remoteSmall} ${remotePose}`],
		{ input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000 }
	);
	remoteRan = true;
	remoteTable = out.trim();
	const expect = [
		{ file: remoteSmall, name: "quad", shape: "(2, 3, 4, 5)", sum: weightedSum(expected.quad.data) },
		{ file: remoteSmall, name: "single", shape: "(1,)", sum: weightedSum(expected.single.data) },
		{ file: remoteSmall, name: "scalar", shape: "()", sum: weightedSum(expected.scalar.data) },
		{ file: remotePose, name: "local_rot_mats", shape: "(1, 27, 3, 3)", sum: weightedSum(poseMembers.local_rot_mats.data) },
		{ file: remotePose, name: "posed_joints", shape: "(1, 27, 3)", sum: weightedSum(poseMembers.posed_joints.data) },
	];
	for (const e of expect) {
		const line = remoteTable
			.split("\n")
			.find((l) => l.startsWith(`${e.file}\t${e.name}\t`));
		let detail = line ?? "no output line from numpy";
		let matches = false;
		if (line) {
			const [, , shape, dtype, sumStr] = line.split("\t");
			matches =
				shape === e.shape &&
				dtype === "float32" &&
				Math.abs(parseFloat(sumStr) - e.sum) <= Math.max(1, Math.abs(e.sum)) * 1e-12;
			detail = `numpy: shape=${shape} dtype=${dtype} weighted=${sumStr}`;
		}
		ok(`remote numpy: ${basename(e.file)}:${e.name}`, matches, detail);
	}
} catch (err) {
	ok("remote numpy: scp + np.load readback on the box", false, err.message);
}
ok("remote numpy: check actually ran on the box", remoteRan);
if (remoteRan) console.log(`remote numpy table:\n${remoteTable}`);

// --- cleanup -------------------------------------------------------------------

try {
	execFileSync("ssh", [...SSH, HOST, `rm -f ${remoteSmall} ${remotePose}`], {
		stdio: "pipe",
		timeout: 30000,
	});
	console.log("cleaned up remote temp files");
} catch (err) {
	console.log(`WARN  remote cleanup failed: ${err.message}`);
}
rmSync(dir, { recursive: true, force: true });

console.log(`\nfailures: ${failures}`);
process.exit(failures ? 1 : 0);
