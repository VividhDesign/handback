import type { ReactNode } from 'react';
import { stateInfo } from '../lib/states.ts';
import { money } from '../lib/format.ts';

export function StateBadge({ state }: { state: string }) {
  const s = stateInfo(state);
  return <span className={`badge s-${s.tone}`}>{s.label}</span>;
}

export function SampleTag() {
  return <span className="badge plain tag-sample" title="Synthetic history row. It never touched PayPal.">sample</span>;
}

export function ModeTag({ mode, model, cachedAt }: { mode: string; model?: string | null; cachedAt?: string | null }) {
  if (mode === 'live') return <span className="badge tag-live">live AI{model ? ` · ${model}` : ''}</span>;
  if (mode === 'cached') return <span className="badge tag-cached" title={`Recorded result${cachedAt ? ` from ${cachedAt.slice(0, 10)}` : ''}${model ? ` with ${model}` : ''}`}>cached AI result{cachedAt ? ` · recorded ${cachedAt.slice(0, 10)}` : ''}</span>;
  return <span className="badge tag-sample">{mode}</span>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok' | 'error'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : undefined}>{children}</div>;
}

export function ErrorNotice({ error }: { error: string | Error | null | undefined }) {
  if (!error) return null;
  return <Notice tone="error">{typeof error === 'string' ? error : error.message}</Notice>;
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack-sm" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 15}%` }} />)}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Button({ busy, children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button className={`btn ${className}`} disabled={busy || rest.disabled} {...rest}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function MoneyLine({ label, cents, total, hint }: { label: ReactNode; cents: number | null | undefined; total?: boolean; hint?: ReactNode }) {
  return (
    <div className={`money-line${total ? ' total' : ''}`}>
      <span>{label}{hint && <span className="faint"> · {hint}</span>}</span>
      <span className="amount">{money(cents)}</span>
    </div>
  );
}

const STEPS = ['Hold', 'Pickup', 'Return', 'Settlement'];
export function Stepper({ index }: { index: number }) {
  return (
    <div className="stepper" aria-label="Booking progress">
      {STEPS.map((s, i) => (
        <div key={s} className={`step${i < index ? ' done' : ''}${i === index ? ' current' : ''}`}>{s}</div>
      ))}
    </div>
  );
}

export function PayPalIds({ payments }: { payments: any[] }) {
  if (!payments?.length) return <p className="faint">No PayPal calls yet.</p>;
  return (
    <table>
      <thead><tr><th>Call</th><th>PayPal id</th><th>Status</th><th className="right">Amount</th><th>Webhook</th></tr></thead>
      <tbody>
        {payments.map((p, i) => (
          <tr key={i}>
            <td>{p.kind}{p.via && p.via !== 'rest' ? <span className="faint"> · {p.via}</span> : null}</td>
            <td className="mono">{p.paypal_id ?? '—'}</td>
            <td>{p.status ?? '—'}</td>
            <td className="right amount">{money(p.amount_cents)}</td>
            <td className="small">{p.webhook_confirmed_at ? <span className="badge s-released">verified</span> : <span className="faint">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
