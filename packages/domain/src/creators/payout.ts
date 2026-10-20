import { payoutApprovalStatus, approvalRequirementMet, type PayoutApprovalStatus } from "../payouts/approval";
import { applyPayoutEvent, type PayoutContext, type PayoutEvent, type PayoutState } from "../payouts/lifecycle";
import type { ApprovalRecord } from "../admin/approval";

export type CreatorPayoutHold = "kyc_incomplete" | "under_age" | "suspended" | "negative_balance" | "below_minimum" | "exceeds_ledger_balance";

/** Batch line amount: the lesser of the ledger payable and the sum of reserved commissions. Never negative. */
export function payoutLineAmount(ledgerPayable: bigint, reservedCommissions: bigint): bigint {
  if (ledgerPayable <= 0n || reservedCommissions <= 0n) return 0n;
  return ledgerPayable < reservedCommissions ? ledgerPayable : reservedCommissions;
}

export function creatorPayoutApproval(input: {
  readonly payoutId: string;
  readonly amountMinor: bigint;
  readonly records: readonly ApprovalRecord[];
  readonly nowMs: number;
}): { readonly status: PayoutApprovalStatus; readonly met: boolean } {
  const status = payoutApprovalStatus(input);
  return { status, met: approvalRequirementMet(status) };
}

/**
 * Creator payouts reuse the seller payout machine. `ibanNameMatched` is the creator's payout identity
 * name match (KYC), `noOpenDispute` is always true until creators have disputes.
 */
export function applyCreatorPayoutEvent(state: PayoutState, event: PayoutEvent, ctx: PayoutContext): PayoutState {
  return applyPayoutEvent(state, event, ctx);
}
