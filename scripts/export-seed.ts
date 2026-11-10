/**
 * Exports real, completed sandbox rentals from a local approval-session DB into
 * server/seed/real-runs.json (PLAN B10 "Seed", B13 `--export-seed`). The hosted server imports
 * them on boot, so its evidence pages show real PayPal ids even on a fresh (ephemeral) disk.
 *
 * Usage: node scripts/export-seed.ts --db data/s2.db --codes HB-1,HB-2,HB-3 [--label "session S2, 11 Nov"]
 *
 * Codes are renamed HB-R1, HB-R2… so they never clash with bookings made on the server.
 * Photos are copied to server/seed/real-runs/ (paths are stored relative to the repo root).
 * Every email address (customer, sandbox payer, sandbox merchant) is replaced with a placeholder.
 * Nothing here calls PayPal.
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, d = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const dbPath = path.resolve(ROOT, arg('db', 'data/s2.db'));
const codes = arg('codes').split(',').map((s) => s.trim()).filter(Boolean);
const label = arg('label', 'an approval session');
if (!codes.length) throw new Error('Pass --codes HB-1,HB-2');

const FINAL = ['settled_clean', 'settled_charged', 'refunded', 'contest_denied', 'cancelled'];
const db = new DatabaseSync(dbPath, { readOnly: true });
const photoDir = path.join(ROOT, 'server', 'seed', 'real-runs');
rmSync(photoDir, { recursive: true, force: true });
mkdirSync(photoDir, { recursive: true });

const out = codes.map((code, i) => {
  const b: any = db.prepare('SELECT * FROM bookings WHERE code = ?').get(code);
  if (!b) throw new Error(`${code} not found in ${dbPath}`);
  if (!FINAL.includes(b.state)) throw new Error(`${code} is ${b.state}; only finished rentals are exported`);
  const newCode = `HB-R${i + 1}`;
  const swap = (s: unknown) => (typeof s === 'string' ? s.replace(new RegExp(`\\b${code}\\b`, 'g'), newCode) : s);
  const rows = (sql: string) => db.prepare(sql).all(b.id).map((r: any) => ({ ...r }));
  const item: any = db.prepare('SELECT slug FROM items WHERE id = ?').get(b.item_id);

  const photos = rows('SELECT * FROM photos WHERE booking_id = ? ORDER BY phase, angle').map((p) => {
    const name = `${newCode}-${p.phase}-${p.angle}.jpg`;
    copyFileSync(p.path, path.join(photoDir, name));
    return { ...p, path: path.posix.join('server/seed/real-runs', name) };
  });
  const booking = { ...b, code: newCode, customer_email: 'buyer@example.com', approve_url: null };
  return {
    itemSlug: item.slug,
    label,
    booking,
    related: {
      photos,
      inspections: rows('SELECT * FROM inspections WHERE booking_id = ? ORDER BY id'),
      findings: rows('SELECT * FROM findings WHERE booking_id = ? ORDER BY id'),
      payments: rows('SELECT * FROM payments WHERE booking_id = ? ORDER BY id'),
      events: rows('SELECT * FROM events WHERE booking_id = ? ORDER BY id').map((e) => ({ ...e, summary: swap(e.summary) })),
      contests: rows('SELECT * FROM contests WHERE booking_id = ? ORDER BY id'),
    },
  };
});

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const json = JSON.stringify(out, (_k, v) => (typeof v === 'string' ? v.replace(EMAIL, 'redacted@example.com') : v), 2);
writeFileSync(path.join(ROOT, 'server', 'seed', 'real-runs.json'), json + '\n');
for (const r of out) console.log(`${r.booking.code} ${r.booking.state} payments=${r.related.payments.length} photos=${r.related.photos.length} events=${r.related.events.length}`);
