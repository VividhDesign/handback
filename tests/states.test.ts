import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition, IllegalTransition } from '../server/lib/states.ts';

describe('booking state machine', () => {
  it('follows the happy paths', () => {
    const clean = ['pending_approval', 'authorized', 'picked_up', 'inspecting', 'settling', 'settled_clean'] as const;
    const charged = ['inspecting', 'needs_review', 'settling', 'settled_charged', 'contested', 'refunded'] as const;
    for (const path of [clean, charged]) for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });
  it('blocks illegal jumps', () => {
    expect(canTransition('authorized', 'settled_charged')).toBe(false);
    expect(canTransition('picked_up', 'settling')).toBe(false);
    expect(canTransition('settled_clean', 'contested')).toBe(false);
    expect(canTransition('settled_charged', 'settling')).toBe(false);
    expect(() => assertTransition('refunded', 'contested')).toThrow(IllegalTransition);
  });
  it('terminal states have no exits', () => {
    for (const s of ['expired', 'cancelled', 'settled_clean', 'refunded', 'contest_denied'] as const)
      expect(canTransition(s, 'authorized')).toBe(false);
  });
});
