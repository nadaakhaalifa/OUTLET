import type { Money } from "../money";

/** Promotion kinds in the Phase 1 core. The wider spec list (birthday, win-back, ...) is Phase 2. */
export const PROMOTION_KINDS = ["percent", "fixed", "free_shipping", "bogo", "tiered"] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

/** Evaluation order is item, store, order, shipping (spec 17). The array index is the rank. */
export const PROMOTION_SCOPES = ["item", "store", "order", "shipping"] as const;
export type PromotionScope = (typeof PROMOTION_SCOPES)[number];

export const PROMOTION_STATUSES = ["draft", "scheduled", "active", "paused", "ended"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export const PAYMENT_METHODS = [
  "card",
  "apple_pay",
  "meeza",
  "mobile_wallet",
  "instapay",
  "fawry",
  "bnpl",
  "cod",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type PromotionOwner =
  | { readonly kind: "platform" }
  | { readonly kind: "store"; readonly storeId: string };

/** Whole percentages that add up to 100. A seller promotion must have platformPct 0. */
export interface Funding {
  readonly platformPct: number;
  readonly sellerPct: number;
}

export interface Tier {
  /** Minimum eligible merchandise subtotal (list price, before any promotion) for this tier. */
  readonly minSubtotal: Money;
  readonly percentBps: number;
}

export type PromotionValue =
  | { readonly kind: "percent"; readonly percentBps: number }
  | { readonly kind: "fixed"; readonly amount: Money }
  | { readonly kind: "free_shipping" }
  | {
      readonly kind: "bogo";
      readonly buyQty: number;
      readonly getQty: number;
      /** 10_000 = the "get" units are free. */
      readonly getPercentBps: number;
    }
  | { readonly kind: "tiered"; readonly tiers: readonly Tier[] };

export interface Targeting {
  /** Empty means every store (platform promotions). Store-owned promotions are always pinned to their store. */
  readonly storeIds: readonly string[];
  /** Empty means every SKU. */
  readonly skuIds: readonly string[];
  /** Empty means any payment method. */
  readonly paymentMethods: readonly PaymentMethod[];
  readonly plusOnly: boolean;
}

/** Economic terms are immutable once created; only status, end date and caps are edited (spec 17). */
export interface Promotion {
  readonly id: string;
  readonly version: number;
  readonly owner: PromotionOwner;
  readonly scope: PromotionScope;
  readonly value: PromotionValue;
  /** Normalised (trimmed, upper case). Null for auto promotions. A promotion has a code XOR autoApply. */
  readonly code: string | null;
  readonly autoApply: boolean;
  readonly funding: Funding;
  readonly targeting: Targeting;
  /** Eligible merchandise subtotal (list price) needed; per store for store and shipping scope. */
  readonly minOrder: Money | null;
  /** Cap on the total discount of this promotion in one evaluation. */
  readonly maxDiscount: Money | null;
  readonly perUserCap: number | null;
  readonly perDayCap: number | null;
  /** Total promotion spend over its life; remaining budget comes from `Usage.spent`. */
  readonly totalBudget: Money | null;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly status: PromotionStatus;
}

export interface EvalLine {
  readonly skuId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly unitPrice: Money;
}

export interface ShippingFee {
  readonly storeId: string;
  readonly fee: Money;
}

/** Already-consumed amounts for one promotion, read by the use case before evaluating. */
export interface Usage {
  readonly userRedemptions: number;
  readonly dayRedemptions: number;
  readonly spent: bigint;
}

export interface EvalRequest {
  readonly userId: string;
  readonly lines: readonly EvalLine[];
  readonly shippingFees: readonly ShippingFee[];
  /** Voucher codes the shopper entered (any case). At most 5 are considered. */
  readonly codes: readonly string[];
  readonly paymentMethod: PaymentMethod | null;
  readonly isPlus: boolean;
  /** Injected instant, so the result is a pure function of the request (idempotent re-evaluation). */
  readonly atMs: number;
  /** Keyed by promotion id; a missing entry means no usage yet. */
  readonly usage: ReadonlyMap<string, Usage>;
}

/** The stacking matrix as data (spec 17). Versioned so an order can cite the policy it used. */
export interface StackingPolicy {
  readonly version: number;
  readonly maxPlatformCodes: number;
  readonly maxStoreVouchersPerStore: number;
  readonly maxAutoPerScope: number;
  readonly maxCandidates: number;
}

export const DEFAULT_STACKING_POLICY: StackingPolicy = {
  version: 1,
  maxPlatformCodes: 1,
  maxStoreVouchersPerStore: 1,
  maxAutoPerScope: 1,
  maxCandidates: 5,
};

export interface Split {
  readonly amount: bigint;
  readonly platformFunded: bigint;
  readonly sellerFunded: bigint;
}

export interface LineAllocation extends Split {
  readonly lineIndex: number;
}

export interface ShippingAllocation extends Split {
  readonly storeId: string;
}

export interface AppliedPromotion extends Split {
  readonly promotionId: string;
  readonly promotionVersion: number;
  readonly code: string | null;
  readonly scope: PromotionScope;
  /** Always a "voucher minus X" line; a promotion never creates a reference price or "% off" claim (spec 9, 17). */
  readonly display: "voucher_minus";
  readonly lines: readonly LineAllocation[];
  readonly shipping: readonly ShippingAllocation[];
}

export type RejectReason =
  | "unknown_code"
  | "too_many_codes"
  | "not_active"
  | "not_started"
  | "expired"
  | "per_user_cap_reached"
  | "per_day_cap_reached"
  | "budget_exhausted"
  | "payment_method_not_eligible"
  | "plus_members_only"
  | "no_eligible_lines"
  | "min_order_not_met"
  | "no_discount"
  | "candidate_limit"
  | "stacking_conflict"
  | "no_additional_saving";

export interface RejectedPromotion {
  readonly code: string | null;
  readonly promotionId: string | null;
  readonly reason: RejectReason;
}

export interface LineResult {
  readonly lineIndex: number;
  readonly subtotal: bigint;
  readonly discount: bigint;
  readonly payable: bigint;
}

export interface ShippingResult {
  readonly storeId: string;
  readonly fee: bigint;
  readonly discount: bigint;
  readonly payable: bigint;
}

export interface EvaluationResult {
  readonly policyVersion: number;
  readonly applied: readonly AppliedPromotion[];
  readonly rejected: readonly RejectedPromotion[];
  readonly lines: readonly LineResult[];
  readonly shipping: readonly ShippingResult[];
  readonly merchandiseSubtotal: bigint;
  readonly merchandiseDiscount: bigint;
  readonly shippingFee: bigint;
  readonly shippingDiscount: bigint;
  readonly totalDiscount: bigint;
  /** Merchandise after discounts plus shipping after discounts. Never negative. */
  readonly payableTotal: bigint;
}
