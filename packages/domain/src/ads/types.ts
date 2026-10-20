/**
 * Sponsored products (CPC), pure domain (spec 10, docs/specs/phase2/10-sponsored-products.md).
 * Money is integer piastres (bigint), VAT-EXCLUSIVE (ad spend is a B2B service, B4). Ratios are
 * basis points (10_000 = 1.0). No clocks, no I/O: instants are epoch milliseconds passed in.
 */
export const CAMPAIGN_STATUSES = ["ACTIVE", "PAUSED", "PAUSED_NO_BALANCE", "SUSPENDED", "ENDED"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const BPS = 10_000n;

export interface Campaign {
  readonly id: string;
  readonly storeId: string;
  readonly name: string;
  readonly status: CampaignStatus;
  /** Daily spend cap, VAT-exclusive piastres, reset at Cairo midnight. */
  readonly dailyBudget: bigint;
  /** Ceiling on what a single click can cost, piastres. */
  readonly maxCpc: bigint;
  /** Normalized keywords (lower case, 2..40 chars). Empty with no categories means "any query". */
  readonly keywords: readonly string[];
  readonly categories: readonly string[];
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ProductBid {
  readonly campaignId: string;
  readonly productId: string;
  /** Piastres per valid click, before the campaign `maxCpc` clamp. */
  readonly bid: bigint;
  /** Used for the earliest-bid-wins tie break. */
  readonly createdAtMs: number;
}

export interface AdsConfig {
  /** Admin-configured reserve price per click, piastres. */
  readonly floorPrice: bigint;
  /** Auction slots per request. The search cap (2 in the top 10) is authoritative downstream. */
  readonly slots: number;
  readonly pricing: "gsp" | "first_price";
  /** Max impressions of one campaign to one pseudonymous session per Cairo day. */
  readonly frequencyCapPerSessionDay: number;
  readonly clickTokenTtlMs: number;
  /** Same session + campaign + product inside this window is one billable click. */
  readonly clickDedupeWindowMs: number;
  /** A click sooner than this after the impression is a bot signal. */
  readonly minDwellMs: number;
  /** Clicks per session per minute above this are invalid. */
  readonly maxClicksPerSessionPerMinute: number;
  /** Clicks per session on one campaign per Cairo day above this are treated as budget drain. */
  readonly maxClicksPerCampaignPerSessionDay: number;
  /** Bot score (bps) at or above this is invalid traffic. */
  readonly botScoreBlockBps: number;
  readonly vatBps: bigint;
  readonly minTopUp: bigint;
  readonly maxTopUp: bigint;
}

export const DEFAULT_ADS_CONFIG: AdsConfig = {
  floorPrice: 100n,
  slots: 2,
  pricing: "gsp",
  frequencyCapPerSessionDay: 5,
  clickTokenTtlMs: 30 * 60_000,
  clickDedupeWindowMs: 10 * 60_000,
  minDwellMs: 400,
  maxClicksPerSessionPerMinute: 5,
  maxClicksPerCampaignPerSessionDay: 3,
  botScoreBlockBps: 8_000,
  vatBps: 1_400n,
  minTopUp: 10_000n,
  maxTopUp: 100_000_000n,
};

/**
 * The ONLY inputs targeting may read (spec 10 Rules). There is deliberately no field for budget,
 * affordability, measurements, size, history or any user attribute: the type cannot carry them.
 */
export interface TargetingContext {
  /** Normalized query text, or null on category pages. */
  readonly query: string | null;
  readonly categoryIds: readonly string[];
  /** My Stores scope in force for this request, or null when unscoped. */
  readonly storeScope: readonly string[] | null;
  readonly locale: "ar" | "en";
}

export type AuctionPricing = AdsConfig["pricing"];
