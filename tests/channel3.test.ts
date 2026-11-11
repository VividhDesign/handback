import { describe, it, expect } from 'vitest';
import { quoteFromProducts } from '../server/pricing/channel3.ts';
import { accessoryPrice } from '../server/pricing/ratecard.ts';

const p = (...offers: [number, string?, string?][]) => ({ offers: offers.map(([price, currency = 'USD', condition = 'new']) => ({ price: { price, currency }, condition, availability: 'InStock' })) });

describe('Channel3 quote', () => {
  it('takes the cheapest new USD offer per product and the median across products', () => {
    const q = quoteFromProducts([p([40], [35]), p([50]), p([30, 'EUR']), p([20, 'USD', 'used']), p([60])]);
    expect(q.prices).toEqual([3500, 5000, 6000]);
    expect(q.medianCents).toBe(5000);
    expect(q.nOffers).toBe(3);
  });
  it('returns no median when nothing usable comes back', () => {
    expect(quoteFromProducts([{ offers: [] }, {}]).medianCents).toBeNull();
  });
  it('feeds the B9 rule: market median only with ≥3 offers inside 0.5×–1.5× of list', () => {
    const at = new Date().toISOString();
    expect(accessoryPrice(4000, { medianCents: 5000, nOffers: 3, fetchedAt: at }).cents).toBe(5000);
    expect(accessoryPrice(4000, { medianCents: 9000, nOffers: 5, fetchedAt: at }).source).toMatch(/out of range/);
    expect(accessoryPrice(4000, null).source).toMatch(/no market data/);
  });
});
