import type { Candidate } from "../recommendations/types";
import { forbiddenFeatureKeys, type UserFeatures } from "../recommendations/features";

/**
 * Closed feature vector contract of the v2 ranker (master prompt 20.5). Item and affinity features
 * only. There is deliberately no budget, affordability, price ceiling, installment or measurement
 * feature: budget fit is a request-time filter applied after ranking and is never stored, logged
 * or fed to a model (spec 12 Privacy). `forbiddenFeatureKeys` is the enforcement point.
 */
export const RANKING_FEATURE_NAMES = [
  "popularity",
  "freshness",
  "verified_discount_pct",
  "seller_health",
  "price_trust",
  "return_rate_permille",
  "in_stock",
  "size_available",
  "is_new_seller",
  "category_affinity",
  "store_affinity",
] as const;
export type RankingFeatureName = (typeof RANKING_FEATURE_NAMES)[number];

export const FEATURE_SCHEMA_VERSION = "ranking-features-v2.1";
const DAY_MS = 86_400_000;

export interface RankingFeatureVector {
  readonly productId: string;
  readonly storeId: string;
  readonly personalized: boolean;
  readonly values: Readonly<Record<RankingFeatureName, number>>;
}

/**
 * Builds the vector. When `personalized` is false the user features are not read at all, so the
 * affinity columns are exactly 0 and nothing about the shopper reaches the model.
 */
export function buildFeatureVector(
  c: Candidate,
  user: UserFeatures | null,
  personalized: boolean,
  nowMs: number,
  sizeLabels: readonly string[] | null = null,
): RankingFeatureVector {
  const ageDays = Math.max(0, (nowMs - c.createdAtMs) / DAY_MS);
  const u = personalized ? user : null;
  const sizeOk = sizeLabels === null || c.sizesInStock.length === 0 || c.sizesInStock.some((s) => sizeLabels.includes(s));
  return {
    productId: c.productId,
    storeId: c.storeId,
    personalized: u !== null,
    values: {
      popularity: c.popularity,
      freshness: Math.round(1000 / (1 + ageDays / 7)),
      verified_discount_pct: c.claimAllowed ? c.verifiedDiscountPct : 0,
      seller_health: c.sellerHealth,
      price_trust: c.priceTrust,
      return_rate_permille: c.returnRatePermille,
      in_stock: c.inStock ? 1 : 0,
      size_available: sizeOk ? 1 : 0,
      is_new_seller: c.isNewSeller ? 1 : 0,
      category_affinity: u?.categoryAffinity[c.categoryId] ?? 0,
      store_affinity: u?.storeAffinity[c.storeId] ?? 0,
    },
  };
}

/** Offending key paths of a vector or log payload; empty means clean. */
export function vectorViolations(v: unknown): string[] {
  const out = forbiddenFeatureKeys(v);
  if (v !== null && typeof v === "object") {
    const values = (v as { values?: unknown }).values;
    if (values !== null && typeof values === "object") {
      for (const k of Object.keys(values as Record<string, unknown>)) {
        if (!(RANKING_FEATURE_NAMES as readonly string[]).includes(k)) out.push(`values.${k}`);
      }
    }
  }
  return out;
}
