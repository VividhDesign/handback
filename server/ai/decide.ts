import type { Compare } from './schemas.ts';

export interface DecisionInput {
  checksPassed: boolean;
  compare: Compare;
  accessoryNames: string[];
  isLate: boolean;
  minConf: number; // AUTO_RELEASE_MIN_CONF
}

export interface Decision {
  decision: 'auto_release' | 'needs_review';
  reasons: string[]; // why it is NOT auto release (empty when auto)
}

/** Code decides, not the model (PLAN B8.6). The AI path can only ever lead to the fee-only capture. */
export function decide(input: DecisionInput): Decision {
  const { compare: c } = input;
  const reasons: string[] = [];
  if (!input.checksPassed) reasons.push('deterministic checks failed');
  if (!c.same_item.value || c.same_item.confidence < 0.8) reasons.push('not sure it is the same item');
  if (c.cannot_determine.value) reasons.push(`AI cannot determine: ${c.cannot_determine.reason ?? 'no reason given'}`);
  if (c.suspicious_text_in_photos) reasons.push('text aimed at the AI found in a photo');
  if (c.photo_quality.some((p) => !p.ok)) reasons.push('a photo has a quality problem');
  const live = c.findings.filter((f) => !f.existing_mark_id);
  if (live.length) reasons.push(`${live.length} new finding(s)`);
  for (const name of input.accessoryNames) {
    const a = c.accessories.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!a) reasons.push(`accessory not reported: ${name}`);
    else if (!a.present || a.confidence < 0.8) reasons.push(`accessory missing or unsure: ${name}`);
  }
  if (c.overall.verdict !== 'clean') reasons.push(`verdict is ${c.overall.verdict}`);
  else if (c.overall.confidence < input.minConf) reasons.push(`confidence ${c.overall.confidence.toFixed(2)} below ${input.minConf}`);
  if (input.isLate) reasons.push('late return');
  return { decision: reasons.length ? 'needs_review' : 'auto_release', reasons };
}
