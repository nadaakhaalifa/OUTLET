import { InvalidAmountError } from "../errors";
import type { AdsConfig, Campaign, CampaignStatus, TargetingContext } from "./types";

export class InvalidCampaignTransitionError extends Error {
  constructor(
    readonly from: CampaignStatus,
    readonly event: CampaignEvent,
  ) {
    super(`campaign cannot handle ${event} while ${from}`);
    this.name = "InvalidCampaignTransitionError";
  }
}

export type CampaignEvent =
  | "seller_pause"
  | "seller_resume"
  | "balance_depleted"
  | "balance_restored"
  | "enforcement_suspend"
  | "enforcement_lifted"
  | "end";

/**
 * Transition table. `seller_resume` is allowed from PAUSED only (a suspended or unfunded campaign
 * is released by the system first). `end` is terminal. Kept as a flat table so every row is a test.
 */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, Readonly<Partial<Record<CampaignEvent, CampaignStatus>>>>> = {
  ACTIVE: {
    seller_pause: "PAUSED",
    balance_depleted: "PAUSED_NO_BALANCE",
    enforcement_suspend: "SUSPENDED",
    end: "ENDED",
  },
  PAUSED: { seller_resume: "ACTIVE", enforcement_suspend: "SUSPENDED", end: "ENDED" },
  PAUSED_NO_BALANCE: { balance_restored: "ACTIVE", seller_pause: "PAUSED", enforcement_suspend: "SUSPENDED", end: "ENDED" },
  SUSPENDED: { enforcement_lifted: "PAUSED", end: "ENDED" },
  ENDED: {},
};

export function transitionCampaign(from: CampaignStatus, event: CampaignEvent): CampaignStatus {
  const to = CAMPAIGN_TRANSITIONS[from][event];
  if (to === undefined) throw new InvalidCampaignTransitionError(from, event);
  return to;
}

export interface FieldError {
  readonly field: string;
  readonly code: string;
}

export interface CampaignDraftInput {
  readonly name: string;
  readonly dailyBudget: bigint;
  readonly maxCpc: bigint;
  readonly keywords: readonly string[];
  readonly categories: readonly string[];
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly bids: readonly { readonly productId: string; readonly bid: bigint }[];
}

export interface CampaignDraft extends Omit<CampaignDraftInput, "bids"> {
  readonly bids: readonly { readonly productId: string; readonly bid: bigint }[];
}

export const MAX_BIDS_PER_CAMPAIGN = 50;
export const MAX_KEYWORDS = 20;
export const MAX_DAILY_BUDGET = 100_000_000n;

export const normalizeKeyword = (k: string): string => k.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

export type Validated<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly FieldError[] };

export function validateCampaignDraft(input: CampaignDraftInput, cfg: AdsConfig, nowMs: number): Validated<CampaignDraft> {
  const errors: FieldError[] = [];
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) errors.push({ field: "name", code: "length" });
  if (input.dailyBudget < cfg.floorPrice || input.dailyBudget > MAX_DAILY_BUDGET) errors.push({ field: "daily_budget", code: "range" });
  if (input.maxCpc < cfg.floorPrice) errors.push({ field: "max_cpc", code: "below_floor" });
  if (input.maxCpc > input.dailyBudget) errors.push({ field: "max_cpc", code: "above_daily_budget" });
  const keywords = [...new Set(input.keywords.map(normalizeKeyword))];
  if (keywords.length > MAX_KEYWORDS) errors.push({ field: "keywords", code: "too_many" });
  if (keywords.some((k) => k.length < 2 || k.length > 40)) errors.push({ field: "keywords", code: "length" });
  const categories = [...new Set(input.categories.map((c) => c.trim()))];
  if (categories.length > MAX_KEYWORDS || categories.some((c) => c.length < 1 || c.length > 60)) {
    errors.push({ field: "categories", code: "invalid" });
  }
  if (input.endsAtMs !== null && input.endsAtMs <= input.startsAtMs) errors.push({ field: "ends_at", code: "before_start" });
  if (input.endsAtMs !== null && input.endsAtMs <= nowMs) errors.push({ field: "ends_at", code: "in_past" });
  if (input.bids.length < 1) errors.push({ field: "bids", code: "required" });
  if (input.bids.length > MAX_BIDS_PER_CAMPAIGN) errors.push({ field: "bids", code: "too_many" });
  const productIds = new Set<string>();
  for (const b of input.bids) {
    if (productIds.has(b.productId)) errors.push({ field: "bids", code: "duplicate_product" });
    productIds.add(b.productId);
    if (b.bid < cfg.floorPrice) errors.push({ field: "bids", code: "below_floor" });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ...input, name, keywords, categories } };
}

/** True when the campaign is inside its schedule window at `nowMs`. */
export const inWindow = (c: Pick<Campaign, "startsAtMs" | "endsAtMs">, nowMs: number): boolean =>
  nowMs >= c.startsAtMs && (c.endsAtMs === null || nowMs < c.endsAtMs);

/**
 * Targeting match (spec 10: only query, category, store scope, locale). A campaign with neither
 * keywords nor categories matches everything. Otherwise any keyword contained in the query, or any
 * category overlap, matches. Store scope: when the shopper scoped to My Stores, only products of
 * scoped stores may be sponsored.
 */
export function matchesTargeting(
  c: Pick<Campaign, "keywords" | "categories" | "storeId">,
  productCategoryIds: readonly string[],
  ctx: TargetingContext,
): boolean {
  if (ctx.storeScope !== null && !ctx.storeScope.includes(c.storeId)) return false;
  if (c.keywords.length === 0 && c.categories.length === 0) return true;
  const q = ctx.query === null ? "" : normalizeKeyword(ctx.query);
  if (q.length > 0 && c.keywords.some((k) => q.includes(k))) return true;
  const cats = new Set([...ctx.categoryIds, ...productCategoryIds]);
  return c.categories.some((x) => cats.has(x));
}

export function assertPositive(n: bigint, label: string): void {
  if (n <= 0n) throw new InvalidAmountError(`${label} must be positive`);
}
