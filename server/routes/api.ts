import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { all, get, run, tx, nowISO } from '../db.ts';
import { env, hasGemini, hasPayPal, ROOT } from '../env.ts';
import { bus, logEvent } from '../lib/events.ts';
import { HttpError, ipHash } from '../lib/ids.ts';
import { limit, MINUTE, DAY } from '../lib/ratelimit.ts';
import { fmt } from '../lib/money.ts';
import * as B from '../bookings.ts';
import { openContest, resolveContest } from '../agent/contest.ts';
import { draftExcessInvoice } from '../agent/invoice.ts';
import { handleWebhook } from '../sync.ts';
import { processPhoto } from '../checks/photos.ts';
import { runReturnChecks } from '../checks/deterministic.ts';
import { runPassport, runCompare, AiUnavailable } from '../ai/inspect.ts';
import { capReason, countUsage, queueLength } from '../ai/queue.ts';
import { decide } from '../ai/decide.ts';
import { suggestDeposit } from '../pricing/ratecard.ts';
import { HELD_STATES } from '../lib/states.ts';
import { insightsData } from '../insights.ts';

export const api = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 5 } });
const ip = (req: Request) => ipHash(req.ip ?? 'unknown');
const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
};
const baseUrl = (req: Request) => env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).then((out) => { if (!res.headersSent) res.json(out ?? { ok: true }); }, next);

// ---------- Webhook: raw body, verified before anything else ----------
api.post('/webhooks/paypal', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const r = await handleWebhook(req.headers as any, raw);
  res.status(r.status).json(r.body);
  if (r.process) void r.process();
});

api.use(express.json({ limit: '100kb' }));
api.use(limit('requests', 60, MINUTE));

// ---------- Public ----------
api.get('/config', wrap(() => ({
  paypalClientId: env.PAYPAL_CLIENT_ID || null,
  sandbox: true,
  paypalConfigured: hasPayPal(),
  liveAi: hasGemini(),
  visionModel: hasGemini() ? env.GEMINI_VISION_MODEL : null,
  agStudioLicense: env.AG_STUDIO || null,
})));

api.get('/items', wrap(() => ({
  items: all('SELECT * FROM items ORDER BY id').map((i) => ({ ...i, accessories: B.accessoriesOf(i.id), sampleSets: B.sampleSets(i.slug) })),
  rateCard: B.rateCard(),
})));

api.get('/items/:id/availability', wrap((req) => {
  const it = B.item(id(req));
  const booked = all(`SELECT start_at, end_at, state FROM bookings WHERE item_id = ? AND is_sample = 0 AND state IN (${['pending_approval', ...HELD_STATES].map(() => '?').join(',')}) AND end_at > ? ORDER BY start_at`,
    it.id, 'pending_approval', ...HELD_STATES, nowISO());
  return { booked, maxDays: B.MAX_DAYS, maxAheadDays: B.MAX_AHEAD_DAYS };
}));

api.get('/items/:id/quote', wrap((req) => {
  const q = z.object({ start: z.string(), end: z.string() }).parse(req.query);
  return B.quote(id(req), q.start, q.end);
}));

const NewBooking = z.object({
  itemId: z.number().int().positive(),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  name: z.string().trim().min(1).max(80),
  email: z.email().max(120),
});
api.post('/bookings', limit('bookings', 20, DAY), wrap(async (req) => {
  if (!hasPayPal()) throw new HttpError(503, 'PayPal sandbox keys are not configured on this server yet');
  const body = NewBooking.parse(req.body);
  const b = await B.createBooking({ ...body, source: 'web', baseUrl: baseUrl(req) });
  return { token: b.public_token, code: b.code, approveUrl: b.approve_url, orderId: b.order_id, state: b.state };
}));

const byToken = (t: string) => {
  if (!/^[a-f0-9]{64}$/.test(t)) throw new HttpError(404, 'Not found');
  const b = get('SELECT id FROM bookings WHERE public_token = ?', t);
  if (!b) throw new HttpError(404, 'Not found');
  return b.id as number;
};

// Customer actions are addressed by the secret token, never by the numeric id.
api.post('/bookings/by-token/:token/authorize', wrap(async (req) => B.bookingDetail((await B.authorizeBooking(byToken(String(req.params.token)))).id, { forCustomer: true })));
api.post('/bookings/by-token/:token/cancel', wrap(async (req) => B.bookingDetail((await B.cancelBooking(byToken(String(req.params.token)), 'customer')).id, { forCustomer: true })));
api.get('/bookings/by-token/:token', wrap((req) => B.bookingDetail(byToken(String(req.params.token)), { forCustomer: true })));

