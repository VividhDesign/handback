import { get, run } from '../db.ts';
import { env } from '../env.ts';
import { median } from '../lib/money.ts';
import type { MarketQuote } from './ratecard.ts';

const DAY = 86_400_000;
const URL = 'https://api.trychannel3.com/v1/search';
/** Only the top results are used: Channel3 ranks by relevance, and lower results drift to other products. */
const TOP = 10;

export interface Channel3Offer { price: number; currency: string; condition?: string; availability?: string }
export interface Channel3Product { offers?: { price?: { price?: number; currency?: string } | null; condition?: string; availability?: string }[] }

/**
 * One price per product: its cheapest new, in-stock USD offer. Returns the median and the count.
 * Response shape checked against a live call on 11 Nov 2026: products[].offers[].price.{price,currency}.
 */
export function quoteFromProducts(products: Channel3Product[]): { medianCents: number | null; nOffers: number; prices: number[] } {
  const prices: number[] = [];
  for (const p of products.slice(0, TOP)) {
    const ok = (p.offers ?? [])
      .filter((o) => o.price?.currency === 'USD' && typeof o.price.price === 'number' && o.price.price > 0)
      .filter((o) => (o.condition ?? 'new') === 'new' && (o.availability ?? 'InStock') !== 'OutOfStock')
      .map((o) => Math.round(o.price!.price! * 100));
    if (ok.length) prices.push(Math.min(...ok));
  }
  return { medianCents: prices.length ? median(prices) : null, nOffers: prices.length, prices };
}

/**
 * Market quote for a search query. Reads the 24-hour cache in `price_quotes`, otherwise calls
 * Channel3 search. Without a key, or on an error, returns null and callers use the shop list price.
 */
export async function getQuote(query: string): Promise<MarketQuote | null> {
  const row = get<{ median_cents: number | null; n_offers: number; fetched_at: string }>('SELECT median_cents, n_offers, fetched_at FROM price_quotes WHERE query = ?', query);
  if (row && Date.now() - Date.parse(row.fetched_at) < DAY) {
    return row.median_cents == null ? null : { medianCents: row.median_cents, nOffers: row.n_offers, fetchedAt: row.fetched_at };
  }
  if (!env.CHANNEL3_API_KEY) return null;

  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'x-api-key': env.CHANNEL3_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Channel3 search failed (${r.status})`);
  const body = (await r.json()) as { products?: Channel3Product[] };
  const q = quoteFromProducts(body.products ?? []);
  const fetchedAt = new Date().toISOString();
  run(`INSERT INTO price_quotes (query, median_cents, n_offers, offers_json, fetched_at) VALUES (?,?,?,?,?)
    ON CONFLICT(query) DO UPDATE SET median_cents = excluded.median_cents, n_offers = excluded.n_offers, offers_json = excluded.offers_json, fetched_at = excluded.fetched_at`,
    query, q.medianCents, q.nOffers, JSON.stringify(q.prices), fetchedAt);
  return q.medianCents == null ? null : { medianCents: q.medianCents, nOffers: q.nOffers, fetchedAt };
}

export const hasChannel3 = () => !!env.CHANNEL3_API_KEY;
