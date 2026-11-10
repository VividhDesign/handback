import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (n === seq.current) setError(e as Error);
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, setData, error, loading, reload };
}

/** Runs one async action at a time and keeps its error for display. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (e: any) {
      const dbg = e?.body?.paypalDebugId ? ` (PayPal debug id ${e.body.paypalDebugId})` : '';
      setError(`${e?.message ?? 'Something went wrong'}${dbg}`);
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, setError, run };
}

export type FeedEvent = { id: number; booking_id: number | null; booking_code?: string | null; type: string; actor: string; summary: string; created_at: string };

/** Live feed over SSE, seeded from history. */
export function useFeed(bookingId?: number | null) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let alive = true;
    api<FeedEvent[]>(`/events${bookingId ? `?booking=${bookingId}` : ''}`).then((e) => alive && setEvents(e)).catch(() => {});
    const es = new EventSource('/api/events/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('event', (m) => {
      const e = JSON.parse((m as MessageEvent).data) as FeedEvent;
      if (bookingId && e.booking_id !== bookingId) return;
      setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e].slice(-200)));
    });
    return () => { alive = false; es.close(); };
  }, [bookingId]);
  return { events, connected };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
