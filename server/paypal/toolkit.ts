import { randomUUID } from 'node:crypto';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';
import { env } from '../env.ts';

/**
 * PayPal Agent Toolkit (PLAN B8.7). We use the `./openai` export: it gives OpenAI-style tool
 * definitions plus `handleToolCall`, which runs the tool against PayPal. The toolkit has no
 * authorize, capture or void tools, so those stay direct REST (server/paypal/payments.ts).
 */
let tk: PayPalAgentToolkit | null = null;

export function toolkit(): PayPalAgentToolkit {
  tk ??= new PayPalAgentToolkit({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    configuration: { actions: { invoices: { create: true, send: true, get: true } }, context: { sandbox: true } },
  });
  return tk;
}

export class ToolError extends Error {
  status?: number;
  constructor(tool: string, body: any) {
    super(`${tool}: ${body?.status ?? ''} ${body?.message ?? 'failed'}`.trim());
    this.status = body?.status;
  }
}

/** Runs one toolkit tool and returns its parsed JSON. Errors come back as `{ ok: false, ... }`. */
export async function callTool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const msg = await toolkit().handleToolCall({ id: `call_${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ToolError(name, { message: text.slice(0, 200) });
  }
  if (body && body.ok === false) throw new ToolError(name, body);
  return body as T;
}

/** Invoice id from a toolkit link (`.../invoices/INV2-...` or `...#INV2-...`). */
export const invoiceIdFromLink = (href?: string) => href?.match(/INV2-[A-Z0-9-]+/)?.[0];
