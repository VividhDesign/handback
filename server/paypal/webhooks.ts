import { paypal } from './client.ts';

export const WEBHOOK_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'INVOICING.INVOICE.PAID',
  'CUSTOMER.DISPUTE.CREATED',
];

let webhookId: string | null = process.env.PAYPAL_WEBHOOK_ID || null;
export const getWebhookId = () => webhookId;

/** Finds or creates the webhook for <base>/api/webhooks/paypal. PayPal only accepts https URLs. */
export async function ensureWebhook(publicBase: string): Promise<string | null> {
  if (!publicBase.startsWith('https://')) return null;
  const url = `${publicBase}/api/webhooks/paypal`;
  const list = (await paypal('GET', '/v1/notifications/webhooks')).body;
  const found = list.webhooks?.find((w: any) => w.url === url);
  if (found) {
    webhookId = found.id;
    const have = new Set((found.event_types ?? []).map((e: any) => e.name));
    if (WEBHOOK_EVENTS.some((e) => !have.has(e))) {
      await paypal('PATCH', `/v1/notifications/webhooks/${found.id}`, {
        body: [{ op: 'replace', path: '/event_types', value: WEBHOOK_EVENTS.map((name) => ({ name })) }],
      });
    }
    return webhookId;
  }
  const created = (await paypal('POST', '/v1/notifications/webhooks', { body: { url, event_types: WEBHOOK_EVENTS.map((name) => ({ name })) } })).body;
  webhookId = created.id;
  return webhookId;
}

/** Verifies the signature. The raw event text is spliced in unchanged (no re-serialization). */
export async function verifySignature(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean> {
  if (!webhookId) return false;
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const fields = {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: webhookId,
  };
  if (Object.values(fields).some((v) => !v)) return false;
  const json = JSON.stringify(fields);
  const raw = `${json.slice(0, -1)},"webhook_event":${rawBody}}`;
  const { body } = await paypal('POST', '/v1/notifications/verify-webhook-signature', { rawBody: raw, representation: false });
  return body.verification_status === 'SUCCESS';
}
