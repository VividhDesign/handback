import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../server/paypal/payments.ts', () => ({ captureFinal: vi.fn(), voidAuthorization: vi.fn(), refundCapture: vi.fn(), reauthorize: vi.fn(), getAuthorization: vi.fn(), getCapture: vi.fn() }));

const { run, get } = await import('../server/db.ts');
const { moveBooking } = await import('../server/bookings.ts');

const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.UTC(2100, 0, 1) + days * DAY).toISOString();
let itemId = 0;
let holdUntil = '';

function make(code: string, startDay: number, endDay: number, extra: Record<string, unknown> = {}) {
  const o = { state: 'authorized', is_sample: 0, hold_expires_at: holdUntil, ...extra };
  // $16/day, deposit $150, hold $182 = 2 days + deposit
  const r = run(`INSERT INTO bookings (code, public_token, item_id, customer_name, customer_email, start_at, end_at, fee_cents, deposit_cents, authorized_cents, state, hold_expires_at, is_sample, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, code.padEnd(64, '0'), itemId, 'Test', 't@example.com', iso(startDay), iso(endDay), 3200, 15000, 18200, o.state, o.hold_expires_at, o.is_sample, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

beforeAll(() => {
  itemId = Number(run("INSERT INTO items (slug, name, category, daily_fee_cents, deposit_cents, replacement_value_cents) VALUES ('mv','Move item','Tools',1600,15000,60000)").lastInsertRowid);
  holdUntil = iso(28);
});

describe('moveBooking (Schedule drag)', () => {
  it('moves a held booking and reprices the fee', () => {
    const id = make('HB-M1', 0, 2);
    const b = moveBooking(id, iso(3), iso(6));
    expect(b.start_at).toBe(iso(3));
    expect(b.fee_cents).toBe(4800);
    expect(get("SELECT type FROM events WHERE booking_id = ? AND type = 'booking.moved'", id)).toBeTruthy();
  });
  it('rejects an overlap with another booking on the same item', () => {
    make('HB-M2', 10, 12);
    const id = make('HB-M3', 13, 14);
    expect(() => moveBooking(id, iso(11), iso(13))).toThrow(/Overlaps HB-M2/);
  });
  it('rejects an end after the hold expires', () => {
    const id = make('HB-M4', 26, 27);
    expect(() => moveBooking(id, iso(26), iso(29))).toThrow(/hold is valid until/);
  });
  it('rejects an extension that leaves less than half the deposit covered', () => {
    // hold $182: 7 days = $112 leaves $70 < $75
    const id = make('HB-M5', 15, 16);
    expect(() => moveBooking(id, iso(15), iso(22))).toThrow(/At least half/);
    // 6 days = $96 leaves $86 ≥ $75
    expect(moveBooking(id, iso(15), iso(21)).fee_cents).toBe(9600);
  });
  it('keeps sample, pending and settled bookings read-only, and a picked-up start fixed', () => {
    expect(() => moveBooking(make('HB-M6', 40, 41, { is_sample: 1 }), iso(40), iso(42))).toThrow(/Sample/);
    expect(() => moveBooking(make('HB-M7', 43, 44, { state: 'pending_approval' }), iso(43), iso(45))).toThrow(/PayPal approval/);
    expect(() => moveBooking(make('HB-M8', 46, 47, { state: 'settled_clean' }), iso(46), iso(48))).toThrow(/read-only/);
    const p = make('HB-M9', 50, 51, { state: 'picked_up', hold_expires_at: iso(60) });
    expect(() => moveBooking(p, iso(30), iso(31))).toThrow(/only the end/);
    expect(moveBooking(p, iso(50), iso(52)).end_at).toBe(iso(52));
  });
});
