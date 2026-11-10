import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { dhash, hamming } from '../server/checks/photos.ts';
import { runReturnChecks, DHASH_REUPLOAD_MAX, type PhotoRow } from '../server/checks/deterministic.ts';

const gradient = (w: number, h: number, flip = false) => {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round(((flip ? w - x : x) / w) * 200 + ((y * 7) % 40));
    px.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
};

describe('dHash', () => {
  it('is 64 hex chars and stable across resize and recompress', async () => {
    const a = await gradient(800, 600);
    const b = await sharp(a).resize(640, 480).jpeg({ quality: 60 }).toBuffer();
    const ha = await dhash(a);
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
    expect(hamming(ha, await dhash(b))).toBeLessThanOrEqual(DHASH_REUPLOAD_MAX);
  });
  it('differs a lot for a different image', async () => {
    expect(hamming(await dhash(await gradient(800, 600)), await dhash(await gradient(800, 600, true)))).toBeGreaterThan(64);
  });
  it('hamming counts bits', () => {
    expect(hamming('0f', '00')).toBe(4);
    expect(hamming('ff', 'ff')).toBe(0);
  });
});

describe('return checks', () => {
  const row = (angle: number, over: Partial<PhotoRow> = {}): PhotoRow => ({
    angle, sha256: `s${angle}`, dhash: '0'.repeat(64), width: 1600, height: 1200, mean_luma: 120, exif_taken_at: null, received_at: '2026-11-12T10:00:00Z', ...over,
  });
  const pickup = [1, 2, 3, 4, 5].map((a) => row(a, { sha256: `p${a}`, dhash: 'f'.repeat(64) }));
  const opts = { pickup, pickedUpAt: '2026-11-11T10:00:00Z', endAt: '2026-11-13T10:00:00Z', returnedAt: '2026-11-12T10:00:00Z', graceMinutes: 60 };
  const byName = (r: ReturnType<typeof runReturnChecks>) => Object.fromEntries(r.map((c) => [c.name, c.passed]));

  it('passes a good return', () => {
    expect(byName(runReturnChecks({ ...opts, ret: [1, 2, 3, 4, 5].map((a) => row(a)) }))).toEqual({ completeness: true, order: true, reupload: true, quality: true, late: true });
  });
  it('catches missing angles, re-uploads, old photos, dark photos and late returns', () => {
    const ret = [row(1, { sha256: 'p1' }), row(2, { dhash: 'f'.repeat(63) + '0' }), row(3, { exif_taken_at: '2026-11-10T09:00:00Z' }), row(4, { mean_luma: 5 })];
    const r = byName(runReturnChecks({ ...opts, ret, returnedAt: '2026-11-13T12:00:00Z' }));
    expect(r).toEqual({ completeness: false, order: false, reupload: false, quality: false, late: false });
  });
});
