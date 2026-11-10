import { describe, it, expect } from 'vitest';
import { dedupeFindings } from '../server/ai/inspect.ts';

describe('dedupeFindings', () => {
  it('merges one issue reported once per photo, keeping the most confident', () => {
    const f = (i: number, conf: number) => ({ type: 'new_damage', part: 'Cap', confidence: conf, return_photo_index: i, existing_mark_id: null, accessory_name: null });
    const out = dedupeFindings([f(1, 0.8), f(2, 0.95), f(3, 0.9)]);
    expect(out).toHaveLength(1);
    expect(out[0].return_photo_index).toBe(2);
  });
  it('keeps different parts, types and accessories apart', () => {
    const out = dedupeFindings([
      { type: 'new_damage', part: 'cap', confidence: 1 },
      { type: 'new_damage', part: 'body', confidence: 1 },
      { type: 'needs_cleaning', part: 'cap', confidence: 1 },
      { type: 'missing_accessory', part: null, accessory_name: 'charger', confidence: 1 },
      { type: 'missing_accessory', part: null, accessory_name: 'remote', confidence: 1 },
    ]);
    expect(out).toHaveLength(5);
  });
});
