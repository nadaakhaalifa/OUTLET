import { MoneyWireSchema, UuidSchema, moneyToWire, type MoneyWire } from "@outlet/validation";
import { z } from "zod";
import {
  CONDITIONS,
  MAX_FACETS,
  WORLDS,
  canonicalizeFilter,
  countFacets,
  money,
  type SearchFilter,
} from "./bridge";

const nonNegative = MoneyWireSchema.refine((m) => !m.amount.startsWith("-"), { message: "amount must not be negative" });
const piastres = nonNegative.transform((w) => BigInt(w.amount));
const UuidArray = z.array(UuidSchema).max(30);
const StringArray = z.array(z.string().min(1).max(40)).max(30);

/**
 * Wire schema for SearchFilter (OpenAPI `SearchFilter`): strict allow-list, snake_case, money as
 * integer strings. Output is the domain filter. Facet cap is enforced here (API4).
 */
export const SearchFilterSchema = z
  .object({
    budget_max: piastres.optional(),
    fits_remaining_budget: z.boolean().optional(),
    installments_available: z.boolean().optional(),
    monthly_max: piastres.optional(),
    payable_with_store_credit: z.boolean().optional(),
    cod_available: z.boolean().optional(),
    my_size_only: z.boolean().optional(),
    world: z.enum(WORLDS).optional(),
    store_ids: UuidArray.optional(),
    category_ids: UuidArray.optional(),
    min_verified_discount_pct: z.number().int().min(5).max(100).optional(),
    price_min: piastres.optional(),
    price_max: piastres.optional(),
    colors: StringArray.optional(),
    materials: StringArray.optional(),
    conditions: z.array(z.enum(CONDITIONS)).max(4).optional(),
    free_delivery_eligible: z.boolean().optional(),
    verified_discount_only: z.boolean().optional(),
    lowest_30d_only: z.boolean().optional(),
    new_arrivals: z.boolean().optional(),
    min_rating: z.number().min(1).max(5).optional(),
  })
  .strict()
  .transform((w): SearchFilter => {
    const f: Record<string, unknown> = {};
    const put = (k: string, v: unknown): void => {
      if (v !== undefined) f[k] = v;
    };
    put("budgetMax", w.budget_max);
    put("fitsRemainingBudget", w.fits_remaining_budget);
    put("installmentsAvailable", w.installments_available);
    put("monthlyMax", w.monthly_max);
    put("payableWithStoreCredit", w.payable_with_store_credit);
    put("codAvailable", w.cod_available);
    put("mySizeOnly", w.my_size_only);
    put("world", w.world);
    put("storeIds", w.store_ids);
    put("categoryIds", w.category_ids);
    put("minVerifiedDiscountPct", w.min_verified_discount_pct);
    put("priceMin", w.price_min);
    put("priceMax", w.price_max);
    put("colors", w.colors);
    put("materials", w.materials);
    put("conditions", w.conditions);
    put("freeDeliveryEligible", w.free_delivery_eligible);
    put("verifiedDiscountOnly", w.verified_discount_only);
    put("lowest30dOnly", w.lowest_30d_only);
    put("newArrivals", w.new_arrivals);
    put("minRating", w.min_rating);
    return canonicalizeFilter(f as SearchFilter);
  })
  .refine((f) => countFacets(f) <= MAX_FACETS, { message: `at most ${MAX_FACETS} facets are allowed` });

export type SearchFilterWire = z.input<typeof SearchFilterSchema>;

const wireMoney = (v: bigint): MoneyWire => moneyToWire(money(v));

export function filterToWire(f: SearchFilter): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  const put = (k: string, v: unknown): void => {
    if (v !== undefined) w[k] = v;
  };
  put("budget_max", f.budgetMax === undefined ? undefined : wireMoney(f.budgetMax));
  put("fits_remaining_budget", f.fitsRemainingBudget);
  put("installments_available", f.installmentsAvailable);
  put("monthly_max", f.monthlyMax === undefined ? undefined : wireMoney(f.monthlyMax));
  put("payable_with_store_credit", f.payableWithStoreCredit);
  put("cod_available", f.codAvailable);
  put("my_size_only", f.mySizeOnly);
  put("world", f.world);
  put("store_ids", f.storeIds);
  put("category_ids", f.categoryIds);
  put("min_verified_discount_pct", f.minVerifiedDiscountPct);
  put("price_min", f.priceMin === undefined ? undefined : wireMoney(f.priceMin));
  put("price_max", f.priceMax === undefined ? undefined : wireMoney(f.priceMax));
  put("colors", f.colors);
  put("materials", f.materials);
  put("conditions", f.conditions);
  put("free_delivery_eligible", f.freeDeliveryEligible);
  put("verified_discount_only", f.verifiedDiscountOnly);
  put("lowest_30d_only", f.lowest30dOnly);
  put("new_arrivals", f.newArrivals);
  put("min_rating", f.minRating);
  return w;
}

/** Parses a persisted filter_json; a corrupt row degrades to an empty filter rather than a 500. */
export function filterFromStored(json: unknown): SearchFilter {
  const r = SearchFilterSchema.safeParse(json);
  return r.success ? r.data : {};
}
