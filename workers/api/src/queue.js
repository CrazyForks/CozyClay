import { dailyCapFor, POLICY, utcDay } from "./policy.js";
import { promptHash as hashPrompt } from "./prompt.js";

function dbOf(env) {
  const db = env?.DB ?? env;
  if (!db || typeof db.prepare !== "function") throw new TypeError("D1 binding DB is required");
  return db;
}

export function changesOf(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? result?.meta?.rows_written ?? 0);
}

function uniqueViolation(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return message.includes("unique") || message.includes("constraint") || message.includes("sqlite_constraint");
}

function newId() {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Jobs use UUIDv7 so created_at,id is a stable total order even for rows
// inserted in the same millisecond. Lease tokens stay opaque random UUIDs.
function newJobId(now = Date.now()) {
  if (typeof globalThis.crypto?.getRandomValues !== "function") return newId();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function positionFormula({ a = 0 }) {
  return Math.max(0, Number(a) || 0) + 1;
}

/**
 * Calculate a ticket's FIFO position. The scalar form is synchronous and
 * useful for policy tests; passing (env, job) performs the D1 count query.
 */
export function positionOf(input, maybeJob) {
  if (maybeJob !== undefined && input && (input.DB || typeof input.prepare === "function")) {
    const db = dbOf(input);
    const job = maybeJob;
    return db.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE status='queued' AND (created_at < ? OR (created_at = ? AND id < ?))",
    ).bind(job.created_at, job.created_at, job.id).first().then((ahead) => positionFormula({ a: Number(ahead?.count ?? 0) }));
  }
  if (input && typeof input === "object") return positionFormula(input);
  throw new TypeError("positionOf expects a position object or (env, job)");
}

async function queuedCountForClassification(db) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='queued'").first();
  return Number(row?.count ?? 0);
}

