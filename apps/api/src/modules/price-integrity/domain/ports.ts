import type {
  EnforcementAction,
  ExternalEvidence,
  PriceEvent,
  PriceEventSource,
  PriceStatus,
  ViolationKind,
} from "./domain";

export class PriceEventConflictError extends Error {
  override readonly name = "PriceEventConflictError";
  constructor(readonly code: "store_mismatch" | "out_of_order" | "idempotency_conflict", message: string) {
    super(message);
  }
}

export interface NewPriceEvent {
  readonly id: string;
  readonly skuId: string;
  readonly storeId: string;
  /** Integer piastres, > 0. */
  readonly priceAmount: bigint;
  readonly validFromMs: number;
  readonly source: PriceEventSource;
  readonly actorId: string | null;
  /** Unique per SKU: a replay with the same key and payload is a no-op. */
  readonly idempotencyKey: string;
}

/** Append-only. There is no update or delete anywhere in this port, by design. */
export interface PriceEventStore {
  /**
   * `created: false` is an idempotent replay (same key, same payload). Rejects with
   * PriceEventConflictError for another store's SKU, a back-dated event, or a reused key with
   * a different payload.
   */
  append(e: NewPriceEvent): Promise<{ readonly event: PriceEvent; readonly created: boolean }>;
  history(skuId: string): Promise<readonly PriceEvent[]>;
  historyMany(skuIds: readonly string[]): Promise<ReadonlyMap<string, readonly PriceEvent[]>>;
  /** Owning store of a SKU that has price history, else null. */
  storeOf(skuId: string): Promise<string | null>;
}

/** Crawler / channel evidence. Phase 1 ships an empty implementation; absent entries mean "none". */
export interface ExternalEvidencePort {
  lookup(skuIds: readonly string[]): Promise<ReadonlyMap<string, ExternalEvidence>>;
}

export interface ClaimRecord {
  /** Deterministic from (sku, status, reference, price, run start). */
  readonly id: string;
  readonly skuId: string;
  readonly storeId: string;
  readonly status: PriceStatus;
  readonly priceAmount: bigint;
  readonly vrpAmount: bigint | null;
  readonly discountPct: number | null;
  readonly evidenceIds: readonly string[];
  readonly reason: string | null;
  readonly computedAtMs: number;
}

export interface ClaimStats {
  readonly evaluated: number;
  readonly verified: number;
}

export interface ClaimStore {
  /** True when newly stored, false when the claim id already existed. */
  record(claim: ClaimRecord): Promise<boolean>;
  statsSince(storeId: string, sinceMs: number): Promise<ClaimStats>;
}

export interface EnforcementRecord {
  readonly id: string;
  readonly storeId: string;
  readonly skuId: string | null;
  readonly kind: ViolationKind;
  readonly actions: readonly EnforcementAction[];
  readonly violationsInWindow: number;
  readonly dedupeKey: string;
  readonly openedAtMs: number;
  readonly resolvedAtMs: number | null;
}

export interface EnforcementStore {
  /** False when `dedupeKey` was already recorded (idempotent). */
  record(r: EnforcementRecord): Promise<boolean>;
  countSince(storeId: string, sinceMs: number): Promise<number>;
  countKindSince(storeId: string, kind: ViolationKind, sinceMs: number): Promise<number>;
  openCrossChannelSince(skuId: string): Promise<number | null>;
  resolveCrossChannel(skuId: string, atMs: number): Promise<number>;
  openCrossChannelCount(storeId: string): Promise<number>;
  recent(storeId: string, limit: number): Promise<readonly EnforcementRecord[]>;
}

export interface ProductSkus {
  readonly storeId: string;
  readonly skuIds: readonly string[];
  /** Only active listings expose evidence publicly. */
  readonly active: boolean;
}

/** Catalog read model. Absent means unknown product (404). */
export interface SkuDirectory {
  forProduct(productId: string): Promise<ProductSkus | null>;
}

export interface PriceIntegrityClock {
  nowMs(): number;
}
