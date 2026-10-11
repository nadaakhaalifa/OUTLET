import { payoutMachine, type PayoutContext, type PayoutEvent, type PayoutState } from "../state-machine/machines/payout";

export type { PayoutContext, PayoutEvent, PayoutState };

export const HOLD_REASONS = [
  "no_bank_details",
  "iban_name_mismatch",
  "name_check_unavailable",
  "risk_review",
  "exceeds_ledger_balance",
  "open_dispute",
  "manual_hold",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** A payout in these states still owns its lines (partial unique index on active lines). */
export const LINE_HOLDING_STATES: readonly PayoutState[] = ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED"];

/** Cancelling is the only way a payout gives its lines back. */
export const releasesLines = (to: PayoutState): boolean => to === "CANCELLED";

/** Pure: next state or a typed machine error. */
export function applyPayoutEvent(state: PayoutState, event: PayoutEvent, ctx: PayoutContext): PayoutState {
  return payoutMachine.transition(state, event, ctx);
}

export const canPayoutEvent = (state: PayoutState, event: PayoutEvent, ctx: PayoutContext): boolean =>
  payoutMachine.can(state, event, ctx);

/**
 * The ledger idempotency subject for one send attempt. A rejected attempt is reversed, so a
 * retry needs a NEW entry; the attempt number keeps the key unique and the replay safe.
 */
export const ledgerPayoutRef = (payoutId: string, attempt: number): string => `${payoutId}~${attempt}`;

export type ProviderOutcomeKind = "accepted" | "settled" | "rejected" | "unavailable";

/** Which machine event a provider outcome causes, if any. `accepted` and `unavailable` keep SENT. */
export function eventForOutcome(kind: ProviderOutcomeKind): PayoutEvent | null {
  switch (kind) {
    case "settled":
      return "BANK_CONFIRMED";
    case "rejected":
      return "BANK_REJECTED";
    case "accepted":
    case "unavailable":
      return null;
  }
}
