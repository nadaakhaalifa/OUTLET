import { defineMachine, guard } from "../machine";

export const PAYOUT_STATES = [
  "SCHEDULED",
  "ON_HOLD",
  "APPROVED",
  "SENT",
  "SETTLED",
  "FAILED",
  "CANCELLED",
] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

export const PAYOUT_EVENTS = [
  "RISK_HOLD",
  "APPROVE",
  "SEND",
  "BANK_CONFIRMED",
  "BANK_REJECTED",
  "RESCHEDULE",
  "CANCEL",
] as const;
export type PayoutEvent = (typeof PAYOUT_EVENTS)[number];

export interface PayoutContext {
  /** Dual approval satisfied where the amount is above the configured threshold. */
  readonly approvalRequirementMet: boolean;
  /** No open dispute on any included line (spec T4 eligibility). */
  readonly noOpenDispute: boolean;
  /** IBAN account-holder name matched the seller legal name. */
  readonly ibanNameMatched: boolean;
}

const approvable = guard<PayoutContext>(
  "approvalRequirementMetAndNoOpenDispute",
  (c) => c.approvalRequirementMet && c.noOpenDispute,
);
const sendable = guard<PayoutContext>("ibanNameMatched", (c) => c.ibanNameMatched);

export const payoutMachine = defineMachine<PayoutState, PayoutEvent, PayoutContext>({
  name: "Payout",
  states: PAYOUT_STATES,
  events: PAYOUT_EVENTS,
  initial: "SCHEDULED",
  terminal: ["SETTLED", "CANCELLED"],
  transitions: {
    SCHEDULED: {
      RISK_HOLD: { to: "ON_HOLD" },
      APPROVE: { to: "APPROVED", guard: approvable },
      CANCEL: { to: "CANCELLED" },
    },
    ON_HOLD: {
      APPROVE: { to: "APPROVED", guard: approvable },
      CANCEL: { to: "CANCELLED" },
    },
    APPROVED: {
      RISK_HOLD: { to: "ON_HOLD" },
      SEND: { to: "SENT", guard: sendable },
      CANCEL: { to: "CANCELLED" },
    },
    SENT: {
      BANK_CONFIRMED: { to: "SETTLED" },
      BANK_REJECTED: { to: "FAILED" },
    },
    FAILED: {
      RESCHEDULE: { to: "SCHEDULED" },
      CANCEL: { to: "CANCELLED" },
    },
    SETTLED: {},
    CANCELLED: {},
  },
});
