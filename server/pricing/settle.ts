export interface SettlementMath {
  feeCents: number;
  chargesCents: number;
  captureCents: number;
  releasedCents: number;
  excessCents: number;
}

/**
 * capture  = fee + min(charges, authorized − fee)   // one final capture, never above the hold
 * released = authorized − capture
 * excess   = charges − (capture − fee)              // > 0: invoice draft, owner must click to send
 */
export function settlementMath(authorizedCents: number, feeCents: number, approvedCharges: number[]): SettlementMath {
  if (feeCents > authorizedCents) throw new Error('fee above authorized amount');
  const chargesCents = approvedCharges.reduce((a, b) => a + b, 0);
  const captureCents = feeCents + Math.min(chargesCents, authorizedCents - feeCents);
  return {
    feeCents,
    chargesCents,
    captureCents,
    releasedCents: authorizedCents - captureCents,
    excessCents: chargesCents - (captureCents - feeCents),
  };
}

/** A contest refund is bounded by the captured charges (never the rental fee). */
export function boundRefund(requestedCents: number, capturedChargesCents: number, alreadyRefundedCents: number): number {
  return Math.max(0, Math.min(requestedCents, capturedChargesCents - alreadyRefundedCents));
}
