import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Local dev: keys live in ../secrets.env (outside the repo). On Render they are env vars.
const local = path.resolve(ROOT, '..', 'secrets.env');
if (existsSync(local) && !process.env.RENDER) process.loadEnvFile(local);

const e = process.env;
const num = (k: string, d: number) => (e[k] && !Number.isNaN(Number(e[k])) ? Number(e[k]) : d);

export const env = {
  PAYPAL_ENV: e.PAYPAL_ENV ?? '',
  PAYPAL_CLIENT_ID: e.PAYPAL_CLIENT_ID ?? '',
  PAYPAL_CLIENT_SECRET: e.PAYPAL_CLIENT_SECRET ?? '',
  PUBLIC_BASE_URL: (e.PUBLIC_BASE_URL || e.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
  GEMINI_API_KEY: e.GEMINI_API_KEY ?? '',
  GEMINI_VISION_MODEL: e.GEMINI_VISION_MODEL || 'gemini-3.5-flash',
  GEMINI_TEXT_MODEL: e.GEMINI_TEXT_MODEL || 'gemini-3.5-flash',
  // Free-tier quotas are per model and small (one model allowed 20 requests a day), so a busy or
  // exhausted model hands over to the next one. The model that answered is recorded and shown.
  GEMINI_FALLBACK_MODELS: (e.GEMINI_FALLBACK_MODELS ?? 'gemini-3.6-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-2.5-flash').split(',').map((s) => s.trim()).filter(Boolean),
  CHANNEL3_API_KEY: e.CHANNEL3_API_KEY ?? '',
  AG_STUDIO: e.AG_STUDIO ?? '',
  ADMIN_TOKEN: e.ADMIN_TOKEN ?? '',
  DATA_DIR: path.resolve(ROOT, e.DATA_DIR || 'data'),
  AI_DAILY_CAP_GLOBAL: num('AI_DAILY_CAP_GLOBAL', 150),
  AI_MIN_INTERVAL_MS: num('AI_MIN_INTERVAL_MS', 7000),
  AUTO_RELEASE_MIN_CONF: num('AUTO_RELEASE_MIN_CONF', 0.85),
  PORT: num('PORT', 8787),
  isProd: e.NODE_ENV === 'production' || !!e.RENDER,
};

export const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';

export function assertSandbox(): void {
  if (env.PAYPAL_ENV !== 'sandbox') {
    console.error('Refusing to start: PAYPAL_ENV must be "sandbox".');
    process.exit(1);
  }
}

export const hasPayPal = () => !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
export const hasGemini = () => !!env.GEMINI_API_KEY;
