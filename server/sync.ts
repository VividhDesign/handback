import { all, get, run, tx, nowISO } from './db.ts';
import { hasPayPal } from './env.ts';
import { logEvent } from './lib/events.ts';
import { getOrder } from './paypal/orders.ts';
import { verifySignature } from './paypal/webhooks.ts';
import { authorizeBooking, booking, cancelBooking } from './bookings.ts';

/** Stores the event once (dedupe on PayPal's event id). Returns false for a duplicate. */
export function recordWebhook(ev: any, verified: boolean): boolean {
  const r = run('INSERT OR IGNORE INTO webhook_events (paypal_event_id, event_type, verified, resource_id, received_at) VALUES (?,?,?,?,?)',
    String(ev.id), String(ev.event_type), verified ? 1 : 0, ev.resource?.id ?? null, nowISO());
  return r.changes === 1;
}

export async function handleWebhook(headers: Record<string, any>, raw: string): Promise<{ status: number; body: unknown; process?: () => Promise<void> }> {
  let ev: any;
  try {
    ev = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  let ok = false;
  try {
    ok = await verifySignature(headers, raw);
  } catch (err) {
    console.warn('[webhook] verify call failed:', (err as Error).message);
  }
  if (!ok) {
    logEvent(null, 'webhook.rejected', 'system', `webhook.rejected ${ev?.event_type ?? 'unknown'}: signature not verified, nothing changed`);
    return { status: 400, body: { error: 'signature not verified' } };
  }
  if (!recordWebhook(ev, true)) return { status: 200, body: { duplicate: true } };
  return { status: 200, body: { ok: true }, process: () => processEvent(ev) };
}

function bookingForResource(ev: any): number | null {
  const r = ev.resource ?? {};
  const ids = [r.id, r.supplementary_data?.related_ids?.order_id, r.supplementary_data?.related_ids?.authorization_id, r.supplementary_data?.related_ids?.capture_id].filter(Boolean);
  for (const id of ids) {
    const p = get<{ booking_id: number }>('SELECT booking_id FROM payments WHERE paypal_id = ? LIMIT 1', id);
    if (p) return p.booking_id;
    const b = get<{ id: number }>('SELECT id FROM bookings WHERE order_id = ? OR authorization_id = ? OR capture_id = ?', id, id, id);
    if (b) return b.id;
  }
  const code = r.custom_id ?? r.purchase_units?.[0]?.custom_id;
  return code ? get<{ id: number }>('SELECT id FROM bookings WHERE code = ?', code)?.id ?? null : null;
}

export async function processEvent(ev: any) {
  const bookingId = bookingForResource(ev);
  const type = String(ev.event_type);
  try {
    if (type === 'CHECKOUT.ORDER.APPROVED' && bookingId) {
      // The buyer may have closed the tab after approving: authorize here (idempotent).
      const b = booking(bookingId);
      if (b.state === 'pending_approval' || b.state === 'expired') await authorizeBooking(bookingId, 'paypal');
    }
    const confirmed = ev.resource?.id
      ? run('UPDATE payments SET webhook_confirmed_at = ? WHERE paypal_id = ? AND webhook_confirmed_at IS NULL', nowISO(), ev.resource.id).changes
      : 0;
    tx(() => {
      run('UPDATE webhook_events SET processed_at = ? WHERE paypal_event_id = ?', nowISO(), String(ev.id));
      logEvent(bookingId, 'webhook.verified', 'paypal', `webhook.verified ${type}${confirmed ? ' (confirms the API result)' : ''}`, { resource_id: ev.resource?.id, status: ev.resource?.status });
    });
  } catch (err) {
    console.error('[webhook] processing failed:', (err as Error).message);
  }
}

/** Every 60 s: expire tentative slots (authorizing late approvals), and void stale demo holds. */
export async function sweep() {
  const now = nowISO();
  for (const b of all("SELECT id, order_id FROM bookings WHERE state = 'pending_approval' AND is_sample = 0")) {
    if (!b.order_id || !hasPayPal()) continue;
    try {
      const o = await getOrder(b.order_id);
      if (o.status === 'APPROVED') {
        await authorizeBooking(b.id, 'system');
        continue;
      }
    } catch (err) {
      console.warn('[sweep] order check failed:', (err as Error).message);
    }
    const fresh = booking(b.id);
    if (fresh.state === 'pending_approval' && fresh.tentative_expires_at && fresh.tentative_expires_at < now) {
      tx(() => {
        run("UPDATE bookings SET state = 'expired' WHERE id = ? AND state = 'pending_approval'", b.id);
        logEvent(b.id, 'booking.expired', 'system', 'Not approved within 15 minutes. The slot is free again; nothing was held.');
      });
    }
  }
  const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
  for (const b of all("SELECT id FROM bookings WHERE state = 'authorized' AND is_sample = 0 AND created_at < ?", stale)) {
    try {
      await cancelBooking(b.id, 'system', 'Demo guard: hold unused for 48 hours');
    } catch (err) {
      console.warn('[sweep] void failed:', (err as Error).message);
    }
  }
}