api.get('/evidence/:token', wrap((req) => {
  const d = B.bookingDetail(byToken(String(req.params.token)), { forCustomer: true });
  if (!['settled_clean', 'settled_charged', 'contested', 'refunded', 'contest_denied'].includes(d.booking.state)) throw new HttpError(404, 'The evidence page opens after settlement');
  return d;
}));
api.post('/evidence/:token/contest', limit('contest', 5, DAY), wrap(async (req) => {
  const { reason } = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(req.body);
  const bid = byToken(String(req.params.token));
  await openContest(bid, reason);
  return B.bookingDetail(bid, { forCustomer: true });
}));

/** Photos are addressed by the booking's secret token. */
api.get('/p/:token/:phase/:angle', (req, res, next) => {
  try {
    const bid = byToken(String(req.params.token));
    const p = get('SELECT path FROM photos WHERE booking_id = ? AND phase = ? AND angle = ?', bid, String(req.params.phase), Number(req.params.angle));
    if (!p || !existsSync(p.path)) throw new HttpError(404, 'Photo not found');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type('jpeg').send(readFileSync(p.path));
  } catch (err) {
    next(err);
  }
});

/** Sample photos for the dry run and the Desk preview. */
api.get('/samples/:slug/:set/:angle', (req, res, next) => {
  const { slug, set, angle } = req.params;
  if (![slug, set, angle].every((s) => /^[a-z0-9-]+$/.test(String(s)))) return next(new HttpError(404, 'Not found'));
  const f = path.join(ROOT, 'samples', String(slug), String(set), `${angle}.jpg`);
  if (!existsSync(f)) return next(new HttpError(404, 'Not found'));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('jpeg').send(readFileSync(f));
});

// ---------- Dry run: AI comparison on sample photos, no PayPal hold ----------
api.post('/dry-run/inspect', limit('inspections', 10, DAY), wrap(async (req) => {
  const { itemId, set } = z.object({ itemId: z.number().int(), set: z.enum(['return-clean', 'return-damaged', 'return-reupload']) }).parse(req.body);
  const it = B.item(itemId);
  const load = async (s: string) => Promise.all([1, 2, 3, 4, 5].map(async (angle) => {
    const f = path.join(B.samplesDir(it.slug, s), `${angle}.jpg`);
    if (!existsSync(f)) throw new HttpError(404, `This item has no "${s}" sample photos`);
    const p = await processPhoto(readFileSync(f));
    return { angle, path: f, sha256: p.sha256, dhash: p.dhash, width: p.width, height: p.height, mean_luma: p.meanLuma, exif_taken_at: null, received_at: nowISO() };
  }));
  const pickup = await load('pickup');
  const ret = await load(set);
  const t0 = new Date(Date.now() - 3 * DAY).toISOString();
  const checks = runReturnChecks({ pickup: pickup.map((p) => ({ ...p, received_at: t0 })), ret, pickedUpAt: t0, endAt: nowISO(), returnedAt: nowISO(), graceMinutes: 60 });
  const failed = checks.filter((c) => c.blocking && !c.passed);
  const label = 'Dry run: no PayPal call is made.';
  if (failed.length) return { label, checks, decision: 'blocked', wouldCall: 'none (photos must be re-shot; the hold stays as it is)', ai: null };
  const acc = B.accessoriesOf(it.id).map((a) => a.name);
  const h = ip(req);
  const capped = capReason(h, false);
  countUsage(h, 'inspection');
  try {
    const passport = await runPassport({ bookingId: null, itemName: it.name, accessories: acc, photos: pickup, sampleSetKey: `${it.slug}-pickup`, ipHash: h, capped });
    const cmp = await runCompare({ bookingId: null, itemName: it.name, accessories: acc, passport: passport.result, pickup, ret, sampleSetKey: `${it.slug}-${set}`, ipHash: h, capped });
    const d = decide({ checksPassed: true, compare: cmp.result, accessoryNames: acc, isLate: false, minConf: env.AUTO_RELEASE_MIN_CONF });
    return {
      label, checks, decision: d.decision, reasons: d.reasons,
      wouldCall: d.decision === 'auto_release' ? 'POST /v2/payments/authorizations/{id}/capture with the rental fee only, final_capture:true (deposit released)' : 'none yet: the owner approves or waives each finding, then one final capture',
      ai: { passport: passport.result, compare: cmp.result, mode: cmp.mode, model: cmp.model, latencyMs: cmp.latencyMs, cachedAt: cmp.cachedAt ?? null },
      photos: { pickup: `/api/samples/${it.slug}/pickup`, ret: `/api/samples/${it.slug}/${set}` },
    };
  } catch (err) {
    if (err instanceof AiUnavailable) throw new HttpError(503, `AI is unavailable and no cached result exists (${err.message})`);
    throw err;
  }
}));

