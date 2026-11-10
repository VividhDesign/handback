/**
 * Turns the user's originals (../photos/<slug>/) into samples/<slug>/ (PLAN B3):
 * rotate by EXIF, resize to at most 1600 px, strip metadata, name 1.jpg–5.jpg,
 * build return-reupload by re-encoding the pickup photos, and copy the item name
 * and accessories from about.txt into server/seed/items.json.
 *
 * Usage: npm run samples [-- item1]
 */
import { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const PHOTOS = path.resolve(ROOT, '..', 'photos');
const SETS = ['pickup', 'return-clean', 'return-damaged'] as const;
const IMG = /\.(jpe?g|png|heic|webp)$/i;

const slugs = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(PHOTOS).filter((d) => /^item\d+$/.test(d));

function listSet(dir: string) {
  if (!existsSync(dir)) return [];
  // Numbered names keep the user's order; otherwise file time is the best capture-time proxy.
  return readdirSync(dir).filter((f) => IMG.test(f)).sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b);
  }).map((f) => path.join(dir, f));
}

async function toJpeg(src: string, dest: string) {
  let input = src;
  if (/\.heic$/i.test(src)) {
    input = dest + '.tmp.jpg';
    execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', input], { stdio: 'ignore' });
  }
  // sharp drops all metadata unless asked to keep it.
  await sharp(input).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toFile(dest);
  if (input !== src) rmSync(input);
}

function parseAbout(file: string) {
  const out: { name?: string; accessories: string[] } = { accessories: [] };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [k, ...rest] = line.split(':');
    const v = rest.join(':').trim();
    if (/^Item ka aam naam/i.test(k) && v) out.name = v.replace(/\s*\(.*\)\s*$/, '').trim() || v;
    if (/^Accessories/i.test(k) && v) out.accessories = v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

const itemsFile = path.join(ROOT, 'server', 'seed', 'items.json');
const items = JSON.parse(readFileSync(itemsFile, 'utf8'));

for (const slug of slugs) {
  const src = path.join(PHOTOS, slug);
  const counts: Record<string, number> = {};
  for (const set of SETS) {
    const files = listSet(path.join(src, set)).slice(0, 5);
    const out = path.join(ROOT, 'samples', slug, set);
    rmSync(out, { recursive: true, force: true });
    if (!files.length) { counts[set] = 0; continue; }
    mkdirSync(out, { recursive: true });
    for (const [i, f] of files.entries()) await toJpeg(f, path.join(out, `${i + 1}.jpg`));
    counts[set] = files.length;
  }
  // Re-upload attack set: the pickup photos re-encoded (new bytes, same picture).
  const pick = path.join(ROOT, 'samples', slug, 'pickup');
  const reup = path.join(ROOT, 'samples', slug, 'return-reupload');
  rmSync(reup, { recursive: true, force: true });
  if (existsSync(pick)) {
    mkdirSync(reup, { recursive: true });
    for (const f of readdirSync(pick)) await sharp(path.join(pick, f)).jpeg({ quality: 78 }).toFile(path.join(reup, f));
    counts['return-reupload'] = readdirSync(reup).length;
  }
  const about = parseAbout(path.join(src, 'about.txt'));
  const it = items.find((x: any) => x.slug === slug);
  if (it && about.name) {
    it.name = about.name;
    it.description = `Photographed for the demo (real photos).`;
    it.accessories = about.accessories.map((name) => ({ name, list_price_cents: 1000, search_query: `${about.name} ${name}` }));
  }
  console.log(slug, about.name ?? '(no name)', counts);
}

writeFileSync(itemsFile, '[\n' + items.map((x: any) => '  ' + JSON.stringify(x)).join(',\n') + '\n]\n');
