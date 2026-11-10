import sharp from 'sharp';
import { createHash } from 'node:crypto';

export interface ProcessedPhoto {
  buffer: Buffer; // 1600 px storage JPEG, metadata stripped
  sha256: string; // of the ORIGINAL upload bytes
  dhash: string; // 256-bit hex
  width: number;
  height: number;
  exifTakenAt: string | null;
  meanLuma: number;
}

const ACCEPTED = new Set(['jpeg', 'png', 'webp']);

export class PhotoError extends Error {
  status = 400;
}

function exifDate(exif: Buffer | undefined): string | null {
  if (!exif) return null;
  // DateTimeOriginal is stored as ASCII "YYYY:MM:DD HH:MM:SS". A tolerant scan is enough here.
  const m = exif.toString('latin1').match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** Decodes with sharp (type check), rotates, resizes, strips metadata, hashes. */
export async function processPhoto(input: Buffer): Promise<ProcessedPhoto> {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new PhotoError('Not a readable image');
  }
  if (!meta.format || !ACCEPTED.has(meta.format)) throw new PhotoError('Only JPEG, PNG and WebP are accepted');
  const rotated = sharp(input).rotate();
  const buffer = await rotated
    .clone()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  const info = await sharp(buffer).metadata();
  const stats = await sharp(buffer).greyscale().stats();
  return {
    buffer,
    sha256: createHash('sha256').update(input).digest('hex'),
    dhash: await dhash(buffer),
    width: info.width ?? 0,
    height: info.height ?? 0,
    exifTakenAt: exifDate(meta.exif),
    meanLuma: stats.channels[0].mean,
  };
}

/** 256-bit difference hash: 17×16 greyscale, compare horizontal neighbours. */
export async function dhash(buf: Buffer): Promise<string> {
  const W = 17,
    H = 16;
  const px = await sharp(buf).rotate().greyscale().resize(W, H, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) bits += px[y * W + x] > px[y * W + x + 1] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Downscaled copy for the model (long edge 1280). */
export async function forModel(buf: Buffer): Promise<Buffer> {
  return sharp(buf).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}
