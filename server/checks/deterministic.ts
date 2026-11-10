import { hamming } from './photos.ts';

export const DHASH_REUPLOAD_MAX = Number(process.env.DHASH_REUPLOAD_MAX ?? 6);

export interface PhotoRow {
  angle: number;
  sha256: string;
  dhash: string;
  width: number;
  height: number;
  mean_luma: number;
  exif_taken_at: string | null;
  received_at: string;
}

export interface CheckResult {
  name: 'completeness' | 'order' | 'reupload' | 'quality' | 'late';
  passed: boolean;
  detail: string;
  blocking: boolean; // late is not blocking (it becomes a finding)
}

export function runReturnChecks(opts: {
  pickup: PhotoRow[];
  ret: PhotoRow[];
  pickedUpAt: string;
  endAt: string;
  returnedAt: string;
  graceMinutes: number;
}): CheckResult[] {
  const { pickup, ret } = opts;
  const out: CheckResult[] = [];
  const angles = new Set(ret.map((p) => p.angle));
  const missing = [1, 2, 3, 4, 5].filter((a) => !angles.has(a));
  out.push({ name: 'completeness', passed: missing.length === 0, detail: missing.length ? `missing angle(s) ${missing.join(', ')}` : 'all 5 angles present', blocking: true });

  const pickedMs = Date.parse(opts.pickedUpAt);
  const badOrder = ret.filter((p) => Date.parse(p.received_at) < pickedMs || (p.exif_taken_at && Date.parse(p.exif_taken_at) < pickedMs - 5 * 60_000));
  out.push({ name: 'order', passed: badOrder.length === 0, detail: badOrder.length ? `photo(s) ${badOrder.map((p) => p.angle).join(', ')} taken before pickup` : 'timestamps after pickup', blocking: true });

  const reused: number[] = [];
  for (const r of ret) {
    const same = pickup.find((p) => p.angle === r.angle);
    if (pickup.some((p) => p.sha256 === r.sha256) || (same && hamming(same.dhash, r.dhash) <= DHASH_REUPLOAD_MAX)) reused.push(r.angle);
  }
  out.push({ name: 'reupload', passed: reused.length === 0, detail: reused.length ? `pickup photo re-uploaded at angle(s) ${reused.join(', ')}` : 'no pickup photo re-uploaded', blocking: true });

  const poor = ret.filter((p) => Math.min(p.width, p.height) < 640 || p.mean_luma < 12 || p.mean_luma > 245);
  out.push({ name: 'quality', passed: poor.length === 0, detail: poor.length ? `photo(s) ${poor.map((p) => p.angle).join(', ')} too small, too dark or too bright` : 'size and exposure ok', blocking: true });

  const late = Date.parse(opts.returnedAt) - Date.parse(opts.endAt) > opts.graceMinutes * 60_000;
  out.push({ name: 'late', passed: !late, detail: late ? 'returned after the grace period' : 'on time', blocking: false });
  return out;
}

export function pickupChecks(photos: PhotoRow[]): CheckResult[] {
  const angles = new Set(photos.map((p) => p.angle));
  const missing = [1, 2, 3, 4, 5].filter((a) => !angles.has(a));
  const poor = photos.filter((p) => Math.min(p.width, p.height) < 640 || p.mean_luma < 12 || p.mean_luma > 245);
  return [
    { name: 'completeness', passed: !missing.length, detail: missing.length ? `missing angle(s) ${missing.join(', ')}` : 'all 5 angles present', blocking: true },
    { name: 'quality', passed: !poor.length, detail: poor.length ? `photo(s) ${poor.map((p) => p.angle).join(', ')} too small, too dark or too bright` : 'size and exposure ok', blocking: true },
  ];
}
