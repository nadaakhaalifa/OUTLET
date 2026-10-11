/**
 * AI stylist v1, pure domain (spec 11, docs/specs/phase2/04-ai-stylist.md).
 *
 * Money is bigint piastres. Scores are integers on a 0..1000 "permille" scale so that ordering is
 * deterministic and never depends on float formatting. Embeddings are plain number arrays: they are
 * only ever compared, never summed into money.
 */

export const SLOTS = ["top", "bottom", "dress", "shoes", "bag", "accessory"] as const;
export type Slot = (typeof SLOTS)[number];

/** Complete outfits: top + bottom/dress + shoes + bag + accessory (spec 11). */
export const TEMPLATES: readonly (readonly Slot[])[] = [
  ["top", "bottom", "shoes", "bag", "accessory"],
  ["dress", "shoes", "bag", "accessory"],
];

export const SLEEVES = ["none", "short", "elbow", "long", "n/a"] as const;
export const NECKLINES = ["low", "mid", "high", "n/a"] as const;
export const LENGTHS = ["mini", "knee", "midi", "maxi", "n/a"] as const;
export const SEASONS = ["summer", "winter", "spring", "autumn", "all"] as const;
export type Sleeve = (typeof SLEEVES)[number];
export type Neckline = (typeof NECKLINES)[number];
export type Length = (typeof LENGTHS)[number];
export type Season = (typeof SEASONS)[number];

export interface Coverage {
  readonly sleeve: Sleeve;
  readonly neckline: Neckline;
  readonly length: Length;
}

export interface Candidate {
  readonly itemId: string;
  readonly storeId: string;
  readonly slot: Slot;
  readonly pricePiastres: bigint;
  /** Integer 0..100. Zero unless the price integrity engine verified the claim (spec 9). */
  readonly verifiedDiscountPct: number;
  readonly colors: readonly string[];
  /** 0 (loungewear) .. 4 (black tie). */
  readonly formality: number;
  readonly seasons: readonly Season[];
  readonly coverage: Coverage;
  /** Integer 0..1000, from real sales velocity, never invented. */
  readonly popularity: number;
  /** In stock in the shopper's size right now (re-validated at add-to-bag). */
  readonly inSize: boolean;
  readonly embedding?: readonly number[];
}

export interface OutfitRequest {
  /** null: no budget constraint. */
  readonly budgetPiastres: bigint | null;
  readonly occasionFormality: number;
  readonly season: Season;
  readonly modest: boolean;
  /** Set when the shopper scoped to one store: the per-store fairness cap is lifted. */
  readonly scopedToSingleStore: boolean;
  readonly freeDeliveryThresholdPiastres: bigint;
  /** Read only when personalization is on; null otherwise. */
  readonly styleVector: readonly number[] | null;
  /** Items fixed by the caller (complete-the-look anchor). */
  readonly locked: readonly Candidate[];
}

export interface OptimizerConfig {
  readonly beamWidth: number;
  readonly timeBudgetMs: number;
  readonly maxPerStore: number;
  readonly perSlotCap: number;
  readonly minSlotDifference: number;
  readonly minOutfits: number;
  readonly maxOutfits: number;
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  beamWidth: 50,
  timeBudgetMs: 300,
  maxPerStore: 2,
  perSlotCap: 40,
  minSlotDifference: 2,
  minOutfits: 3,
  maxOutfits: 5,
};

export type OutfitSource = "ml" | "rules";

export interface MissingSlot {
  readonly slot: Slot;
  readonly reason: "budget" | "no_item_in_size";
  /** Piastres the shopper must add to afford the cheapest item for this slot, null when not a budget problem. */
  readonly addPiastres: bigint | null;
}

export interface Outfit {
  readonly items: readonly Candidate[];
  readonly totalPiastres: bigint;
  readonly score: number;
  readonly complete: boolean;
  readonly missing: readonly MissingSlot[];
  readonly source: OutfitSource;
  /** Stores whose same-store subtotal reaches the free-delivery threshold. */
  readonly freeDeliveryStoreIds: readonly string[];
}

export interface OptimizerResult {
  readonly outfits: readonly Outfit[];
  readonly timedOut: boolean;
  readonly explored: number;
  readonly source: OutfitSource;
}

export type Clock = () => number;
