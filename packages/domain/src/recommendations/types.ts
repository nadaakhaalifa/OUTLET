/**
 * Pure recommendation and history vocabulary (spec 13, 20.5, 20.6). No infrastructure imports.
 * Prices are integer piastres (bigint). Ratios are integers (permille or percent) so the ranking
 * code never relies on float rounding for anything a user can see. Embedding similarity is the
 * one float, and it is only ever used to order candidates, never to display or charge.
 */

export const HISTORY_EVENT_TYPES = ["viewed", "searched", "saved", "bought", "returned", "outfit_generated"] as const;
export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];

export interface HistoryEvent {
  readonly id: string;
  readonly userId: string;
  readonly type: HistoryEventType;
  /** Product id for viewed/saved/bought/returned, outfit id for outfit_generated, null for searched. */
  readonly itemId: string | null;
  readonly storeId: string | null;
  readonly categoryId: string | null;
  /** Price the shopper saw (viewed) or paid (bought), piastres. Used only for honest "price dropped". */
  readonly priceMinor: bigint | null;
  /** Search text (searched), return reason code (returned). Short, shopper-visible in History. */
  readonly detail: string | null;
  readonly atMs: number;
}

export interface RecentlyViewed {
  readonly productId: string;
  readonly viewedAtMs: number;
  readonly priceMinor: bigint | null;
}

/** A candidate item as the retrieval and ranking stages see it. Nothing here is user specific. */
export interface Candidate {
  readonly productId: string;
  readonly storeId: string;
  readonly categoryId: string;
  /** Decayed sales velocity, integer. */
  readonly popularity: number;
  readonly createdAtMs: number;
  readonly priceMinor: bigint;
  /** Price integrity output (spec 9.3). false means no "% off" claim may be shown. */
  readonly claimAllowed: boolean;
  readonly verifiedDiscountPct: number;
  /** 0..100 */
  readonly sellerHealth: number;
  /** 0..100 */
  readonly priceTrust: number;
  /** permille of delivered units returned. */
  readonly returnRatePermille: number;
  readonly storeActive: boolean;
  readonly inStock: boolean;
  /** Sizes in stock (labels). Empty means one-size or not size-gated. */
  readonly sizesInStock: readonly string[];
  readonly isNewSeller: boolean;
}

export interface ScoredCandidate {
  readonly candidate: Candidate;
  readonly score: number;
  readonly exploration: boolean;
}

/** Deterministic randomness behind a port (seeded in tests and replay). Values are in [0, 1). */
export interface Rng {
  next(): number;
}
