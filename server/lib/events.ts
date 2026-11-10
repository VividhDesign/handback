import { EventEmitter } from 'node:events';
import { run, nowISO, get } from '../db.ts';

export type Actor = 'system' | 'ai' | 'owner' | 'customer' | 'paypal' | 'agent';

export interface FeedEvent {
  id: number;
  booking_id: number | null;
  booking_code?: string | null;
  type: string;
  actor: Actor;
  summary: string;
  data?: unknown;
  created_at: string;
}

export const bus = new EventEmitter();
bus.setMaxListeners(200);

/** Writes an events row and pushes it to SSE listeners. Call inside the state transaction. */
export function logEvent(bookingId: number | null, type: string, actor: Actor, summary: string, data?: unknown): FeedEvent {
  const created_at = nowISO();
  const r = run('INSERT INTO events (booking_id, type, actor, summary, data_json, created_at) VALUES (?,?,?,?,?,?)', bookingId, type, actor, summary, data === undefined ? null : JSON.stringify(data), created_at);
  const code = bookingId ? (get<{ code: string }>('SELECT code FROM bookings WHERE id = ?', bookingId)?.code ?? null) : null;
  const ev: FeedEvent = { id: Number(r.lastInsertRowid), booking_id: bookingId, booking_code: code, type, actor, summary, data, created_at };
  queueMicrotask(() => bus.emit('event', ev));
  return ev;
}

/** Non-persistent progress pings (AI queue position etc.). */
export function ping(bookingId: number | null, type: string, data: unknown) {
  bus.emit('ping', { booking_id: bookingId, type, data, at: nowISO() });
}
