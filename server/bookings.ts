import path from 'node:path';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { all, get, run, tx, nowISO, type Row } from './db.ts';
import { env, ROOT } from './env.ts';
import { logEvent } from './lib/events.ts';
import { assertTransition, HELD_STATES, type BookingState } from './lib/states.ts';
import { HttpError, token } from './lib/ids.ts';
import { fmt, fromPayPal } from './lib/money.ts';
import { rentalDays, rentalFee, damagePrice, cleaningPrice, latePrice, accessoryPrice, DEFAULT_RATE_CARD, type RateCard } from './pricing/ratecard.ts';
import { settlementMath } from './pricing/settle.ts';
import { createAuthorizeOrder, getOrder, authorizeOrder } from './paypal/orders.ts';
import { captureFinal, voidAuthorization } from './paypal/payments.ts';
import { PayPalError } from './paypal/client.ts';
import { processPhoto } from './checks/photos.ts';
import { runReturnChecks, pickupChecks, type PhotoRow } from './checks/deterministic.ts';
import { runPassport, runCompare, AiUnavailable, PROMPT_VERSION, type LoadedPhoto } from './ai/inspect.ts';
import { capReason, countUsage } from './ai/queue.ts';
import { decide } from './ai/decide.ts';
import type { Passport } from './ai/schemas.ts';
import { getQuote } from './pricing/channel3.ts';

export const MAX_DAYS = 7;
export const MAX_AHEAD_DAYS = 21;
const TENTATIVE_MIN = 15;

export function rateCard(): RateCard {
  const r = get<{ value: string }>("SELECT value FROM settings WHERE key = 'rate_card'");
  return r ? { ...DEFAULT_RATE_CARD, ...JSON.parse(r.value) } : DEFAULT_RATE_CARD;
}

/**
 * Prefix for every PayPal-Request-Id of a booking. The code alone repeats across databases (a fresh
 * Render disk, a local DB), and PayPal would answer a repeated id with the old order or capture, so
 * the booking's random token is part of the key.
 */
export const reqKey = (b: Record<string, any>) => `hb-${b.code}-${b.public_token.slice(0, 10)}`;

export function booking(id: number): Row {
  const b = get('SELECT * FROM bookings WHERE id = ?', id);
  if (!b) throw new HttpError(404, 'Booking not found');
  return b;
}

export function item(id: number): Row {
  const i = get('SELECT * FROM items WHERE id = ?', id);
  if (!i) throw new HttpError(404, 'Item not found');
  return i;
}

export function accessoriesOf(itemId: number): Row[] {
  return all('SELECT * FROM accessories WHERE item_id = ? ORDER BY id', itemId);
}

/** Moves a booking to a new state inside the caller's transaction and writes an event. */
function transition(b: Row, to: BookingState, actor: Parameters<typeof logEvent>[2], summary: string, patch: Record<string, unknown> = {}, data?: unknown) {
  assertTransition(b.state, to);
  const fields = { ...patch, state: to };
  const keys = Object.keys(fields);
  const r = run(`UPDATE bookings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND state = ?`, ...keys.map((k) => (fields as any)[k]), b.id, b.state);
  if (r.changes !== 1) throw new HttpError(409, 'Booking changed meanwhile, reload and try again');
  logEvent(b.id, `booking.${to}`, actor, summary, data);
}

function recordPayment(bookingId: number, kind: string, requestId: string | null, p: { id?: string; status?: string; cents?: number; raw?: unknown; debugId?: string; via?: string }) {
  run(
    `INSERT INTO payments (booking_id, kind, paypal_id, status, amount_cents, request_id, debug_id, raw_json, via, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(request_id) DO UPDATE SET paypal_id = excluded.paypal_id, status = excluded.status, raw_json = excluded.raw_json`,
    bookingId, kind, p.id ?? null, p.status ?? null, p.cents ?? null, requestId, p.debugId ?? null, p.raw === undefined ? null : JSON.stringify(p.raw), p.via ?? 'rest', nowISO(),
  );
}

// ---------- Availability and booking ----------

const BLOCKING = ['pending_approval', ...HELD_STATES];

