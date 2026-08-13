import { getGenerationJob, submitGeneration, validateGeneration } from "./client.js";

const TERMINAL = new Set(["succeeded", "failed"]);

export async function runGeneration(spec, {
  signal,
  timeoutMs = 10 * 60 * 1000,
  initialDelayMs = 1000,
  maxDelayMs = 10000,
  validate = validateGeneration,
  submit = submitGeneration,
  poll = getGenerationJob,
  sleep = (ms, waitSignal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    waitSignal?.addEventListener("abort", () => { clearTimeout(timer); reject(waitSignal.reason); }, { once: true });
  }),
  onUpdate = () => {},
} = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const update = (state) => { onUpdate(state); return state; };
  try {
    update({ status: "validating", job: null, error: null });
    const validation = await validate(spec, { signal: combined });
    update({ status: "submitting", job: null, validation, error: null });
    let job = await submit(spec, { signal: combined });
    update({ status: job.status, job, validation, error: null });
    let delay = initialDelayMs;
    while (!TERMINAL.has(job.status)) {
      await sleep(delay, combined);
      job = await poll(job.id, { signal: combined });
      update({ status: job.status, job, validation, error: null });
      delay = Math.min(maxDelayMs, Math.max(initialDelayMs, delay * 2));
    }
    if (job.status === "failed") throw new Error(job.failure || "generation failed");
    return job;
  } catch (error) {
    const timedOut = timeout.aborted && !signal?.aborted;
    const canceled = signal?.aborted;
    update({ status: timedOut ? "timed_out" : canceled ? "canceled" : "failed", job: null, error: error?.message || String(error) });
    throw error;
  }
}
