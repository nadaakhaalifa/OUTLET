import type { Candidate, FeedbackSignal, MissingSlot, OutfitSource, Season, Slot } from "./bridge";

export interface IdPort {
  uuidV7(): string;
}
export interface Clock {
  nowMs(): number;
}

/** A catalog candidate plus its display title (seller text: untrusted, only ever sent as a data field). */
export interface StylistCandidate extends Candidate {
  readonly title?: string;
}

export type World = "local" | "global" | "everything" | "my_stores";
export interface Scope {
  readonly world: World;
  readonly storeIds: readonly string[];
}

export interface CandidateQuery {
  readonly userId: string;
  readonly scope: Scope;
  /** "Shop my wishlist": only items on the shopper's Need/Want lists. */
  readonly wishlistOnly: boolean;
  /** Complete-the-look anchor (a PDP, bag or past purchase item). */
  readonly anchorItemId: string | null;
}

export class CatalogUnavailableError extends Error {
  constructor() {
    super("catalog unavailable");
    this.name = "CatalogUnavailableError";
  }
}

// ---- ports owned by other modules (fakes live in adapters/in-memory.ts) ----------------------

/**
 * Catalog + sizing + inventory + address + age gates in one read model: size in stock, delivery to
 * the default address, scope. Prices and stock come from Postgres at call time (spec 11 Rules).
 */
export interface CandidateSourcePort {
  candidates(q: CandidateQuery): Promise<readonly StylistCandidate[]>;
}

/** ML embeddings service. Rejects on timeout or outage; the stylist then uses the rules fallback. */
export interface EmbeddingPort {
  embeddings(itemIds: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>>;
}

/** Budget suite. Returns null unless the shopper opted in to budget_insights (spec 12). */
export interface BudgetPort {
  remainingBudgetPiastres(userId: string): Promise<bigint | null>;
}

/** Consent `personalization` and the personalization toggle (spec 13). */
export interface PersonalizationPort {
  enabled(userId: string): Promise<boolean>;
}

export interface LivePrice {
  readonly pricePiastres: bigint;
  readonly storeId: string;
  readonly inStockInSize: boolean;
}

/** Re-validation at add-to-bag: current price and stock for the items of an outfit. */
export interface LivePricePort {
  current(itemIds: readonly string[]): Promise<ReadonlyMap<string, LivePrice>>;
}

/** Cart module. Writes only on an explicit user tap (LLM06). */
export interface BagPort {
  addLines(userId: string, itemIds: readonly string[], idempotencyKey: string): Promise<void>;
}

export interface StylistFlagPort {
  isEnabled(key: string): Promise<boolean>;
}

/** Everything the stylist asks of an LLM goes through this port (adapter wraps llm-gateway). */
export interface StylistLlmPort {
  parseIntent(input: { readonly userId: string; readonly note: string }): Promise<{
    readonly occasion: string;
    readonly formality: number;
    readonly season: Season;
    readonly modest: boolean;
  } | null>;
  rerank(input: {
    readonly userId: string;
    readonly occasion: string;
    readonly season: Season;
    readonly items: readonly { readonly id: string; readonly title: string }[];
  }): Promise<readonly string[] | null>;
}

// ---- persistence -----------------------------------------------------------------------------

export type OutfitKind = "outfit" | "complete_look" | "capsule" | "wishlist";

export interface StoredItem {
  readonly itemId: string;
  readonly storeId: string;
  readonly slot: Slot;
  readonly pricePiastres: bigint;
  readonly verifiedDiscountPct: number;
}

export interface OutfitRecord {
  readonly id: string;
  /** Shared by the outfits of one generation request (fair use counts these). */
  readonly generationId: string;
  readonly userId: string;
  readonly kind: OutfitKind;
  readonly source: OutfitSource;
  readonly complete: boolean;
  readonly items: readonly StoredItem[];
  readonly missing: readonly MissingSlot[];
  readonly score: number;
  readonly totalPiastres: bigint;
  /** Only the budget the shopper typed. A budget derived from the budget suite is never stored. */
  readonly budgetPiastres: bigint | null;
  readonly request: {
    readonly occasion: string | null;
    readonly season: Season;
    readonly modest: boolean;
    readonly world: World;
    readonly budgetSource: "none" | "user" | "budget_suite";
  };
  readonly createdAtMs: number;
  readonly addedToBagAtMs: number | null;
}

export type StylistEvent =
  | {
      readonly type: "outfit.generated";
      readonly userId: string;
      readonly outfitIds: readonly string[];
      readonly count: number;
      readonly budgetBand: string;
      readonly latencyMs: number;
      readonly source: OutfitSource;
    }
  | { readonly type: "outfit.added_to_bag"; readonly outfitId: string; readonly userId: string; readonly itemCount: number }
  | {
      readonly type: "stylist.feedback";
      readonly outfitId: string;
      readonly userId: string;
      readonly signal: FeedbackSignal;
    };

export interface FeedbackRecord {
  readonly id: string;
  readonly outfitId: string;
  readonly userId: string;
  readonly itemId: string;
  readonly signal: FeedbackSignal;
  readonly atMs: number;
}

export interface StylistStore {
  insertOutfits(records: readonly OutfitRecord[], events: readonly StylistEvent[]): Promise<void>;
  getOutfit(id: string): Promise<OutfitRecord | null>;
  /** Distinct generations by `userId` at or after `sinceMs` (daily fair use). */
  countSince(userId: string, sinceMs: number): Promise<number>;
  /** Sets added_to_bag_at once. "already" when it was set before (idempotent concurrent adds). */
  markAddedToBag(outfitId: string, userId: string, atMs: number, events: readonly StylistEvent[]): Promise<"marked" | "already">;
  upsertFeedback(f: FeedbackRecord, events: readonly StylistEvent[]): Promise<void>;
  getFeedback(outfitId: string): Promise<readonly FeedbackRecord[]>;
  getStyleVector(userId: string): Promise<readonly number[] | null>;
  putStyleVector(userId: string, vec: readonly number[], atMs: number): Promise<void>;
  /** History clear / consent withdrawal: outfits, feedback and style vector. */
  eraseForUser(userId: string): Promise<void>;
}

/** Band for events and LLM inputs: never the exact budget (LLM02). */
export function budgetBand(piastres: bigint | null): string {
  if (piastres === null) return "none";
  const egp = piastres / 100n;
  if (egp < 1000n) return "lt_1000";
  if (egp < 3000n) return "1000_2999";
  if (egp < 5000n) return "3000_4999";
  if (egp < 10000n) return "5000_9999";
  return "gte_10000";
}