export function overlaps(itemId: number, startISO: string, endISO: string, exceptId = 0): Row[] {
  return all(
    `SELECT id, code, state FROM bookings WHERE item_id = ? AND id != ? AND is_sample = 0 AND state IN (${BLOCKING.map(() => '?').join(',')}) AND start_at < ? AND end_at > ?`,
    itemId, exceptId, ...BLOCKING, endISO, startISO,
  );
}

export function quote(itemId: number, startISO: string, endISO: string) {
  const it = item(itemId);
  const days = rentalDays(startISO, endISO);
  const fee = rentalFee(it.daily_fee_cents, startISO, endISO);
  return { days, feeCents: fee, depositCents: it.deposit_cents, totalCents: fee + it.deposit_cents };
}

function validateDates(startISO: string, endISO: string) {
  const s = Date.parse(startISO), e = Date.parse(endISO);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) throw new HttpError(400, 'End must be after start');
  if (e - s > MAX_DAYS * 86_400_000) throw new HttpError(400, `A booking is at most ${MAX_DAYS} days`);
  if (s > Date.now() + MAX_AHEAD_DAYS * 86_400_000) throw new HttpError(400, `Bookings start at most ${MAX_AHEAD_DAYS} days ahead`);
  if (e < Date.now()) throw new HttpError(400, 'Dates are in the past');
}

function nextCode(): string {
  const r = get<{ n: number }>("SELECT COALESCE(MAX(CAST(SUBSTR(code, 4) AS INTEGER)), 1040) n FROM bookings WHERE code GLOB 'HB-[0-9]*'")!;
  return `HB-${r.n + 1}`;
}

export async function createBooking(input: { itemId: number; start: string; end: string; name: string; email: string; source: string; baseUrl: string }) {
  validateDates(input.start, input.end);
  const it = item(input.itemId);
  const q = quote(input.itemId, input.start, input.end);
  const b = tx(() => {
    if (overlaps(input.itemId, input.start, input.end).length) throw new HttpError(409, 'That item is already booked for these dates');
    const code = nextCode();
    const r = run(
      `INSERT INTO bookings (code, public_token, item_id, customer_name, customer_email, start_at, end_at, fee_cents, deposit_cents, state, tentative_expires_at, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,'pending_approval',?,?,?)`,
      code, token(), it.id, input.name, input.email, input.start, input.end, q.feeCents, q.depositCents,
      new Date(Date.now() + TENTATIVE_MIN * 60_000).toISOString(), input.source, nowISO(),
    );
    const id = Number(r.lastInsertRowid);
    logEvent(id, 'booking.created', 'customer', `${code}: ${it.name}, ${q.days} day(s), ${fmt(q.feeCents)} rental + ${fmt(q.depositCents)} deposit hold`);
    return booking(id);
  });
  try {
    const o = await createAuthorizeOrder({
      code: b.code, invoiceId: `${b.code}-${b.public_token.slice(0, 8)}`, itemName: it.name, days: q.days, feeCents: q.feeCents, depositCents: q.depositCents,
      returnUrl: `${input.baseUrl}/paypal/return?b=${b.public_token}`, cancelUrl: `${input.baseUrl}/paypal/cancel?b=${b.public_token}`,
      requestId: `${reqKey(b)}-order-1`,
    });
    tx(() => {
      run('UPDATE bookings SET order_id = ?, approve_url = ? WHERE id = ?', o.orderId, o.approveUrl ?? null, b.id);
      recordPayment(b.id, 'order', `${reqKey(b)}-order-1`, { id: o.orderId, status: o.status, cents: q.totalCents, raw: o.order, debugId: o.debugId });
      logEvent(b.id, 'paypal.order.created', 'paypal', `PayPal order ${o.orderId} created (intent AUTHORIZE, ${fmt(q.totalCents)})`);
    });
  } catch (err) {
    tx(() => transition(booking(b.id), 'cancelled', 'system', `PayPal order could not be created: ${(err as Error).message}`));
    throw err;
  }
  return booking(b.id);
}

