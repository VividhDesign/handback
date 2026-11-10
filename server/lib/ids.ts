import { randomBytes, createHash } from 'node:crypto';

export const token = () => randomBytes(32).toString('hex');
export const ipHash = (ip: string) => createHash('sha256').update(`hb:${ip}`).digest('hex').slice(0, 16);

// No TS parameter properties: the server runs with Node's type stripping.
export class HttpError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
