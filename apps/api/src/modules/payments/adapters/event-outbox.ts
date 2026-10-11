import type { PaymentDomainEvent } from "../domain/seam";

export type PayloadValue = string | number | boolean | null;

/** One outbox row to write in the same transaction as the state change (spec A2.7). */
export interface OutboxDraft {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Record<string, PayloadValue>>;
}

/**
 * Domain event to outbox row. Payloads carry ids, amounts as decimal strings and codes only: no
 * card data, no raw bodies, no PII (spec 7, B8). `fallbackAggregateId` is used by events that have
 * neither an intent nor an order group (an anomaly for an unknown reference).
 */
export function toDraft(
  e: PaymentDomainEvent,
  ids: () => string,
  occurredAtMs: number,
  fallbackAggregateId: string,
): OutboxDraft {
  const base = { id: ids(), occurredAtMs, aggregateType: "payment_intent" as const };
  switch (e.type) {
    case "payment.authorized":
      return {
        ...base,
        type: e.type,
        aggregateId: e.intentId,
        payload: { intent_id: e.intentId, order_group_id: e.orderGroupId, amount: e.amount.toString(), currency: e.currency },
      };
    case "payment.succeeded":
      return {
        ...base,
        type: e.type,
        aggregateId: e.intentId,
        payload: {
          intent_id: e.intentId,
          order_group_id: e.orderGroupId,
          amount: e.amount.toString(),
          currency: e.currency,
          provider: e.provider,
          method: e.method,
          provider_ref: e.providerRef,
        },
      };
    case "payment.failed":
      return {
        ...base,
        type: e.type,
        aggregateId: e.intentId,
        payload: { intent_id: e.intentId, order_group_id: e.orderGroupId, reason: e.reason },
      };
    case "payment.voided":
      return { ...base, type: e.type, aggregateId: e.intentId, payload: { intent_id: e.intentId, order_group_id: e.orderGroupId } };
    case "payment.refunded":
      return {
        ...base,
        type: e.type,
        aggregateId: e.intentId,
        payload: {
          intent_id: e.intentId,
          order_group_id: e.orderGroupId,
          refund_id: e.refundId,
          refund_amount: e.refundAmount.toString(),
          total_refunded: e.totalRefunded.toString(),
          currency: e.currency,
          full: e.full,
        },
      };
    case "payment.refund_failed":
      return {
        ...base,
        type: e.type,
        aggregateId: e.intentId,
        payload: { intent_id: e.intentId, order_group_id: e.orderGroupId, refund_id: e.refundId, reason: e.reason },
      };
    case "payment.anomaly":
      return {
        ...base,
        type: e.type,
        aggregateId: e.intentId ?? e.orderGroupId ?? fallbackAggregateId,
        payload: { intent_id: e.intentId, order_group_id: e.orderGroupId, anomaly: e.anomaly, detail: e.detail.slice(0, 200) },
      };
  }
}

export const draftsFor = (
  events: readonly PaymentDomainEvent[],
  ids: () => string,
  occurredAtMs: number,
  fallbackAggregateId: string,
): OutboxDraft[] => events.map((e) => toDraft(e, ids, occurredAtMs, fallbackAggregateId));
