import type { Candidate, ExplorationStats, Neighbor, Rng, UserFeatures } from "./bridge";

export interface IdPort {
  uuidV7(): string;
}
export interface Clock {
  nowMs(): number;
}

export type RecModule = "feed" | "similar" | "similar_for_less" | "goes_with" | "restock" | "price_drop" | "exploration";
export type CooccurrenceKind = "co_view" | "co_buy";

// ---- ports owned by other modules ------------------------------------------------------------

/** Catalog + price integrity. `claimAllowed` is the price-integrity output, never recomputed here. */
export interface CatalogPort {
  product(productId: string): Promise<Candidate | null>;
  byIds(productIds: readonly string[]): Promise<readonly Candidate[]>;
  /** Popularity + freshness candidate pool, optionally scoped to categories. */
  popular(opts: { readonly limit: number; readonly categoryIds?: readonly string[] }): Promise<readonly Candidate[]>;
  /** New sellers eligible for exploration (Thompson sampling, spec 20.5). */
  newSellerPool(limit: number): Promise<readonly Candidate[]>;
  /** Replenishment interval in days for "basics"; absent means not a basic. */
  basicsIntervalDays(productIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

/** ANN retrieval (ADR-0023). Throws when the index is unavailable; callers fall back to rules. */
export interface VectorIndexPort {
  nearest(productId: string, k: number): Promise<readonly Neighbor[]>;
}

/** Offline GBDT model behind a port. `features` is null whenever the request is not personalized. */
export interface RankerPort {
  rank(input: {
    readonly candidates: readonly Candidate[];
    readonly features: UserFeatures | null;
    readonly personalized: boolean;
    readonly nowMs: number;
  }): Promise<{ readonly modelVersion: string; readonly scores: ReadonlyMap<string, number> }>;
}

export interface HistoryPurchase {
  readonly productId: string;
  readonly boughtAtMs: number;
  readonly returned: boolean;
}
export interface HistoryView {
  readonly productId: string;
  readonly priceMinor: bigint | null;
  readonly viewedAtMs: number;
}

/** Read side of the history module. Structurally satisfied by wiring in the composition root. */
export interface PersonalizationReadPort {
  settings(userId: string): Promise<{ readonly personalization: boolean; readonly historyPaused: boolean }>;
  consentGranted(userId: string): Promise<boolean>;
  /** The feature store. Never called when the request is not personalized (spy-tested). */
  features(userId: string): Promise<UserFeatures | null>;
  recentViews(userId: string, limit: number): Promise<readonly HistoryView[]>;
  purchases(userId: string, limit: number): Promise<readonly HistoryPurchase[]>;
}

/** Sizing module: size labels the shopper wears (labels only, never measurements). */
export interface UserSizePort {
  sizeLabels(userId: string): Promise<readonly string[] | null>;
}

/** Spec 03 budget module. Request-time filter only: its output is never persisted here. */
export interface AffordabilityFilterPort {
  filter(userId: string, items: readonly Candidate[]): Promise<readonly Candidate[]>;
}

export interface FlagPort {
  /** kill.ml_ranking: true means ML ranking and exploration may run. */
  mlRankingAllowed(): Promise<boolean>;
}

export interface RngPort {
  /** A fresh generator per request. Tests inject a seeded one. */
  create(): Rng;
}

// ---- events and store ------------------------------------------------------------------------

export type RecOutboxEvent =
  | { readonly type: "recommendation.impression"; readonly module: RecModule; readonly modelVersion: string; readonly productIds: readonly string[]; readonly personalized: boolean }
  | { readonly type: "recommendation.click"; readonly module: RecModule; readonly modelVersion: string; readonly productId: string };

export interface CooccurrenceRow {
  readonly itemA: string;
  readonly itemB: string;
  readonly kind: CooccurrenceKind;
  readonly score: number;
  readonly windowDays: number;
}

export interface RecoStore {
  neighbors(productId: string, kind: CooccurrenceKind, limit: number): Promise<readonly Neighbor[]>;
  /** Batch job output (symmetric pairs are written by the job as two rows). */
  upsertCooccurrence(rows: readonly CooccurrenceRow[], nowMs: number): Promise<number>;
  activeModelVersion(): Promise<string | null>;
  explorationStats(productIds: readonly string[]): Promise<ReadonlyMap<string, ExplorationStats>>;
  /** Counters and the outbox event in one transaction. */
  recordImpressions(module: RecModule, productIds: readonly string[], event: RecOutboxEvent, nowMs: number): Promise<void>;
  recordClick(module: RecModule, productId: string, event: RecOutboxEvent, nowMs: number): Promise<void>;
}