// ---------- Shop (demo: open console; production needs login and roles) ----------
api.get('/shop/bookings', wrap((req) => {
  const q = z.object({ state: z.string().optional(), sample: z.enum(['0', '1', 'all']).optional() }).parse(req.query);
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.state) { where.push('b.state = ?'); args.push(q.state); }
  if (q.sample !== 'all') { where.push('b.is_sample = ?'); args.push(q.sample === '1' ? 1 : 0); }
  return {
    bookings: all(`SELECT b.id, b.code, b.public_token, b.state, b.start_at, b.end_at, b.customer_name, b.fee_cents, b.deposit_cents, b.authorized_cents, b.captured_cents, b.released_cents,
      b.tentative_expires_at, b.honor_ends_at, b.hold_expires_at, b.is_sample, b.source, b.created_at, b.release_ms, i.name item_name, i.id item_id
      FROM bookings b JOIN items i ON i.id = b.item_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.id DESC LIMIT 300`, ...args),
    queue: queueLength(),
  };
}));

api.get('/shop/insights', wrap((req) => insightsData(req.query.real === '1')));
api.get('/shop/bookings/:id', wrap((req) => B.bookingDetail(id(req))));

const notSample = (bid: number) => {
  if (B.booking(bid).is_sample) throw new HttpError(409, 'Sample bookings are read-only');
  return bid;
};

api.patch('/shop/bookings/:id', wrap((req) => {
  const body = z.object({ start: z.iso.datetime(), end: z.iso.datetime() }).parse(req.body);
  return B.bookingDetail(B.moveBooking(id(req), body.start, body.end, 'owner').id);
}));

api.post('/shop/bookings/:id/cancel', wrap(async (req) => B.bookingDetail((await B.cancelBooking(notSample(id(req)), 'owner', 'Cancelled by the shop')).id)));

api.post('/shop/bookings/:id/photos', upload.array('photos', 5), wrap(async (req) => {
  const bid = notSample(id(req));
  const phase = z.enum(['pickup', 'return']).parse(req.query.phase);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length) {
    const angles = z.array(z.coerce.number().int().min(1).max(5)).parse([].concat((req.body?.angles ?? []) as any));
    if (angles.length !== files.length) throw new HttpError(400, 'Each photo needs its angle (1–5)');
    await B.savePhotos(bid, phase, files.map((f, i) => ({ angle: angles[i], buffer: f.buffer })), null);
  } else {
    const { sampleSet } = z.object({ sampleSet: z.enum(['pickup', 'return-clean', 'return-damaged', 'return-reupload']) }).parse(req.body ?? {});
    if ((phase === 'pickup') !== (sampleSet === 'pickup')) throw new HttpError(400, 'That sample set is for the other phase');
    await B.useSampleSet(bid, phase, sampleSet);
  }
  return B.bookingDetail(bid);
}));

api.post('/shop/bookings/:id/pickup', limit('inspections', 10, DAY), wrap(async (req) => B.bookingDetail((await B.runPickup(notSample(id(req)), ip(req))).id)));
api.post('/shop/bookings/:id/return', limit('inspections', 10, DAY), wrap(async (req) => {
  const { returnedAt } = z.object({ returnedAt: z.iso.datetime().optional() }).parse(req.body ?? {});
  return B.bookingDetail((await B.runReturn(notSample(id(req)), ip(req), { returnedAt })).id);
}));

api.post('/shop/bookings/:id/findings', wrap((req) => {
  const bid = notSample(id(req));
  const body = z.object({ type: z.enum(['new_damage', 'missing_accessory', 'needs_cleaning']), severity: z.enum(['minor', 'moderate', 'major']), description: z.string().trim().min(3).max(300), accessoryId: z.number().int().optional() }).parse(req.body);
  B.addManualFinding(bid, body);
  return B.bookingDetail(bid);
}));

api.post('/shop/findings/:id/decision', wrap((req) => {
  const body = z.object({ decision: z.enum(['approved', 'waived']), note: z.string().max(300).nullable().optional() }).parse(req.body);
  const f = B.decideFinding(id(req), body.decision, body.note ?? null);
  return B.bookingDetail(f!.booking_id);
}));

api.post('/shop/bookings/:id/settle', wrap(async (req) => B.bookingDetail((await B.settle(notSample(id(req)), 'owner')).id)));

