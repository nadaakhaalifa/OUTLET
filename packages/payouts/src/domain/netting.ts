export interface AccrualView {
  readonly id: string;
  /** Piastres, > 0. */
  readonly amountMinor: bigint;
  readonly eligible: boolean;
}

export interface PlanLine {
  readonly kind: "order" | "adjustment";
  readonly accrualId: string | null;
  /** Signed piastres; never 0. */
  readonly amountMinor: bigint;
}

export type PayoutPlan =
  | { readonly kind: "none"; readonly reason: "nothing_eligible" | "no_balance" }
  | { readonly kind: "payout"; readonly grossMinor: bigint; readonly adjustmentsMinor: bigint; readonly netMinor: bigint; readonly lines: readonly PlanLine[] };

/**
 * Chart 4.11: the payout is the seller_available balance, minus what is closed but not yet payable.
 *   payable = available - (accruals that are AVAILABLE but not eligible, or held)
 * The difference between payable and the eligible accruals is the netting line (refund, chargeback or recharge after payout
 * makes it negative; it is recovered from this payout). I12: net <= available always, because the subtracted part is >= 0.
 * A non-positive payable means the seller owes us: no payout, the debt carries forward (chart 4.11).
 */
export const planPayout = (accruals: readonly AccrualView[], availableMinor: bigint): PayoutPlan => {
  let gross = 0n;
  let blocked = 0n;
  const lines: PlanLine[] = [];
  for (const a of accruals) {
    if (a.amountMinor <= 0n) throw new RangeError("accrual amount must be positive");
    if (a.eligible) {
      gross += a.amountMinor;
      lines.push({ kind: "order", accrualId: a.id, amountMinor: a.amountMinor });
    } else {
      blocked += a.amountMinor;
    }
  }
  if (gross === 0n) return { kind: "none", reason: "nothing_eligible" };
  const payable = availableMinor - blocked;
  if (payable <= 0n) return { kind: "none", reason: "no_balance" };
  const adjustments = payable - gross;
  if (adjustments !== 0n) lines.push({ kind: "adjustment", accrualId: null, amountMinor: adjustments });
  return { kind: "payout", grossMinor: gross, adjustmentsMinor: adjustments, netMinor: payable, lines };
};
