import type { Currency, Money } from "@outlet/money";
import type { Level, OwnerType, PromotionStatus, PromotionType, Rules, StackingClass } from "./rules.js";

export interface EvalLine {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  readonly categoryId?: string;
  readonly qty: number;
  /** VAT-inclusive live unit price in minor units */
  readonly unitMinor: bigint;
  readonly vatBp: number;
}
export interface EvalStoreGroup {
  readonly storeId: string;
  /** delivery fee before any waiver, minor units */
  readonly shippingFeeMinor: bigint;
  readonly lines: readonly EvalLine[];
}
export interface EvalBag {
  readonly currency: Currency;
  readonly stores: readonly EvalStoreGroup[];
}

/** Facts about the shopper. Nothing here comes from budget, wellbeing, measurement or DOB data. */
export interface EvalContext {
  readonly now: Date;
  readonly userId: string;
  readonly isPlus: boolean;
  readonly isFirstOrder: boolean;
  /** computed by the caller from the shopper's own birthday window; the DOB itself never enters this package */
  readonly birthdayToday: boolean;
  readonly daysSinceLastOrder: number | null;
  readonly followedStoreIds: readonly string[];
  readonly paymentMethod: string | null;
  readonly city: string | null;
  readonly segments: readonly string[];
  readonly tier: string | null;
}

export interface PromotionCandidate {
  readonly id: string;
  readonly version: number;
  readonly ownerType: OwnerType;
  readonly storeId: string | null;
  readonly type: PromotionType;
  readonly stackingClass: StackingClass;
  readonly rules: Rules;
  readonly fundingPlatformBp: number;
  readonly fundingSellerBp: number;
  readonly perUserLimit: number | null;
  readonly minOrderMinor: bigint | null;
  readonly maxDiscountMinor: bigint | null;
  readonly budgetMinor: bigint | null;
  readonly totalLimit: number | null;
  readonly currency: Currency;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: PromotionStatus;
  /** set when the shopper entered a code that resolved to this promotion */
  readonly voucherId: string | null;
}

export interface UsageSnapshot {
  readonly userUses: number;
  readonly totalUses: number;
  readonly usedMinor: bigint;
}
export type UsageMap = ReadonlyMap<string, UsageSnapshot>;

export type RejectReason =
  | "inactive" | "not_started" | "ended" | "currency_mismatch" | "not_first_order" | "not_birthday" | "win_back_window" | "not_follower"
  | "payment_method" | "plus_only" | "segment" | "tier" | "city" | "per_user_limit" | "total_limit" | "budget_exhausted" | "no_eligible_lines" | "min_order" | "no_discount";

export interface LineDiscount { readonly lineId: string; readonly amount: Money; readonly platform: Money; readonly seller: Money }
export interface ShippingDiscount { readonly storeId: string; readonly amount: Money; readonly platform: Money; readonly seller: Money }

export interface AppliedPromotion {
  readonly promotionId: string;
  readonly version: number;
  readonly voucherId: string | null;
  readonly level: Level;
  readonly stackingClass: StackingClass;
  readonly total: Money;
  readonly platform: Money;
  readonly seller: Money;
  readonly lines: readonly LineDiscount[];
  readonly shipping: readonly ShippingDiscount[];
}

export interface LineResult {
  readonly lineId: string;
  readonly storeId: string;
  readonly gross: Money;
  readonly discount: Money;
  readonly platformDiscount: Money;
  readonly sellerDiscount: Money;
  readonly payable: Money;
}
export interface StoreResult {
  readonly storeId: string;
  readonly goodsGross: Money;
  readonly goodsDiscount: Money;
  readonly goodsPayable: Money;
  readonly shippingFee: Money;
  readonly shippingDiscount: Money;
  readonly shippingPayable: Money;
}

export interface EvaluationResult {
  readonly currency: Currency;
  readonly applied: readonly AppliedPromotion[];
  readonly rejected: readonly { readonly promotionId: string; readonly reason: RejectReason }[];
  readonly lines: readonly LineResult[];
  readonly stores: readonly StoreResult[];
  readonly totals: {
    readonly goodsGross: Money;
    readonly goodsDiscount: Money;
    readonly shippingFee: Money;
    readonly shippingDiscount: Money;
    readonly platformFunded: Money;
    readonly sellerFunded: Money;
    /** what the shopper pays for goods and delivery, before store credit */
    readonly payable: Money;
  };
}
