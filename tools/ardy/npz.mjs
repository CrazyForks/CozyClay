/**
 * Pure-Node writer for numpy .npz archives: v1.0 .npy members inside a
 * STORED (uncompressed) zip. No numpy on the workstation and no new
 * dependencies -- .npy is a 10-byte prefix plus a little-endian float32
 * payload, and STORED zip keeps CRC-32 and sizes trivial to compute.
 *
 * The only consumer today is the ARDY constrained generator:
 *
 *   --pose-from <npz> <src-frame> <dst-frame>
 *
 * cclay_constrained_generate.load_poses reads exactly two float32 members,
 * local_rot_mats (frames, 27, 3, 3) and posed_joints (frames, 27, 3), then
 * runs its own FK. poseArraysToNpzMembers turns one CozyClay frame into
 * that exact 1-frame member set, so a hand-blocked pose can be materialized
 * as a standalone npz without ever hardcoding a rest skeleton: proportions
 * come from the base clip (deriveBoneOffsets) and the 8 joints CozyClay
 * does not author stay IDENTITY, i.e. "at ARDY rest".
 */
import { writeFileSync } from "node:fs";

const ZIP_LOCAL_SIG = 0x04034b50; // PK\x03\x04
const ZIP_CENTRAL_SIG = 0x02014b50; // PK\x01\x02
const ZIP_EOCD_SIG = 0x06054b50; // PK\x05\x06

// --- CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) ----------------

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

// --- .npy v1.0 -------------------------------------------------------------

/**
 * The ASCII dict header, matching numpy's own text byte for byte:
 *   {'descr': '<f4', 'fortran_order': False, 'shape': (1, 27, 3, 3), }
 * Shape tuples follow Python repr: `()` for 0-d, `(n,)` for a single
 * element, `(a, b, c)` otherwise.
 */
