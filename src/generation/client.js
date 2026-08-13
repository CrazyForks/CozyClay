const JSON_HEADERS = { "Content-Type": "application/json" };
const TIMEOUT_MS = 5000;

async function requestJson(path, options = {}, timeoutMs = TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(path, { ...options, signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.reason || payload.errors?.[0] || `generation request failed (HTTP ${response.status})`);
  return payload;
}

export async function checkGenerationBridge() {
  try {
    return await requestJson("/generation/health");
  } catch (error) { return { ok: false, reason: error.message || "generation bridge unreachable" }; }
}

export async function listGenerationModels() {
  const payload = await requestJson("/generation/models");
  return Array.isArray(payload.models) ? payload.models : [];
}

export function validateGeneration(spec, { signal } = {}) {
  return requestJson("/generation/validate", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(spec), signal });
}

export function submitGeneration(spec, { signal } = {}) {
  return requestJson("/generation/jobs", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(spec), signal }, 30000);
}

export function getGenerationJob(id, { signal } = {}) {
  return requestJson(`/generation/jobs/${encodeURIComponent(id)}`, { signal }, 30000);
}
