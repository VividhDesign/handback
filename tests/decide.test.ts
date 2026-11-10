import { describe, it, expect } from 'vitest';
import { decide } from '../server/ai/decide.ts';
import type { Compare } from '../server/ai/schemas.ts';

const clean = (): Compare => ({
  same_item: { value: true, confidence: 0.95 },
  photo_quality: [1, 2, 3, 4, 5].map((i) => ({ photo_index: i, ok: true })),
  findings: [],
  accessories: [{ name: 'Power adapter', present: true, confidence: 0.92 }],
  suspicious_text_in_photos: false,
  cannot_determine: { value: false },
  overall: { verdict: 'clean', confidence: 0.93, summary: 'No change' },
});
const base = { checksPassed: true, accessoryNames: ['power adapter'], isLate: false, minConf: 0.85 };

describe('decision rules', () => {
  it('auto releases only a clean, confident return', () => {
    expect(decide({ ...base, compare: clean() })).toEqual({ decision: 'auto_release', reasons: [] });
  });
  it('sends anything doubtful to review', () => {
    const cases: [string, (c: Compare) => void, Partial<typeof base>?][] = [
      ['checks', () => {}, { checksPassed: false }],
      ['same item', (c) => (c.same_item.confidence = 0.6)],
      ['cannot determine', (c) => (c.cannot_determine = { value: true, reason: 'blurry' })],
      ['injection', (c) => (c.suspicious_text_in_photos = true)],
      ['quality', (c) => (c.photo_quality[2].ok = false)],
      ['finding', (c) => c.findings.push({ type: 'new_damage', description: 'scratch', severity: 'minor', confidence: 0.9 })],
      ['accessory', (c) => (c.accessories[0].present = false)],
      ['accessory unsure', (c) => (c.accessories[0].confidence = 0.5)],
      ['verdict', (c) => (c.overall.verdict = 'unclear')],
      ['low confidence', (c) => (c.overall.confidence = 0.8)],
      ['late', () => {}, { isLate: true }],
    ];
    for (const [name, mut, extra] of cases) {
      const c = clean();
      mut(c);
      const d = decide({ ...base, ...extra, compare: c });
      expect(d.decision, name).toBe('needs_review');
      expect(d.reasons.length, name).toBeGreaterThan(0);
    }
  });
  it('a finding matching an existing pickup mark does not block release', () => {
    const c = clean();
    c.findings.push({ type: 'new_damage', description: 'old scuff', severity: 'minor', confidence: 0.9, existing_mark_id: 'm1' });
    expect(decide({ ...base, compare: c }).decision).toBe('auto_release');
  });
});
