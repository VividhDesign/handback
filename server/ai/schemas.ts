import { z } from 'zod';

const box = z.array(z.number()).length(4).nullable().optional();
const photoQuality = z.array(z.object({ photo_index: z.number().int(), ok: z.boolean(), problem: z.string().nullable().optional() }));
const accessories = z.array(z.object({ name: z.string(), present: z.boolean(), confidence: z.number().min(0).max(1) }));

export const PassportSchema = z.object({
  item_matches_listing: z.boolean(),
  photo_quality: photoQuality,
  existing_marks: z.array(
    z.object({
      id: z.string(),
      part: z.string(),
      description: z.string(),
      severity: z.enum(['minor', 'moderate', 'major']),
      photo_index: z.number().int(),
      box_2d: box,
    }),
  ),
  accessories,
  summary: z.string(),
});
export type Passport = z.infer<typeof PassportSchema>;

export const FindingSchema = z.object({
  type: z.enum(['new_damage', 'missing_accessory', 'needs_cleaning']),
  part: z.string().nullable().optional(),
  description: z.string(),
  severity: z.enum(['minor', 'moderate', 'major']),
  confidence: z.number().min(0).max(1),
  return_photo_index: z.number().int().nullable().optional(),
  pickup_photo_index: z.number().int().nullable().optional(),
  box_2d: box,
  existing_mark_id: z.string().nullable().optional(),
  accessory_name: z.string().nullable().optional(),
});
export type AiFinding = z.infer<typeof FindingSchema>;

export const CompareSchema = z.object({
  same_item: z.object({ value: z.boolean(), confidence: z.number().min(0).max(1) }),
  photo_quality: photoQuality,
  findings: z.array(FindingSchema),
  accessories,
  suspicious_text_in_photos: z.boolean(),
  cannot_determine: z.object({ value: z.boolean(), reason: z.string().nullable().optional() }),
  overall: z.object({ verdict: z.enum(['clean', 'issues', 'unclear']), confidence: z.number().min(0).max(1), summary: z.string() }),
});
export type Compare = z.infer<typeof CompareSchema>;

// Gemini responseSchema (OpenAPI subset). Kept free of unions so Gemini accepts it.
const S = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });
const num = S('NUMBER');
const int = S('INTEGER');
const str = S('STRING');
const bool = S('BOOLEAN');
const nstr = S('STRING', { nullable: true });
const boxS = S('ARRAY', { items: int, nullable: true });
const pq = S('ARRAY', { items: S('OBJECT', { properties: { photo_index: int, ok: bool, problem: nstr }, required: ['photo_index', 'ok'] }) });
const acc = S('ARRAY', { items: S('OBJECT', { properties: { name: str, present: bool, confidence: num }, required: ['name', 'present', 'confidence'] }) });
const sev = S('STRING', { enum: ['minor', 'moderate', 'major'] });

export const passportResponseSchema = S('OBJECT', {
  properties: {
    item_matches_listing: bool,
    photo_quality: pq,
    existing_marks: S('ARRAY', {
      items: S('OBJECT', {
        properties: { id: str, part: str, description: str, severity: sev, photo_index: int, box_2d: boxS },
        required: ['id', 'part', 'description', 'severity', 'photo_index'],
      }),
    }),
    accessories: acc,
    summary: str,
  },
  required: ['item_matches_listing', 'photo_quality', 'existing_marks', 'accessories', 'summary'],
});

export const compareResponseSchema = S('OBJECT', {
  properties: {
    same_item: S('OBJECT', { properties: { value: bool, confidence: num }, required: ['value', 'confidence'] }),
    photo_quality: pq,
    findings: S('ARRAY', {
      items: S('OBJECT', {
        properties: {
          type: S('STRING', { enum: ['new_damage', 'missing_accessory', 'needs_cleaning'] }),
          part: nstr,
          description: str,
          severity: sev,
          confidence: num,
          return_photo_index: S('INTEGER', { nullable: true }),
          pickup_photo_index: S('INTEGER', { nullable: true }),
          box_2d: boxS,
          existing_mark_id: nstr,
          accessory_name: nstr,
        },
        required: ['type', 'description', 'severity', 'confidence'],
      }),
    }),
    accessories: acc,
    suspicious_text_in_photos: bool,
    cannot_determine: S('OBJECT', { properties: { value: bool, reason: nstr }, required: ['value'] }),
    overall: S('OBJECT', {
      properties: { verdict: S('STRING', { enum: ['clean', 'issues', 'unclear'] }), confidence: num, summary: str },
      required: ['verdict', 'confidence', 'summary'],
    }),
  },
  required: ['same_item', 'photo_quality', 'findings', 'accessories', 'suspicious_text_in_photos', 'cannot_determine', 'overall'],
});
