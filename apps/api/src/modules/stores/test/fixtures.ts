import type { Store, StoreStats } from "../domain/store";

export const uuid = (n: number): string => `0192f3a4-1111-7000-8000-${String(n).padStart(12, "0")}`;

export const EMPTY_STATS: StoreStats = {
  maxVerifiedDiscountPct: null,
  ratingAvg: null,
  ratingCount: 0,
  liveDrop: false,
  trendingScore: 0,
  lastDropAtMs: null,
  p80DeliveryHours: null,
};

export function makeStore(n: number, over: Partial<Store> = {}): Store {
  return {
    id: uuid(n),
    sellerId: uuid(5000 + n),
    kind: "local",
    slug: `store-${n}`,
    nameAr: `متجر ${n}`,
    nameEn: `Store ${n}`,
    descriptionAr: null,
    descriptionEn: null,
    status: "ACTIVE",
    sellerKycState: "APPROVED",
    healthScore: 90,
    verifiedBadge: true,
    logoUrl: null,
    coverUrl: null,
    freeDeliveryThresholdAmount: 200_000n,
    stats: EMPTY_STATS,
    legalIdentity: {
      legalNameAr: `شركة ${n} (تجريبي)`,
      legalNameEn: null,
      commercialRegisterNo: `CR-${n}`,
      taxCardNo: `TX-${n}`,
      governorate: "الجيزة",
    },
    ...over,
  };
}
