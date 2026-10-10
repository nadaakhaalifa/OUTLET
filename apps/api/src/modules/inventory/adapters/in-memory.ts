import {
  DEFAULT_TTL_POLICIES,
  StockModel,
  type ClaimOutcome,
  type InventoryEvent,
  type LevelView,
  type ReleaseOutcome,
  type ReleaseReason,
  type ReserveOutcome,
  type SweepResult,
  type SyncCommand,
  type SyncOutcome,
  type TransferCommand,
  type TransferOutcome,
  type TtlPolicy,
} from "../domain/core";
import type { InventoryStore, PoolIds, ReserveCommand, SkuDirectory, SkuLocation } from "../domain/ports";

/** Fixed ids shared with migration 0016 (stock_pools seed). */
export const STANDARD_POOL_ID = "00000000-0000-4000-8000-000000000501";
export const FAWRY_POOL_ID = "00000000-0000-4000-8000-000000000502";

/**
 * DEVELOPMENT FIXTURE. Backs the port with the pure reference model, so it is exactly as correct
 * as the model and offers NO cross-process durability or concurrency. It is not a stand-in for
 * the Postgres adapter's locking behaviour.
 */
export class InMemoryInventoryStore implements InventoryStore {
  readonly model: StockModel;
  private readonly dropPools = new Map<string, string>();

  constructor(
    newUnitId: () => string,
    private readonly policies: readonly TtlPolicy[] = DEFAULT_TTL_POLICIES,
    poolCap?: number,
  ) {
    this.model = new StockModel({ newUnitId, fawryPoolId: FAWRY_POOL_ID, ...(poolCap === undefined ? {} : { poolCap }) });
  }

  registerDropPool(dropId: string, poolId: string): void {
    this.dropPools.set(dropId, poolId);
  }

  get events(): readonly InventoryEvent[] {
    return this.model.events;
  }

  async ttlPolicies(): Promise<readonly TtlPolicy[]> {
    return this.policies;
  }

  async poolIds(dropIds: readonly string[]): Promise<PoolIds> {
    const drops = new Map<string, string>();
    for (const d of dropIds) {
      const p = this.dropPools.get(d);
      if (p !== undefined) drops.set(d, p);
    }
    return { standard: STANDARD_POOL_ID, fawry: FAWRY_POOL_ID, drops };
  }

  async reserve(cmd: ReserveCommand): Promise<ReserveOutcome> {
    return this.model.reserve(cmd);
  }

  async claim(orderGroupId: string, nowMs: number): Promise<ClaimOutcome> {
    return this.model.claim(orderGroupId, nowMs);
  }

  async release(orderGroupId: string, reason: ReleaseReason, nowMs: number): Promise<ReleaseOutcome> {
    return this.model.release(orderGroupId, reason, nowMs);
  }

  async sweepExpired(nowMs: number, batch: number): Promise<SweepResult> {
    return this.model.sweepExpired(nowMs, batch);
  }

  async replenishDue(): Promise<number> {
    return 0;
  }

  async applySync(cmd: SyncCommand): Promise<SyncOutcome> {
    return this.model.applySync(cmd);
  }

  async transfer(cmd: TransferCommand): Promise<TransferOutcome> {
    return this.model.transferBetweenPools(cmd);
  }

  async levelView(skuId: string, locationId: string, poolId: string): Promise<LevelView | null> {
    return this.model.level(skuId, locationId, poolId);
  }
}

/** DEVELOPMENT FIXTURE. Real ownership comes from the catalog module. */
export class InMemorySkuDirectory implements SkuDirectory {
  private readonly skus = new Map<string, SkuLocation>();

  register(skuId: string, location: SkuLocation): void {
    this.skus.set(skuId, location);
  }

  async lookup(skuId: string): Promise<SkuLocation | null> {
    return this.skus.get(skuId) ?? null;
  }
}
