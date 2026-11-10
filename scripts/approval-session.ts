/**
 * Approval session (PLAN B13). Creates sandbox AUTHORIZE orders and prints numbered approval
 * links. The user approves them in the browser; this script never logs in to PayPal. Once an order
 * is APPROVED it is authorized and its branch runs. Prints a PASS/FAIL table and saves JSON under
 * scripts/out/ (git-ignored).
 *
 * Usage: npm run session -- [--branches A,B,C,D] [--pool 6] [--minutes 20]
 *        npm run session -- --resume scripts/out/session-....json   (re-poll runs that did not finish)
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env, assertSandbox } from '../server/env.ts';
import { PayPalError } from '../server/paypal/client.ts';
import { createAuthorizeOrder, getOrder, authorizeOrder } from '../server/paypal/orders.ts';
import { captureFinal, voidAuthorization, reauthorize, refundCapture, getAuthorization, getCapture } from '../server/paypal/payments.ts';

assertSandbox();

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const branches = arg('branches', 'A,B,C,D').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const pool = Number(arg('pool', '0'));
const minutes = Number(arg('minutes', '20'));
const base = env.PUBLIC_BASE_URL || 'https://handback-nvq9.onrender.com';

const FEE = 1200; // 3 days x $4
const DEPOSIT = 4000;
const HOLD = FEE + DEPOSIT;
const CHARGE = 1500;

type Check = { name: string; ok: boolean; detail: string };
type Run = { n: number; branch: string; orderId: string; approveUrl?: string; authId?: string; ids: Record<string, string>; checks: Check[]; error?: string; debugId?: string };

const rid = () => randomUUID();
const errText = (e: unknown) => (e instanceof PayPalError ? `${e.status} ${e.issue ?? ''} debug_id=${e.debugId ?? '-'}` : String((e as Error)?.message ?? e));

/** Expect a PayPal call to be refused; returns the refusal text. */
async function refused(fn: () => Promise<unknown>): Promise<{ ok: boolean; detail: string }> {
  try {
    const r: any = await fn();
    return { ok: false, detail: `accepted (${r?.id ?? r?.status ?? 'ok'})` };
  } catch (e) {
    return { ok: e instanceof PayPalError, detail: errText(e) };
  }
}

async function runBranch(r: Run) {
  const auth = r.authId!;
  const add = (name: string, ok: boolean, detail: string) => r.checks.push({ name, ok, detail });
  if (r.branch === 'A') {
    const cap = await captureFinal(auth, FEE, 'Rental fee. Deposit released.', rid(), `HB-S1-${r.orderId}-A`);
    r.ids.capture = cap.id;
    add('capture fee, final', cap.status === 'COMPLETED' || cap.status === 'PENDING', `${cap.status} ${cap.id}`);
    const a = await getAuthorization(auth);
    add('authorization closed', a.status === 'CAPTURED' || a.status === 'PARTIALLY_CAPTURED', a.status);
    const again = await refused(() => captureFinal(auth, 100, 'second capture', rid()));
    add('second capture refused', again.ok, again.detail);
  } else if (r.branch === 'B') {
    const over = await refused(() => captureFinal(auth, HOLD + 10_000, 'over the hold', rid()));
    add('capture above the hold refused', over.ok, over.detail);
    const v = await voidAuthorization(auth, rid());
    add('void returns 204/200', v.status === 204 || v.status === 200, String(v.status));
    const a = await getAuthorization(auth);
    add('status VOIDED', a.status === 'VOIDED', a.status);
    const after = await refused(() => captureFinal(auth, FEE, 'after void', rid()));
    add('capture after void refused', after.ok, after.detail);
  } else if (r.branch === 'C') {
    const reqId = rid();
    const cap = await captureFinal(auth, FEE + CHARGE, 'Rental fee + approved charge.', reqId, `HB-S1-${r.orderId}-C`);
    r.ids.capture = cap.id;
    add('capture fee + charge, final', cap.status === 'COMPLETED' || cap.status === 'PENDING', `${cap.status} ${cap.id}`);
    let replayId = '';
    try {
      replayId = (await captureFinal(auth, FEE + CHARGE, 'Rental fee + approved charge.', reqId, `HB-S1-${r.orderId}-C`)).id;
    } catch (e) {
      replayId = `error: ${errText(e)}`;
    }
    add('replay same request id -> same capture', replayId === cap.id, replayId);
    const ref = await refundCapture(cap.id, 500, 'Contest resolved: part of the charge refunded.', rid());
    r.ids.refund = ref.id;
    add('partial refund', ref.status === 'COMPLETED' || ref.status === 'PENDING', `${ref.status} ${ref.id}`);
    const c = await getCapture(cap.id);
    add('capture shows partial refund', c.status === 'PARTIALLY_REFUNDED', c.status);
  } else if (r.branch === 'D') {
    try {
      const re = await reauthorize(auth, HOLD, rid());
      r.ids.reauth = re.id;
      add('reauthorize answered (new id)', !!re.id, `${re.status} ${re.id}`);
    } catch (e) {
      // Inside the 3-day honor period the sandbox refuses; a clear refusal is the expected answer.
      add('reauthorize answered (clear refusal)', e instanceof PayPalError, errText(e));
    }
    const v = await voidAuthorization(r.ids.reauth ?? auth, rid());
    add('void after reauthorize', v.status === 204 || v.status === 200, String(v.status));
  } else if (r.branch === 'P') {
    const a = await getAuthorization(auth);
    add('pooled hold authorized', a.status === 'CREATED', `${a.status}, expires ${a.expiration_time}`);
  }
}

