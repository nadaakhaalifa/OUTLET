import { createAdminAccess } from "@outlet/admin-access";
import { LateRefundConsumer, RejectedOrderInventoryRelease, SELLER_ORDER_REJECTED_EVENT } from "@outlet/checkout";
import type { RefundPort } from "@outlet/checkout";
import { contextClient } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { CHANNEL_KILL_SWITCH_NAMES } from "@outlet/notifications";
import type { Channel } from "@outlet/notifications";
import { isKillSwitchName } from "@outlet/flags";
import type { KillSwitchName } from "@outlet/flags";
import type { Logger } from "@outlet/logger";
import { COMMITTED_RELEASED_EVENT, RELEASE_REQUIRED_EVENT, ReleaseRequiredConsumer } from "@outlet/inventory";
import { ATTENTION_OPENED_EVENT } from "@outlet/ops-attention";
import type { RetentionMetricsPort } from "@outlet/privacy";
import { makeEnv } from "@outlet/pricing-integrity";
import { pricingDisplayLookup } from "@outlet/search";
import type { InboxOutcome } from "@outlet/outbox";
import { InventoryRestock, REFUNDS_KILL_SWITCH, RefundService } from "@outlet/returns";
import type { KillSwitchPort, ProviderRefundPort, ProviderRefundResult } from "@outlet/returns";
import { CourierCancelError, SHIPMENT_CANCELLED_EVENT } from "@outlet/shipping";
import type { CourierPort } from "@outlet/shipping";
import type { PriceDisplayLookup } from "@outlet/search";
import { productionPromotionsPort } from "../modules/checkout/cancellation-composition.js";
import type { PromotionsKillRead } from "../modules/checkout/cancellation-composition.js";
import { NoCategoryReturnPolicy, UnconfiguredEvidence } from "../modules/returns/index.js";
import { pgSqlClient } from "../platform/db.js";
import type { PoolLike } from "../platform/db.js";
import { Problems } from "../platform/problem.js";
import { attentionHandlers, financeRefundHandlers, ledgerIntegrityHandlers, notificationHandlers, promotionsSettleHandlers, reportingRollupHandlers, retentionHandlers, searchSyncHandlers, shipmentCancelHandlers } from "../worker-consumers.js";
import type { OutboxEventIn } from "../worker-consumers.js";

export type Handler = (e: OutboxEventIn) => Promise<InboxOutcome>;

/**
 * The ONLY place the worker names the outlet_app role (eslint rule in eslint.config.mjs, ADR-0016 section "outlet_app uses"). Every use is listed in
 * marketJobs below and in the ADR; the pool is separate and small (worker.ts, application_name worker.app).
 */
export type WorkerAppClient = RoleSqlClient<"outlet_app">;
export const workerAppClient = (pool: PoolLike): WorkerAppClient => pgSqlClient<"outlet_app">(pool);

/**
 * One inbox consumer of the worker: a status / metrics label, its kill switch and its dispatch table (event type -> handler). Several consumers may
 * own the same event type (seller_order.rejected: refund and inventory release); the runner runs all of them, each in its own inbox transaction.
 */
export interface WorkerJobDef {
  readonly name: string;
  readonly killSwitch: KillSwitchName;
  readonly handlers: ReadonlyMap<string, Handler>;
}

/** The kill switch read the worker needs (FlagService.isKilled over feature_flags on the worker pool: money switches fail closed, the others open). */
export interface KillRead {
  isKilled(name: KillSwitchName, ctx: { readonly marketId: string }): Promise<boolean>;
}

/** Relay switch: off = nothing is claimed at all. */
export const RELAY_KILL_SWITCH: KillSwitchName = "workers.outbox.relay.enabled";
export const ROLLUP_KILL_SWITCH: KillSwitchName = "workers.reporting.rollup.enabled";
export const SEARCH_SYNC_KILL_SWITCH: KillSwitchName = "workers.search.sync.enabled";
/** Nightly ledger integrity run and its scheduler tick. Money class: unreadable flag store = killed (no run), never a silent "ok". */
export const LEDGER_INTEGRITY_KILL_SWITCH: KillSwitchName = "workers.ledger.integrity.enabled";
/** Retention purge (privacy.retention): deletes rows, so the switch is fail CLOSED (flag store unreadable = killed), unlike the other workers.* ui switches. */
export const RETENTION_KILL_SWITCH: KillSwitchName = "workers.privacy.retention.enabled";
export const NOTIFICATIONS_KILL_SWITCH: KillSwitchName = "workers.notifications.dispatch.enabled";

