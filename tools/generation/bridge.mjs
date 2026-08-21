#!/usr/bin/env node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createJobStore } from "./job-store.mjs";
import { klingProvider } from "./providers/kling.mjs";
import { runwayProvider } from "./providers/runway.mjs";
import { seedanceProvider } from "./providers/seedance.mjs";
import { veoProvider } from "./providers/veo.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CCLAY_GENERATION_PORT || 5182);
const MAX_BODY = 16 * 1024 * 1024;
const RETRYABLE = new Set([429, 502, 503, 504]);

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("request body exceeds 16 MB"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("invalid JSON body"), { status: 400 }); }
}

function publicJob(job) {
  const { raw, outputPath, remoteOutputUrl, ...safe } = job;
  return { ...safe, outputUrl: outputPath ? `/generation/jobs/${encodeURIComponent(job.id)}/output` : null };
}

export async function downloadResult(url, target, { fetchImpl = fetch, retries = 3, timeoutMs = 30000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  await mkdir(join(target, ".."), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok && response.body) {
      await pipeline(Readable.fromWeb(response.body), await import("node:fs").then(({ createWriteStream }) => createWriteStream(temp)));
      await rename(temp, target);
      return target;
    }
    await response.body?.cancel().catch(() => {});
    if (!RETRYABLE.has(response.status) || attempt === retries) throw new Error(`result download failed (HTTP ${response.status})`);
    await sleep(250 * (2 ** attempt));
  }
  throw new Error("result download failed");
}

export function createGenerationServer({ store = createJobStore(), providers = { runway: runwayProvider, seedance: seedanceProvider, kling: klingProvider, veo: veoProvider }, download = downloadResult, now = () => new Date().toISOString() } = {}) {
  const ready = store.load();
  return createServer(async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      if (req.method === "GET" && url.pathname === "/generation/health") {
        return json(res, 200, { ok: true, providers: Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, provider.available()])) });
      }
      if (req.method === "GET" && url.pathname === "/generation/models") {
        const models = Object.entries(providers).flatMap(([providerId, provider]) => provider.models.map((model) => ({ ...model, provider: providerId, available: provider.available() })));
        return json(res, 200, { models });
      }
      if (req.method === "GET" && url.pathname === "/generation/jobs") {
        return json(res, 200, { jobs: store.list().map(publicJob) });
      }
      if (req.method === "POST" && url.pathname === "/generation/validate") {
        const spec = await readJson(req);
        const provider = providers[spec.provider];
        if (!provider) return json(res, 422, { reason: spec.provider ? `unsupported provider: ${spec.provider}` : "provider is required" });
        if (!spec.model) return json(res, 422, { reason: "model is required" });
        const verdict = provider.validate(spec);
        return json(res, verdict.ok ? 200 : 422, { ok: verdict.ok, errors: verdict.errors, warnings: verdict.warnings, estimatedCostUsd: verdict.ok ? provider.estimateCost(spec) : null });
      }
      if (req.method === "POST" && url.pathname === "/generation/jobs") {
        const spec = await readJson(req);
        const provider = providers[spec.provider];
        if (!provider) return json(res, 422, { reason: spec.provider ? `unsupported provider: ${spec.provider}` : "provider is required" });
        if (!provider.available()) return json(res, 503, { reason: `${spec.provider} is not configured` });
        const verdict = provider.validate(spec);
        if (!verdict.ok) return json(res, 422, { reason: verdict.errors[0], errors: verdict.errors, warnings: verdict.warnings });
        const submitted = await provider.submit(spec);
        const timestamp = now();
        const job = { id: randomUUID(), provider: spec.provider, model: spec.model, shot: spec.shot ?? null, camera: spec.camera ?? null, subjects: spec.subjects ?? [], providerJobId: submitted.providerJobId, status: "processing", progress: null, outputPath: null, remoteOutputUrl: null, failure: null, warnings: submitted.warnings, estimatedCostUsd: provider.estimateCost(spec), createdAt: timestamp, updatedAt: timestamp };
        await store.set(job);
        return json(res, 202, publicJob(job));
      }
      const outputMatch = url.pathname.match(/^\/generation\/jobs\/([^/]+)\/output$/);
      if (req.method === "GET" && outputMatch) {
        const job = store.get(outputMatch[1]);
        if (!job?.outputPath) return json(res, 404, { reason: "result not available" });
        const info = await stat(job.outputPath).catch(() => null);
        if (!info) return json(res, 410, { reason: "saved result is missing" });
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": info.size, "Content-Disposition": `attachment; filename="cozyclay-${job.id}.mp4"`, "Cache-Control": "no-store" });
        createReadStream(job.outputPath).pipe(res);
        return;
      }
      const match = url.pathname.match(/^\/generation\/jobs\/([^/]+)$/);
      if (req.method === "DELETE" && match) {
        const job = store.get(match[1]);
        if (!job) return json(res, 404, { reason: "job not found" });
        if (job.status !== "processing") return json(res, 200, publicJob(job));
        const provider = providers[job.provider];
        if (!provider?.cancel) return json(res, 409, { reason: `${job.provider} does not expose a verified remote cancellation operation` });
        if (!provider.available()) return json(res, 503, { reason: `${job.provider} is not configured; restore its key to cancel this job` });
        await provider.cancel(job.providerJobId, { model: job.model });
        Object.assign(job, { status: "canceled", failure: "generation canceled", updatedAt: now() });
        await store.set(job);
        return json(res, 200, publicJob(job));
      }
      if (req.method === "GET" && match) {
        const job = store.get(match[1]);
        if (!job) return json(res, 404, { reason: "job not found" });
        if (job.status === "processing") {
          const provider = providers[job.provider];
          if (!provider?.available()) return json(res, 503, { reason: `${job.provider} is not configured; restore its key to resume this job` });
          const state = await provider.poll(job.providerJobId, { model: job.model });
          Object.assign(job, state, { remoteOutputUrl: state.outputUrl ?? job.remoteOutputUrl, updatedAt: now() });
          if (state.status === "succeeded" && state.outputUrl) {
            const target = join(store.resultDir, `${job.id}.mp4`);
            try { await download(state.outputUrl, target); job.outputPath = target; }
            catch (error) { job.status = "failed"; job.failure = `provider finished, but its expiring output could not be saved locally: ${error.message}`; }
          }
          await store.set(job);
        }
        return json(res, 200, publicJob(job));
      }
      return json(res, 404, { reason: "not found" });
    } catch (error) {
      return json(res, error.status || 500, { reason: error.message || String(error) });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGenerationServer();
  server.listen(PORT, HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    process.send?.({ type: "cozyclay-generation-ready", port });
    console.log(`[generation] listening on http://${HOST}:${port}`);
  });
  server.on("error", (error) => {
    if (process.send && process.connected) {
      process.send({ type: "cozyclay-generation-listen-error", port: PORT, code: error?.code }, () => process.exit(1));
    } else {
      console.error(`[generation] cannot listen on http://${HOST}:${PORT}: ${error.message}`);
      process.exit(1);
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
