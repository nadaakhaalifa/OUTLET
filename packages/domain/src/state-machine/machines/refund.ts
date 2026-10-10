import { defineMachine, guard } from "../machine";

export const REFUND_STATES = [
  "REQUESTED",
  "LEDGER_POSTED",
  "SUBMITTED",
  "COMPLETED",
  "FAILED",
  "MANUAL_REVIEW",
  "CANCELLED",
] as const;
export type RefundState = (typeof REFUND_STATES)[number];

export const REFUND_EVENTS = [
  "POST_LEDGER",
  "CREDIT_ISSUED",
  "SUBMIT_TO_PSP",
  "PSP_CONFIRMED",
  "PSP_REJECTED",
  "RETRY",
  "ESCALATE",
  "MANUAL_TRANSFER_CONFIRMED",
  "CANCEL",
] as const;
export type RefundEvent = (typeof REFUND_EVENTS)[number];

export interface RefundContext {
  readonly attempts: number;
}

export const MAX_REFUND_ATTEMPTS = 3;

const canRetry = guard<RefundContext>("attemptsBelowMax", (c) => c.attempts < MAX_REFUND_ATTEMPTS);
const mustEscalate = guard<RefundContext>("attemptsAtMax", (c) => c.attempts >= MAX_REFUND_ATTEMPTS);

export const refundMachine = defineMachine<RefundState, RefundEvent, RefundContext>({
  name: "Refund",
  states: REFUND_STATES,
  events: REFUND_EVENTS,
  initial: "REQUESTED",
  terminal: ["COMPLETED", "CANCELLED"],
  transitions: {
    REQUESTED: { POST_LEDGER: { to: "LEDGER_POSTED" }, CANCEL: { to: "CANCELLED" } },
    LEDGER_POSTED: {
      CREDIT_ISSUED: { to: "COMPLETED" },
      SUBMIT_TO_PSP: { to: "SUBMITTED" },
    },
    SUBMITTED: {
      PSP_CONFIRMED: { to: "COMPLETED" },
      PSP_REJECTED: { to: "FAILED" },
    },
    FAILED: {
      RETRY: { to: "SUBMITTED", guard: canRetry },
      ESCALATE: { to: "MANUAL_REVIEW", guard: mustEscalate },
    },
    MANUAL_REVIEW: {
      RETRY: { to: "SUBMITTED" },
      MANUAL_TRANSFER_CONFIRMED: { to: "COMPLETED" },
    },
    COMPLETED: {},
    CANCELLED: {},
  },
});
