const JSON_HEADERS = { "Content-Type": "application/json" };
const TIMEOUT_MS = 5000;

async function reasonOf(response, fallback) {
  try { const payload = await response.json(); return payload.reason || fallback; }
  catch { return fallback; }
}

export async function checkGenerationBridge() {
  try {
    const response = await fetch("/generation/health", { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: await reasonOf(response, `generation bridge unhealthy (HTTP ${response.status})`) };
    return await response.json();
  } catch (error) { return { ok: false, reason: error.message || "generation bridge unreachable" }; }
}

export async function listGenerationModels() {
  const response = await fetch("/generation/models", { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(await reasonOf(response, `model list failed (HTTP ${response.status})`));
  const payload = await response.json();
  return Array.isArray(payload.models) ? payload.models : [];
}

export async function validateGeneration(spec) {
  const response = await fetch("/generation/validate", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(spec) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.reason || payload.errors?.[0] || `validation failed (HTTP ${response.status})`);
  return payload;
}

export async function submitGeneration(spec) {
  const response = await fetch("/generation/jobs", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(spec) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.reason || `generation submit failed (HTTP ${response.status})`);
  return payload;
}

export async function getGenerationJob(id) {
  const response = await fetch(`/generation/jobs/${encodeURIComponent(id)}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.reason || `generation poll failed (HTTP ${response.status})`);
  return payload;
}
