import { ETA_FALLBACK_TEXT, POLICY } from "./policy.js";

/**
 * Return display data rather than guessing when no worker heartbeat is fresh.
 * `jobs_done_10m` is a rolling throughput sample supplied by the box.
 */
export async function etaFor(env, position, now = Date.now()) {
  const fallback = { etaMinutes: null, etaText: ETA_FALLBACK_TEXT };
  const db = env?.DB;
  if (!db || !Number.isFinite(Number(position)) || Number(position) <= 0) return { etaMinutes: 0, etaText: "Ready soon" };
  try {
    const rows = await db.prepare(
      "SELECT jobs_done_10m FROM worker_health WHERE last_seen >= ?",
    ).bind(now - POLICY.HEARTBEAT_FRESH_MS).all();
    const throughput = (rows?.results ?? []).reduce((sum, row) => sum + Math.max(0, Number(row.jobs_done_10m ?? 0)), 0);
    if (throughput <= 0) return fallback;
    const minutes = Math.max(1, Math.ceil(Number(position) * 10 / throughput));
    return { etaMinutes: minutes, etaText: `About ${minutes} minute${minutes === 1 ? "" : "s"}` };
  } catch {
    return fallback;
  }
}

export { ETA_FALLBACK_TEXT };
