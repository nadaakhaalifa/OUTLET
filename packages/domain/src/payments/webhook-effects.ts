import { paymentIntentMachine, refundEventFor, type PaymentIntentEvent, type PaymentIntentStatus } from "./intent-machine";

export const NORMALIZED_EVENT_KINDS = [
  "payment.requires_action",
  "payment.authorized",
  "payment.succeeded",
  "payment.failed",
  "payment.voided",
  "refund.succeeded",
  "refund.failed",
] as const;
export type NormalizedEventKind = (typeof NORMALIZED_EVENT_KINDS)[number];

/** Provider-independent shape produced by an adapter's `parseWebhook`. Amounts are piastres. */
export interface NormalizedPaymentEvent {
  readonly eventId: string;
  readonly kind: NormalizedEventKind;
  readonly providerRef: string | null;
  readonly orderGroupId: string | null;
  readonly amount: bigint;
  readonly currency: string;
  readonly occurredAtMs: number;
  readonly failureCode: string | null;
  readonly providerRefundRef: string | null;
}

export interface IntentView {
  readonly id: string;
  readonly orderGroupId: string;
  readonly status: PaymentIntentStatus;
  readonly amount: bigint;
  readonly currency: string;
  readonly refundedAmount: bigint;
  readonly provider: string;
  readonly method: string;
}

export const ANOMALIES = [
  "late_success",
  "conflicting_terminal",
  "amount_mismatch",
  "currency_mismatch",
  "unknown_intent",
  "unknown_refund",
  "pan_in_webhook",
  "refund_exceeds_captured",
] as const;
export type AnomalyKind = (typeof ANOMALIES)[number];

export type PaymentDomainEvent =
  | { readonly type: "payment.authorized"; readonly intentId: string; readonly orderGroupId: string; readonly amount: bigint; readonly currency: string }
  | {
      readonly type: "payment.succeeded";
      readonly intentId: string;
      readonly orderGroupId: string;
      readonly amount: bigint;
      readonly currency: string;
      readonly provider: string;
      readonly method: string;
      readonly providerRef: string | null;
    }
  | { readonly type: "payment.failed"; readonly intentId: string; readonly orderGroupId: string; readonly reason: string }
  | { readonly type: "payment.voided"; readonly intentId: string; readonly orderGroupId: string }
  | {
      readonly type: "payment.refunded";
      readonly intentId: string;
      readonly orderGroupId: string;
      readonly refundId: string;
      readonly refundAmount: bigint;
      readonly totalRefunded: bigint;
      readonly currency: string;
      readonly full: boolean;
    }
  | { readonly type: "payment.refund_failed"; readonly intentId: string; readonly orderGroupId: string; readonly refundId: string; readonly reason: string }
  | {
      readonly type: "payment.anomaly";
      readonly intentId: string | null;
      readonly orderGroupId: string | null;
      readonly anomaly: AnomalyKind;
      readonly detail: string;
    };

export type EffectDecision =
  | {
      readonly kind: "transition";
      readonly to: PaymentIntentStatus;
      readonly failureCode: string | null;
      readonly events: readonly PaymentDomainEvent[];
    }
  | { readonly kind: "noop"; readonly reason: "stale" | "duplicate" }
  | { readonly kind: "anomaly"; readonly anomaly: AnomalyKind; readonly events: readonly PaymentDomainEvent[] };

const EVENT_FOR: Readonly<Partial<Record<NormalizedEventKind, PaymentIntentEvent>>> = {
  "payment.requires_action": "REQUIRE_ACTION",
  "payment.authorized": "AUTHORIZE",
  "payment.succeeded": "SUCCEED",
  "payment.failed": "FAIL",
  "payment.voided": "VOID",
};

/** Progress rank, used to tell "behind where we already are" (stale) from a real conflict. */
const RANK: Readonly<Record<PaymentIntentStatus, number>> = {
  CREATED: 0,
  REQUIRES_ACTION: 1,
  AUTHORIZED: 2,
  SUCCEEDED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
  FAILED: 3,
  VOIDED: 3,
};

const anomaly = (a: AnomalyKind, i: IntentView, detail: string): EffectDecision => ({
  kind: "anomaly",
  anomaly: a,
  events: [{ type: "payment.anomaly", intentId: i.id, orderGroupId: i.orderGroupId, anomaly: a, detail }],
});

/**
 * Pure decision for one verified provider event against the locked intent. Never throws for
 * provider-caused conditions: a conflicting message must not move money state (spec 7 failure
 * handling) and must not make the consumer retry forever.
 *
 * Refund events are not decided here: a refund is settled through the refund record (the store
 * correlates by provider refund ref), see `PaymentStore.settleRefund`.
 */
