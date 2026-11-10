import { all, get, run, nowISO } from '../db.ts';
import { HttpError } from '../lib/ids.ts';
import { fmt, toPayPal } from '../lib/money.ts';
import { logEvent } from '../lib/events.ts';
import { env } from '../env.ts';
import { reqKey, booking, item } from '../bookings.ts';
import { callTool, invoiceIdFromLink, ToolError } from '../paypal/toolkit.ts';

/**
 * Excess above the hold (PLAN B7, B8.7). The agent drafts an invoice from the approved findings;
 * sending runs only after the owner's click (`confirm: true`). The PayPal calls go through the
 * Agent Toolkit `create_invoice` and `send_invoice` tools. The tool arguments are built by code from
 * the owner-approved amount, never by a model, so AI never decides how much is charged.
 */
export async function draftExcessInvoice(bookingId: number, confirm: boolean) {
  const b = booking(bookingId);
  if (!['settled_charged', 'contested', 'contest_denied', 'refunded'].includes(b.state)) throw new HttpError(409, 'Settle the booking first');
  if (!b.excess_cents || b.excess_cents <= 0) throw new HttpError(409, 'Approved charges fit inside the hold; no invoice needed');
  const it = item(b.item_id);
  const findings = all("SELECT description, proposed_cents, price_source FROM findings WHERE booking_id = ? AND decision = 'approved' AND existing_mark_id IS NULL", bookingId);
  const evidence = `${env.PUBLIC_BASE_URL || ''}/e/${b.public_token}`;
  const draft = {
    recipient: { name: b.customer_name, email: b.customer_email },
    reference: b.code,
    note: `Charges above the ${fmt(b.authorized_cents)} hold for ${it.name} (${b.code}). Evidence: ${evidence}`,
    items: [{ name: `Damage charges above the deposit hold (${b.code})`, amount_cents: b.excess_cents }],
    based_on: findings,
  };

  const reqId = `${reqKey(b)}-invoice`;
  const existing = get("SELECT paypal_id, status, raw_json FROM payments WHERE request_id = ?", reqId);
  if (existing?.status === 'SENT' || (existing && !confirm)) {
    return { draft, sent: existing.status === 'SENT', invoice: { id: existing.paypal_id, status: existing.status, payer_view: JSON.parse(existing.raw_json ?? '{}').payer_view } };
  }
  if (!confirm) return { draft, sent: false };

  // One invoice per booking: the unique request id blocks a double click before PayPal is called.
  if (!existing) {
    try {
      run(`INSERT INTO payments (booking_id, kind, status, amount_cents, request_id, via, created_at) VALUES (?,?,?,?,?,?,?)`, bookingId, 'invoice', 'CREATING', b.excess_cents, reqId, 'agent_toolkit', nowISO());
    } catch {
      throw new HttpError(409, 'An invoice for this booking is already being created');
    }
  } else if (existing.status !== 'DRAFT') {
    throw new HttpError(409, 'An invoice for this booking is already being created');
  }
  try {
    let id: string | undefined = existing?.paypal_id ?? undefined;
    let created: any = null;
    if (!id) {
      const [given, ...rest] = String(b.customer_name).trim().split(/\s+/);
      created = await callTool('create_invoice', {
        currency_code: 'USD',
        invoice_number: `HB-${b.code}`.slice(0, 25),
        reference: b.code,
        note: draft.note.slice(0, 4000),
        invoicer_business_name: 'Handback Rentals',
        primary_recipients: [{ billing_info: { email_address: b.customer_email, name: { given_name: given || 'Customer', surname: rest.join(' ') || '-' } } }],
        items: [{ name: draft.items[0].name.slice(0, 200), quantity: '1', unit_amount: { currency_code: 'USD', value: toPayPal(b.excess_cents) } }],
      });
      id = invoiceIdFromLink(created?.href);
      if (!id) throw new ToolError('create_invoice', { message: 'no invoice id in the answer' });
      run("UPDATE payments SET paypal_id = ?, status = 'DRAFT' WHERE request_id = ?", id, reqId);
    }
    const sent = await callTool('send_invoice', { invoice_id: id, send_to_recipient: true, note: `Evidence: ${evidence}` });
    const payerView = sent?.href;
    run("UPDATE payments SET status = 'SENT', raw_json = ? WHERE request_id = ?", JSON.stringify({ created, sent, payer_view: payerView }), reqId);
    logEvent(b.id, 'paypal.invoice', 'owner', `paypal.invoice ${fmt(b.excess_cents)} sent (invoice ${id}, Agent Toolkit create_invoice + send_invoice)`, { invoice_id: id });
    return { draft, sent: true, invoice: { id, status: 'SENT', payer_view: payerView } };
  } catch (err) {
    // Keep a created draft id so a retry does not make a second invoice; otherwise free the slot.
    const row = get('SELECT paypal_id FROM payments WHERE request_id = ?', reqId);
    if (row?.paypal_id) run("UPDATE payments SET status = 'DRAFT' WHERE request_id = ?", reqId);
    else run('DELETE FROM payments WHERE request_id = ?', reqId);
    throw new HttpError(502, `PayPal invoice failed: ${(err as Error).message}. Nothing was charged.`);
  }
}
