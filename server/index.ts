import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { env, assertSandbox, hasPayPal, ROOT } from './env.ts';

assertSandbox();

const { api } = await import('./routes/api.ts');
const { seedIfEmpty } = await import('./seed/seed.ts');
const { sweep } = await import('./sync.ts');
const { ensureWebhook } = await import('./paypal/webhooks.ts');
const { get } = await import('./db.ts');

seedIfEmpty();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
// CSP is off: it would block the PayPal JS SDK (B12 allows adding it later if it does not break checkout).
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

app.get('/healthz', (_req, res) => {
  get('SELECT 1 x');
  res.json({ ok: true, sandbox: true });
});

// PayPal redirects the buyer here after approval or cancel.
app.get('/paypal/return', (req, res) => {
  const t = String(req.query.b ?? '');
  res.redirect(/^[a-f0-9]{64}$/.test(t) ? `/booking/${t}?approved=1` : '/');
});
app.get('/paypal/cancel', (req, res) => {
  const t = String(req.query.b ?? '');
  res.redirect(/^[a-f0-9]{64}$/.test(t) ? `/booking/${t}?cancelled=1` : '/');
});
// Return page for the approval-session script (B13).
app.get('/approved', (_req, res) => res.type('html').send('<!doctype html><meta name="robots" content="noindex"><title>Approved</title><p style="font-family:system-ui;padding:2rem">Approved. You can close this tab.</p>'));

app.use('/api', api);

const dist = path.join(ROOT, 'client', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    if (/^\/(booking|e)\//.test(req.path)) res.setHeader('X-Robots-Tag', 'noindex');
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.listen(env.PORT, () => {
  console.log(`Handback on :${env.PORT} (PayPal sandbox${hasPayPal() ? '' : ', keys missing'})`);
});

if (hasPayPal() && env.PUBLIC_BASE_URL.startsWith('https://')) {
  ensureWebhook(env.PUBLIC_BASE_URL).then(
    (id) => console.log(`[webhook] registered (${id ? 'ok' : 'skipped'})`),
    (err) => console.warn('[webhook] setup failed:', err.message),
  );
}

let sweeping = false;
setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweep();
  } catch (err) {
    console.warn('[sweep]', (err as Error).message);
  } finally {
    sweeping = false;
  }
}, 60_000).unref();