export function decideWebhookEffect(intent: IntentView, ev: NormalizedPaymentEvent): EffectDecision {
  const machineEvent = EVENT_FOR[ev.kind];
  if (machineEvent === undefined) {
    return anomaly("unknown_refund", intent, `event ${ev.kind} is settled through refund records`);
  }
  if (ev.kind === "payment.succeeded" || ev.kind === "payment.authorized") {
    if (ev.currency !== intent.currency) return anomaly("currency_mismatch", intent, `${ev.currency} != ${intent.currency}`);
    if (ev.amount !== intent.amount) return anomaly("amount_mismatch", intent, `${ev.amount} != ${intent.amount}`);
  }
  const ctx = { amount: intent.amount, refunded: intent.refundedAmount, refundAmount: 0n };
  if (paymentIntentMachine.can(intent.status, machineEvent, ctx)) {
    const to = paymentIntentMachine.transition(intent.status, machineEvent, ctx);
    return { kind: "transition", to, failureCode: ev.kind === "payment.failed" ? (ev.failureCode ?? "unknown") : null, events: eventsFor(intent, to, ev) };
  }
  if (intent.status === targetOf(machineEvent)) return { kind: "noop", reason: "duplicate" };
  // Success after the intent was failed or voided: money was taken that checkout no longer expects.
  if (machineEvent === "SUCCEED" && (intent.status === "FAILED" || intent.status === "VOIDED")) {
    return anomaly("late_success", intent, `succeeded event while ${intent.status}`);
  }
  // Failure or void after money was captured.
  if ((machineEvent === "FAIL" || machineEvent === "VOID") && RANK[intent.status] >= RANK.SUCCEEDED && intent.status !== "FAILED" && intent.status !== "VOIDED") {
    return anomaly("conflicting_terminal", intent, `${ev.kind} while ${intent.status}`);
  }
  return { kind: "noop", reason: "stale" };
}

function targetOf(e: PaymentIntentEvent): PaymentIntentStatus | null {
  switch (e) {
    case "REQUIRE_ACTION":
      return "REQUIRES_ACTION";
    case "AUTHORIZE":
      return "AUTHORIZED";
    case "SUCCEED":
      return "SUCCEEDED";
    case "FAIL":
      return "FAILED";
    case "VOID":
      return "VOIDED";
    default:
      return null;
  }
}

function eventsFor(i: IntentView, to: PaymentIntentStatus, ev: NormalizedPaymentEvent): PaymentDomainEvent[] {
  switch (to) {
    case "AUTHORIZED":
      return [{ type: "payment.authorized", intentId: i.id, orderGroupId: i.orderGroupId, amount: i.amount, currency: i.currency }];
    case "SUCCEEDED":
      return [
        {
          type: "payment.succeeded",
          intentId: i.id,
          orderGroupId: i.orderGroupId,
          amount: i.amount,
          currency: i.currency,
          provider: i.provider,
          method: i.method,
          providerRef: ev.providerRef,
        },
      ];
    case "FAILED":
      return [{ type: "payment.failed", intentId: i.id, orderGroupId: i.orderGroupId, reason: ev.failureCode ?? "unknown" }];
    case "VOIDED":
      return [{ type: "payment.voided", intentId: i.id, orderGroupId: i.orderGroupId }];
    default:
      return [];
  }
}

/** Decision for applying a confirmed refund of `refundAmount` to an intent. Pure. */
export type RefundDecision =
  | { readonly kind: "apply"; readonly to: PaymentIntentStatus; readonly totalRefunded: bigint; readonly full: boolean }
  | { readonly kind: "reject"; readonly anomaly: AnomalyKind };

export function decideRefundApplication(i: Pick<IntentView, "status" | "amount" | "refundedAmount">, refundAmount: bigint): RefundDecision {
  const ev = refundEventFor({ amount: i.amount, refunded: i.refundedAmount, refundAmount });
  if (ev === null) return { kind: "reject", anomaly: "refund_exceeds_captured" };
  const ctx = { amount: i.amount, refunded: i.refundedAmount, refundAmount };
  if (!paymentIntentMachine.can(i.status, ev, ctx)) return { kind: "reject", anomaly: "refund_exceeds_captured" };
  return {
    kind: "apply",
    to: paymentIntentMachine.transition(i.status, ev, ctx),
    totalRefunded: i.refundedAmount + refundAmount,
    full: ev === "REFUND_FULL",
  };
}
