import type { Request, Response, NextFunction } from 'express';
import { ipHash } from './ids.ts';

type Bucket = { n: number; reset: number };
const buckets = new Map<string, Bucket>();

/** Fixed-window limit per IP hash. In memory: resets on restart, which is fine for a demo. */
export function limit(name: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${name}:${ipHash(req.ip ?? 'unknown')}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) {
      b = { n: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    if (++b.n > max) {
      res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000));
      return res.status(429).json({ error: `Too many requests (${name}). Try again later.` });
    }
    next();
  };
}

export const MINUTE = 60_000;
export const DAY = 86_400_000;

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 10 * MINUTE).unref();
