import { describe, it, expect, vi, beforeAll } from 'vitest';

const capture = vi.hoisted(() => vi.fn());
vi.mock('../server/paypal/payments.ts', () => ({ captureFinal: capture, voidAuthorization: vi.fn(), refundCapture: vi.fn(), reauthorize: vi.fn(), getAuthorization: vi.fn(), getCapture: vi.fn() }));
vi.mock('../server/paypal/webhooks.ts', () => ({ verifySignature: vi.fn(async (h: any) => h['x-ok'] === '1') }));

const { run, get, all } = await import('../server/db.ts');
const { settle } = await import('../server/bookings.ts');
const { handleWebhook } = await import('../server/sync.ts');

let itemId = 0;
function makeBooking(code: string, state = 'needs_review') {
  const now = new Date().toISOString();
  const r = run(`INSERT INTO bookings (code, public_token, item_id, customer_name, customer_email, start_at, end_at, fee_cents, deposit_cents, authorized_cents, state, authorization_id, picked_up_at, returned_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, code.padEnd(64, '0'), itemId, 'Test', 't@example.com', now, now, 3200, 15000, 18200, state, `AUTH-${code}`, now, now, now);
  return Number(r.lastInsertRowid);
}

beforeAll(() => {
  itemId = Number(run("INSERT INTO items (slug, name, category, daily_fee_cents, deposit_cents, replacement_value_cents) VALUES ('t','Test item','Tools',1600,15000,60000)").lastInsertRowid);
});

describe('idempotent settle', () => {
  it('a double click captures once; the second call gets 409', async () => {
    const id = makeBooking('HB-T1');
    run("INSERT INTO findings (booking_id, type, description, severity, confidence, proposed_cents, price_source, decision) VALUES (?, 'needs_cleaning', 'dirt', 'minor', 0.9, 1000, 'Rate card', 'approved')", id);
    capture.mockImplementation(async (_a: string, cents: number) => {
      await new Promise((r) => setTimeout(r, 20));
      return { id: 'CAP-1', status: 'COMPLETED', amount: { value: (cents / 100).toFixed(2) } };
    });
    const results = await Promise.allSettled([settle(id, 'owner'), settle(id, 'owner')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(409);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toBe(4200);
    const b = get('SELECT * FROM bookings WHERE id = ?', id)!;
    expect(b.state).toBe('settled_charged');
    expect(b.captured_cents).toBe(4200);
    expect(b.released_cents).toBe(14000);
  });
  it('a failed capture charges nothing and returns to review', async () => {
    const id = makeBooking('HB-T2');
    capture.mockRejectedValueOnce(Object.assign(new Error('INSTRUMENT_DECLINED'), { status: 422, body: {}, debugId: 'dbg' }));
    await expect(settle(id, 'owner')).rejects.toThrow();
    expect(get('SELECT state FROM bookings WHERE id = ?', id)!.state).toBe('needs_review');
  });
  it('the AI path cannot capture charges', async () => {
    const id = makeBooking('HB-T3', 'inspecting');
    run("INSERT INTO findings (booking_id, type, description, severity, confidence, proposed_cents, price_source, decision) VALUES (?, 'new_damage', 'scratch', 'minor', 0.9, 1500, 'Rate card', 'approved')", id);
    await expect(settle(id, 'ai')).rejects.toThrow(/only release/);
  });
});

describe('webhook dedupe', () => {
  const ev = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-X' } };
  it('rejects unverified events without storing them', async () => {
    const r = await handleWebhook({}, JSON.stringify(ev));
    expect(r.status).toBe(400);
    expect(all("SELECT * FROM webhook_events WHERE paypal_event_id = 'WH-1'")).toHaveLength(0);
  });
  it('processes a verified event once; a redelivery is a no-op', async () => {
    const first = await handleWebhook({ 'x-ok': '1' }, JSON.stringify(ev));
    expect(first.status).toBe(200);
    expect(first.process).toBeTypeOf('function');
    await first.process!();
    const again = await handleWebhook({ 'x-ok': '1' }, JSON.stringify(ev));
    expect(again).toEqual({ status: 200, body: { duplicate: true } });
    expect(all("SELECT * FROM webhook_events WHERE paypal_event_id = 'WH-1'")).toHaveLength(1);
  });
});
