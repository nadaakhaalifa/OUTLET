import { CancellationRefundConsumer, PROMOTIONS_SETTLE_EVENT, PromotionsSettleConsumer, SELLER_ORDER_CANCELLED_EVENT, SELLER_ORDER_REJECTED_EVENT } from "@outlet/checkout";
import type { CancellationRefundPort, PromotionsPort } from "@outlet/checkout";
import type { RoleSqlClient } from "@outlet/db";
import { ATTENTION_KINDS, AttentionConsumer } from "@outlet/ops-attention";
import { RollupConsumer, RollupService, ROLLUP_REQUESTED_EVENT } from "@outlet/reporting";
import { SHIPMENT_CANCEL_REQUIRED_EVENT, ShipmentCancelConsumer } from "@outlet/shipping";
import type { CourierPort } from "@outlet/shipping";
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

/**
 * checkout.settle job: confirms reserved vouchers after an order is paid or COD-confirmed (at-least-once, inbox-deduplicated). The inbox and
 * the attention event run on `worker` (job checkout.settle); `promotions` MUST be composed on the outlet_app pool (makePromotionsPort): the
 * voucher confirm runs in the shopper's user context and outlet_worker has no promotions grant (finding 11).
 */
export const promotionsSettleHandlers = (worker: RoleSqlClient<"outlet_worker">, marketId: string, promotions: Pick<PromotionsPort, "confirm">): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const c = new PromotionsSettleConsumer(worker, marketId, promotions);
  return new Map([[PROMOTIONS_SETTLE_EVENT, (e: OutboxEventIn) => c.handle(e)]]);
};

/** shipping.tracking job: cancels the courier AWB of a seller order cancelled while PACKED (M4). Courier is the configured adapter (Unconfigured fails closed: the event is redelivered until a courier exists). */
export const shipmentCancelHandlers = (worker: RoleSqlClient<"outlet_worker">, marketId: string, courier: Pick<CourierPort, "cancelShipment">): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const c = new ShipmentCancelConsumer({ client: worker, marketId, courier });
  return new Map([[SHIPMENT_CANCEL_REQUIRED_EVENT, (e: OutboxEventIn) => c.handle(e)]]);
};

/** ops.attention job: queues the `*.attention` events the money and cancellation workers park (refund, voucher settlement, shipment cancel) for ops (migration 0033). */
export const attentionHandlers = (worker: RoleSqlClient<"outlet_worker">, marketId: string): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const c = new AttentionConsumer(worker, marketId);
  return new Map(ATTENTION_KINDS.map((t) => [t, (e: OutboxEventIn) => c.handle(e)]));
};

/**
 * reporting.rollup job: a scheduler tick (`reporting.rollup_requested`, scope sales | nightly | snapshots) recomputes the admin dashboard rollups of this market
 * (migration 0035): sales every 5 minutes (last 3 days), snapshots every 60 seconds, nightly 90 days. Idempotent and inbox-deduplicated; the tick source (cron) is composed with the worker process.
 */
export const reportingRollupHandlers = (worker: RoleSqlClient<"outlet_worker">, marketId: string, now: () => Date = () => new Date()): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const c = new RollupConsumer(worker, marketId, new RollupService({ client: worker, now }));
  return new Map([[ROLLUP_REQUESTED_EVENT, (e: OutboxEventIn) => c.handle(e)]]);
};