function npyHeader(shape, descr = "<f4") {
	const tuple =
		shape.length === 0 ? "()" : `(${shape.join(", ")}${shape.length === 1 ? "," : ""})`;
	const dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${tuple}, }`;
	// Pad so magic(6) + version(2) + len(2) + header is a multiple of 64,
	// i.e. the header-with-newline is 54 mod 64. numpy's loader only reads
	// the length field and ast.literal_eval's the dict, so it accepts either
	// alignment; this repo's convention is that the whole prefix aligns.
	const pad = (53 - (dict.length % 64) + 64) % 64;
	return dict + " ".repeat(pad) + "\n";
}

function buildNpy(data, shape) {
	const descr = data instanceof Float32Array ? "<f4" : data instanceof Int32Array ? "<i4" : null;
	if (!descr) throw new Error(`buildNpy: unsupported typed array ${data?.constructor?.name ?? typeof data}`);
	const header = npyHeader(shape, descr);
	const prefix = Buffer.alloc(10);
	prefix.writeUInt8(0x93, 0);
	prefix.write("NUMPY", 1, "ascii");
	prefix.writeUInt8(1, 6); // version 1.0
	prefix.writeUInt8(0, 7);
	prefix.writeUInt16LE(header.length, 8);
	// Float32Array is little-endian on every platform this repo runs on;
	// the view (not a copy) is safe: writeNpz builds the payload and the
	// archive in the same synchronous call.
	const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return Buffer.concat([prefix, Buffer.from(header, "ascii"), payload]);
}

// --- ZIP (STORED) -----------------------------------------------------------

/**
 * Build the archive: local headers + payloads, central directory, EOCD.
 * Every size is known up front, so the whole file is one Buffer.
 */
function buildZip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;
	for (const { name, payload } of entries) {
		const nameBuf = Buffer.from(name, "ascii");
		const crc = crc32(payload);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(ZIP_LOCAL_SIG, 0);
		local.writeUInt16LE(20, 4); // version needed to extract
		local.writeUInt16LE(0, 6); // general purpose flags
		local.writeUInt16LE(0, 8); // method: STORED
		local.writeUInt16LE(0, 10); // last mod time
		local.writeUInt16LE(0x21, 12); // last mod date (1980-01-01)
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18); // compressed size
		local.writeUInt32LE(payload.length, 22); // uncompressed size
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28); // extra field length
		chunks.push(local, nameBuf, payload);
		central.push({ name: nameBuf, crc, size: payload.length, offset });
		offset += 30 + nameBuf.length + payload.length;
	}
	const centralDirStart = offset;
	const centralChunks = [];
	let centralDirSize = 0;
	for (const entry of central) {
		const c = Buffer.alloc(46);
		c.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
		c.writeUInt16LE(20, 4); // version made by
		c.writeUInt16LE(20, 6); // version needed to extract
		c.writeUInt16LE(0, 8); // general purpose flags
		c.writeUInt16LE(0, 10); // method: STORED
		c.writeUInt16LE(0, 12); // last mod time
		c.writeUInt16LE(0x21, 14); // last mod date
		c.writeUInt32LE(entry.crc, 16);
		c.writeUInt32LE(entry.size, 20); // compressed size
		c.writeUInt32LE(entry.size, 24); // uncompressed size
		c.writeUInt16LE(entry.name.length, 28);
		c.writeUInt16LE(0, 30); // extra field length
		c.writeUInt16LE(0, 32); // file comment length
		c.writeUInt16LE(0, 34); // disk number start
		c.writeUInt16LE(0, 36); // internal attributes
		c.writeUInt32LE(0, 38); // external attributes
		c.writeUInt32LE(entry.offset, 42); // local header offset
		centralChunks.push(c, entry.name);
		centralDirSize += 46 + entry.name.length;
	}
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(ZIP_EOCD_SIG, 0);
	eocd.writeUInt16LE(0, 4); // disk number
	eocd.writeUInt16LE(0, 6); // disk with central directory
	eocd.writeUInt16LE(entries.length, 8); // entries on this disk
	eocd.writeUInt16LE(entries.length, 10); // total entries
	eocd.writeUInt32LE(centralDirSize, 12);
	eocd.writeUInt32LE(centralDirStart, 16);
	eocd.writeUInt16LE(0, 20); // comment length
	return Buffer.concat([...chunks, ...centralChunks, eocd]);
}

// --- public API -------------------------------------------------------------

/**
 * Write a numpy .npz archive: one STORED zip entry `<key>.npy` per member.
 * Each member is { data: Float32Array, shape: number[] } in C order.
 * Throws on an empty member set, a member whose shape product does not
 * match its data length, a non-finite value, or a member name that would
 * not make a flat zip entry.
 */
export function writeNpz(path, arrays) {
	const names = Object.keys(arrays);
	if (names.length === 0) {
		throw new Error("writeNpz: refusing to write an npz with no members");
	}
	const entries = names.map((name) => {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
			throw new Error(`writeNpz: invalid member name ${JSON.stringify(name)}`);
		}
		const member = arrays[name];
		if (
			!member ||
			(!(member.data instanceof Float32Array) && !(member.data instanceof Int32Array)) ||
			!Array.isArray(member.shape)
		) {
			throw new Error(
				`writeNpz: member ${JSON.stringify(name)} must be { data: Float32Array|Int32Array, shape: number[] }`
			);
		}
		const { data, shape } = member;
		const size = shape.reduce((n, d) => n * d, 1);
		if (size !== data.length) {
			throw new Error(
				`writeNpz: member ${JSON.stringify(name)} shape ${JSON.stringify(shape)} ` +
					`has ${size} elements but data has ${data.length}`
			);
		}
		for (let i = 0; i < data.length; i += 1) {
			if (!Number.isFinite(data[i])) {
				throw new Error(
					`writeNpz: member ${JSON.stringify(name)}[${i}] is not finite: ${data[i]}`
				);
			}
		}
		return { name: `${name}.npy`, payload: buildNpy(data, shape) };
	});
	writeFileSync(path, buildZip(entries));
}

/**
 * Turn one CozyClay frame of plain nested arrays into the exact 1-frame
 * members load_poses expects: local_rot_mats [1, 27, 3, 3] and posed_joints
 * [1, 27, 3], both float32 C order. Inputs are the ardy.frame.v1 fixture
 * shapes: local_rot_mats [27][3][3] and posed_joints [27][3]. The leading 1
 * is the frames axis, so the generator's `[frame]` / `[frame, root_idx]`
 * indexing works unchanged.
 */
export function poseArraysToNpzMembers({ local_rot_mats, posed_joints }) {
	return {
		local_rot_mats: {
			data: flattenToF32(local_rot_mats, [27, 3, 3], "local_rot_mats"),
			shape: [1, 27, 3, 3],
		},
		posed_joints: {
			data: flattenToF32(posed_joints, [27, 3], "posed_joints"),
			shape: [1, 27, 3],
		},
	};
}

/**
 * Depth-first flatten of a nested number array against an expected shape.
 * Throws on a structural mismatch or a non-finite value so a bad pose can
 * never silently serialize.
 */
function flattenToF32(value, dims, name) {
	const out = [];
	const walk = (node, depth, path) => {
		if (depth === dims.length) {
			if (typeof node !== "number") {
				throw new Error(
					`poseArraysToNpzMembers: ${name}${path} is not a number: ${node}`
				);
			}
			if (!Number.isFinite(node)) {
				throw new Error(
					`poseArraysToNpzMembers: ${name}${path} is not finite: ${node}`
				);
			}
			out.push(node);
			return;
		}
		if (!Array.isArray(node) || node.length !== dims[depth]) {
			throw new Error(
				`poseArraysToNpzMembers: ${name}${path} must be an array of length ` +
					`${dims[depth]} (expected shape ${JSON.stringify(dims)})`
			);
		}
		for (let i = 0; i < node.length; i += 1) walk(node[i], depth + 1, `${path}[${i}]`);
	};
	walk(value, 0, "");
	return Float32Array.from(out);
}


/** Convert decoded ARDY motion arrays into writer members. */
export function motionArraysToNpzMembers({ frames, fps, rotMats, rootPos, posedJoints }) {
	if (!Number.isInteger(frames) || frames < 1) throw new Error("motionArraysToNpzMembers: frames must be positive");
	if (!Number.isInteger(fps) || fps < 1) throw new Error("motionArraysToNpzMembers: fps must be positive");
	const requireLength = (array, length, label) => {
		if (!(array instanceof Float32Array) || array.length !== length) {
			throw new Error(`motionArraysToNpzMembers: ${label} must be Float32Array(${length})`);
		}
	};
	requireLength(rotMats, frames * 27 * 9, "rotMats");
	requireLength(rootPos, frames * 3, "rootPos");
	requireLength(posedJoints, frames * 27 * 3, "posedJoints");
	return {
		local_rot_mats: { data: rotMats, shape: [frames, 27, 3, 3] },
		root_positions: { data: rootPos, shape: [frames, 3] },
		posed_joints: { data: posedJoints, shape: [frames, 27, 3] },
		fps: { data: Int32Array.of(fps), shape: [] },
	};
}

/** Concatenate contiguous, already world-aligned generated blocks. */
export function stitchMotionSegments(segments) {
	if (!Array.isArray(segments) || segments.length === 0) {
		throw new Error("stitchMotionSegments: at least one segment is required");
	}
	const fps = segments[0].fps;
	if (!segments.every((segment) => segment.fps === fps)) {
		throw new Error("stitchMotionSegments: every segment must use the same fps");
	}
	const frames = segments.reduce((sum, segment) => sum + segment.frames, 0);
	const concat = (key, stride) => {
		const out = new Float32Array(frames * stride);
		let offset = 0;
		for (const segment of segments) {
			const values = segment[key];
			if (!(values instanceof Float32Array) || values.length !== segment.frames * stride) {
				throw new Error(`stitchMotionSegments: invalid ${key} length for ${segment.frames}-frame segment`);
			}
			out.set(values, offset);
			offset += values.length;
		}
		return out;
	};
	return {
		frames,
		fps,
		rotMats: concat("rotMats", 27 * 9),
		rootPos: concat("rootPos", 3),
		posedJoints: concat("posedJoints", 27 * 3),
	};
}

/** Return a copy of a motion with one equal-fps replacement written at startFrame. */
export function replaceMotionSegment(base, replacement, startFrame) {
	if (!Number.isInteger(startFrame) || startFrame < 0) {
		throw new Error("replaceMotionSegment: startFrame must be a non-negative integer");
	}
	if (!base || !replacement || base.fps !== replacement.fps) {
		throw new Error("replaceMotionSegment: motions must use the same fps");
	}
	if (startFrame + replacement.frames > base.frames) {
		throw new Error("replaceMotionSegment: replacement extends past the base motion");
	}
	const copyAndReplace = (key, stride) => {
		const source = base[key];
		const patch = replacement[key];
		if (
			!(source instanceof Float32Array) ||
			source.length !== base.frames * stride ||
			!(patch instanceof Float32Array) ||
			patch.length !== replacement.frames * stride
		) {
			throw new Error(`replaceMotionSegment: invalid ${key} array`);
		}
		const out = new Float32Array(source);
		out.set(patch, startFrame * stride);
		return out;
	};
	return {
		frames: base.frames,
		fps: base.fps,
		rotMats: copyAndReplace("rotMats", 27 * 9),
		rootPos: copyAndReplace("rootPos", 3),
		posedJoints: copyAndReplace("posedJoints", 27 * 3),
	};
}
