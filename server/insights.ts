import { all } from './db.ts';

/**
 * Flat tables for the AG Studio insights dashboard. Every row carries `run`
 * ("Sandbox run" or "Sample") so the page can show real sandbox runs only.
 */
const usd = (c: number | null | undefined) => (c == null ? null : Math.round(c) / 100);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);
const runOf = (s: number) => (s ? 'Sample' : 'Sandbox run');

/** Where the PayPal hold ended up. Bookings that never got a hold are "No hold". */
export function holdOutcome(b: { state: string; authorization_id: string | null; authorized_cents: number }): string {
  const held = !!b.authorization_id || b.authorized_cents > 0;
  if (!held) return 'No hold';
  switch (b.state) {
    case 'settled_clean': return 'Released';
    case 'settled_charged': case 'contested': case 'contest_denied': return 'Charged';
    case 'refunded': return 'Refunded';
    case 'cancelled': case 'expired': return 'Voided';
    default: return 'Holding';
  }
}

export function insightsData(realOnly = false) {
  const where = realOnly ? 'WHERE b.is_sample = 0' : '';
  const bookings = all<any>(`SELECT b.*, i.name AS item_name, i.category FROM bookings b JOIN items i ON i.id = b.item_id ${where} ORDER BY b.id`).map((b) => ({
    code: b.code,
    item: b.item_name,
    category: b.category,
    state: b.state,
    hold_outcome: holdOutcome(b),
    rental_days: Math.max(1, Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 86_400_000)),
    fee_usd: usd(b.fee_cents),
    deposit_usd: usd(b.deposit_cents),
    hold_usd: usd(b.authorized_cents),
    captured_usd: usd(b.captured_cents) ?? 0,
    released_usd: usd(b.released_cents) ?? 0,
    refunded_usd: usd(b.refunded_cents) ?? 0,
    release_seconds: b.release_ms == null ? null : Math.round(b.release_ms / 100) / 10,
    start_day: day(b.start_at),
    settled_day: day(b.settled_at),
    created_day: day(b.created_at),
    channel: b.source,
    run: runOf(b.is_sample),
  }));

  const findings = all<any>(`SELECT f.*, b.code, b.is_sample, ins.mode AS ai_mode FROM findings f JOIN bookings b ON b.id = f.booking_id
    LEFT JOIN inspections ins ON ins.id = f.inspection_id ${where} ORDER BY f.id`).map((f) => ({
    booking: f.code,
    type: f.type,
    severity: f.severity,
    confidence: f.confidence,
    proposed_usd: usd(f.proposed_cents),
    owner_decision: f.decision,
    ai_mode: f.ai_mode ?? 'deterministic',
    run: runOf(f.is_sample),
  }));

  const payments = all<any>(`SELECT p.*, b.code, b.is_sample FROM payments p JOIN bookings b ON b.id = p.booking_id ${where} ORDER BY p.id`).map((p) => ({
    booking: p.code,
    kind: p.kind,
    status: p.status,
    amount_usd: usd(p.amount_cents),
    via: p.via,
    webhook_confirmed: p.webhook_confirmed_at ? 'yes' : 'no',
    day: day(p.created_at),
    run: runOf(p.is_sample),
  }));

  // Booked days per item over all bookings that held the item (not cancelled, expired or pending).
  const util = new Map<string, { item: string; category: string; booked_days: number; bookings: number; fees_usd: number }>();
  for (const b of bookings) {
    if (['cancelled', 'expired', 'pending_approval'].includes(b.state)) continue;
    const u = util.get(b.item) ?? { item: b.item, category: b.category, booked_days: 0, bookings: 0, fees_usd: 0 };
    u.booked_days += b.rental_days;
    u.bookings += 1;
    u.fees_usd = Math.round((u.fees_usd + (b.fee_usd ?? 0)) * 100) / 100;
    util.set(b.item, u);
  }

  return { bookings, findings, payments, utilisation: [...util.values()] };
}
