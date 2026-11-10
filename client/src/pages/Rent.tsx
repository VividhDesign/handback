import { useEffect, useMemo, useState } from 'react';
import { api, post } from '../lib/api.ts';
import { useApi, useAction } from '../lib/hooks.ts';
import { money, shortMoney, date } from '../lib/format.ts';
import { Button, ErrorNotice, Loading, MoneyLine, Notice } from '../components/ui.tsx';

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s: string, n: number) => { const d = new Date(`${s}T10:00:00`); d.setDate(d.getDate() + n); return localDay(d); };
/** Pickup and return at 10:00 local time. */
const toIso = (day: string) => new Date(`${day}T10:00:00`).toISOString();

export function Rent() {
  const { data, error, loading } = useApi<any>('/items');
  const cfg = useApi<any>('/config');
  const [itemId, setItemId] = useState<number | null>(null);
  const today = localDay(new Date());
  const [start, setStart] = useState(addDays(today, 1));
  const [end, setEnd] = useState(addDays(today, 3));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [booked, setBooked] = useState<any[]>([]);
  const act = useAction();

  useEffect(() => { if (data?.items?.length && itemId == null) setItemId(data.items[0].id); }, [data, itemId]);
  const it = useMemo(() => data?.items?.find((i: any) => i.id === itemId), [data, itemId]);

  useEffect(() => {
    if (!itemId || end <= start) { setQuote(null); return; }
    let alive = true;
    api(`/items/${itemId}/quote?start=${encodeURIComponent(toIso(start))}&end=${encodeURIComponent(toIso(end))}`).then((q) => alive && setQuote(q)).catch(() => alive && setQuote(null));
    api(`/items/${itemId}/availability`).then((a) => alive && setBooked(a.booked)).catch(() => {});
    return () => { alive = false; };
  }, [itemId, start, end]);

  const clash = booked.some((b) => Date.parse(b.start_at) < Date.parse(toIso(end)) && Date.parse(b.end_at) > Date.parse(toIso(start)));
  const days = Math.round((Date.parse(toIso(end)) - Date.parse(toIso(start))) / 86_400_000);
  const dateError = end <= start ? 'Return must be after pickup.' : days > 7 ? 'A booking is at most 7 days.' : clash ? 'This item is already booked for some of these days.' : null;
  const paypalReady = cfg.data?.paypalConfigured;

  async function book() {
    const r = await act.run('book', () => post('/bookings', { itemId, start: toIso(start), end: toIso(end), name, email }));
    if (r?.approveUrl) window.location.assign(r.approveUrl);
  }

  if (loading) return <div className="page"><Loading lines={6} /></div>;
  if (error) return <div className="page"><ErrorNotice error={error} /></div>;
  const rc = data.rateCard;

  return (
    <div className="page">
      <h1>Rent an item</h1>
      <p className="lead">You approve a hold with PayPal. Nothing is charged until the item comes back.</p>
      <div className="grid split split-rent" style={{ marginTop: 24 }}>
        <div className="grid grid-3">
          {data.items.map((i: any) => (
            <button key={i.id} type="button" className={`card item-card${i.id === itemId ? ' selected' : ''}`} style={{ textAlign: 'left', font: 'inherit' }} onClick={() => setItemId(i.id)} aria-pressed={i.id === itemId}>
              <div className="faint">{i.category}</div>
              <h3 style={{ marginTop: 4 }}>{i.name}</h3>
              <p className="small muted">{i.description}</p>
              <div className="row between small" style={{ marginTop: 12 }}>
                <span><strong>{shortMoney(i.daily_fee_cents)}</strong>/day</span>
                <span className="muted">{shortMoney(i.deposit_cents)} deposit hold</span>
              </div>
            </button>
          ))}
        </div>
        <aside className="card stack" style={{ position: 'sticky', top: 16 }}>
          <div>
            <div className="faint">Your booking</div>
            <h2>{it?.name ?? 'Pick an item'}</h2>
            {it?.accessories?.length > 0 && <p className="small muted">Includes: {it.accessories.map((a: any) => a.name).join(', ')}</p>}
          </div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <label style={{ flex: 1 }}>Pickup<input type="date" value={start} min={today} max={addDays(today, 21)} onChange={(e) => setStart(e.target.value)} /></label>
            <label style={{ flex: 1 }}>Return<input type="date" value={end} min={addDays(start, 1)} max={addDays(start, 7)} onChange={(e) => setEnd(e.target.value)} /></label>
          </div>
          <p className="faint">Pickup and return at 10:00. Up to 7 days, starting within 21 days.</p>
          {dateError && <Notice tone="warn">{dateError}</Notice>}
          {quote && !dateError && (
            <div>
              <MoneyLine label={`Rental, ${quote.days} day${quote.days === 1 ? '' : 's'}`} cents={quote.feeCents} />
              <MoneyLine label="Refundable deposit (hold)" cents={quote.depositCents} />
              <MoneyLine label="Authorized now" cents={quote.totalCents} total />
              <MoneyLine label="Charged now" cents={0} />
              <p className="small muted" style={{ marginTop: 8 }}>
                {shortMoney(quote.feeCents)} rental + {shortMoney(quote.depositCents)} deposit hold = {shortMoney(quote.totalCents)} authorized, $0 charged now.
                On a clean return only the rental is captured and the deposit is released.
              </p>
            </div>
          )}
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} /></label>
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={120} /></label>
          <ErrorNotice error={act.error} />
          {cfg.data && !paypalReady && <Notice tone="warn">PayPal sandbox keys are not configured on this server yet, so booking is turned off.</Notice>}
          <Button className="btn-paypal" style={{ width: '100%', justifyContent: 'center', minHeight: 48 }} busy={act.busy === 'book'}
            disabled={!it || !!dateError || !quote || !name.trim() || !/^\S+@\S+\.\S+$/.test(email) || !paypalReady} onClick={book}>
            Approve the hold with PayPal
          </Button>
          <p className="faint">You will approve in the PayPal sandbox and come back here. {date(toIso(start))} → {date(toIso(end))}.</p>
          <details id="rate-card">
            <summary>Rate card: how charges are priced</summary>
            <table style={{ marginTop: 8 }}>
              <tbody>
                <tr><td>Minor damage</td><td className="right">{rc.minorPct}% of replacement value ({money(rc.minorMinCents)}–{money(rc.minorMaxCents)})</td></tr>
                <tr><td>Moderate damage</td><td className="right">{rc.moderatePct}% of replacement value</td></tr>
                <tr><td>Major damage</td><td className="right">{rc.majorPct}% of replacement value</td></tr>
                <tr><td>Cleaning</td><td className="right">{money(rc.cleaningCents)}</td></tr>
                <tr><td>Missing accessory</td><td className="right">market price, or list price</td></tr>
                <tr><td>Late return</td><td className="right">daily fee per late day after {rc.lateGraceMinutes} min grace</td></tr>
              </tbody>
            </table>
            <p className="faint" style={{ marginTop: 8 }}>Charges never exceed the hold. Marks recorded at pickup are never charged.</p>
          </details>
        </aside>
      </div>
    </div>
  );
}