/**
 * Event types that have no in-process consumer BY DESIGN and may be acked as published without a handler (chief review F1). Everything else with
 * no consumer is never claimed: it stays pending and shows as `unrouted` in /healthz and the worker_unrouted_pending gauge.
 * - ops.attention_opened: informational (the item row is the record); a notification consumer may subscribe later (then remove it from here).
 * - shipment.cancelled: result of ShipmentCancelConsumer; nothing downstream yet.
 * - inventory.committed_released: result of ReleaseRequiredConsumer; the replenisher reads inventory_levels, not this event.
 * - ledger.integrity_failed: informational; alerting reads the stored reconciliation run status and its exceptions, not this event (a consumer may subscribe later).
 */
export const UNSUBSCRIBED_TYPES: readonly string[] = [ATTENTION_OPENED_EVENT, SHIPMENT_CANCELLED_EVENT, COMMITTED_RELEASED_EVENT, "ledger.integrity_failed"];

/**
 * No PSP is contracted (ADR-0029): refund execution is never reached from the worker's cancellation consumer (createForCancellation only records
 * REQUESTED refunds), and if it were, it is rejected. canReverse=false is the honest "not supported" answer of an absent provider.
 */
export class UnconfiguredProviderRefunds implements ProviderRefundPort {
  canReverse(): boolean {
    return false;
  }
  refund(): Promise<ProviderRefundResult> {
    return Promise.resolve({ outcome: "rejected", code: "provider_unconfigured" });
  }
}

/**
 * No courier is contracted (V33/V43). An AWB that must be cancelled while no courier API exists needs a human at the courier: answering
 * `not_cancellable` makes ShipmentCancelConsumer park the event as `shipment.cancel_attention` (inbox row + ops queue) instead of looping to the DLQ.
 */
export class UnconfiguredWorkerCourier implements Pick<CourierPort, "cancelShipment"> {
  cancelShipment(): Promise<void> {
    return Promise.reject(new CourierCancelError("not_cancellable"));
  }
}

/** Refund execution switch for RefundService: `refunds.enabled` from the flag store (money: unreadable = killed); any other key is engaged (fail closed). */
export const refundsKill = (kill: KillRead, marketId: string): KillSwitchPort => ({
  isEngaged: (key) => (key === REFUNDS_KILL_SWITCH ? kill.isKilled("refunds.enabled", { marketId }) : Promise.resolve(true)),
});

export interface MarketJobsInput {
  readonly marketId: string;
  readonly worker: RoleSqlClient<"outlet_worker">;
  /** outlet_app, separate small pool. Uses (all listed in ADR-0016): voucher confirm, inventory release, restock port, admin-access stub. */
  readonly app: WorkerAppClient;
  readonly kill: KillRead;
  /**
   * PSP refund port for `order_group.late_payment_refund`. Undefined while no PSP is contracted: the type is then NOT routed (it stays pending and
   * visible as unrouted lag) instead of retrying a rejecting port into the DLQ.
   */
  readonly lateRefunds?: RefundPort;
  readonly now?: () => Date;
  /** privacy.retention: dryRun defaults to true (counts only; WORKER_RETENTION_DRY_RUN=false deletes). */
  readonly retention?: { readonly dryRun?: boolean; readonly budgetMs?: number; readonly metrics?: RetentionMetricsPort; readonly log?: Logger; readonly inventoryPath?: string };
}

/**
 * Display decisions (verified discount / lowest in 30 days) for the search index, read under the `search.sync` worker context (price_events, sku_price_windows
 * and the price_claims policy of migration 0038) with the Price Watch switch as the kill: killed or unreadable = plain (fail closed, same as the PDP).
 */
const searchDisplay = (i: MarketJobsInput, opts: { readonly now?: () => Date }): PriceDisplayLookup =>
  pricingDisplayLookup(makeEnv({
    client: contextClient(i.worker, { kind: "worker", marketId: i.marketId, job: "search.sync" }), marketId: i.marketId,
    killSwitch: { isKilled: () => i.kill.isKilled("pricing.price_watch.enabled", { marketId: i.marketId }).catch(() => true) }, ...opts,
  }));

/** notifications.<channel>.enabled (ui class: an unreadable store means allowed, an unknown name means killed). */
const channelKilled = (i: MarketJobsInput, channel: Channel): Promise<boolean> => {
  const name = CHANNEL_KILL_SWITCH_NAMES[channel];
  return isKillSwitchName(name) ? i.kill.isKilled(name, { marketId: i.marketId }) : Promise.resolve(true);
};

