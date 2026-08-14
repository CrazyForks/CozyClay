import { fetchProviderJson, findModel, noKnownUsdEstimate } from "./shared.mjs";

const API = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

export const SEEDANCE_MODELS = Object.freeze([
  {
    id: "dreamina-seedance-2-0-260128",
    label: "Seedance 2.0",
    durations: Array.from({ length: 12 }, (_, index) => index + 4),
    resolutions: ["480p", "720p", "1080p", "4k"],
    capabilities: { prompt: true, startFrame: true, endFrame: true, referenceVideo: true, cameraControl: false, audio: true },
  },
]);

const authHeaders = (apiKey) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
const modelOf = (id) => findModel(SEEDANCE_MODELS, id, "Seedance");

export function validateSeedanceSpec(spec) {
  const model = modelOf(spec.model);
  const errors = [];
  const warnings = [];
  if (!spec.prompt?.trim()) errors.push("prompt is required");
  if (!model.durations.includes(spec.durationSeconds)) errors.push(`${model.label} duration must be an integer from 4 to 15 seconds`);
  if (!model.resolutions.includes(spec.resolution)) errors.push(`${model.label} resolution must be ${model.resolutions.join(", ")}`);
  if (!spec.conditioning?.startFrame && !spec.conditioning?.referenceVideo) errors.push(`${model.label} requires a staged start frame or reference video`);
  if (spec.conditioning?.referenceVideo && (spec.conditioning?.startFrame || spec.conditioning?.endFrame)) errors.push("Seedance first/last-frame and reference-video modes cannot be mixed");
  if (spec.conditioning?.referenceVideo && !/^https?:\/\/|^asset:\/\//.test(spec.conditioning.referenceVideo)) errors.push("Seedance reference video must be a public URL or ModelArk asset URI");
  if (spec.seed !== null && spec.seed !== undefined) warnings.push("Seedance 2.0 does not support seed; it will not be sent");
  if (spec.camera) warnings.push("Seedance 2.0 has no verified camera-trajectory field; staged frames and composed prompt will carry the camera direction");
  return { ok: errors.length === 0, errors, warnings, model };
}

export function mapSeedanceRequest(spec) {
  const verdict = validateSeedanceSpec(spec);
  if (!verdict.ok) throw new Error(verdict.errors[0]);
  const content = [{ type: "text", text: spec.prompt }];
  if (spec.conditioning.startFrame) content.push({ type: "image_url", image_url: { url: spec.conditioning.startFrame }, role: "first_frame" });
  if (spec.conditioning.endFrame) content.push({ type: "image_url", image_url: { url: spec.conditioning.endFrame }, role: "last_frame" });
  if (spec.conditioning.referenceVideo) content.push({ type: "video_url", video_url: { url: spec.conditioning.referenceVideo }, role: "reference_video" });
  return {
    model: verdict.model.id,
    content,
    resolution: spec.resolution,
    ratio: spec.aspectRatio,
    duration: spec.durationSeconds,
    generate_audio: true,
    watermark: false,
  };
}

export async function submitSeedance(spec, { apiKey = process.env.ARK_API_KEY, fetchImpl = fetch, signal, ...retryOptions } = {}) {
  if (!apiKey) throw new Error("ARK_API_KEY is not configured");
  const verdict = validateSeedanceSpec(spec);
  if (!verdict.ok) throw new Error(verdict.errors[0]);
  const { response, payload } = await fetchProviderJson(API, { method: "POST", headers: authHeaders(apiKey), body: JSON.stringify(mapSeedanceRequest(spec)) }, { fetchImpl, signal, ...retryOptions });
  if (!response.ok) throw new Error(`Seedance submit failed (HTTP ${response.status})`);
  if (!payload.id) throw new Error("Seedance submit response has no task id");
  return { providerJobId: payload.id, warnings: verdict.warnings };
}

export async function pollSeedance(providerJobId, { apiKey = process.env.ARK_API_KEY, fetchImpl = fetch, signal, ...retryOptions } = {}) {
  if (!apiKey) throw new Error("ARK_API_KEY is not configured");
  const { response, payload } = await fetchProviderJson(`${API}/${encodeURIComponent(providerJobId)}`, { headers: authHeaders(apiKey) }, { fetchImpl, signal, ...retryOptions });
  if (!response.ok) throw new Error(`Seedance poll failed (HTTP ${response.status})`);
  const remote = String(payload.status || "").toLowerCase();
  const status = remote === "succeeded" ? "succeeded" : ["failed", "expired", "canceled", "cancelled"].includes(remote) ? "failed" : "processing";
  return { status, progress: null, outputUrl: status === "succeeded" ? payload.content?.video_url ?? null : null, failure: status === "failed" ? payload.error?.message || `generation ${remote || "failed"}` : null, raw: payload };
}

export async function cancelSeedance(providerJobId, { apiKey = process.env.ARK_API_KEY, fetchImpl = fetch, signal, ...retryOptions } = {}) {
  if (!apiKey) throw new Error("ARK_API_KEY is not configured");
  const { response } = await fetchProviderJson(`${API}/${encodeURIComponent(providerJobId)}`, { method: "DELETE", headers: authHeaders(apiKey) }, { fetchImpl, signal, ...retryOptions });
  if (!response.ok) throw new Error(`Seedance cancel failed (HTTP ${response.status})`);
}

export const seedanceProvider = Object.freeze({
  id: "seedance",
  label: "Seedance / BytePlus ModelArk",
  auth: { type: "bearer-env", env: "ARK_API_KEY" },
  available: () => Boolean(process.env.ARK_API_KEY),
  models: SEEDANCE_MODELS,
  validate: validateSeedanceSpec,
  estimateCost: noKnownUsdEstimate,
  submit: submitSeedance,
  poll: pollSeedance,
  cancel: cancelSeedance,
});
