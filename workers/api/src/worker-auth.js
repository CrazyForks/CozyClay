import { POLICY } from "./policy.js";

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value) {
  const text = String(value).replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(text.padEnd(Math.ceil(text.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function fromHex(value) {
  if (!/^[0-9a-f]+$/iu.test(value) || value.length % 2) return null;
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

async function digestHex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, bytes) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
}

async function verifyHmac(secret, bytes, signature) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, bytes);
}

function bodyBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value == null) return new Uint8Array();
  return encoder.encode(String(value));
}

function field(payload, camel, snake = camel) {
  return payload?.[camel] ?? payload?.[snake] ?? "";
}

/** Canonical bytes shared by the box signer and Worker verifier. */
export async function canonicalBytes(payload = {}) {
  const body = bodyBytes(payload.body ?? payload.rawBody);
  const bodyHash = await digestHex(body);
  const method = String(payload.method ?? "GET").toUpperCase();
  const path = String(payload.path ?? "/");
  const value = [
    "v1",
    String(field(payload, "workerId", "worker_id")),
    String(payload.ts ?? ""),
    String(payload.nonce ?? ""),
    method,
    path,
    String(field(payload, "jobId", "job_id")),
    String(field(payload, "leaseToken", "lease_token")),
    bodyHash,
  ].join("\n");
  return encoder.encode(value);
}

export async function signPayload(secretOrPayload, maybePayload) {
  const payload = typeof secretOrPayload === "string"
    ? maybePayload
    : secretOrPayload;
  const secret = typeof secretOrPayload === "string"
    ? secretOrPayload
    : typeof maybePayload === "string"
      ? maybePayload
      : payload?.secret;
  if (!secret) throw new TypeError("worker secret is required");
  return toBase64Url(await hmac(secret, await canonicalBytes(payload)));
}

export async function signedHeaders({ secret, workerId, method = "GET", path = "/", body = new Uint8Array(), jobId = "", leaseToken = "", ts = Date.now(), nonce = randomNonce() }) {
  const signature = await signPayload(secret, { workerId, method, path, body, jobId, leaseToken, ts, nonce });
  return {
    "X-CC-Worker-Id": String(workerId),
    "X-CC-Ts": String(ts),
    "X-CC-Nonce": String(nonce),
    "X-CC-Job-Id": String(jobId),
    "X-CC-Lease": String(leaseToken),
    "X-CC-Kid": "current",
    "X-CC-Sig": signature,
  };
}

export function randomNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failure(status, error, extra = {}) {
  return { ok: false, status, error, ...extra };
}

function requestPath(request) {
  try {
    const url = new URL(request.url);
    return `${url.pathname}${url.search}`;
  } catch {
    return request.url || "/";
  }
}

async function consumeNonce(db, nonce, seenAt) {
  try {
    const result = await db.prepare("INSERT INTO worker_nonce(nonce, seen_at) VALUES (?, ?)").bind(nonce, seenAt).run();
    return Number(result?.meta?.changes ?? result?.changes ?? 0) === 1;
  } catch (error) {
    const message = String(error?.message ?? error).toLowerCase();
    if (message.includes("unique") || message.includes("constraint")) return false;
    throw error;
  }
}

/** Verify and consume a worker request nonce. The raw body is returned for callers. */
export async function verifyWorkerRequest(request, env) {
  const headers = request.headers;
  const workerId = headers.get("X-CC-Worker-Id") ?? "";
  const tsRaw = headers.get("X-CC-Ts") ?? "";
  const nonce = headers.get("X-CC-Nonce") ?? "";
  const signature = headers.get("X-CC-Sig") ?? "";
  const kid = headers.get("X-CC-Kid") ?? "";
  const jobId = headers.get("X-CC-Job-Id") ?? "";
  const leaseToken = headers.get("X-CC-Lease") ?? "";
  if (!workerId || !tsRaw || !nonce || !signature || !/^[0-9a-f]{64}$/iu.test(nonce)) return failure(401, "invalid_worker_headers");
  const ts = Number(tsRaw);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > POLICY.WORKER_CLOCK_SKEW_MS) return failure(401, "skew");
  if (kid !== "current") return failure(401, "unknown_key");
  const secret = env?.CC_WORKER_SECRET;
  if (!secret) return failure(401, "worker_key_missing");

  const body = new Uint8Array(await request.arrayBuffer());
  const canonical = await canonicalBytes({ workerId, ts, nonce, method: request.method, path: requestPath(request), jobId, leaseToken, body });
  let valid = false;
  try {
    let expected;
    if (/^[0-9a-f]{64}$/iu.test(signature)) expected = fromHex(signature);
    else expected = fromBase64Url(signature);
    valid = expected ? await verifyHmac(secret, canonical, expected) : false;
  } catch {
    valid = false;
  }
  if (!valid) return failure(401, "bad_signature");
  if (!env?.DB) return failure(503, "worker_nonce_store_unavailable");
  try {
    if (!(await consumeNonce(env.DB, nonce, now))) return failure(401, "replay");
  } catch {
    return failure(503, "worker_nonce_store_unavailable");
  }
  return { ok: true, workerId, ts, nonce, kid, jobId, leaseToken, body, bodyText: new TextDecoder().decode(body) };
}

export { digestHex, bodyBytes, toBase64Url, fromBase64Url };
