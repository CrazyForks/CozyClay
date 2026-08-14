const JSON_HEADERS = { "Content-Type": "application/json" };
const TIMEOUT_MS = 5000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function requestJson(path, options = {}, timeoutMs = TIMEOUT_MS, retries = 0) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(path, { ...options, signal });
    } catch (error) {
      if (options.signal?.aborted || attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
      continue;
    }
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if (!RETRYABLE.has(response.status) || attempt === retries) {
      throw new Error(payload.reason || payload.errors?.[0] || `generation request failed (HTTP ${response.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
  }
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

export async function listGenerationJobs() {
  const payload = await requestJson("/generation/jobs");
  return Array.isArray(payload.jobs) ? payload.jobs : [];
}

export function validateGeneration(spec, { signal } = {}) {
  return requestJson("/generation/validate", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(spec), signal });
}

export function submitGeneration(spec, { signal } = {}) {
  return requestJson("/generation/jobs", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(spec), signal }, 30000, 2);
}

export function getGenerationJob(id, { signal } = {}) {
  return requestJson(`/generation/jobs/${encodeURIComponent(id)}`, { signal }, 30000, 3);
}

export function cancelGenerationJob(id) {
  return requestJson(`/generation/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }, 30000, 1);
}
