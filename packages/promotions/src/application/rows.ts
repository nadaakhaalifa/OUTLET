import type { Currency } from "@outlet/money";
import { parseRules } from "../domain/rules.js";
import type { OwnerType, PromotionStatus, PromotionType, StackingClass } from "../domain/rules.js";
import type { PromotionCandidate } from "../domain/types.js";

export interface PromotionRow {
  id: string; market_id: string; owner_type: OwnerType; store_id: string | null; type: PromotionType; name_ar: string; name_en: string | null;
  rules: unknown; stacking_class: StackingClass; funding_platform_bp: number; funding_seller_bp: number; per_user_limit: number | null; total_limit: number | null;
  min_order_minor: string | bigint | null; max_discount_minor: string | bigint | null; budget_minor: string | bigint | null; currency: Currency;
  starts_at: Date | string; ends_at: Date | string; status: PromotionStatus; version: number;
}
export const PROMOTION_COLS = `id, market_id, owner_type, store_id, type, name_ar, name_en, rules, stacking_class, funding_platform_bp, funding_seller_bp, per_user_limit,
  total_limit, min_order_minor, max_discount_minor, budget_minor, currency, starts_at, ends_at, status, version`;

const big = (v: string | bigint | null): bigint | null => (v === null ? null : BigInt(v));
const date = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export const toCandidate = (r: PromotionRow, voucherId: string | null = null): PromotionCandidate => ({
  id: r.id, version: r.version, ownerType: r.owner_type, storeId: r.store_id, type: r.type, stackingClass: r.stacking_class, rules: parseRules(r.rules),
  fundingPlatformBp: r.funding_platform_bp, fundingSellerBp: r.funding_seller_bp, perUserLimit: r.per_user_limit, totalLimit: r.total_limit,
  minOrderMinor: big(r.min_order_minor), maxDiscountMinor: big(r.max_discount_minor), budgetMinor: big(r.budget_minor), currency: r.currency,
  startsAt: date(r.starts_at), endsAt: date(r.ends_at), status: r.status, voucherId,
});
