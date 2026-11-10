import { paypal } from './client.ts';
import { toPayPal } from '../lib/money.ts';

export interface CreateOrderInput {
  code: string;
  invoiceId: string;
  itemName: string;
  days: number;
  feeCents: number;
  depositCents: number;
  returnUrl: string;
  cancelUrl: string;
  requestId: string;
}

export async function createAuthorizeOrder(i: CreateOrderInput) {
  const total = i.feeCents + i.depositCents;
  const { body, debugId } = await paypal('POST', '/v2/checkout/orders', {
    requestId: i.requestId,
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: i.code,
          custom_id: i.code,
          invoice_id: i.invoiceId,
          description: `Handback rental ${i.code}`,
          amount: {
            currency_code: 'USD',
            value: toPayPal(total),
            breakdown: { item_total: { currency_code: 'USD', value: toPayPal(total) } },
          },
          items: [
            { name: `Rental: ${i.itemName}, ${i.days} day${i.days > 1 ? 's' : ''}`.slice(0, 127), quantity: '1', unit_amount: { currency_code: 'USD', value: toPayPal(i.feeCents) }, category: 'DIGITAL_GOODS' },
            { name: 'Refundable deposit (hold)', quantity: '1', unit_amount: { currency_code: 'USD', value: toPayPal(i.depositCents) }, category: 'DIGITAL_GOODS' },
          ],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Handback Rentals',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'CONTINUE',
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            return_url: i.returnUrl,
            cancel_url: i.cancelUrl,
          },
        },
      },
    },
  });
  const approve = body.links?.find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href as string | undefined;
  return { order: body, orderId: body.id as string, status: body.status as string, approveUrl: approve, debugId };
}

export async function getOrder(orderId: string) {
  return (await paypal('GET', `/v2/checkout/orders/${orderId}`)).body;
}

export async function authorizeOrder(orderId: string, requestId: string) {
  const { body } = await paypal('POST', `/v2/checkout/orders/${orderId}/authorize`, { requestId, body: {} });
  const auth = body.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error('Authorize response has no authorization');
  return { order: body, auth };
}
