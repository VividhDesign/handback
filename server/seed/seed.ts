import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, db } from '../db.ts';
import { ROOT } from '../env.ts';
import { DEFAULT_RATE_CARD, rentalFee, damagePrice, cleaningPrice } from '../pricing/ratecard.ts';
import { token } from '../lib/ids.ts';

const SEED_DIR = path.join(ROOT, 'server', 'seed');

type SeedItem = { slug: string; name: string; category: string; description: string; daily_fee_cents: number; deposit_cents: number; replacement_value_cents: number; tag?: string; accessories: { name: string; list_price_cents: number; search_query: string }[] };

/** Seeds items, accessories and the rate card when the DB is empty, then refreshes sample rows. */
export function seedIfEmpty() {
  const n = get<{ n: number }>('SELECT COUNT(*) n FROM items')!.n;
  if (n === 0) {
    const items: SeedItem[] = JSON.parse(readFileSync(path.join(SEED_DIR, 'items.json'), 'utf8'));
    tx(() => {
      for (const it of items) {
        const r = run('INSERT INTO items (slug, name, category, description, daily_fee_cents, deposit_cents, replacement_value_cents, has_samples, tag) VALUES (?,?,?,?,?,?,?,?,?)',
          it.slug, it.name, it.category, it.description, it.daily_fee_cents, it.deposit_cents, it.replacement_value_cents, existsSync(path.join(ROOT, 'samples', it.slug, 'pickup', '1.jpg')) ? 1 : 0, it.tag ?? null);
        for (const a of it.accessories) run('INSERT INTO accessories (item_id, name, list_price_cents, search_query) VALUES (?,?,?,?)', Number(r.lastInsertRowid), a.name, a.list_price_cents, a.search_query);
      }
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('rate_card', ?)", JSON.stringify(DEFAULT_RATE_CARD));
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('shop_name', 'Handback Rentals')");
    });
  }
  const day = new Date().toISOString().slice(0, 10);
  const last = get<{ value: string }>("SELECT value FROM settings WHERE key = 'samples_day'")?.value;
  if (last !== day) reseedSamples();
  importRealRuns();
}

// Deterministic pseudo-random so the sample history is stable within a day.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const NAMES = ['Sam Rivera', 'Alex Kim', 'Jordan Lee', 'Priya N.', 'Chris Park', 'Taylor Brooks', 'Morgan Diaz', 'Riya S.', 'Casey Wong', 'Jamie Fox'];

