import { fetchProviderJson, findModel, imageForVertex, noKnownUsdEstimate } from "./shared.mjs";

export const VEO_MODELS = Object.freeze([
  { id: "veo-3.1-generate-001", label: "Google Veo 3.1", durations: [4, 6, 8], resolutions: ["720p", "1080p"], capabilities: { prompt: true, startFrame: true, endFrame: true, referenceVideo: false, cameraControl: false, audio: true } },
  { id: "veo-3.1-fast-generate-001", label: "Google Veo 3.1 Fast", durations: [4, 6, 8], resolutions: ["720p", "1080p"], capabilities: { prompt: true, startFrame: true, endFrame: true, referenceVideo: false, cameraControl: false, audio: true } },
]);

const modelOf = (id) => findModel(VEO_MODELS, id, "Veo");
const authHeaders = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" });
const endpoint = ({ project, location, model }) => `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}`;

export function validateVeoSpec(spec) {
  const model = modelOf(spec.model);
  const errors = [];
  const warnings = [];
  if (!spec.prompt?.trim()) errors.push("prompt is required");
  if (!model.durations.includes(spec.durationSeconds)) errors.push(`${model.label} duration must be 4, 6, or 8 seconds`);
  if (!model.resolutions.includes(spec.resolution)) errors.push(`${model.label} resolution must be 720p or 1080p`);
  if (!spec.conditioning?.startFrame) errors.push(`${model.label} requires a staged start frame`);
  for (const frame of [spec.conditioning?.startFrame, spec.conditioning?.endFrame].filter(Boolean)) {
    try { imageForVertex(frame); } catch (error) { errors.push(error.message); }
  }
  if (spec.conditioning?.referenceVideo) warnings.push("Veo 3.1 reference-video input is not supported by this adapter and will not be sent");
  if (spec.camera) warnings.push("Veo has no camera-trajectory field; staged frames and composed prompt will carry the authored camera move");
  return { ok: errors.length === 0, errors, warnings, model };
}

export function mapVeoRequest(spec) {
  const verdict = validateVeoSpec(spec);
  if (!verdict.ok) throw new Error(verdict.errors[0]);
  const instance = { prompt: spec.prompt, image: imageForVertex(spec.conditioning.startFrame) };
  if (spec.conditioning.endFrame) instance.lastFrame = imageForVertex(spec.conditioning.endFrame);
  const parameters = { aspectRatio: spec.aspectRatio, durationSeconds: spec.durationSeconds, resolution: spec.resolution, sampleCount: 1, generateAudio: true };
  if (Number.isInteger(spec.seed)) parameters.seed = spec.seed;
  return { instances: [instance], parameters };
}

function config(options) {
  return {
    token: options.token ?? process.env.GOOGLE_CLOUD_ACCESS_TOKEN,
    project: options.project ?? process.env.GOOGLE_CLOUD_PROJECT,
    location: options.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
  };
}

export async function submitVeo(spec, { fetchImpl = fetch, signal, ...options } = {}) {
  const cfg = config(options);
  if (!cfg.token || !cfg.project) throw new Error("GOOGLE_CLOUD_ACCESS_TOKEN and GOOGLE_CLOUD_PROJECT are required");
  const verdict = validateVeoSpec(spec);
  if (!verdict.ok) throw new Error(verdict.errors[0]);
  const url = `${endpoint({ ...cfg, model: spec.model })}:predictLongRunning`;
  const { response, payload } = await fetchProviderJson(url, { method: "POST", headers: authHeaders(cfg.token), body: JSON.stringify(mapVeoRequest(spec)) }, { fetchImpl, signal, ...options });
  if (!response.ok) throw new Error(`Veo submit failed (HTTP ${response.status})`);
  if (!payload.name) throw new Error("Veo submit response has no operation name");
  return { providerJobId: payload.name, warnings: verdict.warnings };
}

export async function pollVeo(providerJobId, { model = "veo-3.1-generate-001", fetchImpl = fetch, signal, ...options } = {}) {
  const cfg = config(options);
  if (!cfg.token || !cfg.project) throw new Error("GOOGLE_CLOUD_ACCESS_TOKEN and GOOGLE_CLOUD_PROJECT are required");
  modelOf(model);
  const url = `${endpoint({ ...cfg, model })}:fetchPredictOperation`;
  const { response, payload } = await fetchProviderJson(url, { method: "POST", headers: authHeaders(cfg.token), body: JSON.stringify({ operationName: providerJobId }) }, { fetchImpl, signal, ...options });
  if (!response.ok) throw new Error(`Veo poll failed (HTTP ${response.status})`);
  if (!payload.done) return { status: "processing", progress: null, outputUrl: null, failure: null, raw: payload };
  if (payload.error) return { status: "failed", progress: null, outputUrl: null, failure: payload.error.message || "generation failed", raw: payload };
  const video = payload.response?.videos?.[0];
  const outputUrl = video?.bytesBase64Encoded ? `data:${video.mimeType || "video/mp4"};base64,${video.bytesBase64Encoded}` : video?.gcsUri ?? null;
  if (!outputUrl) return { status: "failed", progress: null, outputUrl: null, failure: "Veo completed without a video result", raw: payload };
  if (outputUrl.startsWith("gs://")) return { status: "failed", progress: null, outputUrl: null, failure: "Veo returned a private gs:// result; omit storageUri so the bridge can save returned video bytes locally", raw: payload };
  return { status: "succeeded", progress: 1, outputUrl, failure: null, raw: payload };
}

export const veoProvider = Object.freeze({
  id: "veo",
  label: "Google Veo / Vertex AI",
  auth: { type: "oauth-env", env: "GOOGLE_CLOUD_ACCESS_TOKEN", projectEnv: "GOOGLE_CLOUD_PROJECT" },
  available: () => Boolean(process.env.GOOGLE_CLOUD_ACCESS_TOKEN && process.env.GOOGLE_CLOUD_PROJECT),
  models: VEO_MODELS,
  validate: validateVeoSpec,
  estimateCost: noKnownUsdEstimate,
  submit: submitVeo,
  poll: (providerJobId, options) => pollVeo(providerJobId, options),
});
