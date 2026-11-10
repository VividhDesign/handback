import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BryntumScheduler } from '@bryntum/scheduler-react';
import { StringHelper } from '@bryntum/scheduler';
import '@bryntum/scheduler/scheduler.css';
import '@bryntum/scheduler/svalbard-light.css';
import '@bryntum/scheduler/fontawesome/css/fontawesome.css';
import '@bryntum/scheduler/fontawesome/css/solid.css';
import { api } from '../lib/api.ts';
import { stateInfo, type Tone } from '../lib/states.ts';
import { money } from '../lib/format.ts';

// Payment-state colours, same as the badges (app.css --s-*).
const TONE_COLOR: Record<Tone, string> = {
  tentative: '#6b7280', held: '#1f5fd0', review: '#a35c00', released: '#177a43', charged: '#6b3fc4', blocked: '#b42318',
};
const HIDDEN = ['cancelled', 'expired'];
const DAY = 86_400_000;
const enc = (s: string) => StringHelper.encodeHtml(s);
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

type B = Record<string, any>;

function movable(b: B): false | true | 'end' {
  if (b.is_sample) return false;
  if (b.state === 'authorized') return true;
  if (b.state === 'picked_up') return 'end';
  return false;
}

function countdown(b: B): string {
  const left = Date.parse(b.tentative_expires_at ?? '') - Date.now();
  if (!(left > 0)) return 'approval window over';
  return `approve within ${Math.ceil(left / 60_000)} min`;
}

