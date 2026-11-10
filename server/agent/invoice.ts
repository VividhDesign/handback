import { all } from '../db.ts';
import { HttpError } from '../lib/ids.ts';
import { fmt } from '../lib/money.ts';
import { booking, item } from '../bookings.ts';

/**
 * Excess above the hold (PLAN B7, B8.7). The agent drafts an invoice from the approved findings;
 * sending runs only after the owner's click (`confirm: true`).
 * The PayPal call goes through the Agent Toolkit `create_invoice` / `send_invoice` tools once the toolkit path is chosen (G0).
 */
export async function draftExcessInvoice(bookingId: number, confirm: boolean) {
  const b = booking(bookingId);
  if (!['settled_charged', 'contested', 'contest_denied', 'refunded'].includes(b.state)) throw new HttpError(409, 'Settle the booking first');
  if (!b.excess_cents || b.excess_cents <= 0) throw new HttpError(409, 'Approved charges fit inside the hold; no invoice needed');
  const it = item(b.item_id);
  const findings = all("SELECT description, proposed_cents, price_source FROM findings WHERE booking_id = ? AND decision = 'approved' AND existing_mark_id IS NULL", bookingId);
  const draft = {
    recipient: { name: b.customer_name, email: b.customer_email },
    reference: b.code,
    note: `Charges above the ${fmt(b.authorized_cents)} hold for ${it.name} (${b.code}). Evidence: /e/${b.public_token}`,
    items: [{ name: `Damage charges above the deposit hold (${b.code})`, amount_cents: b.excess_cents }],
    based_on: findings,
  };
  if (!confirm) return { draft, sent: false };
  throw new HttpError(501, 'Sending invoices is not wired yet (waiting for the Agent Toolkit setup). Nothing was sent.');
}
