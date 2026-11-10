import { get } from '../db.ts';
import { env } from '../env.ts';
import type { MarketQuote } from './ratecard.ts';

const DAY = 86_400_000;

/**
 * Market quote for a search query. Reads the 24-hour cache in `price_quotes`.
 * The live Channel3 call is P1 and is added after its request/response shape is confirmed in the docs.
 * Without a key, a fresh cache row or a live result, this returns null and the shop list price is used.
 */
export async function getQuote(query: string): Promise<MarketQuote | null> {
  const row = get<{ median_cents: number | null; n_offers: number; fetched_at: string }>('SELECT median_cents, n_offers, fetched_at FROM price_quotes WHERE query = ?', query);
  if (row && Date.now() - Date.parse(row.fetched_at) < DAY && row.median_cents != null) {
    return { medianCents: row.median_cents, nOffers: row.n_offers, fetchedAt: row.fetched_at };
  }
  if (!env.CHANNEL3_API_KEY) return null;
  return null;
}
