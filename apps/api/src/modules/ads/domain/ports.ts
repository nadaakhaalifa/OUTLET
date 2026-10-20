import type {
  AdStatsRow,
  AdsConfig,
  Campaign,
  CampaignStatus,
  InvalidReason,
  TargetingContext,
} from "./bridge";

export interface IdPort {
  uuidV7(): string;
}
export interface Clock {
  nowMs(): number;
}

// ---- ports owned by other modules (fakes live in adapters/in-memory.ts) ---------------------

/** Kill switch `sponsored_products` (default OFF, fail closed). */
export interface AdsFlagsPort {
  sponsoredEnabled(): Promise<boolean>;
}

/** Price-integrity enforcement: a store with an active suspension or auto-pause cannot advertise. */
export interface EnforcementPort {
  blockedStores(storeIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface ProductAdFacts {
  readonly productId: string;
  readonly storeId: string;
  readonly categoryIds: readonly string[];
  /** In stock, listed, store open, age gate passed for the request. False products never serve. */
  readonly purchasable: boolean;
  /** Query relevance, seller health and price trust, each 0..10_000 (spec 10: quality score). */
  readonly relevanceBp: number;
  readonly sellerHealthBp: number;
  readonly priceTrustBp: number;
}

/** Catalog/search facts. Sponsored items must pass the same filters, stock, size and age gates. */
export interface ProductEligibilityPort {
  facts(productIds: readonly string[], ctx: TargetingContext): Promise<readonly ProductAdFacts[]>;
}

/** B2B charge for an ad top-up (seller pays Z-OUTLET through the PSP, VAT 14%, ETA e-invoice). */
export interface ChargeIntentPort {
  create(input: {
    readonly storeId: string;
    readonly topUpId: string;
    readonly net: bigint;
    readonly vat: bigint;
    readonly gross: bigint;
    readonly idempotencyKey: string;
  }): Promise<{ readonly intentRef: string; readonly clientAction: "redirect" | "native_sheet" | "none" }>;
}

/** Ledger module. Idempotent on `entryKey`; postings must balance to zero (domain/billing). */
export interface LedgerPostingPort {
  post(input: {
    readonly entryKey: string;
    readonly kind: "ads_topup" | "ads_click" | "ads_click_credit_back";
    readonly refId: string;
    readonly postings: readonly { readonly account: string; readonly amount: bigint }[];
  }): Promise<{ readonly entryId: string }>;
}

/** Fraud/bot signal for a click, 0..10_000, or null when unavailable. */
export interface BotScorePort {
  score(sessionHash: string): Promise<number | null>;
}

/** Orders: attributed GMV of the advertiser's sponsored products inside a window (read model). */
export interface AttributionPort {
  attributedRevenue(input: {
    readonly storeId: string;
    readonly productIds: readonly string[];
    readonly fromMs: number;
    readonly toMs: number;
  }): Promise<bigint>;
}

/** KMS-held HMAC key: signs click tokens and salts session hashes. */
export interface SecretPort {
  hmac(data: string): Promise<string>;
}

// ---- records ----------------------------------------------------------------------------------

export interface BidRecord {
  readonly campaignId: string;
  readonly productId: string;
  readonly bid: bigint;
  readonly createdAtMs: number;
}

export interface ClickSignalsQuery {
  readonly sessionHash: string;
  readonly campaignId: string;
  readonly productId: string;
  readonly dayKey: string;
  readonly windowSinceMs: number;
  readonly minuteSinceMs: number;
}

export interface ClickSignalsResult {
  readonly validInWindow: number;
  readonly clicksLastMinute: number;
  readonly campaignClicksToday: number;
}

export interface ClickRecheck {
  readonly query: ClickSignalsQuery;
  readonly verdict: (s: ClickSignalsResult) => string | null;
}

export interface TopUpRecord {
  readonly id: string;
  readonly storeId: string;
  readonly net: bigint;
  readonly vat: bigint;
  readonly gross: bigint;
  readonly status: "PENDING_PAYMENT" | "CREDITED" | "FAILED";
  readonly intentRef: string | null;
  readonly idempotencyKey: string;
  readonly createdAtMs: number;
  readonly creditedAtMs: number | null;
}

export interface ServableBid {
  readonly campaign: Campaign;
  readonly productId: string;
  readonly bid: bigint;
  readonly bidAtMs: number;
  /** Spent today (Cairo day) by the campaign. */
  readonly spentToday: bigint;
  readonly balance: bigint;
}

export interface ImpressionRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly position: number;
  readonly queryHash: string | null;
  readonly sessionHash: string;
  readonly atMs: number;
}

export interface ClickRecord {
  readonly id: string;
  readonly tokenJti: string;
  readonly campaignId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly impressionId: string;
  readonly sessionHash: string;
  readonly valid: boolean;
  readonly invalidReason: InvalidReason | "credited_back" | null;
  readonly cost: bigint;
  readonly dayKey: string;
  readonly atMs: number;
  readonly postedEntryId: string | null;
  readonly creditedBack: bigint;
}

export const CLICK_REVIEW_DECISIONS = ["confirm_invalid", "flag_store"] as const;
export type ClickReviewDecision = (typeof CLICK_REVIEW_DECISIONS)[number];
/** Invalid reasons an admin can meaningfully review (fraud signals, not budget/token mechanics). */
export const REVIEWABLE_INVALID_REASONS = ["too_fast", "duplicate_window", "burst", "self_click", "bot", "campaign_drain"] as const;

export interface ClickReviewRecord {
  readonly clickId: string;
  readonly decision: ClickReviewDecision;
  readonly reasonCode: string;
  readonly decidedBy: string;
  readonly decidedAtMs: number;
}

export type DecideClickReview =
  | { readonly kind: "decided" | "replayed"; readonly review: ClickReviewRecord }
  | { readonly kind: "conflict"; readonly review: ClickReviewRecord }
  | { readonly kind: "not_found" | "not_reviewable" };

export interface OutboxDraft {
  readonly type: "ad.click_valid" | "ad.budget_exhausted" | "ad.balance_topped_up" | "ad.campaign_status_changed";
  readonly aggregateType: "ad_campaign" | "ad_balance";
  readonly aggregateId: string;
  /** Ids, enums and integer piastres only. */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export type BillClick =
  | { readonly kind: "billed"; readonly click: ClickRecord }
  | { readonly kind: "duplicate"; readonly click: ClickRecord }
  | { readonly kind: "rejected"; readonly click: ClickRecord };

/**
 * Persistence. Every method is atomic; outbox drafts are written in the same transaction as the
 * state change. In-memory and Kysely stores share one contract suite.
 */
export interface AdsStore {
  getConfig(): Promise<AdsConfig | null>;
  putConfig(cfg: AdsConfig, actorId: string): Promise<void>;

