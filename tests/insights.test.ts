import { describe, it, expect } from 'vitest';
import { holdOutcome } from '../server/insights.ts';

describe('holdOutcome (Insights hold funnel)', () => {
  const h = (state: string, held = true) => holdOutcome({ state, authorization_id: held ? 'AUTH' : null, authorized_cents: held ? 100 : 0 });
  it('maps settled and closed states', () => {
    expect(h('settled_clean')).toBe('Released');
    expect(h('settled_charged')).toBe('Charged');
    expect(h('contest_denied')).toBe('Charged');
    expect(h('refunded')).toBe('Refunded');
    expect(h('cancelled')).toBe('Voided');
    expect(h('picked_up')).toBe('Holding');
  });
  it('says No hold when PayPal never authorized', () => {
    expect(h('pending_approval', false)).toBe('No hold');
    expect(h('expired', false)).toBe('No hold');
  });
});
