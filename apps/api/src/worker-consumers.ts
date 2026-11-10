import { CancellationRefundConsumer, PROMOTIONS_SETTLE_EVENT, PromotionsSettleConsumer, SELLER_ORDER_CANCELLED_EVENT, SELLER_ORDER_REJECTED_EVENT } from "@outlet/checkout";
import type { CancellationRefundPort, PromotionsPort } from "@outlet/checkout";
import type { RoleSqlClient } from "@outlet/db";
import { ATTENTION_KINDS, AttentionConsumer } from "@outlet/ops-attention";
import { getMarket } from "@outlet/markets-config";
import { INTEGRITY_REQUESTED_EVENT, IntegrityConsumer, IntegrityJob } from "@outlet/payouts";
import { NOTIFYING_EVENT_TYPES, NotificationDispatchConsumer } from "@outlet/notifications";
import type { Channel } from "@outlet/notifications";
import { ConsentService, RETENTION_REQUESTED_EVENT, RetentionConsumer, RetentionRunner } from "@outlet/privacy";
import { RollupConsumer, RollupService, ROLLUP_REQUESTED_EVENT } from "@outlet/reporting";
import { SHIPMENT_CANCEL_REQUIRED_EVENT, ShipmentCancelConsumer } from "@outlet/shipping";
import type { CourierPort } from "@outlet/shipping";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { InboxOutcome } from "@outlet/outbox";
import { SYNC_EVENT_TYPES, SearchSyncConsumer } from "@outlet/search";
import type { PriceDisplayLookup } from "@outlet/search";
import type { Logger } from "@outlet/logger";
import type { RetentionMetricsPort } from "@outlet/privacy";

export interface OutboxEventIn {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Source event time. Handlers that version their writes by it (search.sync) park an event that arrives without it. */
  readonly occurredAt?: string;
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

/** shipping.tracking job: cancels the courier AWB of a seller order cancelled while PACKED (M4). Courier is the configured adapter; the worker process composes UnconfiguredWorkerCourier until a contract exists, which answers not_cancellable so the event is parked as shipment.cancel_attention for ops (ADR-0016). */
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
  const c = new RollupConsumer(worker, marketId, new RollupService({ client: worker, now }), undefined, now);
  return new Map([[ROLLUP_REQUESTED_EVENT, (e: OutboxEventIn) => c.handle(e)]]);
};

/**
 * search.sync job (migration 0038): keeps search_documents in step with listing.activated / listing.updated / price.changed / inventory.sold_out /
 * inventory.restocked, inbox-deduplicated and version-guarded (older events never overwrite newer ones). Runs entirely under the `search.sync` worker
 * context; `display` must be composed on that same context (pricing reads) and fails closed to plain prices. The external engine is not touched here
 * (UnconfiguredSearchEngine by default, ADR-0029): staleness reports `search_provider_unconfigured` instead of fresh.
 */
export const searchSyncHandlers = (worker: RoleSqlClient<"outlet_worker">, marketId: string, deps: { readonly display: PriceDisplayLookup; readonly log?: Logger }): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const c = new SearchSyncConsumer(worker, marketId, deps.display, deps.log);
  return new Map(SYNC_EVENT_TYPES.map((t) => [t, (e: OutboxEventIn) => c.handle(e)]));
};

/**
 * notifications.dispatch job (migrations 0021 / 0034): plans notification_log rows for every NOTIFYING_EVENT_TYPE (order lifecycle, refund, return, store notices),
 * inbox-deduplicated, one row per recipient and channel decision (consent, preferences, kill switches and Cairo quiet hours applied by the Dispatcher). No channel
 * provider is contracted (ADR-0029): nothing is sent here, outbound rows stay `queued` with provider NULL until a sender composes `Dispatcher.runDue`.
 * `isChannelKilled` reads notifications.<channel>.enabled (ui class, fail open).
 */
export const notificationHandlers = (
  worker: RoleSqlClient<"outlet_worker">,
  marketId: string,
  deps: { readonly isChannelKilled: (channel: Channel) => Promise<boolean>; readonly log?: Logger; readonly now?: () => Date },
): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const outbox = new OutboxWriter(pgTransactionalWriter);
  const c = new NotificationDispatchConsumer(worker, marketId, {
    outbox,
    killSwitch: { isKilled: deps.isChannelKilled },
    consentFor: (db) => new ConsentService({ db, outbox }),
    ...(deps.log === undefined ? {} : { logger: deps.log }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  return new Map(NOTIFYING_EVENT_TYPES.map((t) => [t, (e: OutboxEventIn) => c.handle(e)]));
};

/**
 * privacy.retention job (migration 0040): a nightly scheduler tick (`privacy.retention_requested`) runs the retention purge of this market over the tables of
 * data_inventory.yaml (RetentionRunner). `dryRun` defaults to true: counts only, nothing is deleted until WORKER_RETENTION_DRY_RUN=false. Idempotent and
 * inbox-deduplicated; every delete is bounded by the RLS cutoff of the `privacy.retention` job.
 */
export const retentionHandlers = (
  worker: RoleSqlClient<"outlet_worker">,
  marketId: string,
  deps: { readonly dryRun?: boolean; readonly budgetMs?: number; readonly metrics?: RetentionMetricsPort; readonly log?: Logger; readonly now?: () => Date; readonly inventoryPath?: string },
): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const runner = new RetentionRunner({
    client: worker, marketId, dryRun: deps.dryRun ?? true, ...(deps.budgetMs === undefined ? {} : { budgetMs: deps.budgetMs }),
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }), ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.now === undefined ? {} : { now: deps.now }), ...(deps.inventoryPath === undefined ? {} : { inventoryPath: deps.inventoryPath }),
  });
  const c = new RetentionConsumer(worker, marketId, runner, deps.log);
  return new Map([[RETENTION_REQUESTED_EVENT, (e: OutboxEventIn) => c.handle(e)]]);
};

/**
 * finance.integrity consumer (runs under the existing `finance.reconcile` worker job, no new policy): a nightly scheduler tick (`ledger.integrity_requested`,
 * scope ledger_integrity) runs the ledger integrity scan of this market and stores the result (reconciliation_runs.details, migration 0039) that the Admin
 * dashboard tile reads. Idempotent per (market, business date), inbox-deduplicated, switch `workers.ledger.integrity.enabled` (money: fails closed).
 */
export const ledgerIntegrityHandlers = (worker: RoleSqlClient<"outlet_worker">, marketId: string, now: () => Date = () => new Date()): ReadonlyMap<string, (e: OutboxEventIn) => Promise<InboxOutcome>> => {
  const job = new IntegrityJob({ client: worker, currency: getMarket(marketId.toLowerCase()).currency, now });
  const c = new IntegrityConsumer(worker, marketId, job, now);
  return new Map([[INTEGRITY_REQUESTED_EVENT, (e: OutboxEventIn) => c.handle(e)]]);
};
