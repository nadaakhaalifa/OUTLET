import { defineMachine, guard } from "../state-machine/machine";

export const PAYMENT_INTENT_STATES = [
  "CREATED",
  "REQUIRES_ACTION",
  "AUTHORIZED",
  "SUCCEEDED",
  "FAILED",
  "VOIDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATES)[number];

export const PAYMENT_INTENT_EVENTS = [
  "REQUIRE_ACTION",
  "AUTHORIZE",
  "SUCCEED",
  "FAIL",
  "VOID",
  "REFUND_PARTIAL",
  "REFUND_FULL",
] as const;
export type PaymentIntentEvent = (typeof PAYMENT_INTENT_EVENTS)[number];

/** Amounts in integer piastres. `refundAmount` is the refund being applied by this event. */
export interface RefundContext {
  readonly amount: bigint;
  readonly refunded: bigint;
  readonly refundAmount: bigint;
}

const partialOk = guard<RefundContext>(
  "refundBelowCaptured",
  (c) => c.refundAmount > 0n && c.refunded >= 0n && c.refunded + c.refundAmount < c.amount,
);
const fullOk = guard<RefundContext>(
  "refundEqualsCaptured",
  (c) => c.refundAmount > 0n && c.refunded >= 0n && c.refunded + c.refundAmount === c.amount,
);

export const paymentIntentMachine = defineMachine<PaymentIntentStatus, PaymentIntentEvent, RefundContext>({
  name: "PaymentIntent",
  states: PAYMENT_INTENT_STATES,
  events: PAYMENT_INTENT_EVENTS,
  initial: "CREATED",
  terminal: ["FAILED", "VOIDED", "REFUNDED"],
  transitions: {
    CREATED: {
      REQUIRE_ACTION: { to: "REQUIRES_ACTION" },
      AUTHORIZE: { to: "AUTHORIZED" },
      SUCCEED: { to: "SUCCEEDED" },
      FAIL: { to: "FAILED" },
      VOID: { to: "VOIDED" },
    },
    REQUIRES_ACTION: {
      AUTHORIZE: { to: "AUTHORIZED" },
      SUCCEED: { to: "SUCCEEDED" },
      FAIL: { to: "FAILED" },
      VOID: { to: "VOIDED" },
    },
    AUTHORIZED: {
      SUCCEED: { to: "SUCCEEDED" },
      FAIL: { to: "FAILED" },
      VOID: { to: "VOIDED" },
    },
    SUCCEEDED: {
      REFUND_PARTIAL: { to: "PARTIALLY_REFUNDED", guard: partialOk },
      REFUND_FULL: { to: "REFUNDED", guard: fullOk },
    },
    PARTIALLY_REFUNDED: {
      REFUND_PARTIAL: { to: "PARTIALLY_REFUNDED", guard: partialOk },
      REFUND_FULL: { to: "REFUNDED", guard: fullOk },
    },
    FAILED: {},
    VOIDED: {},
    REFUNDED: {},
  },
});

/** The refund event that applies `refundAmount` to a captured `amount`, or null when it would over-refund. */
export function refundEventFor(ctx: RefundContext): "REFUND_PARTIAL" | "REFUND_FULL" | null {
  if (ctx.refundAmount <= 0n || ctx.refunded < 0n) return null;
  const total = ctx.refunded + ctx.refundAmount;
  if (total > ctx.amount) return null;
  return total === ctx.amount ? "REFUND_FULL" : "REFUND_PARTIAL";
}

/** Statuses from which money has been captured (refundable). */
export const CAPTURED_STATUSES: readonly PaymentIntentStatus[] = ["SUCCEEDED", "PARTIALLY_REFUNDED"];
