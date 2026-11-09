import { CancellationRefundConsumer, PROMOTIONS_SETTLE_EVENT, PromotionsSettleConsumer, SELLER_ORDER_CANCELLED_EVENT, SELLER_ORDER_REJECTED_EVENT } from "@outlet/checkout";
import type { CancellationRefundPort, PromotionsPort } from "@outlet/checkout";
import type { RoleSqlClient } from "@outlet/db";
import type { InboxOutcome } from "@outlet/outbox";

export interface OutboxEventIn {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** finance.refunds job: event types handled by CancellationRefundConsumer (cancel and seller rejection both end in a refund). */
export const CANCELLATION_REFUND_EVENT_TYPES: readonly string[] = [SELLER_ORDER_CANCELLED_EVENT, SELLER_ORDER_REJECTED_EVENT];

/** Dispatch table of the finance.refunds worker: event type -> handler. Register next to the returns refund consumer wherever the worker process is composed. */
export const financeRefundHandlers = (worker: RoleSqlClient<"outlet_worker">, marketId: string, refunds: CancellationRefundPort): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const c = new CancellationRefundConsumer(worker, marketId, refunds);
  return new Map(CANCELLATION_REFUND_EVENT_TYPES.map((t) => [t, (e: OutboxEventIn) => c.handle(e)]));
};

/** checkout.settle job: confirms reserved vouchers after an order is paid or COD-confirmed (at-least-once, inbox-deduplicated). */
export const promotionsSettleHandlers = (worker: RoleSqlClient<"outlet_worker">, promotions: PromotionsPort): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const c = new PromotionsSettleConsumer(worker, promotions);
  return new Map([[PROMOTIONS_SETTLE_EVENT, (e: OutboxEventIn) => c.handle(e)]]);
};
