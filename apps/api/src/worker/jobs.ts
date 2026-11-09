import { createAdminAccess } from "@outlet/admin-access";
import type { WorkerJob } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import type { KillSwitchName } from "@outlet/flags";
import type { InboxOutcome } from "@outlet/outbox";
import { InventoryRestock, REFUNDS_KILL_SWITCH, RefundService } from "@outlet/returns";
import type { KillSwitchPort, ProviderRefundPort, ProviderRefundResult } from "@outlet/returns";
import { CourierCancelError } from "@outlet/shipping";
import type { CourierPort } from "@outlet/shipping";
import { productionPromotionsPort } from "../modules/checkout/cancellation-composition.js";
import type { PromotionsKillRead } from "../modules/checkout/cancellation-composition.js";
import { NoCategoryReturnPolicy, UnconfiguredEvidence } from "../modules/returns/index.js";
import { Problems } from "../platform/problem.js";
import { attentionHandlers, financeRefundHandlers, promotionsSettleHandlers, reportingRollupHandlers, shipmentCancelHandlers } from "../worker-consumers.js";
import type { OutboxEventIn } from "../worker-consumers.js";

export type Handler = (e: OutboxEventIn) => Promise<InboxOutcome>;

/** One inbox consumer group of the worker: its DB job, its kill switch and its dispatch table (event type -> handler). */
export interface WorkerJobDef {
  readonly job: WorkerJob;
  readonly killSwitch: KillSwitchName;
  readonly handlers: ReadonlyMap<string, Handler>;
}

/** The kill switch read the worker needs (FlagService.isKilled: money switches fail closed, the others open). */
export interface KillRead {
  isKilled(name: KillSwitchName, ctx: { readonly marketId: string }): Promise<boolean>;
}

/** Relay switch: off = nothing is claimed at all. */
export const RELAY_KILL_SWITCH: KillSwitchName = "workers.outbox.relay.enabled";
export const ROLLUP_KILL_SWITCH: KillSwitchName = "workers.reporting.rollup.enabled";

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
  /** outlet_app: voucher confirm in the shopper's user context (finding 11) and the inventory restock port of the refund service. */
  readonly app: RoleSqlClient<"outlet_app">;
  readonly kill: KillRead;
  readonly now?: () => Date;
}

/**
 * Every dispatch table of worker-consumers.ts for one market, each with its job and kill switch. Throws when two jobs claim the same event type
 * (one event type has exactly one in-process consumer, so a kill switch maps cleanly to the types it holds back).
 */
export const marketJobs = (i: MarketJobsInput): readonly WorkerJobDef[] => {
  const promotionsKill: PromotionsKillRead = { isKilled: (name, ctx) => i.kill.isKilled(name, ctx) };
  const refunds = new RefundService({
    app: i.app, worker: i.worker, marketId: i.marketId, policy: new NoCategoryReturnPolicy(), evidence: new UnconfiguredEvidence(), restock: new InventoryRestock(i.app, i.marketId),
    provider: new UnconfiguredProviderRefunds(),
    // Refund execution fails closed on an unreadable switch (money); createForCancellation itself does not read it.
    kill: refundsKill(i.kill, i.marketId),
    // Approvals belong to the Admin Console: an audit sink that always fails keeps them unusable from the worker.
    admin: createAdminAccess({ db: i.app, audit: { appendIn: () => Promise.reject(Problems.unavailable("audit-unconfigured")) }, clock: () => new Date(), thresholdMinor: 0n }),
  });
  const jobs: WorkerJobDef[] = [
    { job: "finance.refunds", killSwitch: "workers.finance.refunds.enabled", handlers: financeRefundHandlers(i.worker, i.marketId, refunds) },
    { job: "checkout.settle", killSwitch: "workers.checkout.settle.enabled", handlers: promotionsSettleHandlers(i.worker, i.marketId, productionPromotionsPort(i.app, i.marketId, promotionsKill)) },
    { job: "shipping.tracking", killSwitch: "workers.shipping.tracking.enabled", handlers: shipmentCancelHandlers(i.worker, i.marketId, new UnconfiguredWorkerCourier()) },
    { job: "ops.attention", killSwitch: "workers.ops.attention.enabled", handlers: attentionHandlers(i.worker, i.marketId) },
    { job: "reporting.rollup", killSwitch: ROLLUP_KILL_SWITCH, handlers: reportingRollupHandlers(i.worker, i.marketId, i.now) },
  ];
  assertDisjoint(jobs);
  return jobs;
};

export const assertDisjoint = (jobs: readonly WorkerJobDef[]): void => {
  const owner = new Map<string, string>();
  for (const j of jobs) {
    for (const t of j.handlers.keys()) {
      const prev = owner.get(t);
      if (prev !== undefined) throw new Error(`event type ${t} is registered by ${prev} and ${j.job}`);
      owner.set(t, j.job);
    }
  }
};
