export type BookingState =
  | 'pending_approval'
  | 'expired'
  | 'authorized'
  | 'cancelled'
  | 'picked_up'
  | 'inspecting'
  | 'blocked'
  | 'needs_review'
  | 'settling'
  | 'settled_clean'
  | 'settled_charged'
  | 'contested'
  | 'refunded'
  | 'contest_denied';

const ALLOWED: Record<BookingState, BookingState[]> = {
  pending_approval: ['authorized', 'expired', 'cancelled'],
  expired: [],
  authorized: ['picked_up', 'cancelled'],
  cancelled: [],
  picked_up: ['inspecting'],
  inspecting: ['blocked', 'needs_review', 'settling'],
  blocked: ['inspecting'],
  needs_review: ['settling', 'inspecting'],
  settling: ['settled_clean', 'settled_charged', 'needs_review'],
  settled_clean: [],
  settled_charged: ['contested'],
  contested: ['refunded', 'contest_denied'],
  refunded: [],
  contest_denied: [],
};

export class IllegalTransition extends Error {
  status = 409;
  constructor(from: string, to: string) {
    super(`Illegal transition ${from} → ${to}`);
  }
}

export function canTransition(from: BookingState, to: BookingState): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertTransition(from: BookingState, to: BookingState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

export const HELD_STATES: BookingState[] = ['authorized', 'picked_up', 'inspecting', 'blocked', 'needs_review', 'settling'];
