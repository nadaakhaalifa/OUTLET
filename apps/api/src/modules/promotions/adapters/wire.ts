import { z } from "zod";
import { money, promotions, type Money } from "../domain/bridge";
import type { PromotionRecord } from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();

export function moneyWire(m: Money): { amount: string; currency: "EGP" } {
  return { amount: m.amount.toString(), currency: m.currency };
}

/** Output shape of schemas/Promotion. Funding and version are server owned. */
export function promotionWire(p: PromotionRecord) {
  return {
    id: p.id,
    type: p.value.kind,
    title: { ar: p.title.ar, ...(p.title.en !== undefined ? { en: p.title.en } : {}) },
    ...(p.code !== null ? { code: p.code } : {}),
    auto_apply: p.autoApply,
    funding: { platform_pct: p.funding.platformPct, seller_pct: p.funding.sellerPct },
    ...(p.minOrder !== null ? { min_order: moneyWire(p.minOrder) } : {}),
    ...(p.maxDiscount !== null ? { max_discount: moneyWire(p.maxDiscount) } : {}),
    ...(p.perUserCap !== null ? { per_user_cap: p.perUserCap } : {}),
    ...(p.totalBudget !== null ? { total_budget: moneyWire(p.totalBudget) } : {}),
    starts_at: iso(p.startsAtMs),
    ends_at: iso(p.endsAtMs),
    status: p.status,
    version: p.version,
  };
}

export const etagOf = (p: PromotionRecord): string => `"${p.id}-v${p.version}"`;

// ---- request schemas (strict allow-lists, Zod at the boundary) -----------------------------

export const MoneyIn = z
  .object({ amount: z.string().regex(/^-?[0-9]{1,18}$/), currency: z.literal("EGP") })
  .strict()
  .transform((m): Money => money(BigInt(m.amount)));

const LocalizedText = z.object({ ar: z.string().min(1).max(2000), en: z.string().max(2000).optional() }).strict();
const Uuid = z.uuid();
const Timestamp = z.iso.datetime({ offset: true });

/** Phase 1 kinds only. Wider spec kinds answer 422 `promotion_type_not_supported`. */
const SPEC_TYPES = [
  "percent",
  "fixed",
  "free_shipping",
  "bogo",
  "tiered",
  "bundle",
  "first_order",
  "birthday",
  "win_back",
  "payment_partner",
  "plus_only",
  "store_follower",
] as const;

export const PromotionInput = z
  .object({
    type: z.enum(SPEC_TYPES),
    title: LocalizedText,
    code: z.string().min(1).max(40).optional(),
    auto_apply: z.boolean().optional(),
    funding: z
      .object({ platform_pct: z.number().int().min(0).max(100), seller_pct: z.number().int().min(0).max(100) })
      .strict(),
    value: z
      .object({ percent_bp: z.number().int().min(1).max(10_000).optional(), fixed: MoneyIn.optional() })
      .strict()
      .optional(),
    // Extensions to PromotionInput needed for bogo, tiered and scope (OpenAPI delta, see gaps).
    scope: z.enum(promotions.PROMOTION_SCOPES).optional(),
    bogo: z
      .object({
        buy_qty: z.number().int().min(1).max(100),
        get_qty: z.number().int().min(1).max(100),
        get_percent_bp: z.number().int().min(1).max(10_000).optional(),
      })
      .strict()
      .optional(),
    tiers: z
      .array(z.object({ min_subtotal: MoneyIn, percent_bp: z.number().int().min(1).max(10_000) }).strict())
      .min(1)
      .max(10)
      .optional(),
    min_order: MoneyIn.optional(),
    max_discount: MoneyIn.optional(),
    per_user_cap: z.number().int().min(1).optional(),
    per_day_cap: z.number().int().min(1).optional(),
    total_budget: MoneyIn.optional(),
    targeting: z
      .object({
        store_ids: z.array(Uuid).max(100).optional(),
        sku_ids: z.array(Uuid).max(500).optional(),
        category_ids: z.array(Uuid).max(100).optional(),
        product_ids: z.array(Uuid).max(500).optional(),
        governorate_codes: z.array(z.string().max(40)).max(30).optional(),
        payment_methods: z.array(z.enum(promotions.PAYMENT_METHODS)).max(8).optional(),
        plus_only: z.boolean().optional(),
      })
      .strict()
      .optional(),
    starts_at: Timestamp,
    ends_at: Timestamp,
  })
  .strict();
export type PromotionInputT = z.infer<typeof PromotionInput>;

export const PromotionUpdate = z
  .object({
    title: LocalizedText.optional(),
    status: z.enum(["paused", "active", "ended"]).optional(),
    ends_at: Timestamp.optional(),
    total_budget: MoneyIn.optional(),
    max_discount: MoneyIn.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "at least one field is required" });
export type PromotionUpdateT = z.infer<typeof PromotionUpdate>;

export const ListQuery = z
  .object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();

export const IdParam = z.object({ promotionId: Uuid }).strict();

export const EvaluateBody = z
  .object({
    user_id: Uuid,
    lines: z
      .array(
        z
          .object({
            sku_id: Uuid,
            store_id: Uuid,
            qty: z.number().int().min(1).max(10_000),
            unit_price: MoneyIn,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    // Extension to PromotionEvaluateRequest: free-shipping needs the fee per store (OpenAPI delta).
    shipping_fees: z.array(z.object({ store_id: Uuid, fee: MoneyIn }).strict()).max(200).optional(),
    voucher_codes: z.array(z.string().max(60)).max(5).optional(),
    payment_method: z.enum(promotions.PAYMENT_METHODS).optional(),
    is_plus_member: z.boolean().optional(),
    at: Timestamp,
  })
  .strict();

export function evaluationWire(r: promotions.EvaluationResult) {
  return {
    applied: r.applied.map((a) => ({
      promotion_id: a.promotionId,
      scope: a.scope,
      amount: moneyWire(money(a.amount)),
    })),
    // Auto promotions have no code to show the shopper; only code-addressed rejections are returned.
    rejected: r.rejected.flatMap((x) => (x.code === null ? [] : [{ code: x.code, reason: x.reason }])),
    total_discount: moneyWire(money(r.totalDiscount)),
  };
}
