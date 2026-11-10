import { paypal } from './client.ts';
import { toPayPal } from '../lib/money.ts';

const money = (cents: number) => ({ currency_code: 'USD', value: toPayPal(cents) });

export async function getAuthorization(id: string) {
  return (await paypal('GET', `/v2/payments/authorizations/${id}`)).body;
}

/** One final capture per booking. Remaining authorized funds are released. */
export async function captureFinal(authId: string, cents: number, note: string, requestId: string, invoiceId?: string) {
  return (
    await paypal('POST', `/v2/payments/authorizations/${authId}/capture`, {
      requestId,
      body: { amount: money(cents), final_capture: true, note_to_payer: note.slice(0, 255), ...(invoiceId ? { invoice_id: invoiceId } : {}) },
    })
  ).body;
}

export async function voidAuthorization(authId: string, requestId: string) {
  const r = await paypal('POST', `/v2/payments/authorizations/${authId}/void`, { requestId, body: undefined });
  return { status: r.status, body: r.body };
}

export async function reauthorize(authId: string, cents: number, requestId: string) {
  return (await paypal('POST', `/v2/payments/authorizations/${authId}/reauthorize`, { requestId, body: { amount: money(cents) } })).body;
}

export async function refundCapture(captureId: string, cents: number, note: string, requestId: string) {
  return (await paypal('POST', `/v2/payments/captures/${captureId}/refund`, { requestId, body: { amount: money(cents), note_to_payer: note.slice(0, 255) } })).body;
}

export async function getCapture(id: string) {
  return (await paypal('GET', `/v2/payments/captures/${id}`)).body;
}
