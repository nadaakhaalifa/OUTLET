import type { Machine } from "@outlet/orders";

/**
 * Payout state machine (master prompt T4: SCHEDULED -> ON_HOLD -> APPROVED -> SENT -> SETTLED | FAILED).
 * FAILED is transient: a failed payout is reversed in the ledger and parked ON_HOLD for review (`park`).
 * The SQL CHECK in migration 0018 must list exactly PAYOUT_STATES (asserted by a test).
 */
export const PAYOUT_STATES = ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED", "CANCELLED"] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];
export const PAYOUT_EVENTS = ["approve", "hold", "release", "send", "settle", "fail", "park", "cancel"] as const;
export type PayoutEvent = (typeof PAYOUT_EVENTS)[number];

export const PAYOUT: Machine<PayoutState, PayoutEvent> = {
  name: "payout",
  initial: "SCHEDULED",
  states: PAYOUT_STATES,
  events: PAYOUT_EVENTS,
  terminal: ["SETTLED", "CANCELLED"],
  table: {
    SCHEDULED: { approve: "APPROVED", hold: "ON_HOLD", cancel: "CANCELLED" },
    // A released payout must be approved again: the approval is bound to the state the reviewer saw.
    ON_HOLD: { release: "SCHEDULED", cancel: "CANCELLED" },
    APPROVED: { send: "SENT", hold: "ON_HOLD", cancel: "CANCELLED" },
    SENT: { settle: "SETTLED", fail: "FAILED" },
    FAILED: { park: "ON_HOLD" },
    SETTLED: {},
    CANCELLED: {},
  },
};

/** States in which the accruals are claimed by the payout but the money has not left seller_available. */
export const PRE_SEND_STATES: readonly PayoutState[] = ["SCHEDULED", "ON_HOLD", "APPROVED", "FAILED"];
