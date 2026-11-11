import { useEffect, useRef, useState } from 'react';
import { post } from '../lib/api.ts';

type Card = { id: string; kind: 'refund' | 'invoice'; title: string; lines: string[]; bookingId: number };
type Msg = { role: 'user' | 'assistant'; text: string; cards?: Card[]; tools?: string[]; note?: boolean };

const STARTERS = [
  'Which real bookings are holding a PayPal deposit?',
  'Extend HB-… by one day',
  'Show PayPal transactions from the last 3 days',
  'Refund the open contest in full',
];

const TOOL_LABEL: Record<string, string> = {
  paypal_get_order: 'PayPal get_order',
  paypal_list_transactions: 'PayPal list_transactions',
  paypal_list_disputes: 'PayPal list_disputes',
  paypal_merchant_insights: 'PayPal get_merchant_insights',
  quote_accessory: 'Channel3 price',
};

/** Minimal markdown: **bold**, "* " bullets and table pipes, rendered as plain React nodes (no HTML injection). */
function Rich({ text }: { text: string }) {
  const lines = text.split('\n').filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l));
  return <>{lines.map((l, i) => {
    let t = l.replace(/^\s*[*-]\s+/, '• ');
    if (/^\s*\|/.test(t)) t = t.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()).join('  ·  ');
    const parts = t.split(/\*\*(.+?)\*\*/g);
    return <div key={i}>{parts.map((p, j) => (j % 2 ? <strong key={j}>{p}</strong> : p))}{!t && '\u00a0'}</div>;
  })}</>;
}

/** Shop assistant drawer, on every shop page. Money actions come back as confirm cards. */
export function Assistant() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [doneCards, setDoneCards] = useState<Record<string, string>>({});
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy, open]);

  async function send(q: string) {
    const t = q.trim();
    if (!t || busy) return;
    const next: Msg[] = [...msgs, { role: 'user', text: t }];
    setMsgs(next);
    setText('');
    setBusy(true);
    try {
      const r = await post<{ reply: string; cards: Card[]; tools: string[] }>('/assistant/chat', { messages: next.filter((m) => !m.note).map(({ role, text }) => ({ role, text })) });
      setMsgs((m) => [...m, { role: 'assistant', text: r.reply, cards: r.cards, tools: r.tools }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'assistant', text: e.message, note: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(c: Card) {
    setDoneCards((d) => ({ ...d, [c.id]: 'Working…' }));
    try {
      const r = await post<{ text: string }>('/assistant/confirm', { id: c.id });
      setDoneCards((d) => ({ ...d, [c.id]: r.text }));
      window.dispatchEvent(new CustomEvent('hb:refresh'));
    } catch (e: any) {
      setDoneCards((d) => ({ ...d, [c.id]: `Not done: ${e.message}` }));
    }
  }

  if (!open) return <button className="btn btn-primary hb-asst-fab" onClick={() => setOpen(true)}>Ask the assistant</button>;

  return (
    <aside className="hb-asst" aria-label="Shop assistant">
      <div className="hb-asst-head">
        <div><strong>Shop assistant</strong><div className="muted" style={{ fontSize: 12 }}>Gemini + PayPal Agent Toolkit. Refunds and invoices need your click.</div></div>
        <button className="btn btn-sm" onClick={() => setOpen(false)} aria-label="Close">Close</button>
      </div>
      <div className="hb-asst-body">
        {!msgs.length && (
          <div className="stack" style={{ gap: 8 }}>
            <p className="muted" style={{ margin: 0 }}>Ask about bookings, holds and PayPal activity. Try:</p>
            {STARTERS.map((s) => <button key={s} className="btn btn-sm hb-asst-starter" onClick={() => (s.includes('…') ? setText(s.replace('…', '')) : void send(s))}>{s}</button>)}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`hb-asst-msg ${m.role === 'user' ? 'me' : ''} ${m.note ? 'err' : ''}`}>
            <div>{m.role === 'assistant' ? <Rich text={m.text} /> : m.text}</div>
            {!!m.tools?.length && <div className="hb-asst-tools">{m.tools.map((t) => <span key={t} className="chip">{TOOL_LABEL[t] ?? t}</span>)}</div>}
            {m.cards?.map((c) => (
              <div key={c.id} className="hb-asst-card">
                <strong>{c.title}</strong>
                <ul>{c.lines.map((l, j) => <li key={j}>{l}</li>)}</ul>
                {doneCards[c.id]
                  ? <div className="notice notice-ok" role="status">{doneCards[c.id]}</div>
                  : <div className="row"><button className="btn btn-primary btn-sm" onClick={() => void confirm(c)}>Confirm {c.kind === 'refund' ? 'refund' : 'and send'}</button><button className="btn btn-sm" onClick={() => setDoneCards((d) => ({ ...d, [c.id]: 'Dismissed. Nothing was sent.' }))}>Dismiss</button></div>}
              </div>
            ))}
          </div>
        ))}
        {busy && <div className="hb-asst-msg muted">Thinking…</div>}
        <div ref={end} />
      </div>
      <form className="hb-asst-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about a booking or PayPal…" aria-label="Message" maxLength={2000} />
        <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>Send</button>
      </form>
    </aside>
  );
}
