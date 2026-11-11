/**
 * Stage data for the demo recording (PLAN D2). Talks to a running Handback over HTTP, so it works
 * against the hosted site. It never logs in to PayPal: it prints approval links for the user.
 *
 *   node scripts/stage-demo.ts create [--base URL]   creates two bookings, prints their PayPal links
 *   node scripts/stage-demo.ts finish [--base URL]   after approval: authorizes both, picks up B
 *
 * Booking B (sample item, 10–12 days ahead) is picked up with the pickup sample set, ready for the
 * "Return: damaged" clip. Booking C (projector, 2–4 days ahead) is authorized for the schedule
 * drag clip. Both are created within the 15-minute tentative window, so approve soon after create.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const base = arg('base', 'https://handback-nvq9.onrender.com').replace(/\/$/, '');
const OUT = path.join(import.meta.dirname, 'out', 'stage-demo.json');
const DAY = 86_400_000;

async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(`${base}/api${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

const day = (n: number) => {
  const d = new Date(Date.now() + n * DAY);
  d.setUTCHours(10, 0, 0, 0);
  return d.toISOString();
};

type Staged = { label: string; token: string; code: string; approveUrl: string; id?: number };

async function create() {
  const plan = [
    { label: 'B (return damaged)', itemId: 1, start: day(10), end: day(12) },
    { label: 'C (schedule drag)', itemId: 2, start: day(2), end: day(4) },
  ];
  const out: Staged[] = [];
  for (const p of plan) {
    const r = await call('POST', '/bookings', { itemId: p.itemId, start: p.start, end: p.end, name: 'Demo customer', email: 'demo.customer@example.com' });
    out.push({ label: p.label, token: r.token, code: r.code, approveUrl: r.approveUrl });
  }
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ base, created: new Date().toISOString(), bookings: out }, null, 2));
  out.forEach((b, i) => console.log(`${i + 1}. ${b.code} ${b.label}\n   ${b.approveUrl}`));
}

async function finish() {
  const s = JSON.parse(readFileSync(OUT, 'utf8')) as { bookings: Staged[] };
  for (const b of s.bookings) {
    let d = await call('POST', `/bookings/by-token/${b.token}/authorize`).catch((e) => ({ error: String(e.message) }));
    if ('error' in d) { console.log(`${b.code}: not authorized yet: ${d.error}`); continue; }
    b.id = d.booking.id;
    console.log(`${b.code}: ${d.booking.state}`);
    if (b.label.startsWith('B') && d.booking.state === 'authorized') {
      await call('POST', `/shop/bookings/${b.id}/photos?phase=pickup`, { sampleSet: 'pickup' });
      d = await call('POST', `/shop/bookings/${b.id}/pickup`);
      console.log(`${b.code}: ${d.booking.state} (pickup sample set)`);
    }
  }
  writeFileSync(OUT, JSON.stringify(s, null, 2));
}

const cmd = process.argv[2];
if (cmd === 'create') await create();
else if (cmd === 'finish') await finish();
else console.log('Usage: node scripts/stage-demo.ts create|finish [--base URL]');