  insertCampaign(c: Campaign, bids: readonly BidRecord[]): Promise<void>;
  getCampaign(id: string): Promise<Campaign | null>;
  listCampaigns(storeId: string, limit: number): Promise<readonly Campaign[]>;
  listBids(campaignId: string): Promise<readonly BidRecord[]>;
  /** Replaces the editable fields and (when given) the bids in one transaction. */
  updateCampaign(
    id: string,
    patch: Partial<Pick<Campaign, "name" | "dailyBudget" | "maxCpc" | "keywords" | "categories" | "endsAtMs">>,
    bids: readonly BidRecord[] | null,
    nowMs: number,
  ): Promise<Campaign | null>;
  /** Compare-and-set on status. Returns null when the campaign is not in `from`. */
  setStatus(id: string, from: CampaignStatus, to: CampaignStatus, nowMs: number, events: readonly OutboxDraft[]): Promise<Campaign | null>;
  listByStatus(status: CampaignStatus, limit: number): Promise<readonly Campaign[]>;
  listStoreCampaignsInStatus(storeId: string, status: CampaignStatus): Promise<readonly Campaign[]>;

  getBalance(storeId: string): Promise<bigint>;
  insertTopUp(t: TopUpRecord): Promise<{ readonly kind: "created" | "duplicate"; readonly topUp: TopUpRecord }>;
  getTopUp(id: string): Promise<TopUpRecord | null>;
  setTopUpIntent(id: string, intentRef: string): Promise<void>;
  /** PENDING -> CREDITED and balance += net, once. */
  creditTopUp(id: string, nowMs: number, events: readonly OutboxDraft[]): Promise<{ readonly kind: "credited" | "replayed" | "not_found"; readonly topUp: TopUpRecord | null; readonly balance: bigint }>;
  failTopUp(id: string): Promise<void>;
  listTopUps(storeId: string, limit: number): Promise<readonly TopUpRecord[]>;

  /** ACTIVE campaigns inside their window with bids, today's spend and the store balance. */
  listServable(nowMs: number, dayKey: string): Promise<readonly ServableBid[]>;

  recordImpressions(rows: readonly ImpressionRecord[]): Promise<void>;
  getImpression(id: string): Promise<ImpressionRecord | null>;
  impressionsTodayBySession(sessionHash: string, campaignId: string, sinceMs: number): Promise<number>;

  /**
   * Inserts the click row and, only for a valid click with cost > 0, atomically takes `cost` from
   * today's campaign budget and the prepaid balance (never below zero, never above the daily
   * budget). A replayed token returns `duplicate` and bills nothing.
   */
  billClick(
    click: ClickRecord,
    caps: { readonly dailyBudget: bigint },
    events: readonly OutboxDraft[],
    /**
     * B-8: dedupe and burst signals re-read inside the billing transaction, after the campaign-day
     * lock is held, so two clicks on two impressions inside the window cannot both bill. `verdict`
     * returns the invalid reason or null; the pre-check outside stays as a cheap early exit.
     */
    recheck?: ClickRecheck,
  ): Promise<BillClick>;
  clickSignals(input: ClickSignalsQuery): Promise<ClickSignalsResult>;
  /** Reverses a valid click's cost into balance and today's spend. Once. */
  creditBack(clickId: string, nowMs: number): Promise<{ readonly kind: "credited" | "replayed" | "not_found"; readonly click: ClickRecord | null }>;
  listUnposted(limit: number): Promise<readonly ClickRecord[]>;
  markPosted(clickId: string, entryId: string): Promise<void>;
  getClick(id: string): Promise<ClickRecord | null>;
  /** Unreviewed invalid clicks with a reviewable reason, newest first (ts desc, id desc), keyset paged. */
  listInvalidClickQueue(q: { readonly limit: number; readonly after: { readonly atMs: number; readonly id: string } | null }): Promise<readonly ClickRecord[]>;
  /** Once per click: same decision replays, a different one conflicts. Never moves money. */
  decideClickReview(r: ClickReviewRecord): Promise<DecideClickReview>;

  stats(input: { readonly storeId: string; readonly campaignId: string | null; readonly fromMs: number; readonly toMs: number }): Promise<Omit<AdStatsRow, "attributedRevenue">>;
  productIdsFor(storeId: string, campaignId: string | null): Promise<readonly string[]>;
}
