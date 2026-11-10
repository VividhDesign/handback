import { fmt, median } from '../lib/money.ts';

export type Severity = 'minor' | 'moderate' | 'major';
export type FindingType = 'new_damage' | 'missing_accessory' | 'needs_cleaning' | 'late';

export interface RateCard {
  minorPct: number; // of replacement value
  minorMinCents: number;
  minorMaxCents: number;
  moderatePct: number;
  majorPct: number;
  cleaningCents: number;
  lateGraceMinutes: number;
  lateMaxDays: number;
}

export const DEFAULT_RATE_CARD: RateCard = {
  minorPct: 5,
  minorMinCents: 500,
  minorMaxCents: 2500,
  moderatePct: 20,
  majorPct: 60,
  cleaningCents: 1000,
  lateGraceMinutes: 60,
  lateMaxDays: 3,
};

export function rentalDays(startISO: string, endISO: string): number {
  const hours = (Date.parse(endISO) - Date.parse(startISO)) / 3_600_000;
  return Math.max(1, Math.ceil(hours / 24));
}

export function rentalFee(dailyFeeCents: number, startISO: string, endISO: string): number {
  return dailyFeeCents * rentalDays(startISO, endISO);
}

export interface Price {
  cents: number;
  source: string;
}

export function damagePrice(card: RateCard, severity: Severity, replacementCents: number): Price {
  if (severity === 'minor') {
    const raw = Math.round((replacementCents * card.minorPct) / 100);
    const cents = Math.min(card.minorMaxCents, Math.max(card.minorMinCents, raw));
    return { cents, source: `Rate card: minor damage, ${card.minorPct}% of ${fmt(replacementCents)} (min ${fmt(card.minorMinCents)}, max ${fmt(card.minorMaxCents)})` };
  }
  const pct = severity === 'moderate' ? card.moderatePct : card.majorPct;
  return { cents: Math.round((replacementCents * pct) / 100), source: `Rate card: ${severity} damage, ${pct}% of ${fmt(replacementCents)}` };
}

export function cleaningPrice(card: RateCard): Price {
  return { cents: card.cleaningCents, source: `Rate card: cleaning, flat ${fmt(card.cleaningCents)}` };
}

/** Late fee: one daily fee per started day after the grace period, at most lateMaxDays. 0 when not late. */
export function latePrice(card: RateCard, dailyFeeCents: number, endISO: string, returnedISO: string): Price | null {
  const lateMs = Date.parse(returnedISO) - Date.parse(endISO) - card.lateGraceMinutes * 60_000;
  if (lateMs <= 0) return null;
  const days = Math.min(card.lateMaxDays, Math.ceil(lateMs / 86_400_000));
  return { cents: days * dailyFeeCents, source: `Rate card: late return, ${days} day(s) × ${fmt(dailyFeeCents)} after a ${card.lateGraceMinutes}-minute grace` };
}

export interface MarketQuote {
  medianCents: number;
  nOffers: number;
  fetchedAt: string;
}

/** Missing accessory: market median when ≥3 offers and within 0.5×–1.5× of list price; otherwise list price. */
export function accessoryPrice(listCents: number, quote: MarketQuote | null): Price {
  if (quote && quote.nOffers >= 3 && quote.medianCents >= listCents * 0.5 && quote.medianCents <= listCents * 1.5) {
    const t = new Date(quote.fetchedAt).toISOString().slice(11, 16);
    return { cents: quote.medianCents, source: `Market median of ${quote.nOffers} offers, checked ${t} UTC` };
  }
  const why = !quote ? 'no market data' : quote.nOffers < 3 ? `only ${quote.nOffers} market offers` : 'market median out of range';
  return { cents: listCents, source: `Shop list price (${why})` };
}

export function suggestDeposit(replacementCents: number): number {
  const raw = replacementCents * 0.25;
  const rounded = Math.round(raw / 500) * 500;
  return Math.min(50_000, Math.max(2_000, rounded));
}

export { median };