api.post('/shop/contests/:id/resolve', wrap(async (req) => {
  const body = z.object({ action: z.enum(['uphold', 'partial', 'deny']), refundCents: z.number().int().min(0).optional(), note: z.string().max(300).optional() }).parse(req.body);
  return B.bookingDetail((await resolveContest(id(req), body)).id);
}));

api.post('/shop/bookings/:id/excess-invoice', wrap(async (req) => {
  const { confirm } = z.object({ confirm: z.boolean().optional() }).parse(req.body ?? {});
  return draftExcessInvoice(notSample(id(req)), !!confirm);
}));

api.get('/shop/items', wrap(() => ({ items: all('SELECT * FROM items ORDER BY id').map((i) => ({ ...i, accessories: B.accessoriesOf(i.id) })), rateCard: B.rateCard() })));

const ItemPatch = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  daily_fee_cents: z.number().int().min(100).max(100_000).optional(),
  deposit_cents: z.number().int().min(2_000).max(50_000).optional(),
  replacement_value_cents: z.number().int().min(1_000).max(1_000_000).optional(),
});
api.post('/shop/items/:id', wrap((req) => {
  const it = B.item(id(req));
  const p = ItemPatch.parse(req.body);
  const keys = Object.keys(p);
  if (keys.length) tx(() => {
    run(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => (p as any)[k]), it.id);
    logEvent(null, 'shop.item.updated', 'owner', `Updated ${it.name}: ${keys.join(', ')}`);
  });
  return B.item(it.id);
}));

api.post('/shop/items/:id/suggest', wrap((req) => {
  const it = B.item(id(req));
  // P1: Channel3 market median. Until it is wired, suggest from the stored replacement value and say so.
  return { replacementCents: it.replacement_value_cents, depositCents: suggestDeposit(it.replacement_value_cents), source: 'Stored replacement value (market search not configured)' };
}));

const RateCardBody = z.object({
  minorPct: z.number().min(0).max(100), minorMinCents: z.number().int().min(0), minorMaxCents: z.number().int().min(0),
  moderatePct: z.number().min(0).max(100), majorPct: z.number().min(0).max(100), cleaningCents: z.number().int().min(0),
  lateGraceMinutes: z.number().int().min(0).max(24 * 60), lateMaxDays: z.number().int().min(0).max(7),
}).partial();
api.post('/shop/rate-card', wrap((req) => {
  const next = { ...B.rateCard(), ...RateCardBody.parse(req.body) };
  tx(() => {
    run("INSERT INTO settings (key, value) VALUES ('rate_card', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
    logEvent(null, 'shop.ratecard.updated', 'owner', 'Rate card updated');
  });
  return next;
}));

// ---------- Live feed ----------
api.get('/events', wrap((req) => {
  const q = z.object({ after: z.coerce.number().int().optional(), booking: z.coerce.number().int().optional() }).parse(req.query);
  return all(`SELECT e.id, e.booking_id, b.code booking_code, e.type, e.actor, e.summary, e.created_at FROM events e LEFT JOIN bookings b ON b.id = e.booking_id
    WHERE e.id > ? ${q.booking ? 'AND e.booking_id = ?' : ''} AND (b.is_sample IS NULL OR b.is_sample = 0) ORDER BY e.id DESC LIMIT 200`, q.after ?? 0, ...(q.booking ? [q.booking] : [])).reverse();
}));

api.get('/events/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (name: string) => (data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const onEvent = send('event');
  const onPing = send('ping');
  bus.on('event', onEvent);
  bus.on('ping', onPing);
  const keep = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(keep);
    bus.off('event', onEvent);
    bus.off('ping', onPing);
  });
});

// ---------- Admin ----------
api.post('/admin/reseed', wrap(async (req) => {
  if (!env.ADMIN_TOKEN || req.get('x-admin-token') !== env.ADMIN_TOKEN) throw new HttpError(403, 'Forbidden');
  const { reseedSamples } = await import('../seed/seed.ts');
  return reseedSamples();
}));

api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));

// No stack traces in responses.
api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  if (err?.name === 'MulterError') return res.status(400).json({ error: err.message });
  const status = err instanceof HttpError ? err.status : err?.status && err.status < 500 && err.status >= 400 ? err.status : err?.name === 'IllegalTransition' ? 409 : 500;
  if (status >= 500 && !(err instanceof HttpError)) console.error('[api]', err);
  const pp = err?.debugId ? { paypalDebugId: err.debugId, paypalIssue: err.issue } : {};
  res.status(status).json({ error: status >= 500 && !err?.debugId && !(err instanceof HttpError) ? 'Something went wrong. Nothing was charged.' : err.message, ...(err?.extra ?? {}), ...pp });
});

void fmt;