/** About 40 synthetic rows flagged is_sample, dated relative to today. They never touch PayPal. */
export function reseedSamples() {
  const items = all('SELECT * FROM items ORDER BY id');
  const r = rng(Number(new Date().toISOString().slice(0, 10).replace(/-/g, '')));
  const now = Date.now();
  const H = 3_600_000;
  let made = 0;
  tx(() => {
    const ids = all('SELECT id FROM bookings WHERE is_sample = 1').map((x) => x.id);
    for (const id of ids) {
      for (const t of ['events', 'findings', 'inspections', 'payments', 'photos', 'contests']) run(`DELETE FROM ${t} WHERE booking_id = ?`, id);
      run('DELETE FROM bookings WHERE id = ?', id);
    }
    for (let i = 0; i < 40; i++) {
      const it = items[Math.floor(r() * items.length)];
      const days = 1 + Math.floor(r() * 4);
      // Past rentals spread over 30 days, plus a few upcoming and current ones.
      const offsetH = i < 32 ? -(24 + r() * 30 * 24) : i < 36 ? -(r() * 48) : 24 + r() * 10 * 24;
      const start = new Date(now + offsetH * H);
      start.setUTCMinutes(0, 0, 0);
      const end = new Date(start.getTime() + days * 24 * H);
      const fee = rentalFee(it.daily_fee_cents, start.toISOString(), end.toISOString());
      const auth = fee + it.deposit_cents;
      const past = end.getTime() < now;
      const roll = r();
      let state = 'authorized';
      let captured: number | null = null;
      let charges = 0;
      const finding: { type: string; desc: string; sev: string; cents: number; conf: number; decision: string } | null = past && roll > 0.72
        ? (roll > 0.9
          ? { type: 'needs_cleaning', desc: 'Dirt on the base', sev: 'minor', cents: cleaningPrice(DEFAULT_RATE_CARD).cents, conf: 0.81, decision: 'approved' }
          : { type: 'new_damage', desc: 'New scratch on the side panel', sev: roll > 0.8 ? 'moderate' : 'minor', cents: damagePrice(DEFAULT_RATE_CARD, roll > 0.8 ? 'moderate' : 'minor', it.replacement_value_cents).cents, conf: 0.7 + r() * 0.25, decision: r() > 0.25 ? 'approved' : 'waived' })
        : null;
      if (past) {
        if (roll < 0.06) state = 'cancelled';
        else {
          if (finding?.decision === 'approved') charges = Math.min(finding.cents, auth - fee);
          state = charges > 0 ? 'settled_charged' : 'settled_clean';
          captured = fee + charges;
        }
      } else if (start.getTime() < now) state = 'picked_up';
      const releaseMs = state === 'settled_clean' ? Math.round(4_000 + r() * 9_000) : state === 'settled_charged' ? Math.round(20 * 60_000 + r() * 6 * 3_600_000) : null;
      const code = `HB-S${String(100 + i)}`;
      const ins = run(`INSERT INTO bookings (code, public_token, item_id, customer_name, customer_email, start_at, end_at, fee_cents, deposit_cents, authorized_cents, state, honor_ends_at, hold_expires_at,
          picked_up_at, returned_at, settled_at, release_ms, captured_cents, released_cents, charges_cents, excess_cents, source, is_sample, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
        code, token(), it.id, NAMES[i % NAMES.length], 'sample@example.com', start.toISOString(), end.toISOString(), fee, it.deposit_cents, state === 'cancelled' ? auth : auth, state,
        new Date(start.getTime() - 24 * H + 72 * H).toISOString(), new Date(start.getTime() - 24 * H + 29 * 24 * H).toISOString(),
        state === 'cancelled' || start.getTime() > now ? null : start.toISOString(),
        past && state !== 'cancelled' ? end.toISOString() : null,
        past ? new Date(end.getTime() + (releaseMs ?? 0)).toISOString() : null,
        releaseMs, captured, captured != null ? auth - captured : state === 'cancelled' ? auth : null, charges || null, 0, 'seed', new Date(start.getTime() - 24 * H).toISOString());
      const bid = Number(ins.lastInsertRowid);
      if (finding && past && state !== 'cancelled') {
        run(`INSERT INTO findings (booking_id, type, description, severity, confidence, proposed_cents, price_source, decision, decided_at) VALUES (?,?,?,?,?,?,?,?,?)`,
          bid, finding.type, finding.desc, finding.sev, finding.conf, finding.cents, 'Rate card (sample)', finding.decision, end.toISOString());
      }
      made++;
    }
    run("INSERT INTO settings (key, value) VALUES ('samples_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", new Date().toISOString().slice(0, 10));
  });
  return { sampleRows: made };
}

/** Real completed sandbox rentals exported by `npm run session -- --export-seed` (B13). */
function importRealRuns() {
  const f = path.join(SEED_DIR, 'real-runs.json');
  if (!existsSync(f)) return;
  const runs: any[] = JSON.parse(readFileSync(f, 'utf8'));
  for (const r of runs) {
    if (get('SELECT id FROM bookings WHERE code = ?', r.booking.code)) continue;
    tx(() => {
      const it = get('SELECT id FROM items WHERE slug = ?', r.itemSlug);
      if (!it) return;
      const cols = Object.keys(r.booking).filter((k) => k !== 'id' && k !== 'item_id');
      const ins = run(`INSERT INTO bookings (${cols.join(',')}, item_id) VALUES (${cols.map(() => '?').join(',')}, ?)`, ...cols.map((k) => r.booking[k]), it.id);
      const bid = Number(ins.lastInsertRowid);
      for (const [table, rows] of Object.entries(r.related ?? {}) as [string, any[]][]) {
        if (!['payments', 'events', 'findings', 'inspections', 'contests'].includes(table)) continue;
        for (const row of rows) {
          const c = Object.keys(row).filter((k) => k !== 'id' && k !== 'booking_id' && k !== 'inspection_id');
          run(`INSERT INTO ${table} (${c.join(',')}, booking_id) VALUES (${c.map(() => '?').join(',')}, ?)`, ...c.map((k) => row[k]), bid);
        }
      }
    });
  }
}

void db;
