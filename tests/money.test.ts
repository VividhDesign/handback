import { describe, it, expect } from 'vitest';
import { toPayPal, fromPayPal, median } from '../server/lib/money.ts';
import { settlementMath, boundRefund } from '../server/pricing/settle.ts';
import { DEFAULT_RATE_CARD as RC, damagePrice, latePrice, accessoryPrice, rentalDays, rentalFee, suggestDeposit } from '../server/pricing/ratecard.ts';

describe('money', () => {
  it('formats cents for PayPal and back', () => {
    expect(toPayPal(18200)).toBe('182.00');
    expect(toPayPal(5)).toBe('0.05');
    expect(fromPayPal('182.00')).toBe(18200);
    expect(fromPayPal('0.29')).toBe(29);
    expect(() => toPayPal(1.5)).toThrow();
    expect(() => toPayPal(-1)).toThrow();
  });
  it('median of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3); // 2.5 rounds up
  });
});

describe('settlement maths', () => {
  it('clean return captures only the fee', () => {
    expect(settlementMath(18200, 3200, [])).toEqual({ feeCents: 3200, chargesCents: 0, captureCents: 3200, releasedCents: 15000, excessCents: 0 });
  });
  it('charges inside the hold are captured once with the fee', () => {
    const m = settlementMath(18200, 3200, [1000, 2500]);
    expect(m.captureCents).toBe(6700);
    expect(m.releasedCents).toBe(11500);
    expect(m.excessCents).toBe(0);
  });
  it('never captures above the hold; the rest is excess', () => {
    const m = settlementMath(18200, 3200, [20000]);
    expect(m.captureCents).toBe(18200);
    expect(m.releasedCents).toBe(0);
    expect(m.excessCents).toBe(5000);
  });
  it('rejects a fee above the authorized amount', () => {
    expect(() => settlementMath(1000, 2000, [])).toThrow();
  });
  it('refunds are bounded by captured charges', () => {
    expect(boundRefund(5000, 3500, 0)).toBe(3500);
    expect(boundRefund(5000, 3500, 3000)).toBe(500);
    expect(boundRefund(5000, 3500, 4000)).toBe(0);
  });
});

describe('rate card', () => {
  it('rental days round up, minimum one', () => {
    expect(rentalDays('2026-11-11T10:00:00Z', '2026-11-13T10:00:00Z')).toBe(2);
    expect(rentalDays('2026-11-11T10:00:00Z', '2026-11-11T11:00:00Z')).toBe(1);
    expect(rentalFee(1600, '2026-11-11T10:00:00Z', '2026-11-13T11:00:00Z')).toBe(4800);
  });
  it('minor damage is clamped between min and max', () => {
    expect(damagePrice(RC, 'minor', 2000).cents).toBe(500);
    expect(damagePrice(RC, 'minor', 30000).cents).toBe(1500);
    expect(damagePrice(RC, 'minor', 100000).cents).toBe(2500);
    expect(damagePrice(RC, 'moderate', 60000).cents).toBe(12000);
    expect(damagePrice(RC, 'major', 60000).cents).toBe(36000);
  });
  it('late fee: grace, started days, cap', () => {
    const end = '2026-11-13T10:00:00Z';
    expect(latePrice(RC, 1600, end, '2026-11-13T10:59:00Z')).toBeNull();
    expect(latePrice(RC, 1600, end, '2026-11-13T11:30:00Z')!.cents).toBe(1600);
    expect(latePrice(RC, 1600, end, '2026-11-20T10:00:00Z')!.cents).toBe(4800);
  });
  it('accessory: market median only with 3+ offers in range', () => {
    const q = (medianCents: number, nOffers: number) => ({ medianCents, nOffers, fetchedAt: '2026-11-10T12:00:00Z' });
    expect(accessoryPrice(2500, q(2200, 5)).cents).toBe(2200);
    expect(accessoryPrice(2500, q(2200, 2)).cents).toBe(2500);
    expect(accessoryPrice(2500, q(9000, 5)).cents).toBe(2500);
    expect(accessoryPrice(2500, null).source).toMatch(/no market data/);
  });
  it('suggested deposit is 25% rounded to $5, within $20–$500', () => {
    expect(suggestDeposit(60000)).toBe(15000);
    expect(suggestDeposit(1000)).toBe(2000);
    expect(suggestDeposit(10_000_000)).toBe(50000);
  });
});
