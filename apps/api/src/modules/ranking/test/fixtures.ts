import type { RankingFeatureVector } from "../domain/bridge";

export const FEATURES_FIXTURE: RankingFeatureVector["values"] = {
  popularity: 90,
  freshness: 800,
  verified_discount_pct: 20,
  seller_health: 80,
  price_trust: 75,
  return_rate_permille: 40,
  in_stock: 1,
  size_available: 1,
  is_new_seller: 0,
  category_affinity: 0,
  store_affinity: 0,
};
