import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_JOB_FILE = join(homedir(), ".cozyclay", "jobs.json");
export const DEFAULT_RESULT_DIR = join(homedir(), ".cozyclay", "results");
export const DEFAULT_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL = new Set(["succeeded", "failed"]);

export function createJobStore({ file = DEFAULT_JOB_FILE, resultDir = DEFAULT_RESULT_DIR, completedTtlMs = DEFAULT_COMPLETED_TTL_MS, now = () => Date.now() } = {}) {
  const jobs = new Map();
  let writeQueue = Promise.resolve();

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      for (const job of Array.isArray(parsed.jobs) ? parsed.jobs : []) if (job?.id) jobs.set(job.id, job);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await cleanup();
    return jobs;
  }

  function persist() {
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, jobs: [...jobs.values()] }, null, 2));
      await rename(temp, file);
    });
    return writeQueue;
  }

  async function cleanup() {
    const cutoff = now() - completedTtlMs;
    let changed = false;
    for (const [id, job] of jobs) {
      if (!TERMINAL.has(job.status) || Date.parse(job.updatedAt) >= cutoff) continue;
      jobs.delete(id);
      if (job.outputPath) await unlink(job.outputPath).catch(() => {});
      changed = true;
    }
    if (changed) await persist();
  }

  async function set(job) { jobs.set(job.id, job); await persist(); return job; }
  function get(id) { return jobs.get(id) ?? null; }
  function list() { return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  return { file, resultDir, load, cleanup, set, get, list };
}