/** Authorize after the buyer approved. Safe to call repeatedly (fixed request id, state guard). */
export async function authorizeBooking(id: number, actor: 'customer' | 'paypal' | 'system' = 'customer') {
  let b = booking(id);
  if (HELD_STATES.includes(b.state) || b.authorization_id) return b;
  if (!['pending_approval', 'expired'].includes(b.state)) throw new HttpError(409, `Cannot authorize a ${b.state} booking`);
  const order = await getOrder(b.order_id);
  if (order.status !== 'APPROVED' && order.status !== 'COMPLETED') throw new HttpError(409, `PayPal order is ${order.status}, not approved yet`);
  const { auth, order: ord } = await authorizeOrder(b.order_id, `${reqKey(b)}-auth`);
  const cents = fromPayPal(auth.amount.value);
  b = booking(id);
  if (b.state === 'expired' || b.state === 'cancelled') {
    // Late approval: authorize only if the slot is still free, otherwise void at once.
    const clash = overlaps(b.item_id, b.start_at, b.end_at, b.id).length > 0;
    if (clash || b.state === 'cancelled') {
      const v = await voidAuthorization(auth.id, `${reqKey(b)}-void`);
      tx(() => {
        recordPayment(b.id, 'authorization', `${reqKey(b)}-auth`, { id: auth.id, status: auth.status, cents, raw: ord });
        recordPayment(b.id, 'void', `${reqKey(b)}-void`, { id: auth.id, status: 'VOIDED', cents, raw: v.body });
        logEvent(b.id, 'paypal.void', 'system', `Approval arrived after the slot was released. Hold ${auth.id} voided at once.`);
      });
      return booking(id);
    }
    run("UPDATE bookings SET state = 'pending_approval' WHERE id = ?", b.id);
    b = booking(id);
  }
  tx(() => {
    recordPayment(b.id, 'authorization', `${reqKey(b)}-auth`, { id: auth.id, status: auth.status, cents, raw: ord });
    const created = Date.parse(auth.create_time ?? nowISO());
    transition(b, 'authorized', actor, `PayPal authorization ${auth.id}: ${fmt(cents)} held, $0.00 captured`, {
      authorization_id: auth.id, authorized_cents: cents, honor_ends_at: new Date(created + 3 * 86_400_000).toISOString(),
      hold_expires_at: auth.expiration_time ?? new Date(created + 29 * 86_400_000).toISOString(), tentative_expires_at: null,
    }, { authorization_id: auth.id, amount: auth.amount, status: auth.status });
    logEvent(b.id, 'paypal.authorized', 'paypal', `paypal.authorized ${fmt(cents)}`);
  });
  return booking(id);
}

export async function cancelBooking(id: number, actor: 'customer' | 'owner' | 'system', why = 'Cancelled before pickup') {
  const b = booking(id);
  if (b.state === 'pending_approval') {
    tx(() => transition(b, 'cancelled', actor, `${why}. Nothing was held.`));
    return booking(id);
  }
  if (b.state !== 'authorized') throw new HttpError(409, 'Only bookings that are not picked up yet can be cancelled');
  const reqId = `${reqKey(b)}-void`;
  const v = await voidAuthorization(b.authorization_id, reqId);
  tx(() => {
    recordPayment(b.id, 'void', reqId, { id: b.authorization_id, status: 'VOIDED', cents: b.authorized_cents, raw: v.body });
    transition(booking(id), 'cancelled', actor, `${why}. Hold ${b.authorization_id} voided, ${fmt(b.authorized_cents)} released.`, { released_cents: b.authorized_cents, settled_at: nowISO() });
    logEvent(b.id, 'paypal.void', 'paypal', `paypal.void ${b.authorization_id}, released ${fmt(b.authorized_cents)}`);
  });
  return booking(id);
}

// ---------- Photos ----------

export function samplesDir(slug: string, set: string) {
  return path.join(ROOT, 'samples', slug, set);
}

export function sampleSets(slug: string): string[] {
  const d = path.join(ROOT, 'samples', slug);
  return existsSync(d) ? readdirSync(d).filter((s) => existsSync(path.join(d, s, '1.jpg'))) : [];
}

