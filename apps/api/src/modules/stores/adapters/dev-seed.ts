import type { Store, StoreStats } from "../domain/store";

/**
 * SYNTHETIC development fixtures. No real seller, brand or person. Discounts and ratings below
 * stand in for derived values that pricing-integrity and reviews will write; they are never
 * produced by this module and must not reach a real shopper.
 */
const NO_STATS: StoreStats = {
  maxVerifiedDiscountPct: null,
  ratingAvg: null,
  ratingCount: 0,
  liveDrop: false,
  trendingScore: 0,
  lastDropAtMs: null,
  p80DeliveryHours: null,
};

const DAY = 86_400_000;
export const SEED_REFERENCE_MS = 1_800_000_000_000;

export const id = (n: number): string => `0192f3a4-0000-7000-8000-${String(n).padStart(12, "0")}`;

interface SeedInput {
  readonly n: number;
  readonly sellerN: number;
  readonly kind: Store["kind"];
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly status?: Store["status"];
  readonly kyc?: Store["sellerKycState"];
  readonly stats?: Partial<StoreStats>;
  readonly legal?: boolean;
  readonly verified?: boolean;
  readonly health?: number | null;
}

function seedStore(i: SeedInput): Store {
  return {
    id: id(i.n),
    sellerId: id(9000 + i.sellerN),
    kind: i.kind,
    slug: i.slug,
    nameAr: i.nameAr,
    nameEn: i.nameEn,
    descriptionAr: null,
    descriptionEn: null,
    status: i.status ?? "ACTIVE",
    sellerKycState: i.kyc ?? "APPROVED",
    healthScore: i.health === undefined ? 85 : i.health,
    verifiedBadge: i.verified ?? true,
    logoUrl: null,
    coverUrl: null,
    freeDeliveryThresholdAmount: 200_000n,
    stats: { ...NO_STATS, ...(i.stats ?? {}) },
    legalIdentity:
      i.legal === false
        ? null
        : {
            legalNameAr: `${i.nameAr} للتجارة (بيانات تجريبية)`,
            legalNameEn: i.nameEn === null ? null : `${i.nameEn} Trading (synthetic)`,
            commercialRegisterNo: `SYN-CR-${i.n}`,
            taxCardNo: `SYN-TAX-${i.n}`,
            governorate: "القاهرة",
          },
  };
}

export function devSeedStores(): readonly Store[] {
  return [
    seedStore({ n: 1, sellerN: 1, kind: "local", slug: "nile-outlet", nameAr: "نايل أوتلت", nameEn: "Nile Outlet",
      stats: { maxVerifiedDiscountPct: 40, ratingAvg: 4.5, ratingCount: 12, liveDrop: true, trendingScore: 90, lastDropAtMs: SEED_REFERENCE_MS - DAY, p80DeliveryHours: 48 } }),
    seedStore({ n: 2, sellerN: 2, kind: "local", slug: "delta-wear", nameAr: "دلتا وير", nameEn: "Delta Wear",
      stats: { maxVerifiedDiscountPct: 25, ratingAvg: 4.1, ratingCount: 5, trendingScore: 70, lastDropAtMs: SEED_REFERENCE_MS - 5 * DAY, p80DeliveryHours: 24 } }),
    seedStore({ n: 3, sellerN: 3, kind: "local", slug: "oasis-basics", nameAr: "واحة بيزكس", nameEn: "Oasis Basics",
      stats: { trendingScore: 70, p80DeliveryHours: 72 } }),
    seedStore({ n: 4, sellerN: 4, kind: "global", slug: "north-label", nameAr: "نورث ليبل", nameEn: "North Label",
      stats: { maxVerifiedDiscountPct: 60, ratingAvg: 3.9, ratingCount: 40, trendingScore: 50, lastDropAtMs: SEED_REFERENCE_MS - 2 * DAY } }),
    seedStore({ n: 5, sellerN: 5, kind: "global", slug: "harbor-co", nameAr: "هاربر", nameEn: null,
      stats: { maxVerifiedDiscountPct: 30, trendingScore: 10 } }),
    seedStore({ n: 6, sellerN: 6, kind: "local", slug: "palm-vacation", nameAr: "بالم", nameEn: "Palm", status: "PAUSED",
      stats: { trendingScore: 5 } }),
    seedStore({ n: 7, sellerN: 7, kind: "local", slug: "suspended-shop", nameAr: "متجر موقوف", nameEn: "Suspended Shop", status: "SUSPENDED" }),
    seedStore({ n: 8, sellerN: 8, kind: "global", slug: "kyc-suspended", nameAr: "بائع موقوف", nameEn: "KYC Suspended", kyc: "SUSPENDED" }),
    seedStore({ n: 9, sellerN: 9, kind: "local", slug: "draft-shop", nameAr: "مسودة", nameEn: "Draft", status: "DRAFT", kyc: "DRAFT" }),
    seedStore({ n: 10, sellerN: 10, kind: "local", slug: "no-legal-identity", nameAr: "بدون هوية", nameEn: "No Legal Identity", legal: false }),
  ];
}
