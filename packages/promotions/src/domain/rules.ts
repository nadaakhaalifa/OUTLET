import { z } from "zod";
import { PromotionError } from "./errors.js";

const minor = z.string().regex(/^[0-9]{1,15}$/, "minor units as a non-negative integer string");
const bps = z.number().int().min(1).max(10_000);
const ids = z.array(z.string().min(1).max(64)).min(1).max(100);

export const PROMOTION_TYPES = ["percent", "fixed", "free_shipping", "bogo", "tiered", "bundle", "first_order", "birthday", "win_back", "payment_partner", "store_follower"] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];
export const LEVELS = ["item", "store", "order", "shipping", "payment_partner"] as const;
export type Level = (typeof LEVELS)[number];
export const STACKING_CLASSES = ["platform_code", "store_voucher", "auto", "payment_partner"] as const;
export type StackingClass = (typeof STACKING_CLASSES)[number];
export const OWNER_TYPES = ["platform", "store", "co_funded"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];
export const PROMOTION_STATUSES = ["DRAFT", "SCHEDULED", "ACTIVE", "PAUSED", "ENDED", "EXHAUSTED"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export const discountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("percent"), bps }).strict(),
  z.object({ kind: z.literal("fixed"), amountMinor: minor.refine((v) => BigInt(v) > 0n, "must be positive") }).strict(),
  z.object({ kind: z.literal("free_shipping") }).strict(),
  z.object({ kind: z.literal("bogo"), buyQty: z.number().int().min(1).max(10), getQty: z.number().int().min(1).max(10), getBps: bps.default(10_000) }).strict(),
  z
    .object({
      kind: z.literal("tiered"),
      tiers: z.array(z.object({ minSubtotalMinor: minor, bps }).strict()).min(1).max(10),
    })
    .strict()
    .refine((v) => v.tiers.every((t, i) => i === 0 || BigInt(t.minSubtotalMinor) > BigInt(v.tiers[i - 1]?.minSubtotalMinor ?? "0")), "tiers must be strictly ascending by minSubtotalMinor"),
  z.object({ kind: z.literal("bundle"), productIds: z.array(z.string().min(1).max(64)).min(2).max(5), bps }).strict(),
]);
export type Discount = z.infer<typeof discountSchema>;

/** Targeting. NO budget, wellbeing or measurement fields exist here, by construction (master prompt section 12 / 17). */
export const targetingSchema = z
  .object({
    storeIds: ids.optional(),
    categoryIds: ids.optional(),
    productIds: ids.optional(),
    cities: ids.optional(),
    segments: ids.optional(),
    tiers: ids.optional(),
    paymentMethods: ids.optional(),
    plusOnly: z.boolean().optional(),
    /** win_back: minimum days since the last order (default 60) */
    minDaysSinceLastOrder: z.number().int().min(1).max(3650).optional(),
  })
  .strict();
export type Targeting = z.infer<typeof targetingSchema>;

export const rulesSchema = z.object({ level: z.enum(LEVELS), discount: discountSchema, targeting: targetingSchema.default({}) }).strict();
export type Rules = z.infer<typeof rulesSchema>;

export interface PromotionDraft {
  readonly ownerType: OwnerType;
  readonly storeId: string | null;
  readonly type: PromotionType;
  readonly stackingClass: StackingClass;
  readonly rules: Rules;
  readonly fundingPlatformBp: number;
  readonly fundingSellerBp: number;
}

const bad = (m: string): never => {
  throw new PromotionError("INVALID_PROMOTION", m);
};

export const parseRules = (raw: unknown): Rules => {
  const r = rulesSchema.safeParse(raw);
  if (!r.success) throw new PromotionError("INVALID_RULES", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
};

const KIND_OF: Partial<Record<PromotionType, readonly Discount["kind"][]>> = {
  percent: ["percent"], fixed: ["fixed"], free_shipping: ["free_shipping"], bogo: ["bogo"], tiered: ["tiered"], bundle: ["bundle"],
  first_order: ["percent", "fixed"], birthday: ["percent", "fixed"], win_back: ["percent", "fixed"], payment_partner: ["percent", "fixed"], store_follower: ["percent", "fixed"],
};

/** Cross-field validation shared by create and update. Throws INVALID_PROMOTION / INVALID_RULES. */
export const validateDraft = (d: PromotionDraft): void => {
  if (!(KIND_OF[d.type] ?? []).includes(d.rules.discount.kind)) bad(`type ${d.type} cannot use discount ${d.rules.discount.kind}`);
  if (d.fundingPlatformBp + d.fundingSellerBp !== 10_000) bad("funding must sum to 10000 bp");
  if (d.ownerType === "platform" && (d.storeId !== null || d.fundingPlatformBp !== 10_000)) bad("platform promotions have no store and are 100% platform-funded");
  if (d.ownerType === "store" && (d.storeId === null || d.fundingSellerBp !== 10_000)) bad("store promotions need a store and are 100% seller-funded");
  if (d.ownerType === "co_funded" && (d.storeId === null || d.fundingPlatformBp === 0 || d.fundingSellerBp === 0)) bad("co-funded promotions need a store and both funders");
  const isShip = d.rules.discount.kind === "free_shipping";
  if (isShip !== (d.rules.level === "shipping")) bad("free_shipping is the only discount at level shipping");
  if ((d.type === "payment_partner") !== (d.rules.level === "payment_partner")) bad("payment_partner type and level go together");
  if ((d.type === "payment_partner") !== (d.stackingClass === "payment_partner")) bad("payment_partner type and stacking class go together");
  if (d.type === "payment_partner" && (d.rules.targeting.paymentMethods?.length ?? 0) === 0) bad("payment_partner needs targeting.paymentMethods");
  if (d.rules.level === "store" && d.storeId === null) bad("store level needs a store");
  if (d.stackingClass === "store_voucher" && d.storeId === null) bad("store vouchers belong to a store");
  if (d.stackingClass === "platform_code" && d.ownerType !== "platform") bad("platform codes are platform promotions");
  if (d.stackingClass === "platform_code" && d.rules.level === "store") bad("platform codes cannot be store level");
};

export const requiresCode = (c: StackingClass): boolean => c === "platform_code" || c === "store_voucher";