/** Every inbox consumer of the worker for one market, with its kill switch. */
export const marketJobs = (i: MarketJobsInput): readonly WorkerJobDef[] => {
  const promotionsKill: PromotionsKillRead = { isKilled: (name, ctx) => i.kill.isKilled(name, ctx) };
  const refunds = new RefundService({
    // outlet_app uses 3 (restock port: return restock only; createForCancellation does not call it) and 4 (admin-access stub below).
    app: i.app, worker: i.worker, marketId: i.marketId, policy: new NoCategoryReturnPolicy(), evidence: new UnconfiguredEvidence(), restock: new InventoryRestock(i.app, i.marketId),
    provider: new UnconfiguredProviderRefunds(),
    kill: refundsKill(i.kill, i.marketId),
    // Approvals belong to the Admin Console: an audit sink that always fails keeps them unusable from the worker.
    admin: createAdminAccess({ db: i.app, audit: { appendIn: () => Promise.reject(Problems.unavailable("audit-unconfigured")) }, clock: () => new Date(), thresholdMinor: 0n }),
  });
  const opts = i.now === undefined ? {} : { now: i.now };
  const rejectedRelease = new RejectedOrderInventoryRelease(i.worker, i.marketId, opts);
  // outlet_app use 2: the release runs in the event's store context, like ReservationService (ADR-0005); no worker policy exists for it.
  const release = new ReleaseRequiredConsumer({ client: i.app, marketId: i.marketId, ...opts });
  const jobs: WorkerJobDef[] = [
    { name: "finance.refunds", killSwitch: "workers.finance.refunds.enabled", handlers: financeRefundHandlers(i.worker, i.marketId, refunds) },
    // outlet_app use 1: voucher confirm in the shopper's user context (finding 11).
    { name: "checkout.settle", killSwitch: "workers.checkout.settle.enabled", handlers: promotionsSettleHandlers(i.worker, i.marketId, productionPromotionsPort(i.app, i.marketId, promotionsKill)) },
    { name: "shipping.tracking", killSwitch: "workers.shipping.tracking.enabled", handlers: shipmentCancelHandlers(i.worker, i.marketId, new UnconfiguredWorkerCourier()) },
    { name: "inventory.rejected_release", killSwitch: "workers.inventory.release.enabled", handlers: new Map<string, Handler>([[SELLER_ORDER_REJECTED_EVENT, (e) => rejectedRelease.handle(e)]]) },
    { name: "inventory.release", killSwitch: "workers.inventory.release.enabled", handlers: new Map<string, Handler>([[RELEASE_REQUIRED_EVENT, (e) => release.handle(e)]]) },
    { name: "ops.attention", killSwitch: "workers.ops.attention.enabled", handlers: attentionHandlers(i.worker, i.marketId) },
    { name: "reporting.rollup", killSwitch: ROLLUP_KILL_SWITCH, handlers: reportingRollupHandlers(i.worker, i.marketId, i.now) },
    // Deletes only through the `privacy.retention` RLS policies (migration 0040); dry run unless the owner flips WORKER_RETENTION_DRY_RUN.
    { name: "privacy.retention", killSwitch: RETENTION_KILL_SWITCH, handlers: retentionHandlers(i.worker, i.marketId, { ...i.retention, ...opts }) },
    { name: "finance.integrity", killSwitch: LEDGER_INTEGRITY_KILL_SWITCH, handlers: ledgerIntegrityHandlers(i.worker, i.marketId, i.now) },
    { name: "search.sync", killSwitch: SEARCH_SYNC_KILL_SWITCH, handlers: searchSyncHandlers(i.worker, i.marketId, { display: searchDisplay(i, opts) }) },
    // Plans notification_log rows only (no channel provider, ADR-0029); per-channel notifications.<channel>.enabled switches still suppress rows (fail open).
    { name: "notifications.dispatch", killSwitch: NOTIFICATIONS_KILL_SWITCH, handlers: notificationHandlers(i.worker, i.marketId, { isChannelKilled: (c) => channelKilled(i, c), ...opts }) },
  ];
  if (i.lateRefunds !== undefined) {
    const late = new LateRefundConsumer(contextClient(i.worker, { kind: "worker", marketId: i.marketId, job: "payments.webhook" }), i.lateRefunds);
    jobs.push({ name: "payments.late_refund", killSwitch: "workers.finance.refunds.enabled", handlers: new Map<string, Handler>([["order_group.late_payment_refund", (e) => late.handle(e)]]) });
  }
  return jobs;
};