const resume = arg('resume', '');
let runs: Run[] = [];
if (resume) {
  // Re-poll runs that never got an authorization (for example a network blip while waiting).
  const saved: Run[] = JSON.parse(readFileSync(resume, 'utf8')).runs;
  runs = saved.filter((r) => !r.authId).map((r) => ({ ...r, error: undefined, debugId: undefined, checks: [] }));
} else {
  const all = [...branches, ...Array.from({ length: pool }, () => 'P')];
  for (const [i, branch] of all.entries()) {
    const code = `S1-${Date.now().toString(36)}-${i + 1}`;
    const o = await createAuthorizeOrder({
      code, invoiceId: `HB-${code}`, itemName: 'Insulated water bottle', days: 3, feeCents: FEE, depositCents: DEPOSIT,
      returnUrl: `${base}/approved`, cancelUrl: `${base}/approved`, requestId: rid(),
    });
    runs.push({ n: i + 1, branch, orderId: o.orderId, approveUrl: o.approveUrl, ids: { order: o.orderId }, checks: [] });
  }
}

console.log(`\nApprove these ${runs.length} sandbox orders (sandbox buyer account, ${'$'}${(HOLD / 100).toFixed(2)} hold each):\n`);
for (const r of runs) console.log(`${r.n}. [${r.branch}] ${r.approveUrl}`);
console.log(`\nWaiting up to ${minutes} min for approvals...\n`);

const outDir = path.join(import.meta.dirname, 'out');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const save = () => writeFileSync(outFile, JSON.stringify({ base, hold_cents: HOLD, runs }, null, 2));
save();

const deadline = Date.now() + minutes * 60_000;
const pending = new Set(runs);
while (pending.size && Date.now() < deadline) {
  for (const r of [...pending]) {
    let o: any;
    try {
      o = await getOrder(r.orderId);
    } catch (e) {
      // Waiting for the buyer: a network blip or a PayPal 5xx is retried on the next poll.
      if (!(e instanceof PayPalError) || e.status >= 500) continue;
      pending.delete(r);
      r.error = errText(e);
      r.debugId = e.debugId;
      console.log(`#${r.n} error: ${r.error}`);
      save();
      continue;
    }
    if (o.status !== 'APPROVED') continue;
    pending.delete(r);
    try {
      const { auth } = await authorizeOrder(r.orderId, rid());
      r.authId = auth.id;
      r.ids.authorization = auth.id;
      console.log(`#${r.n} approved -> authorization ${auth.id} (${auth.status}); running branch ${r.branch}`);
      await runBranch(r);
    } catch (e) {
      pending.delete(r);
      r.error = errText(e);
      r.debugId = e instanceof PayPalError ? e.debugId : undefined;
      console.log(`#${r.n} error: ${r.error}`);
    }
    save();
  }
  if (pending.size) await new Promise((res) => setTimeout(res, 3000));
}
for (const r of pending) r.error = 'not approved in time';
save();

console.log('\n#  branch  result  checks');
for (const r of runs) {
  const pass = !r.error && r.checks.length > 0 && r.checks.every((c) => c.ok);
  console.log(`${r.n}  ${r.branch}  ${pass ? 'PASS' : 'FAIL'}  ${r.error ?? ''}`);
  for (const c of r.checks) console.log(`     ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
}
console.log(`\nSaved ${path.relative(process.cwd(), outFile)}`);