export async function savePhotos(bookingId: number, phase: 'pickup' | 'return', files: { angle: number; buffer: Buffer }[], sampleSet: string | null) {
  const b = booking(bookingId);
  if (phase === 'pickup' && b.state !== 'authorized') throw new HttpError(409, 'Pickup photos need an authorized booking');
  if (phase === 'return' && !['picked_up', 'blocked', 'needs_review'].includes(b.state)) throw new HttpError(409, 'Return photos need a picked-up booking');
  if (files.length < 1 || files.length > 5) throw new HttpError(400, 'Send 1–5 photos');
  const processed = await Promise.all(files.map(async (f) => ({ angle: f.angle, p: await processPhoto(f.buffer) })));
  const received = nowISO();
  tx(() => {
    for (const { angle, p } of processed) {
      run('DELETE FROM photos WHERE booking_id = ? AND phase = ? AND angle = ?', bookingId, phase, angle);
      const file = path.join(env.DATA_DIR, 'photos', `${b.public_token.slice(0, 16)}-${phase}-${angle}-${p.sha256.slice(0, 8)}.jpg`);
      writeFileSync(file, p.buffer);
      run('INSERT INTO photos (booking_id, phase, angle, path, sha256, dhash, width, height, mean_luma, exif_taken_at, received_at, sample_set) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        bookingId, phase, angle, file, p.sha256, p.dhash, p.width, p.height, p.meanLuma, p.exifTakenAt, received, sampleSet);
    }
    logEvent(bookingId, 'photos.saved', 'owner', `${processed.length} ${phase} photo(s) saved${sampleSet ? ` (sample set "${sampleSet}")` : ''}`);
  });
}

export async function useSampleSet(bookingId: number, phase: 'pickup' | 'return', set: string) {
  const b = booking(bookingId);
  const it = item(b.item_id);
  const dir = samplesDir(it.slug, set);
  if (!existsSync(path.join(dir, '1.jpg'))) throw new HttpError(404, `No sample set "${set}" for this item`);
  const files = [1, 2, 3, 4, 5].map((angle) => ({ angle, buffer: readFileSync(path.join(dir, `${angle}.jpg`)) }));
  await savePhotos(bookingId, phase, files, set);
}

function photosOf(bookingId: number, phase: string): (PhotoRow & { path: string; sample_set: string | null })[] {
  return all('SELECT * FROM photos WHERE booking_id = ? AND phase = ? ORDER BY angle', bookingId, phase) as any;
}

// ---------- Pickup: passport ----------

export async function runPickup(bookingId: number, ipHash: string) {
  const b = booking(bookingId);
  if (b.state !== 'authorized') throw new HttpError(409, 'Pickup needs an authorized booking');
  const it = item(b.item_id);
  const acc = accessoriesOf(it.id).map((a) => a.name);
  const photos = photosOf(bookingId, 'pickup');
  const checks = pickupChecks(photos);
  if (checks.some((c) => !c.passed)) throw new HttpError(422, `Pickup photos: ${checks.filter((c) => !c.passed).map((c) => c.detail).join('; ')}`);
  const sample = photos.every((p) => p.sample_set) ? `${it.slug}-${photos[0].sample_set}` : null;
  const capped = capReason(ipHash, !sample);
  countUsage(ipHash, 'inspection');
  if (!sample) countUsage(ipHash, 'custom');
  let out;
  try {
    out = await runPassport({ bookingId, itemName: it.name, accessories: acc, photos, sampleSetKey: sample, ipHash, capped });
  } catch (err) {
    if (err instanceof AiUnavailable) {
      // Manual mode: an empty passport the owner can trust; marks will not be auto-excluded.
      out = { result: { item_matches_listing: true, photo_quality: [], existing_marks: [], accessories: acc.map((name) => ({ name, present: true, confidence: 1 })), summary: `Manual pickup (AI unavailable: ${err.message}).` } as Passport, mode: 'manual' as const, model: null, latencyMs: 0 };
    } else throw err;
  }
  tx(() => {
    run('INSERT INTO inspections (booking_id, phase, mode, model, prompt_version, checks_json, result_json, decision, latency_ms, cached_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      bookingId, 'pickup', out.mode, out.model, PROMPT_VERSION, JSON.stringify(checks), JSON.stringify(out.result), 'passport', out.latencyMs, (out as any).cachedAt ?? null, nowISO());
    logEvent(bookingId, 'ai.passport', out.mode === 'manual' ? 'owner' : 'ai',
      `ai.passport ${out.result.existing_marks.length} existing mark(s), ${out.result.accessories.filter((a) => a.present).length}/${acc.length} accessories (${out.mode}${out.mode === 'live' ? `, ${(out.latencyMs / 1000).toFixed(1)} s` : ''})`);
    transition(booking(bookingId), 'picked_up', 'owner', `Picked up. Condition passport saved.`, { picked_up_at: nowISO() });
  });
  return booking(bookingId);
}

export function latestInspection(bookingId: number, phase: string): Row | undefined {
  return get('SELECT * FROM inspections WHERE booking_id = ? AND phase = ? ORDER BY id DESC LIMIT 1', bookingId, phase);
}

// ---------- Return: checks, comparison, decision ----------

export async function runReturn(bookingId: number, ipHash: string, opts: { returnedAt?: string } = {}) {
  let b = booking(bookingId);
  if (!['picked_up', 'blocked', 'needs_review'].includes(b.state)) throw new HttpError(409, `Cannot inspect a ${b.state} booking`);
  if (b.state === 'needs_review' && all("SELECT id FROM findings WHERE booking_id = ? AND decision != 'pending'", bookingId).length)
    throw new HttpError(409, 'Findings were already decided; settle instead');
  const it = item(b.item_id);
  const acc = accessoriesOf(it.id);
  const pickup = photosOf(bookingId, 'pickup');
  const ret = photosOf(bookingId, 'return');
  const returnedAt = opts.returnedAt ?? nowISO();
  const card = rateCard();
  tx(() => transition(booking(bookingId), 'inspecting', 'owner', 'Return photos received. Running checks.', { returned_at: returnedAt, block_reason: null }));
  const checks = runReturnChecks({ pickup, ret, pickedUpAt: b.picked_up_at, endAt: b.end_at, returnedAt, graceMinutes: card.lateGraceMinutes });
  for (const c of checks) logEvent(bookingId, `check.${c.name}`, 'system', `check.${c.name} ${c.passed ? 'passed' : 'FAILED'}: ${c.detail}`);
  const failed = checks.filter((c) => c.blocking && !c.passed);
  if (failed.length) {
    tx(() => {
      run('INSERT INTO inspections (booking_id, phase, mode, checks_json, decision, reasons_json, created_at) VALUES (?,?,?,?,?,?,?)',
        bookingId, 'return', 'checks_only', JSON.stringify(checks), 'blocked', JSON.stringify(failed.map((f) => f.detail)), nowISO());
      transition(booking(bookingId), 'blocked', 'system', `Blocked before any AI call: ${failed.map((f) => f.detail).join('; ')}. Re-shoot the return photos.`, { block_reason: failed.map((f) => f.detail).join('; ') });
    });
    return booking(bookingId);
  }

  const passportRow = latestInspection(bookingId, 'pickup');
  const passport: Passport = JSON.parse(passportRow!.result_json);
  const sample = ret.every((p) => p.sample_set) && pickup.every((p) => p.sample_set) ? `${it.slug}-${ret[0].sample_set}` : null;
  const capped = capReason(ipHash, !sample);
  countUsage(ipHash, 'inspection');
  if (!sample) countUsage(ipHash, 'custom');
  const isLate = !checks.find((c) => c.name === 'late')!.passed;

  let out: any;
  try {
    out = await runCompare({ bookingId, itemName: it.name, accessories: acc.map((a) => a.name), passport, pickup, ret, sampleSetKey: sample, ipHash, capped });
  } catch (err) {
    if (!(err instanceof AiUnavailable)) throw err;
    out = null;
    tx(() => {
      run('INSERT INTO inspections (booking_id, phase, mode, checks_json, decision, reasons_json, created_at) VALUES (?,?,?,?,?,?,?)',
        bookingId, 'return', 'manual', JSON.stringify(checks), 'needs_review', JSON.stringify([`AI unavailable: ${err.message}`]), nowISO());
      if (isLate) addLateFinding(booking(bookingId), it, card, returnedAt, null);
      transition(booking(bookingId), 'needs_review', 'system', `Manual inspection: AI unavailable (${err.message}). The owner adds findings from the rate card.`);
    });
    return booking(bookingId);
  }

  const d = decide({ checksPassed: true, compare: out.result, accessoryNames: acc.map((a) => a.name), isLate, minConf: env.AUTO_RELEASE_MIN_CONF });
  const pricedFindings = await priceFindings(out.result.findings, it, acc, card);
  const inspectionId = tx(() => {
    const r = run('INSERT INTO inspections (booking_id, phase, mode, model, prompt_version, checks_json, result_json, decision, reasons_json, latency_ms, cached_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      bookingId, 'return', out.mode, out.model, PROMPT_VERSION, JSON.stringify(checks), JSON.stringify(out.result), d.decision, JSON.stringify(d.reasons), out.latencyMs, out.cachedAt ?? null, nowISO());
    const iid = Number(r.lastInsertRowid);
    run("DELETE FROM findings WHERE booking_id = ? AND decision = 'pending'", bookingId);
    for (const f of pricedFindings) {
      run(`INSERT INTO findings (inspection_id, booking_id, type, part, description, severity, confidence, photo_index, pickup_photo_index, box_json, existing_mark_id, accessory_name, proposed_cents, price_source)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        iid, bookingId, f.type, f.part ?? null, f.description, f.severity, f.confidence, f.return_photo_index ?? null, f.pickup_photo_index ?? null,
        f.box_2d ? JSON.stringify(f.box_2d) : null, f.existing_mark_id ?? null, f.accessory_name ?? null, f.cents, f.source);
    }
    if (isLate) addLateFinding(booking(bookingId), it, card, returnedAt, iid);
    const v = out.result.overall;
    logEvent(bookingId, 'ai.compare', 'ai', `ai.compare ${v.verdict} ${v.confidence.toFixed(2)} (${out.mode}${out.mode === 'live' ? `, ${(out.latencyMs / 1000).toFixed(1)} s` : `, recorded ${String(out.cachedAt).slice(0, 10)} with ${out.model}`})`, { reasons: d.reasons });
    return iid;
  });
  void inspectionId;
  b = booking(bookingId);
  if (d.decision === 'auto_release') {
    return settle(bookingId, 'ai');
  }
  tx(() => transition(booking(bookingId), 'needs_review', 'ai', `Needs the owner: ${d.reasons.join('; ')}. Nothing is charged until the owner decides.`));
  return booking(bookingId);
}

function addLateFinding(b: Row, it: Row, card: RateCard, returnedAt: string, inspectionId: number | null) {
  const p = latePrice(card, it.daily_fee_cents, b.end_at, returnedAt);
  if (!p) return;
  run(`INSERT INTO findings (inspection_id, booking_id, type, description, severity, confidence, proposed_cents, price_source) VALUES (?,?,?,?,?,?,?,?)`,
    inspectionId, b.id, 'late', `Returned ${new Date(returnedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC, due ${b.end_at.slice(0, 16).replace('T', ' ')} UTC`, 'minor', 1, p.cents, p.source);
}

async function priceFindings(findings: any[], it: Row, acc: Row[], card: RateCard) {
  const out: any[] = [];
  for (const f of findings) {
    if (f.existing_mark_id) {
      out.push({ ...f, cents: 0, source: `Matches passport mark ${f.existing_mark_id}: never charged` });
      continue;
    }
    if (f.type === 'missing_accessory') {
      const a = acc.find((x) => x.name.toLowerCase() === String(f.accessory_name ?? '').toLowerCase()) ?? acc.find((x) => String(f.description).toLowerCase().includes(x.name.toLowerCase()));
      if (a) {
        const q = await getQuote(a.search_query).catch(() => null);
        const p = accessoryPrice(a.list_price_cents, q);
        out.push({ ...f, accessory_name: a.name, cents: p.cents, source: p.source });
      } else out.push({ ...f, cents: 0, source: 'Unknown accessory: owner sets the price or waives' });
      continue;
    }
    const p = f.type === 'needs_cleaning' ? cleaningPrice(card) : damagePrice(card, f.severity, it.replacement_value_cents);
    out.push({ ...f, cents: p.cents, source: p.source });
  }
  return out;
}

/** Manual finding added by the owner (manual mode), priced from the rate card. */
export function addManualFinding(bookingId: number, input: { type: 'new_damage' | 'missing_accessory' | 'needs_cleaning'; severity: 'minor' | 'moderate' | 'major'; description: string; accessoryId?: number }) {
  const b = booking(bookingId);
  if (b.state !== 'needs_review') throw new HttpError(409, 'Findings can only be added while the booking needs review');
  const it = item(b.item_id);
  const card = rateCard();
  let p = input.type === 'needs_cleaning' ? cleaningPrice(card) : damagePrice(card, input.severity, it.replacement_value_cents);
  let accName: string | null = null;
  if (input.type === 'missing_accessory') {
    const a = accessoriesOf(it.id).find((x) => x.id === input.accessoryId);
    if (!a) throw new HttpError(400, 'Pick an accessory');
    accName = a.name;
    p = { cents: a.list_price_cents, source: 'Shop list price (manual finding)' };
  }
  tx(() => {
    run(`INSERT INTO findings (booking_id, type, description, severity, confidence, accessory_name, proposed_cents, price_source) VALUES (?,?,?,?,?,?,?,?)`,
      bookingId, input.type, input.description, input.severity, null, accName, p.cents, p.source);
    logEvent(bookingId, 'finding.manual', 'owner', `Owner added a finding: ${input.description} (${fmt(p.cents)})`);
  });
}

export function decideFinding(findingId: number, decision: 'approved' | 'waived', note: string | null) {
  const f = get('SELECT * FROM findings WHERE id = ?', findingId);
  if (!f) throw new HttpError(404, 'Finding not found');
  const b = booking(f.booking_id);
  if (b.state !== 'needs_review') throw new HttpError(409, 'This booking is not waiting for review');
  if (decision === 'approved' && f.existing_mark_id) throw new HttpError(409, 'A mark from the pickup passport can never be charged');
  tx(() => {
    run('UPDATE findings SET decision = ?, decision_note = ?, decided_at = ? WHERE id = ?', decision, note, nowISO(), findingId);
    logEvent(b.id, `finding.${decision}`, 'owner', `Owner ${decision} "${f.description}"${decision === 'approved' ? ` (${fmt(f.proposed_cents)})` : ''}`);
  });
  return get('SELECT * FROM findings WHERE id = ?', findingId);
}

export function settlementPreview(bookingId: number) {
  const b = booking(bookingId);
  const fs = all('SELECT * FROM findings WHERE booking_id = ?', bookingId);
  const approved = fs.filter((f) => f.decision === 'approved' && !f.existing_mark_id).map((f) => f.proposed_cents);
  const m = settlementMath(b.authorized_cents, b.fee_cents, approved);
  return { ...m, pending: fs.filter((f) => f.decision === 'pending' && !f.existing_mark_id).length, authorizedCents: b.authorized_cents };
}

/**
 * One final capture per booking. 'ai' can only settle a clean return (fee only).
 * Charges are captured only here, after the owner decided every finding.
 */
export async function settle(bookingId: number, by: 'ai' | 'owner') {
  const b0 = booking(bookingId);
  const prev = settlementPreview(bookingId);
  if (by === 'ai' && prev.chargesCents > 0) throw new Error('AI path may only release');
  if (by === 'owner' && b0.state !== 'needs_review') throw new HttpError(409, `Cannot settle a ${b0.state} booking`);
  if (by === 'owner' && prev.pending > 0) throw new HttpError(409, 'Approve or waive every finding first');
  const m = by === 'ai' ? settlementMath(b0.authorized_cents, b0.fee_cents, []) : prev;
  // Claim the settlement inside a transaction: a double click or a retry gets 409 here.
  tx(() => transition(booking(bookingId), 'settling', by === 'ai' ? 'ai' : 'owner', by === 'ai' ? 'Clean and confident: releasing the deposit.' : `Owner settles: capture ${fmt(m.captureCents)}, release ${fmt(m.releasedCents)}.`));
  const reqId = `${reqKey(b0)}-capture`;
  const note = m.chargesCents > 0
    ? `Rental fee ${fmt(m.feeCents)} + approved charges ${fmt(m.captureCents - m.feeCents)}. ${fmt(m.releasedCents)} of your hold released. Evidence: ${env.PUBLIC_BASE_URL || ''}/e/${b0.public_token}`
    : `Rental fee ${fmt(m.feeCents)}. Your ${fmt(m.releasedCents)} deposit hold is released.`;
  let cap: any;
  try {
    cap = await captureFinal(b0.authorization_id, m.captureCents, note, reqId, `${b0.code}-cap-${b0.public_token.slice(0, 6)}`);
  } catch (err) {
    tx(() => {
      const pe = err as PayPalError;
      recordPayment(b0.id, 'capture', null, { status: 'FAILED', cents: m.captureCents, raw: pe.body, debugId: pe.debugId });
      transition(booking(bookingId), 'needs_review', 'system', `Capture failed: ${pe.message}. Nothing was charged; try again.`);
    });
    throw err;
  }
  const releaseMs = Date.now() - Date.parse(b0.returned_at ?? nowISO());
  tx(() => {
    recordPayment(b0.id, 'capture', reqId, { id: cap.id, status: cap.status, cents: fromPayPal(cap.amount.value), raw: cap });
    const to = m.chargesCents > 0 ? 'settled_charged' : 'settled_clean';
    transition(booking(bookingId), to, by === 'ai' ? 'ai' : 'owner',
      m.chargesCents > 0 ? `Settled: captured ${fmt(m.captureCents)} (fee + approved charges), released ${fmt(m.releasedCents)}.` : `Deposit released in ${(releaseMs / 1000).toFixed(1)} s.`,
      { capture_id: cap.id, captured_cents: m.captureCents, released_cents: m.releasedCents, charges_cents: m.chargesCents, excess_cents: m.excessCents, settled_at: nowISO(), release_ms: releaseMs });
    logEvent(b0.id, 'paypal.capture.final', 'paypal', `paypal.capture.final ${fmt(m.captureCents)}, released ${fmt(m.releasedCents)} (capture ${cap.id}, ${cap.status})`);
    if (m.excessCents > 0) logEvent(b0.id, 'excess.pending', 'system', `Approved charges exceed the hold by ${fmt(m.excessCents)}. The agent can draft a PayPal invoice; sending needs the owner's click.`);
  });
  return booking(bookingId);
}

export function bookingDetail(bookingId: number, opts: { forCustomer?: boolean } = {}) {
  const b = booking(bookingId);
  const it = item(b.item_id);
  const photos = all('SELECT id, phase, angle, sample_set, received_at, width, height FROM photos WHERE booking_id = ? ORDER BY phase, angle', bookingId);
  const inspections = all('SELECT id, phase, mode, model, checks_json, result_json, decision, reasons_json, latency_ms, cached_at, created_at FROM inspections WHERE booking_id = ? ORDER BY id', bookingId)
    .map((i) => ({ ...i, checks: JSON.parse(i.checks_json ?? '[]'), result: i.result_json ? JSON.parse(i.result_json) : null, reasons: JSON.parse(i.reasons_json ?? '[]'), checks_json: undefined, result_json: undefined, reasons_json: undefined }));
  const findings = all('SELECT * FROM findings WHERE booking_id = ? ORDER BY id', bookingId).map((f) => ({ ...f, box: f.box_json ? JSON.parse(f.box_json) : null, box_json: undefined }));
  const payments = all('SELECT kind, paypal_id, status, amount_cents, via, webhook_confirmed_at, created_at, debug_id FROM payments WHERE booking_id = ? ORDER BY id', bookingId);
  const events = all('SELECT id, type, actor, summary, created_at FROM events WHERE booking_id = ? ORDER BY id', bookingId);
  const contests = all('SELECT id, reason, state, recommendation_json, refund_cents, created_at, resolved_at FROM contests WHERE booking_id = ? ORDER BY id', bookingId)
    .map((c) => ({ ...c, recommendation: c.recommendation_json ? JSON.parse(c.recommendation_json) : null, recommendation_json: undefined }));
  const out: any = {
    booking: { ...b, customer_email: opts.forCustomer ? undefined : b.customer_email, approve_url: b.state === 'pending_approval' ? b.approve_url : null },
    item: { ...it, accessories: accessoriesOf(it.id) },
    photos, inspections, findings, payments, events, contests,
    settlement: HELD_STATES.includes(b.state) && b.authorized_cents ? settlementPreview(bookingId) : null,
    rateCard: rateCard(),
    sampleSets: sampleSets(it.slug),
  };
  return out;
}
