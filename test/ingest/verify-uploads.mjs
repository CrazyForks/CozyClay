#!/usr/bin/env node
/**
 * Staged uploads (plan §11, commit H2).
 *
 * Every rule here has a negative control, because the interesting failures are
 * the ones that LOOK contained. Two of them already escaped the artifact
 * allowlist earlier in this project and are re-asserted at this surface:
 *
 *  - a HARD LINK is the same inode reached by a legitimate inside path, so a
 *    path-based containment check reports success while the bytes served are
 *    the outside file's;
 *  - a DIRECTORY in place of a file passes containment and Content-Length,
 *    then fails the read with EISDIR after a 200 has been committed.
 *
 * The suite also asserts the boring-but-load-bearing part: ids are generated
 * here, so a client-supplied path never reaches the filesystem and traversal is
 * unrepresentable rather than filtered.
 */
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadStore, isStageId, UploadError } from "../../tools/ingest/uploads.mjs";

const fail = [];
function ok(label, cond, detail = "") {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
}
const tmp = () => mkdtempSync(join(tmpdir(), "cc-up-"));
const threw = (fn, code) => {
	try {
		fn();
		return false;
	} catch (e) {
		return e instanceof UploadError && e.code === code;
	}
};

// ---------------------------------------------------------------------------
// ids are opaque and generated here
// ---------------------------------------------------------------------------
{
	const base = tmp();
	const store = createUploadStore({ base });
	const id = store.put(Buffer.from("clip-bytes"), { filename: "../../etc/passwd" });
	ok("put returns an opaque 32-hex id", isStageId(id), id);
	ok("the caller's filename never becomes the id", !id.includes("passwd") && !id.includes(".."), id);
	ok("the staged file sits directly under the base", store.resolve(id)?.endsWith(id) === true, String(store.resolve(id)));

	// A path-shaped or traversing id cannot resolve: not because it is filtered
	// downstream, but because it is not a well-formed id at all.
	for (const bad of ["..", "../etc/passwd", "/etc/passwd", `${id}/../${id}`, id.toUpperCase(), `${id}x`, ""]) {
		ok(`a non-id "${bad.slice(0, 24)}" resolves to null`, store.resolve(bad) === null);
	}
	rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// containment: symlink, hard link, directory
// ---------------------------------------------------------------------------
{
	const base = tmp();
	const outside = tmp();
	const secret = join(outside, "secret.bin");
	writeFileSync(secret, "OUTSIDE-SECRET-BYTES");

	// symlink
	const s1 = createUploadStore({ base });
	const symId = s1.put(Buffer.from("real"));
	const symPath = s1.resolve(symId);
	rmSync(symPath);
	symlinkSync(secret, symPath);
	ok("a stage replaced by a SYMLINK to an outside file is refused", s1.resolve(symId) === null);
	ok("opening a symlinked stage throws a named error", threw(() => s1.open(symId), "STAGE-UNAVAILABLE"));

	// hard link — same inode, legitimate inside path
	const hardId = s1.put(Buffer.from("real2"));
	const hardPath = s1.resolve(hardId);
	rmSync(hardPath);
	linkSync(secret, hardPath);
	ok("a stage replaced by a HARD LINK to an outside file is refused (identity, not location)",
		s1.resolve(hardId) === null, "path is inside base and realpath alone would accept it");

	// directory
	const dirId = s1.put(Buffer.from("real3"));
	const dirPath = s1.resolve(dirId);
	rmSync(dirPath);
	mkdirSync(dirPath);
	ok("a stage replaced by a DIRECTORY is refused before any status is committed",
		s1.resolve(dirId) === null);
	ok("opening a directory stage throws rather than emitting a body", threw(() => s1.open(dirId), "STAGE-UNAVAILABLE"));

	rmSync(base, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------
{
	const base = tmp();
	let clock = 1_000;
	const store = createUploadStore({ base, ttlMs: 100, now: () => clock });
	const id = store.put(Buffer.from("perishable"));
	const path = store.resolve(id);
	ok("a fresh stage resolves", path !== null);

	clock += 99;
	ok("a stage inside its TTL still resolves", store.resolve(id) !== null);

	clock += 2; // now past expiry
	ok("an expired stage is refused", store.resolve(id) === null);
	ok("an expired stage's bytes are removed from disk", !existsSync(path), path);
	ok("opening an expired stage throws a named error", threw(() => store.open(id), "STAGE-UNAVAILABLE"));
	ok("expiry frees the byte accounting", store.stats().totalBytes === 0, JSON.stringify(store.stats()));

	// Expiry mid-read must not hang a reader: the handle was resolved before the
	// status was committed, so an already-open stream is a live fd and finishes,
	// while any NEW resolution refuses. That is the property that keeps a
	// client from waiting forever on a body that will never arrive.
	const id2 = store.put(Buffer.from("mid-read-bytes"));
	const opened = store.open(id2);
	clock += 1000;
	ok("a stage that expires mid-read still has a live handle (no hang)", opened.bytes === "mid-read-bytes".length, `${opened.bytes}`);
	ok("but a NEW resolution after mid-read expiry is refused", store.resolve(id2) === null);
	opened.stream.destroy();

	rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// caps
// ---------------------------------------------------------------------------
{
	const base = tmp();
	const store = createUploadStore({ base, maxStageBytes: 32, maxTotalBytes: 64, maxStages: 3 });

	ok("an empty body is refused", threw(() => store.put(Buffer.alloc(0)), "BODY-EMPTY"));
	ok("a non-Buffer body is refused", threw(() => store.put("not a buffer"), "BODY-TYPE"));
	ok("an over-cap stage is refused by name", threw(() => store.put(Buffer.alloc(33)), "STAGE-TOO-LARGE"));

	const a = store.put(Buffer.alloc(32));
	const b = store.put(Buffer.alloc(32));
	ok("two stages at exactly the per-stage cap are accepted", isStageId(a) && isStageId(b));
	ok("exceeding the TOTAL byte cap is refused by name", threw(() => store.put(Buffer.alloc(1)), "TOTAL-TOO-LARGE"));

	store.drop(a);
	store.drop(b);
	const small = [store.put(Buffer.alloc(1)), store.put(Buffer.alloc(1)), store.put(Buffer.alloc(1))];
	ok("three concurrent stages are accepted at the count cap", small.every(isStageId));
	ok("exceeding the concurrent-stage cap is refused by name", threw(() => store.put(Buffer.alloc(1)), "STAGE-LIMIT"));

	rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// drop and construction
// ---------------------------------------------------------------------------
{
	const base = tmp();
	const store = createUploadStore({ base });
	const id = store.put(Buffer.from("x"));
	const path = store.resolve(id);
	ok("drop removes a live stage", store.drop(id) === true);
	ok("dropped bytes are gone from disk", !existsSync(path));
	ok("dropping an unknown id is false, not an error", store.drop("0".repeat(32)) === false);
	ok("dropping a malformed id is false, not an error", store.drop("../x") === false);

	let ctorThrew = false;
	try {
		createUploadStore({});
	} catch (e) {
		ctorThrew = e instanceof UploadError && e.code === "BASE-MISSING";
	}
	ok("a store without a base is refused by name", ctorThrew);
	rmSync(base, { recursive: true, force: true });
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
