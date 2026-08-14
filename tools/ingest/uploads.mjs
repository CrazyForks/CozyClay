// Staged uploads (plan §11, commit H2).
//
// This is the feature's highest-risk untrusted-input surface: it is how a user's
// footage reaches a box that also holds model weights. Three properties do the
// work, and each exists because the alternative has already failed in this repo.
//
//  1. Ids are OPAQUE and generated here. A client-supplied path never reaches
//     the filesystem, so traversal is not "sanitised" -- it is unrepresentable.
//  2. Containment is by IDENTITY, not location. The artifact allowlist in
//     tools/providers/envelope.mjs already learned this the hard way: a symlink
//     is caught by realpath, but a HARD LINK is the same inode at a legitimate
//     inside path, so a path-only check reports containment while serving the
//     outside file's bytes. A DIRECTORY in place of a file passes containment
//     too, then fails the read with EISDIR after a 200 is already committed,
//     hanging the client. Reusing that allowlist inherits both fixes rather
//     than re-deriving them.
//  3. Everything is BOUNDED: per-stage bytes, total bytes, concurrent stages,
//     and a TTL. An unbounded staging area on the GPU box is a disk-exhaustion
//     vector, and an un-expired one is an indefinite copy of the user's footage.
//
// Failures are named and thrown before any status is committed, because a
// committed 200 followed by a failed read is the one response a client cannot
// recover from.

import { randomBytes } from "node:crypto";
import { createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createArtifactAllowlist } from "../providers/envelope.mjs";

export class UploadError extends Error {
	constructor(code, message) {
		super(`uploads: ${code} ${message}`);
		this.code = code;
	}
}

export const UPLOAD_DEFAULTS = {
	maxStageBytes: 512 * 1024 * 1024,
	maxTotalBytes: 4 * 1024 * 1024 * 1024,
	maxStages: 16,
	ttlMs: 60 * 60 * 1000,
};

// 128 bits of opaque id. Hex only, so an id can never be mistaken for or coerced
// into a path fragment; the validator below is the single place that decides
// what an id may look like.
const ID_BYTES = 16;
const ID_RE = /^[0-9a-f]{32}$/;

export function isStageId(value) {
	return typeof value === "string" && ID_RE.test(value);
}

export function createUploadStore({
	base,
	maxStageBytes = UPLOAD_DEFAULTS.maxStageBytes,
	maxTotalBytes = UPLOAD_DEFAULTS.maxTotalBytes,
	maxStages = UPLOAD_DEFAULTS.maxStages,
	ttlMs = UPLOAD_DEFAULTS.ttlMs,
	now = () => Date.now(),
} = {}) {
	if (typeof base !== "string" || base.length === 0) {
		throw new UploadError("BASE-MISSING", "a staging base directory is required");
	}
	mkdirSync(base, { recursive: true, mode: 0o700 });

	// The allowlist owns containment and identity; this module owns lifetime and
	// caps. Splitting them keeps one implementation of the containment contract.
	const allow = createArtifactAllowlist({ base, max: maxStages });
	const stages = new Map(); // id -> { path, bytes, expiresAt }
	let totalBytes = 0;

	const dropStage = (id) => {
		const stage = stages.get(id);
		if (stage === undefined) return;
		stages.delete(id);
		totalBytes -= stage.bytes;
		try {
			rmSync(stage.path, { force: true });
		} catch {
			/* already gone: the accounting above is what matters */
		}
	};

	// Expiry is evaluated on every access rather than on a timer: a timer would
	// let an expired stage stay readable until it happened to fire, and the
	// whole point of the TTL is that the footage stops being readable when it
	// says it does.
	const sweep = () => {
		const t = now();
		for (const [id, stage] of stages) {
			if (stage.expiresAt <= t) dropStage(id);
		}
	};

	return {
		/** Accept bytes as a new stage. Returns the opaque id. */
		put(bytes, { filename } = {}) {
			sweep();
			if (!Buffer.isBuffer(bytes)) {
				throw new UploadError("BODY-TYPE", "a stage body must be a Buffer");
			}
			if (bytes.length === 0) {
				throw new UploadError("BODY-EMPTY", "a stage body must not be empty");
			}
			if (bytes.length > maxStageBytes) {
				throw new UploadError("STAGE-TOO-LARGE", `${bytes.length} bytes exceeds the ${maxStageBytes} per-stage cap`);
			}
			if (stages.size >= maxStages) {
				throw new UploadError("STAGE-LIMIT", `${maxStages} concurrent stages already exist`);
			}
			if (totalBytes + bytes.length > maxTotalBytes) {
				throw new UploadError("TOTAL-TOO-LARGE", `staging total would exceed the ${maxTotalBytes} byte cap`);
			}
			// The id is generated, never derived from `filename`. The caller's
			// name is metadata only and never touches the filesystem, so a
			// traversal or absolute path in it cannot escape anything.
			const id = randomBytes(ID_BYTES).toString("hex");
			const path = join(base, id);
			writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
			allow.register(id, path);
			stages.set(id, { path, bytes: bytes.length, expiresAt: now() + ttlMs, filename: filename ?? null });
			totalBytes += bytes.length;
			return id;
		},

		/** The on-disk path for a live stage, or null. Never throws on bad input. */
		resolve(id) {
			if (!isStageId(id)) return null;
			sweep();
			if (!stages.has(id)) return null;
			// Identity check lives in the allowlist: a symlink, a hard link to an
			// outside file, a directory, or any replacement returns null here.
			return allow.resolve(id);
		},

		/**
		 * A read stream for a live stage. Resolution happens BEFORE the caller
		 * commits a status, so a refusal is a clean named error rather than a
		 * truncated body on an already-sent 200.
		 */
		open(id) {
			const path = this.resolve(id);
			if (path === null) throw new UploadError("STAGE-UNAVAILABLE", `no live stage ${String(id)}`);
			const st = statSync(path);
			if (!st.isFile()) throw new UploadError("STAGE-NOT-FILE", `stage ${id} is not a regular file`);
			return { stream: createReadStream(path), bytes: st.size };
		},

		drop(id) {
			if (!isStageId(id)) return false;
			const existed = stages.has(id);
			dropStage(id);
			return existed;
		},

		stats() {
			sweep();
			return { stages: stages.size, totalBytes, maxStages, maxTotalBytes, maxStageBytes, ttlMs };
		},

		/** Test seam: expire everything now without waiting out the TTL. */
		expireAll() {
			for (const id of [...stages.keys()]) dropStage(id);
		},
	};
}
