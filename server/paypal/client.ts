import { env, PAYPAL_BASE, hasPayPal } from '../env.ts';

let cached: { token: string; exp: number } | null = null;

export class PayPalError extends Error {
  status: number;
  issue?: string;
  debugId?: string;
  body: any;
  constructor(status: number, body: any) {
    const issue = body?.details?.[0]?.issue ?? body?.name ?? body?.error;
    super(`PayPal ${status}: ${issue ?? 'error'}${body?.details?.[0]?.description ? ` (${body.details[0].description})` : body?.message ? ` (${body.message})` : ''}`);
    this.status = status;
    this.issue = issue;
    this.debugId = body?.debug_id;
    this.body = body;
  }
}

export async function accessToken(): Promise<string> {
  if (!hasPayPal()) throw new Error('PayPal keys are not configured');
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, body);
  cached = { token: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

export function resetToken() {
  cached = null;
}

export interface CallOpts {
  requestId?: string;
  body?: unknown;
  rawBody?: string;
  representation?: boolean;
}

/** Reads (GET) are retried twice on a network error or a PayPal 5xx; writes are never retried here. */
export async function paypal<T = any>(method: string, path: string, opts: CallOpts = {}): Promise<{ status: number; body: T; debugId?: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await paypalOnce<T>(method, path, opts);
    } catch (err) {
      const retry = method === 'GET' && attempt < 3 && (!(err instanceof PayPalError) || err.status >= 500);
      if (!retry) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function paypalOnce<T>(method: string, path: string, opts: CallOpts): Promise<{ status: number; body: T; debugId?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    'Content-Type': 'application/json',
  };
  if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
  if (opts.representation !== false) headers['Prefer'] = 'return=representation';
  const res = await fetch(`${PAYPAL_BASE}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  const debugId = res.headers.get('paypal-debug-id') ?? body?.debug_id;
  if (!res.ok) throw new PayPalError(res.status, { ...body, debug_id: debugId });
  return { status: res.status, body, debugId: debugId ?? undefined };
}
