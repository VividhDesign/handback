import { env } from '../env.ts';
import { get, run } from '../db.ts';
import { ping } from '../lib/events.ts';

// One in-process queue: concurrency 1, minimum gap between calls, backoff on 429.
type Job<T> = { fn: () => Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void; bookingId: number | null };
const jobs: Job<any>[] = [];
let busy = false;
let lastAt = 0;
let backoffUntil = 0;

export function queueLength() {
  return jobs.length + (busy ? 1 : 0);
}

export function enqueue<T>(bookingId: number | null, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    jobs.push({ fn, resolve, reject, bookingId });
    jobs.forEach((j, i) => ping(j.bookingId, 'ai.queued', { position: i + 1 + (busy ? 1 : 0) }));
    void pump();
  });
}

async function pump() {
  if (busy) return;
  const job = jobs.shift();
  if (!job) return;
  busy = true;
  try {
    const wait = Math.max(lastAt + env.AI_MIN_INTERVAL_MS, backoffUntil) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    ping(job.bookingId, 'ai.running', {});
    lastAt = Date.now();
    job.resolve(await job.fn());
  } catch (err: any) {
    if (String(err?.status ?? err?.message).includes('429')) backoffUntil = Date.now() + 30_000;
    job.reject(err);
  } finally {
    busy = false;
    void pump();
  }
}

const day = () => new Date().toISOString().slice(0, 10);

/** Global daily cap plus per-IP caps. Returns null when allowed, or a reason. */
export function capReason(ipHash: string, custom: boolean): string | null {
  const g = get<{ n: number }>("SELECT COALESCE(SUM(n),0) n FROM ai_usage WHERE day = ? AND kind = 'call'", day())!.n;
  if (g >= env.AI_DAILY_CAP_GLOBAL) return 'daily AI cap reached';
  const mine = get<{ n: number }>("SELECT COALESCE(SUM(n),0) n FROM ai_usage WHERE day = ? AND ip_hash = ? AND kind = 'inspection'", day(), ipHash)!.n;
  if (mine >= 10) return 'your daily inspection limit (10) is reached';
  if (custom) {
    const c = get<{ n: number }>("SELECT COALESCE(SUM(n),0) n FROM ai_usage WHERE day = ? AND ip_hash = ? AND kind = 'custom'", day(), ipHash)!.n;
    if (c >= 5) return 'your daily limit for custom photos (5) is reached';
  }
  return null;
}

export function countUsage(ipHash: string, kind: 'call' | 'inspection' | 'custom') {
  run('INSERT INTO ai_usage (day, ip_hash, kind, n) VALUES (?,?,?,1) ON CONFLICT(day, ip_hash, kind) DO UPDATE SET n = n + 1', day(), ipHash, kind);
}