async function findDedup(db, accountId, hash, now) {
  return db.prepare(
    "SELECT id, token, expires_at FROM jobs WHERE account_id=? AND prompt_hash=? AND status='done' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).bind(accountId, hash, now).first();
}

function normalizeEnqueueArgs(args) {
  if (args.length === 1 && args[0] && typeof args[0] === "object") return { ...args[0] };
  const [accountId, prompt, promptHashValue] = args;
  return { accountId, prompt, promptHash: promptHashValue };
}

/**
 * Atomically reserve a daily slot and insert a queued job. `reserved_job_id` is
 * deliberately the only predicate connecting those two statements: when the
 * cap is exhausted both statements report zero changes and the batch is a
 * no-op. A partial unique index handles concurrent active submissions.
 */
export async function enqueue(env, ...args) {
  const options = normalizeEnqueueArgs(args);
  const db = dbOf(env);
  const accountId = options.accountId ?? options.userId;
  const prompt = options.prompt;
  const now = Number(options.now ?? Date.now());
  const day = options.usageDay ?? utcDay(now);
  const id = options.jobId ?? newJobId(now);
  const token = options.token ?? newId();
  const hash = options.promptHash ?? await hashPrompt(prompt);
  const expiresAt = options.expiresAt ?? now + POLICY.RESULT_RETENTION_DAYS * 86_400_000;
  if (!accountId) throw new TypeError("accountId is required");

  // A completed, unexpired result is a successful reissue, not a new admission.
  const duplicate = await findDedup(db, accountId, hash, now);
  if (duplicate) {
    return {
      ok: true,
      dedupHit: true,
      token: duplicate.token,
      jobId: duplicate.id,
      position: 0,
    };
  }

  const cap = dailyCapFor();
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO daily_usage(account_id, day, used, reserved_job_id)
         SELECT ?, ?, 1, ?
          WHERE (SELECT COUNT(*) FROM jobs WHERE status='queued') < ?
         ON CONFLICT(account_id, day) DO UPDATE SET
           used = used + 1, reserved_job_id = excluded.reserved_job_id
         WHERE daily_usage.used < ?
           AND (SELECT COUNT(*) FROM jobs WHERE status='queued') < ?`,
      ).bind(accountId, day, id, POLICY.QUEUE_MAX_WAITING, cap, POLICY.QUEUE_MAX_WAITING),
      db.prepare(
        `INSERT INTO jobs(
           id, token, account_id, status, prompt, prompt_hash, attempts,
           usage_day, created_at, expires_at
         )
         SELECT ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?
          WHERE (SELECT reserved_job_id FROM daily_usage
                 WHERE account_id=? AND day=?) = ?
            AND (SELECT COUNT(*) FROM jobs WHERE status='queued') < ?`,
      ).bind(
        id,
        token,
        accountId,
        prompt,
        hash,
        day,
        now,
        expiresAt,
        accountId,
        day,
        id,
        POLICY.QUEUE_MAX_WAITING,
      ),
    ]);
    const reserved = changesOf(results?.[0]);
    const inserted = changesOf(results?.[1]);
    if (reserved !== 1) {
      // The count predicate above is the enforcement boundary. This second
      // read only classifies the already-committed no-op for HTTP status.
      return {
        ok: false,
        error: (await queuedCountForClassification(db)) >= POLICY.QUEUE_MAX_WAITING ? "queue_full" : "daily_cap",
      };
    }
    if (inserted !== 1) return { ok: false, error: "admission_failed" };
    const row = await db.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first();
    return {
      ok: true,
      dedupHit: false,
      token,
      jobId: id,
      position: row ? await positionOf(db, row) : 1,
      createdAt: now,
    };
  } catch (error) {
    if (uniqueViolation(error)) return { ok: false, error: "active_job_exists" };
    throw error;
  }
}

async function firstQueued(db) {
  return db.prepare(
    "SELECT id, token, account_id, prompt, created_at, attempts FROM jobs WHERE status='queued' ORDER BY created_at, id LIMIT 1",
  ).first();
}

/** Claim one job from the FIFO queue with a compare-and-set update. */
export async function claimNext(env, workerId) {
  const db = dbOf(env);
  if (!workerId) throw new TypeError("workerId is required");
  for (let attempt = 0; attempt < POLICY.CLAIM_MAX_RETRIES; attempt += 1) {
    const job = await firstQueued(db);
    if (!job) return null;

    const leaseToken = newId();
    const now = Date.now();
    let result;
    try {
      result = await db.prepare(
        `UPDATE jobs SET status='running', lease_token=?, lease_owner=?,
           lease_expires_at=?, started_at=COALESCE(started_at,?), attempts=attempts+1
         WHERE id=? AND status='queued'`,
      ).bind(leaseToken, workerId, now + POLICY.LEASE_TTL_MS, now, job.id).run();
    } catch (error) {
      // A transient D1 conflict is treated like a lost CAS and retried.
      if (attempt + 1 >= POLICY.CLAIM_MAX_RETRIES) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(8, attempt + 1)));
      continue;
    }
    const claimed = changesOf(result);
    if (claimed === 1) {
      return {
        jobId: job.id,
        job_id: job.id,
        token: job.token,
        accountId: job.account_id,
        prompt: job.prompt,
        durationS: POLICY.DEMO_DURATION_S,
        duration: POLICY.DEMO_DURATION_S,
        leaseToken,
        lease_token: leaseToken,
        leaseExpiresAt: now + POLICY.LEASE_TTL_MS,
        lease_expires_at: now + POLICY.LEASE_TTL_MS,
      };
    }
    // Let other pollers finish their CAS before re-reading the queue. Without
    // a yield, a burst of callers can burn every bounded retry on the same row.
    if (attempt + 1 < POLICY.CLAIM_MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(8, attempt + 1)));
    }
  }
  return null;
}

async function refundStatement(db, job, now, transitionToken = null) {
  const transitionPredicate = transitionToken
    ? "id=? AND status='revoked' AND lease_token=? AND finished_at=?"
    : "id=? AND status IN ('failed','canceled','revoked') AND finished_at=?";
  return db.prepare(
    `UPDATE daily_usage
        SET used=used-1,
            reserved_job_id=CASE WHEN reserved_job_id=? THEN NULL ELSE reserved_job_id END
      WHERE account_id=? AND day=? AND used>0
        AND EXISTS (SELECT 1 FROM jobs WHERE ${transitionPredicate})`,
  ).bind(
    job.id,
    job.account_id,
    job.usage_day,
    ...(transitionToken ? [job.id, transitionToken, now] : [job.id, now]),
  );
}

async function loadJob(db, jobId) {
  return db.prepare("SELECT * FROM jobs WHERE id=?").bind(jobId).first();
}

export async function renewLease(env, jobId, leaseToken, now = Date.now()) {
  const db = dbOf(env);
  const result = await db.prepare(
    `UPDATE jobs SET lease_expires_at=?
      WHERE id=? AND status='running' AND lease_token=?
        AND (started_at IS NULL OR started_at >= ?)`,
  ).bind(now + POLICY.LEASE_TTL_MS, jobId, leaseToken, now - POLICY.JOB_HARD_TIMEOUT_MS).run();
  return changesOf(result) === 1;
}

export async function completeJob(env, jobId, leaseToken, resultKey, options = {}) {
  const db = dbOf(env);
  const now = Number(options.now ?? Date.now());
  const expiresAt = Number(options.expiresAt ?? now + POLICY.RESULT_RETENTION_DAYS * 86_400_000);
  const result = await db.prepare(
    `UPDATE jobs SET status='done', result_key=?, finished_at=?, expires_at=?,
       lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL,
       error=NULL
      WHERE id=? AND status='running' AND lease_token=?
        AND (started_at IS NULL OR started_at >= ?)`,
  ).bind(resultKey, now, expiresAt, jobId, leaseToken, now - POLICY.JOB_HARD_TIMEOUT_MS).run();
  if (changesOf(result) !== 1) return { ok: false, error: "lease_lost" };
  return { ok: true, job: await loadJob(db, jobId) };
}

export async function failJob(env, jobId, leaseToken, reason = "worker_failed", options = {}) {
  const db = dbOf(env);
  const now = Number(options.now ?? Date.now());
  const job = await loadJob(db, jobId);
  if (!job || job.status !== "running" || job.lease_token !== leaseToken) {
    return { ok: false, error: "lease_lost" };
  }
  const terminal = Number(job.attempts ?? 0) >= POLICY.MAX_ATTEMPTS;
  const nextStatus = terminal ? "failed" : "queued";
  try {
    const statements = [db.prepare(
      `UPDATE jobs SET status=?, error=?, finished_at=?,
         lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL
        WHERE id=? AND status='running' AND lease_token=?`,
    ).bind(nextStatus, String(reason).slice(0, 1000), terminal ? now : null, jobId, leaseToken)];
    if (terminal) statements.push(await refundStatement(db, job, now));
    const results = await db.batch(statements);
    if (changesOf(results?.[0]) !== 1) return { ok: false, error: "lease_lost" };
    return { ok: true, status: nextStatus, job: await loadJob(db, jobId) };
  } catch (error) {
    throw error;
  }
}

async function terminalizeExpired(db, job, now, reason) {
  const terminal = Number(job.attempts ?? 0) >= POLICY.MAX_ATTEMPTS;
  if (!terminal) {
    const result = await db.prepare(
      `UPDATE jobs SET status='queued', lease_token=NULL, lease_owner=NULL,
         lease_expires_at=NULL, error=?
        WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at < ?`,
    ).bind(reason, job.id, job.lease_token, now).run();
    return changesOf(result);
  }
  const results = await db.batch([
    db.prepare(
      `UPDATE jobs SET status='failed', error=?, finished_at=?, lease_token=NULL,
         lease_owner=NULL, lease_expires_at=NULL
        WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at < ?`,
    ).bind(reason, now, job.id, job.lease_token, now),
    await refundStatement(db, job, now),
  ]);
  return changesOf(results?.[0]);
}

export async function reclaimExpiredLeases(env, now = Date.now()) {
  const db = dbOf(env);
  const rows = await db.prepare(
    "SELECT * FROM jobs WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ? ORDER BY created_at, id",
  ).bind(now).all();
  let count = 0;
  for (const job of rows?.results ?? []) count += await terminalizeExpired(db, job, now, "lease_expired");
  return count;
}

export async function expireHardTimeouts(env, now = Date.now()) {
  const db = dbOf(env);
  const rows = await db.prepare(
    "SELECT * FROM jobs WHERE status='running' AND started_at IS NOT NULL AND started_at < ? ORDER BY started_at, id",
  ).bind(now - POLICY.JOB_HARD_TIMEOUT_MS).all();
  let count = 0;
  // The hard timeout is absolute: unlike a lease expiry it never grants the
  // job another attempt, even when the current attempt budget is not spent.
  for (const job of rows?.results ?? []) {
    const results = await db.batch([
      db.prepare(
        `UPDATE jobs SET status='failed', error='hard_timeout', finished_at=?,
           lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL
          WHERE id=? AND status='running' AND lease_token=?`,
      ).bind(now, job.id, job.lease_token),
      await refundStatement(db, job, now),
    ]);
    count += changesOf(results?.[0]);
  }
  return count;
}

export async function revokeJob(env, jobId, options = {}) {
  if (typeof options === "string") options = { leaseToken: options };
  if (!options || typeof options !== "object") options = {};
  const db = dbOf(env);
  const now = Number(options.now ?? Date.now());
  const job = await loadJob(db, jobId);
  if (!job || job.status === "revoked") return { ok: false, error: "not_found" };
  if (job.status === "canceled") return { ok: false, error: "not_found" };
  if (job.status === "running" && !Object.hasOwn(options, "leaseToken")) {
    return { ok: false, error: "lease_required" };
  }
  const expectedStatus = Object.hasOwn(options, "expectedStatus") ? options.expectedStatus : job.status;
  const expectedLeaseToken = Object.hasOwn(options, "leaseToken") ? options.leaseToken : (job.lease_token ?? null);
  if (expectedStatus !== job.status) return { ok: false, error: "lease_lost" };

  // A unique marker makes the refund statement mutually dependent on the
  // successful CAS. It is held in lease_token only for this transaction and
  // cleared before commit; stale revoke requests therefore cannot refund.
  const transitionToken = newId();
  const leasePredicate = expectedLeaseToken === null ? "lease_token IS NULL" : "lease_token=?";
  const leaseArguments = expectedLeaseToken === null ? [] : [expectedLeaseToken];
  const statements = [
    db.prepare(
      `UPDATE jobs SET status='revoked', finished_at=?, error=?, lease_token=?,
         lease_owner=NULL, lease_expires_at=NULL
        WHERE id=? AND status=? AND ${leasePredicate}`,
    ).bind(now, options.reason ?? "revoked", transitionToken, jobId, expectedStatus, ...leaseArguments),
  ];
  const shouldRefund = expectedStatus === "queued" || expectedStatus === "running";
  if (shouldRefund) statements.push(await refundStatement(db, job, now, transitionToken));
  statements.push(
    db.prepare(
      "UPDATE jobs SET lease_token=NULL WHERE id=? AND status='revoked' AND lease_token=?",
    ).bind(jobId, transitionToken),
  );
  const results = await db.batch(statements);
  if (changesOf(results?.[0]) !== 1) return { ok: false, error: "lease_lost" };

  // Delete a completed artifact immediately so an already-shared result cannot
  // remain in private R2. D1 revoked status is the security boundary if R2 is
  // temporarily unavailable; the cron orphan sweep retries deletion.
  if (job.result_key && env.RESULTS?.delete) {
    try {
      await env.RESULTS.delete(job.result_key);
      await db.prepare("UPDATE jobs SET result_key=NULL WHERE id=? AND status='revoked'").bind(job.id).run();
    } catch {
      // Keep the key for the prefix-based orphan cleanup path.
    }
  }
  return { ok: true, job: await loadJob(db, jobId) };
}

export async function jobByToken(env, token, accountId = null) {
  const db = dbOf(env);
  if (accountId) return db.prepare("SELECT * FROM jobs WHERE token=? AND account_id=?").bind(token, accountId).first();
  return db.prepare("SELECT * FROM jobs WHERE token=?").bind(token).first();
}

export async function cleanupExpiredResults(env, now = Date.now()) {
  const db = dbOf(env);
  const rows = await db.prepare(
    "SELECT id, result_key FROM jobs WHERE status IN ('done','revoked','canceled') AND expires_at IS NOT NULL AND expires_at <= ? AND result_key IS NOT NULL",
  ).bind(now).all();
  let removed = 0;
  for (const row of rows?.results ?? []) {
    let deleted = !env.RESULTS?.delete;
    if (env.RESULTS?.delete && row.result_key) {
      try {
        await env.RESULTS.delete(row.result_key);
        deleted = true;
      } catch {
        deleted = false;
      }
    }
    if (deleted) {
      const result = await db.prepare(
        "UPDATE jobs SET result_key=NULL WHERE id=? AND status IN ('done','revoked','canceled') AND result_key=?",
      ).bind(row.id, row.result_key).run();
      removed += changesOf(result);
    }
  }
  return removed;
}

function objectUploadedAt(object) {
  const value = object?.uploaded ?? object?.uploadedAt ?? object?.uploaded_at ?? object?.lastModified ?? object?.created_at;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number(value);
  }
  return NaN;
}

/**
 * Remove result objects left by a put that lost its lease CAS. R2 list is
 * prefix-scoped and age-bounded so a just-uploaded object has time to finish
 * its D1 transition before it can be considered orphaned.
 */
export async function cleanupOrphanResults(env, now = Date.now()) {
  const bucket = env?.RESULTS;
  if (!bucket?.list || !bucket?.delete) return 0;
  const db = dbOf(env);
  const rows = await db.prepare("SELECT result_key, status FROM jobs WHERE result_key IS NOT NULL").all();
  const referenced = new Set(
    (rows?.results ?? [])
      .filter((row) => !["failed", "revoked", "canceled"].includes(row.status))
      .map((row) => row.result_key),
  );
  const cutoff = now - POLICY.RESULT_ORPHAN_GRACE_MS;
  let cursor;
  let removed = 0;
  do {
    const page = await bucket.list({
      prefix: "results/",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page?.objects ?? []) {
      const key = object?.key;
      if (!key || referenced.has(key)) continue;
      const uploadedAt = objectUploadedAt(object);
      if (!Number.isFinite(uploadedAt) || uploadedAt > cutoff) continue;
      try {
        await bucket.delete(key);
        removed += 1;
      } catch {
        // Retry the orphan on the next scheduled sweep.
      }
    }
    cursor = page?.truncated ? page.cursor : null;
  } while (cursor);
  return removed;
}

export async function cleanupWorkerNonces(env, now = Date.now()) {
  const db = dbOf(env);
  const result = await db.prepare("DELETE FROM worker_nonce WHERE seen_at <= ?").bind(now - POLICY.WORKER_NONCE_TTL_MS).run();
  return changesOf(result);
}

export { positionFormula };
