import { useEffect, useRef } from 'react';
import { useFeed } from '../lib/hooks.ts';
import { time } from '../lib/format.ts';

export function Ledger({ bookingId, title = 'Live ledger' }: { bookingId?: number | null; title?: string }) {
  const { events, connected } = useFeed(bookingId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [events.length]);
  return (
    <div className="card">
      <div className="row between">
        <h3>{title}</h3>
        <span className={`badge ${connected ? 's-released' : 's-tentative'}`}>{connected ? 'live' : 'reconnecting'}</span>
      </div>
      <div className="ledger" ref={ref} aria-live="polite">
        {events.length === 0 && <p className="faint">No events yet. Book something, or run a sample return.</p>}
        {events.map((e) => (
          <div key={e.id} className="ledger-line">
            <time dateTime={e.created_at}>{time(e.created_at)}</time>
            {!bookingId && e.booking_code && <span className="code">{e.booking_code}</span>}
            <span>{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
