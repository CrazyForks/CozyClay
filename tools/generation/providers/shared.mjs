const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function findModel(models, id, providerLabel) {
  if (typeof id !== "string" || !id) throw new Error("model is required");
  const model = models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`unsupported ${providerLabel} model: ${id}`);
  return model;
}

export async function fetchProviderJson(url, options, {
  fetchImpl = fetch,
  signal,
  timeoutMs = 15000,
  retries = 3,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
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
    if (!RETRYABLE.has(response.status) || attempt === retries) break;
    await response.body?.cancel().catch(() => {});
    await sleep(250 * (2 ** attempt) * (1 + random() * 0.5));
  }
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

export function imageForVertex(value) {
  if (typeof value !== "string" || !value) return null;
  const data = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (data) return { bytesBase64Encoded: data[2], mimeType: data[1] };
  if (value.startsWith("gs://")) {
    const extension = value.match(/\.(png|webp|jpe?g)(?:$|[?#])/i)?.[1]?.toLowerCase();
    const mimeType = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
    return { gcsUri: value, mimeType };
  }
  throw new Error("Veo conditioning images must be data URIs or gs:// Cloud Storage URIs");
}

export const noKnownUsdEstimate = () => null;