export function Schedule() {
  const ref = useRef<BryntumScheduler>(null);
  const [items, setItems] = useState<B[]>([]);
  const [bookings, setBookings] = useState<B[]>([]);
  const [showSamples, setShowSamples] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const byId = useRef(new Map<number, B>());

  // Items and bookings arrive together, and the scheduler mounts only after both are in
  // (bookings without their item rows rendered as an empty chart about one load in four).
  const load = useCallback(async () => {
    const [it, r] = await Promise.all([
      api<{ items: B[] }>('/shop/items'),
      api<{ bookings: B[] }>(`/shop/bookings?sample=${showSamples ? 'all' : '0'}`),
    ]);
    setItems(it.items);
    setBookings(r.bookings.filter((b) => !HIDDEN.includes(b.state)));
    setReady(true);
  }, [showSamples]);

  useEffect(() => { void load().catch((e) => setNotice({ tone: 'error', text: e.message })); }, [load]);

  // Live: a PayPal authorization (or any booking change) arrives over SSE and the bar updates.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource('/api/events/stream');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.addEventListener('event', (m) => {
      const e = JSON.parse((m as MessageEvent).data);
      if (!e.booking_id) return;
      clearTimeout(t);
      t = setTimeout(() => void load().catch(() => {}), 300);
    });
    return () => { clearTimeout(t); es.close(); };
  }, [load]);

  // Countdown on tentative bars.
  useEffect(() => {
    const t = setInterval(() => ref.current?.instance?.refreshRows(), 30_000);
    return () => clearInterval(t);
  }, []);


  const resources = useMemo(() => items.map((i) => ({ id: i.id, name: i.name })), [items]);
  const events = useMemo((): any[] => { byId.current = new Map(bookings.map((b) => [b.id, b])); return bookings.map((b) => {
    const tone = stateInfo(b.state).tone;
    const m = movable(b);
    return {
      id: b.id, resourceId: b.item_id, name: b.code, startDate: b.start_at, endDate: b.end_at,
      eventColor: TONE_COLOR[tone], eventStyle: b.state === 'pending_approval' ? 'hollow' : null,
      draggable: m === true, resizable: m === 'end' ? 'end' : m,
      cls: [b.is_sample && 'hb-sample', b.state === 'pending_approval' && 'hb-tentative'].filter(Boolean).join(' '),
    };
  }); }, [bookings]);

  const sel = selected ? bookings.find((b) => b.id === selected) ?? null : null;
  // Markers: "now", plus the honor-period end and hold expiry of the selected booking.
  const timeRanges = useMemo(() => {
    if (!sel) return [];
    const r: B[] = [];
    if (sel.honor_ends_at) r.push({ id: 'honor', name: `${sel.code}: honor period ends`, startDate: sel.honor_ends_at, cls: 'hb-marker-honor' });
    if (sel.hold_expires_at) r.push({ id: 'expiry', name: `${sel.code}: hold expires`, startDate: sel.hold_expires_at, cls: 'hb-marker-expiry' });
    return r;
  }, [sel]);

  const range = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { start: new Date(d.getTime() - 7 * DAY), end: new Date(d.getTime() + 35 * DAY) };
  }, []);

  const columns = useMemo(() => [{ text: 'Item', field: 'name', width: 210, editor: false }], []);
  const visibleDate = useMemo(() => ({ date: new Date(range.start.getTime() + 6 * DAY), block: 'start' as const }), [range]);

  const patch = useCallback(async (record: any) => {
    const id = Number(record.id);
    const before = byId.current.get(id);
    try {
      const r = await api<B>(`/shop/bookings/${id}`, { method: 'PATCH', body: { start: record.startDate.toISOString(), end: record.endDate.toISOString() } });
      const nb = r.booking ?? r;
      setNotice({ tone: 'ok', text: `${nb.code} now ${when(nb.start_at)} – ${when(nb.end_at)}. Rental fee ${money(before?.fee_cents ?? 0)} → ${money(nb.fee_cents)}. The PayPal hold is unchanged.` });
      setSelected(id);
      await load();
    } catch (e: any) {
      // Snap back to the server's dates and say why.
      if (before) record.set({ startDate: new Date(before.start_at), endDate: new Date(before.end_at) });
      setNotice({ tone: 'error', text: `Not moved: ${e.message}` });
    }
  }, [load]);

  return (
    <div className="page stack">
      <div className="row between">
        <div>
          <h1>Schedule</h1>
          <p className="muted">Items are rows. Bars are bookings, coloured by payment state. Drag a held booking to move it, or drag its end to extend it.</p>
        </div>
        <div className="row">
          <span className={`badge ${live ? "s-released" : "s-tentative"}`}>{live ? 'Live' : 'Reconnecting'}</span>
          <label className="row" style={{ gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={showSamples} onChange={(e) => setShowSamples(e.target.checked)} /> Show sample rows
          </label>
        </div>
      </div>

      <div className="row legend" aria-label="Legend">
        {([['tentative', 'Awaiting PayPal approval (dashed)'], ['held', 'Hold placed'], ['review', 'Needs review'], ['released', 'Deposit released'], ['charged', 'Charged']] as [Tone, string][]).map(([t, l]) => (
          <span key={t} className="row" style={{ gap: 6, fontSize: 13 }}><i className="swatch" style={{ background: TONE_COLOR[t] }} />{l}</span>
        ))}
      </div>

      {notice && <div className={`notice ${notice.tone === 'error' ? 'notice-error' : 'notice-ok'}`} role="status">{notice.text}</div>}

      <div className="schedule-box">
        {!ready ? <p className="muted" style={{ padding: 16 }}>Loading the schedule…</p> : <BryntumScheduler
          ref={ref}
          startDate={range.start}
          endDate={range.end}
          viewPreset="weekAndDay"
          visibleDate={visibleDate}
          timeResolution={{ unit: 'hour', increment: 1 }}
          rowHeight={52}
          barMargin={8}
          columns={columns}
          resources={resources}
          events={events}
          timeRanges={timeRanges}
          timeRangesFeature={{ showCurrentTimeLine: true }}
          eventDragFeature={{ constrainDragToResource: true }}
          eventDragCreateFeature={false}
          eventEditFeature={false}
          eventMenuFeature={false}
          scheduleMenuFeature={false}
          cellEditFeature={false}
          eventRenderer={({ eventRecord }: any) => {
            const b = byId.current.get(Number(eventRecord.id));
            if (!b) return enc(String(eventRecord.name));
            let sub = b.state === 'pending_approval' ? countdown(b) : stateInfo(b.state).label;
            if (b.is_sample) sub += ' · sample';
            return `<div class="hb-ev"><b>${enc(b.code)}</b><span>${enc(sub)}</span></div>`;
          }}
          onEventClick={({ eventRecord }: any) => setSelected(Number(eventRecord.id))}
          onEventDrop={({ eventRecords }: any) => { for (const r of eventRecords) void patch(r); }}
          onEventResizeEnd={({ changed, eventRecord }: any) => { if (changed) void patch(eventRecord); }}
        />}
      </div>

      {sel ? (
        <div className="card">
          <div className="row between">
            <h3>{sel.code} · {sel.item_name}</h3>
            <span className={`badge s-${stateInfo(sel.state).tone}`}>{stateInfo(sel.state).label}</span>
          </div>
          <div className="grid grid-3" style={{ marginTop: 8 }}>
            <div><div className="muted">Dates</div>{when(sel.start_at)} – {when(sel.end_at)}</div>
            <div><div className="muted">Rental fee / deposit</div>{money(sel.fee_cents)} / {money(sel.deposit_cents)}</div>
            <div><div className="muted">PayPal hold</div>{sel.authorized_cents ? money(sel.authorized_cents) : 'not yet'}</div>
            <div><div className="muted">Honor period ends</div>{when(sel.honor_ends_at)}</div>
            <div><div className="muted">Hold expires</div>{when(sel.hold_expires_at)}</div>
            <div><div className="muted">Customer</div>{sel.customer_name}{sel.is_sample ? ' (sample)' : ''}</div>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            {movable(sel) === true && 'Drag to move or extend. The new dates must end before the hold expires, and the new fee must leave at least half of the deposit covered by the hold.'}
            {movable(sel) === 'end' && 'Picked up: drag the end to extend. The same hold rules apply.'}
            {!movable(sel) && (sel.is_sample ? 'Sample rows are read-only.' : sel.state === 'pending_approval' ? 'Waiting for PayPal approval. It locks in as a held booking when the authorization arrives.' : 'Read-only in this state.')}
          </p>
          {!sel.is_sample && (
            <div className="row" style={{ marginTop: 8 }}>
              <Link className="btn btn-sm" to={`/shop?b=${sel.id}`}>Open on the Desk</Link>
              {['settled_clean', 'settled_charged', 'contested', 'refunded', 'contest_denied'].includes(sel.state) && <Link className="btn btn-sm" to={`/e/${sel.public_token}`}>Evidence page</Link>}
            </div>
          )}
        </div>
      ) : (
        <p className="muted">Click a booking to see its hold, the end of PayPal's honor period and the hold expiry (shown as markers).</p>
      )}
    </div>
  );
}
