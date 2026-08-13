const API = "https://api.dev.runwayml.com/v1";
const VERSION = "2024-11-06";

export const RUNWAY_MODELS = Object.freeze([
  { id: "gen4_turbo", label: "Runway Gen-4 Turbo", endpoint: "image_to_video", durations: [2, 3, 4, 5, 6, 7, 8, 9, 10], costPerSecondUsd: 0.05, capabilities: { prompt: true, startFrame: true, endFrame: false, referenceVideo: false, audio: false } },
  { id: "gen4.5", label: "Runway Gen-4.5", endpoint: "image_to_video", durations: [2, 3, 4, 5, 6, 7, 8, 9, 10], costPerSecondUsd: 0.12, capabilities: { prompt: true, startFrame: true, endFrame: false, referenceVideo: false, audio: false } },
]);

const RETRYABLE = new Set([429, 502, 503, 504]);

async function runwayFetch(url, options, { fetchImpl, signal, timeoutMs = 15000, retries = 3, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random }) {
  let response;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      response = await fetchImpl(url, { ...options, signal: attemptSignal });
    } catch (error) {
      if (signal?.aborted || attempt === retries) throw error;
      await sleep(250 * (2 ** attempt) * (1 + random() * 0.5));
      continue;
    }
    if (!RETRYABLE.has(response.status) || attempt === retries) return response;
    await response.body?.cancel().catch(() => {});
    await sleep(250 * (2 ** attempt) * (1 + random() * 0.5));
  }
  return response;
}

function headers(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Runway-Version": VERSION };
}

function modelOf(id) {
  if (typeof id !== "string" || !id) throw new Error("model is required");
  const model = RUNWAY_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`unsupported Runway model: ${id}`);
  return model;
}

export function estimateRunwayCost(spec) {
  const model = modelOf(spec.model);
  return Number((model.costPerSecondUsd * spec.durationSeconds).toFixed(2));
}

export function validateRunwaySpec(spec) {
  const model = modelOf(spec.model);
  const errors = [];
  const warnings = [];
  if (!spec.prompt?.trim()) errors.push("prompt is required");
  if (spec.prompt?.length > 1000) errors.push("Runway prompt must be at most 1000 UTF-16 code units");
  if (!model.durations.includes(spec.durationSeconds)) errors.push(`${model.label} duration must be ${model.durations.join(" or ")} seconds`);
  if (!spec.conditioning?.startFrame) errors.push(`${model.label} requires a start frame`);
  if (spec.conditioning?.startFrame?.startsWith("data:") && spec.conditioning.startFrame.length > 5 * 1024 * 1024) errors.push("Runway data URI images must be at most 5 MB encoded");
  if (spec.conditioning?.endFrame && !model.capabilities.endFrame) warnings.push("end frame is not supported by this adapter and will not be sent");
  if (spec.conditioning?.referenceVideo && !model.capabilities.referenceVideo) warnings.push("reference video is not supported by this adapter and will not be sent");
  return { ok: errors.length === 0, errors, warnings, model };
}

export async function submitRunway(spec, { apiKey = process.env.RUNWAYML_API_SECRET, fetchImpl = fetch, signal, ...retryOptions } = {}) {
  if (!apiKey) throw new Error("RUNWAYML_API_SECRET is not configured");
  const verdict = validateRunwaySpec(spec);
  if (!verdict.ok) throw new Error(verdict.errors[0]);
  const body = {
    model: spec.model,
    promptText: spec.prompt,
    promptImage: spec.conditioning.startFrame,
    ratio: spec.aspectRatio === "9:16" ? "720:1280" : "1280:720",
    duration: spec.durationSeconds,
  };
  if (Number.isInteger(spec.seed)) body.seed = spec.seed;
  const response = await runwayFetch(`${API}/${verdict.model.endpoint}`, { method: "POST", headers: headers(apiKey), body: JSON.stringify(body) }, { fetchImpl, signal, ...retryOptions });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Runway submit failed (HTTP ${response.status})`);
  if (!payload.id) throw new Error("Runway submit response has no task id");
  return { providerJobId: payload.id, warnings: verdict.warnings };
}

export async function pollRunway(providerJobId, { apiKey = process.env.RUNWAYML_API_SECRET, fetchImpl = fetch, signal, ...retryOptions } = {}) {
  if (!apiKey) throw new Error("RUNWAYML_API_SECRET is not configured");
  const response = await runwayFetch(`${API}/tasks/${encodeURIComponent(providerJobId)}`, { headers: headers(apiKey) }, { fetchImpl, signal, ...retryOptions });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Runway poll failed (HTTP ${response.status})`);
  const state = String(payload.status || "").toUpperCase();
  const status = state === "SUCCEEDED" ? "succeeded" : state === "FAILED" || state === "CANCELED" ? "failed" : "processing";
  return { status, progress: payload.progress ?? null, outputUrl: status === "succeeded" ? payload.output?.[0] ?? null : null, failure: status === "failed" ? payload.failure || payload.failureCode || "generation failed" : null, raw: payload };
}

export const runwayProvider = Object.freeze({
  id: "runway",
  label: "Runway",
  auth: { type: "bearer-env", env: "RUNWAYML_API_SECRET" },
  available: () => Boolean(process.env.RUNWAYML_API_SECRET),
  models: RUNWAY_MODELS,
  validate: validateRunwaySpec,
  estimateCost: estimateRunwayCost,
  submit: submitRunway,
  poll: pollRunway,
});
