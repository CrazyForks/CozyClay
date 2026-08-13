#!/usr/bin/env node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { RUNWAY_MODELS, estimateRunwayCost, pollRunway, submitRunway, validateRunwaySpec } from "./providers/runway.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CCLAY_GENERATION_PORT || 5182);
const MAX_BODY = 16 * 1024 * 1024;
const jobs = new Map();

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
  const { raw, ...safe } = job;
  return safe;
}

export function createGenerationServer() {
return createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/generation/health") {
      return json(res, 200, { ok: true, providers: { runway: Boolean(process.env.RUNWAYML_API_SECRET) } });
    }
    if (req.method === "GET" && url.pathname === "/generation/models") {
      return json(res, 200, { models: RUNWAY_MODELS.map((model) => ({ ...model, provider: "runway", available: Boolean(process.env.RUNWAYML_API_SECRET) })) });
    }
    if (req.method === "POST" && url.pathname === "/generation/validate") {
      const spec = await readJson(req);
      if (!spec.provider) return json(res, 422, { reason: "provider is required" });
      if (spec.provider !== "runway") return json(res, 422, { reason: `unsupported provider: ${spec.provider}` });
      if (!spec.model) return json(res, 422, { reason: "model is required" });
      const verdict = validateRunwaySpec(spec);
      return json(res, verdict.ok ? 200 : 422, { ...verdict, model: undefined, estimatedCostUsd: verdict.ok ? estimateRunwayCost(spec) : null });
    }
    if (req.method === "POST" && url.pathname === "/generation/jobs") {
      const spec = await readJson(req);
      if (!spec.provider) return json(res, 422, { reason: "provider is required" });
      if (spec.provider !== "runway") return json(res, 422, { reason: `unsupported provider: ${spec.provider}` });
      if (!spec.model) return json(res, 422, { reason: "model is required" });
      const verdict = validateRunwaySpec(spec);
      if (!verdict.ok) return json(res, 422, { reason: verdict.errors[0], errors: verdict.errors, warnings: verdict.warnings });
      const submitted = await submitRunway(spec);
      const id = randomUUID();
      const job = { id, provider: "runway", model: spec.model, providerJobId: submitted.providerJobId, status: "processing", progress: null, outputUrl: null, failure: null, warnings: submitted.warnings, estimatedCostUsd: estimateRunwayCost(spec), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      jobs.set(id, job);
      return json(res, 202, publicJob(job));
    }
    const match = url.pathname.match(/^\/generation\/jobs\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const job = jobs.get(match[1]);
      if (!job) return json(res, 404, { reason: "job not found" });
      if (job.status === "processing") {
        const state = await pollRunway(job.providerJobId);
        Object.assign(job, state, { updatedAt: new Date().toISOString() });
      }
      return json(res, 200, publicJob(job));
    }
    return json(res, 404, { reason: "not found" });
  } catch (error) {
    return json(res, error.status || 500, { reason: error.message || String(error) });
  }
});
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGenerationServer();
  server.listen(PORT, HOST, () => console.log(`[generation] listening on http://${HOST}:${PORT}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
