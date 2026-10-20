import type {
  ClaimOutcome,
  LevelView,
  ReleaseOutcome,
  ReleaseReason,
  UnclaimOutcome,
  ReserveOutcome,
  ReservePlan,
  SweepResult,
  SyncCommand,
  SyncOutcome,
  TransferCommand,
  TransferOutcome,
  TtlPolicy,
} from "./core";

/** Where a SKU's stock lives and which store owns it. Owned by the catalog module in production. */
export interface SkuLocation {
  readonly storeId: string;
  readonly locationId: string;
  /** Set for drop SKUs. */
  readonly dropId: string | null;
}

export interface SkuDirectory {
  lookup(skuId: string): Promise<SkuLocation | null>;
}

export interface PoolIds {
  readonly standard: string;
  readonly fawry: string;
  readonly drops: ReadonlyMap<string, string>;
}

export interface ReserveCommand {
  readonly reservationId: string;
  readonly orderGroupId: string;
  readonly userId: string;
  readonly plan: ReservePlan;
  readonly nowMs: number;
}

/**
 * Persistence port. Every method is one atomic unit of work: the adapter owns the transaction,
 * because the stock invariants are only as strong as the transaction that enforces them.
 */
export interface InventoryStore {
  ttlPolicies(nowMs: number): Promise<readonly TtlPolicy[]>;
  poolIds(dropIds: readonly string[]): Promise<PoolIds>;
  reserve(cmd: ReserveCommand): Promise<ReserveOutcome>;
  claim(orderGroupId: string, nowMs: number): Promise<ClaimOutcome>;
  release(orderGroupId: string, reason: ReleaseReason, nowMs: number): Promise<ReleaseOutcome>;
  /** R-2: returns CLAIMED stock for a group whose orders will never be placed. Idempotent. */
  unclaim(orderGroupId: string, reason: ReleaseReason, nowMs: number): Promise<UnclaimOutcome>;
  sweepExpired(nowMs: number, batch: number): Promise<SweepResult>;
  /** Tops up and trims pools that drifted. Returns the number of pools examined. */
  replenishDue(limit: number): Promise<number>;
  applySync(cmd: SyncCommand): Promise<SyncOutcome>;
  transfer(cmd: TransferCommand): Promise<TransferOutcome>;
  levelView(skuId: string, locationId: string, poolId: string): Promise<LevelView | null>;
}

export interface ClockPort {
  nowMs(): number;
}

export interface IdPort {
  /** Time ordered id for a new aggregate. */
  newId(): string;
}
