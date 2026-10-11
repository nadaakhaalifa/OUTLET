import { defineMachine } from "../state-machine/machine";
import { GIFT_CARD_LIMITS, checkAmount } from "./rules";

/** Group gift pot (spec 15.1): OPEN -> CLOSED_FUNDED | CLOSED_UNFUNDED -> REFUNDING -> REFUNDED. */
export const POT_STATES = ["OPEN", "CLOSED_FUNDED", "CLOSED_UNFUNDED", "REFUNDING", "REFUNDED"] as const;
export type PotState = (typeof POT_STATES)[number];
export const POT_EVENTS = ["CLOSE_FUNDED", "CLOSE_UNFUNDED", "START_REFUND", "REFUND_DONE"] as const;
export type PotEvent = (typeof POT_EVENTS)[number];

export const potMachine = defineMachine<PotState, PotEvent>({
  name: "GiftPot",
  states: POT_STATES,
  events: POT_EVENTS,
  initial: "OPEN",
  terminal: ["CLOSED_FUNDED", "REFUNDED"],
  transitions: {
    OPEN: { CLOSE_FUNDED: { to: "CLOSED_FUNDED" }, CLOSE_UNFUNDED: { to: "CLOSED_UNFUNDED" } },
    CLOSED_FUNDED: {},
    CLOSED_UNFUNDED: { START_REFUND: { to: "REFUNDING" } },
    REFUNDING: { REFUND_DONE: { to: "REFUNDED" } },
    REFUNDED: {},
  },
});

export type ContributionStatus = "pending" | "pending_void" | "paid" | "cancelled" | "refunded" | "refund_failed";

export interface ContributionFacts {
  readonly id: string;
  readonly amount: bigint;
  readonly status: ContributionStatus;
}

export const paidTotal = (cs: readonly ContributionFacts[]): bigint =>
  cs.filter((c) => c.status === "paid").reduce((s, c) => s + c.amount, 0n);

export type ContributionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "below_min" | "exceeds_target" | "not_whole_egp" };

/**
 * `pending_void`: the pot closed and a PSP cancel was requested but not confirmed, so the payer may
 * still have paid. It keeps counting against the target and is never treated as cancelled.
 *
 * Pending money counts against the target so two contributors cannot jointly overshoot it.
 * The last contribution may be smaller than the minimum when that is exactly what is missing.
 */
export function checkContribution(target: bigint, committed: bigint, amount: bigint): ContributionCheck {
  if (amount <= 0n || amount % 100n !== 0n) return { ok: false, reason: "not_whole_egp" };
  const missing = target - committed;
  if (amount > missing) return { ok: false, reason: "exceeds_target" };
  if (amount < GIFT_CARD_LIMITS.minContribution && amount !== missing) return { ok: false, reason: "below_min" };
  return { ok: true };
}

export const checkTarget = (target: bigint) => checkAmount(target);

export type CloseOutcome = "stay_open" | "funded" | "unfunded";

/** Closes when funded, or at the closing date. The organiser has no withdrawal path. */
export function closeOutcome(input: { target: bigint; paid: bigint; closesAtMs: number; nowMs: number }): CloseOutcome {
  if (input.paid >= input.target) return "funded";
  return input.nowMs >= input.closesAtMs ? "unfunded" : "stay_open";
}

/** Refund plan for an unfunded pot: every paid contribution back to its own payer, nothing else. */
export function refundPlan<T extends ContributionFacts>(cs: readonly T[]): { readonly refunds: readonly T[]; readonly total: bigint } {
  const refunds = cs.filter((c) => c.status === "paid" || c.status === "refund_failed");
  return { refunds, total: refunds.reduce((s, c) => s + c.amount, 0n) };
}
