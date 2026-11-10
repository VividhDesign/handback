import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { post } from '../lib/api.ts';
import { useAction, useApi } from '../lib/hooks.ts';
import { dateTime, duration, money } from '../lib/format.ts';
import { Button, ErrorNotice, Loading, MoneyLine, Notice, PayPalIds, StateBadge, Stepper } from '../components/ui.tsx';
import { stepIndex } from '../lib/states.ts';

const SETTLED = ['settled_clean', 'settled_charged', 'contested', 'refunded', 'contest_denied'];

export function Booking() {
  const { token = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, setData, error, loading, reload } = useApi<any>(`/bookings/by-token/${token}`);
  const act = useAction();
  const tried = useRef(false);

  // Back from PayPal: authorize once. The server is idempotent, and the webhook repairs a closed tab.
  useEffect(() => {
    if (!data || tried.current) return;
    if (params.get('approved') === '1' && data.booking.state === 'pending_approval') {
      tried.current = true;
      void act.run('authorize', async () => setData(await post(`/bookings/by-token/${token}/authorize`)));
    }
  }, [data, params, token, act, setData]);

  useEffect(() => {
    const s = data?.booking?.state;
    if (!s || !['pending_approval', 'inspecting', 'settling', 'picked_up', 'authorized', 'needs_review'].includes(s)) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [data?.booking?.state, reload]);

  if (loading && !data) return <div className="page narrow"><Loading lines={6} /></div>;
  if (error) return <div className="page narrow"><ErrorNotice error={error.message === 'Not found' ? 'This booking link is not valid.' : error} /></div>;
  const { booking: b, item, payments, events } = data;

  return (
    <div className="page narrow stack">
      {params.get('cancelled') === '1' && b.state === 'pending_approval' && (
        <Notice tone="warn">You left PayPal without approving. The slot stays reserved for a few minutes; <a href={b.approve_url}>approve now</a> or let it expire.</Notice>
      )}
      <div className="card">
        <div className="row between">
          <div>
            <div className="faint">Booking {b.code}</div>
            <h1>{item.name}</h1>
          </div>
          <StateBadge state={b.state} />
        </div>
        <Stepper index={stepIndex(b.state)} />
        <p className="muted">{dateTime(b.start_at)} → {dateTime(b.end_at)}</p>
        <ErrorNotice error={act.error} />
        {act.busy === 'authorize' && <Notice>Placing the hold with PayPal…</Notice>}
        {b.state === 'pending_approval' && !act.busy && (
          <div className="row" style={{ marginTop: 8 }}>
            {b.approve_url && <a className="btn btn-paypal" href={b.approve_url}>Approve with PayPal</a>}
            <span className="faint">Reserved until {dateTime(b.tentative_expires_at)}</span>
          </div>
        )}
        {b.state === 'authorized' && <Notice tone="info">Your hold is placed. Nothing has been charged. Bring the item back by {dateTime(b.end_at)}.</Notice>}
        {b.state === 'settled_clean' && <Notice tone="ok">Returned clean. Deposit released{b.release_ms ? ` ${duration(b.release_ms)} after the return` : ''}. Only the rental fee was captured.</Notice>}
        {b.state === 'settled_charged' && <Notice tone="warn">The shop approved charges for this return. See the evidence for each line and its price source.</Notice>}
        {b.state === 'expired' && <Notice tone="warn">This booking expired before it was approved. Nothing was held.</Notice>}
        {b.state === 'cancelled' && <Notice>Cancelled. The hold was voided; nothing was charged.</Notice>}
      </div>

      <div className="card">
        <h2>Money</h2>
        <MoneyLine label="Rental fee" cents={b.fee_cents} />
        <MoneyLine label="Deposit (hold)" cents={b.deposit_cents} />
        <MoneyLine label="Authorized" cents={b.authorized_cents} total />
        {b.captured_cents != null && <MoneyLine label="Captured" cents={b.captured_cents} />}
        {b.released_cents != null && <MoneyLine label="Released" cents={b.released_cents} />}
        {b.refunded_cents > 0 && <MoneyLine label="Refunded" cents={b.refunded_cents} />}
        <div className="row" style={{ marginTop: 16 }}>
          {b.state === 'authorized' && (
            <Button className="btn-danger" busy={act.busy === 'cancel'} onClick={() => { if (confirm('Cancel this booking and void the hold?')) void act.run('cancel', async () => setData(await post(`/bookings/by-token/${token}/cancel`))); }}>
              Cancel booking
            </Button>
          )}
          {SETTLED.includes(b.state) && <Link className="btn btn-primary" to={`/e/${token}`}>Open the evidence page</Link>}
        </div>
      </div>

      <div className="card">
        <h2>Timeline</h2>
        <ul className="timeline">
          {events.map((e: any) => <li key={e.id}><span className="faint">{dateTime(e.created_at)}</span> · {e.summary}</li>)}
        </ul>
      </div>
      <div className="card">
        <h2>PayPal</h2>
        <PayPalIds payments={payments} />
        <p className="faint" style={{ marginTop: 8 }}>Sandbox. Authorized {money(b.authorized_cents)}; the hold is valid until {dateTime(b.hold_expires_at)}.</p>
      </div>
    </div>
  );
}
