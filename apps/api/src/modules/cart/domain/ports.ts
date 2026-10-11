import type { Money, LineState } from "./bridge";

export interface LocalizedText {
  readonly ar: string;
  readonly en?: string;
}

export interface StoreSummaryFacts {
  readonly id: string;
  readonly slug: string;
  readonly name: LocalizedText;
  readonly kind: "local" | "global";
  readonly logoUrl?: string;
  readonly coverUrl?: string;
  readonly verifiedBadge: boolean;
  /** Null unless backed by verified claims. Never seller supplied. */
  readonly maxVerifiedDiscountPct: number | null;
  readonly rating: number | null;
  readonly ratingCount: number;
  readonly followerCount: number;
  readonly liveDrop: boolean;
  readonly isFavorite: boolean;
}

export interface StoreFacts {
  readonly summary: StoreSummaryFacts;
  /** False when the store is suspended or otherwise not selling. */
  readonly open: boolean;
  /** Per-store free-delivery threshold (piastres); null means "use the platform default". */
  readonly freeDeliveryThreshold: Money | null;
  readonly standardDeliveryFee: Money;
}

export interface SkuFacts {
  readonly skuId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly title: LocalizedText;
  readonly sizeLabel?: string;
  readonly imageUrl?: string;
  /** Current selling price, already net of item-level discounts, VAT inclusive. */
  readonly unitPrice: Money;
  readonly available: boolean;
}

export type PriceBadge = "verified_discount" | "lowest_30d" | "launch_price" | "none";

export interface SuggestionFacts {
  readonly skuId: string;
  readonly productId: string;
  readonly title: LocalizedText;
  readonly store: StoreSummaryFacts;
  readonly imageUrl?: string;
  readonly blurhash?: string;
  readonly unitPrice: Money;
  readonly badge: PriceBadge;
  readonly referencePrice: Money | null;
  readonly discountPct: number | null;
  readonly condition: "new_with_tags" | "new_without_tags" | "sample" | "minor_defect";
  readonly sponsored: boolean;
}

/**
 * Read-only view of the catalog. Contract: `freeDeliveryCandidates` returns only items that are
 * in stock, from `storeId`, and in a size the shopper can wear (the adapter resolves the size).
 * Any failure must throw `CatalogUnavailableError`; the bag never prices from stale guesses.
 */
export interface CatalogPort {
  skus(skuIds: readonly string[]): Promise<ReadonlyMap<string, SkuFacts>>;
  stores(storeIds: readonly string[], userId: string): Promise<ReadonlyMap<string, StoreFacts>>;
  freeDeliveryCandidates(query: {
    readonly storeId: string;
    readonly userId: string;
    readonly excludeSkuIds: readonly string[];
    readonly limit: number;
  }): Promise<readonly SuggestionFacts[]>;
}

export class CatalogUnavailableError extends Error {
  constructor() {
    super("catalog unavailable");
    this.name = "CatalogUnavailableError";
  }
}

export interface MembershipPort {
  isPlusMember(userId: string): Promise<boolean>;
}

export interface PlatformConfigPort {
  /** Platform-wide free-delivery threshold, piastres (ADR-0010 default 200000). */
  freeDeliveryThreshold(): Promise<Money>;
}

export type LineSource = "pdp" | "search" | "stylist" | "wishlist" | "feed" | "bag_suggestion" | "reorder";

export interface CartLineRecord {
  readonly id: string;
  readonly skuId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly priceAtAdd: Money;
  readonly thresholdAtAdd: Money | null;
  readonly state: LineState;
  readonly source: LineSource | null;
  readonly unavailableSinceMs: number | null;
  readonly addedAtMs: number;
}

export interface CartRecord {
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly updatedAtMs: number;
  /** In the order the shopper added them. */
  readonly lines: readonly CartLineRecord[];
}

export interface CartRepository {
  getOrCreate(userId: string, newId: string, nowMs: number): Promise<CartRecord>;
  /** Optimistic write: false when `expectedVersion` is no longer current. Bumps the version. */
  save(cart: CartRecord, expectedVersion: number, nowMs: number): Promise<boolean>;
  /** Availability bookkeeping only; does not bump the version. */
  setUnavailableSince(userId: string, changes: readonly { readonly lineId: string; readonly sinceMs: number | null }[]): Promise<void>;
  findLineOwner(lineId: string): Promise<string | null>;
}

export interface LineUnavailableEvent {
  readonly name: "cart.line_unavailable";
  readonly userId: string;
  readonly cartId: string;
  readonly skuId: string;
  readonly reason: "sold_out" | "store_suspended";
}

export interface CartEventPublisher {
  publish(event: LineUnavailableEvent): Promise<void>;
}
