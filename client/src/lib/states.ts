export type Tone = 'tentative' | 'held' | 'review' | 'released' | 'charged' | 'blocked';

export const STATE_INFO: Record<string, { label: string; tone: Tone }> = {
  pending_approval: { label: 'Awaiting approval', tone: 'tentative' },
  expired: { label: 'Expired', tone: 'tentative' },
  cancelled: { label: 'Cancelled, hold voided', tone: 'tentative' },
  authorized: { label: 'Hold placed', tone: 'held' },
  picked_up: { label: 'Picked up', tone: 'held' },
  inspecting: { label: 'Inspecting', tone: 'held' },
  blocked: { label: 'Re-shoot photos', tone: 'blocked' },
  needs_review: { label: 'Needs review', tone: 'review' },
  settling: { label: 'Settling', tone: 'held' },
  settled_clean: { label: 'Deposit released', tone: 'released' },
  settled_charged: { label: 'Charged', tone: 'charged' },
  contested: { label: 'Contested', tone: 'review' },
  refunded: { label: 'Refunded', tone: 'released' },
  contest_denied: { label: 'Contest denied', tone: 'charged' },
};

export const stateInfo = (s: string) => STATE_INFO[s] ?? { label: s, tone: 'tentative' as Tone };

/** Hold → Pickup → Return → Settlement */
export function stepIndex(state: string): number {
  if (['pending_approval', 'expired', 'cancelled'].includes(state)) return 0;
  if (state === 'authorized') return 1;
  if (['picked_up'].includes(state)) return 2;
  if (['inspecting', 'blocked', 'needs_review', 'settling'].includes(state)) return 3;
  return 4;
}
