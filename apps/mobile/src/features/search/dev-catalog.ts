/**
 * DEV-only synthetic catalogue for exercising long lists, pagination and every Shop everything facet.
 * Pure and deterministic (index arithmetic only, no randomness, no clock). It never reads __DEV__ itself so it can be
 * unit-tested; the ONLY composition point is state/ports.ts, which includes it behind a `__DEV__` check, so production
 * bundles never reference it. Every name is plainly synthetic ("Demo store 07", "Demo item 042"): no brands, no
 * ratings, no viewer or sales counts, no fake urgency.
 */
import type { StoreSummary } from "../worlds/model";
import type { Condition, FakeSearchRow, ShopDepartment } from "./model";

export const DEV_CATALOG_SIZE = 60;
export const DEV_STORE_COUNT = 12;
/** Verified discount steps used by the Shop everything floor chips (10/20/30/50). */
export const DEV_DISCOUNT_STEPS = [10, 20, 30, 50] as const;

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
/** Same synthetic category ids as FIXTURE_CATEGORIES (features/shop-all/model.ts), literal to avoid an import cycle. */
const catId = (n: number): string => `00000000-0000-4000-8000-${pad(n, 12)}`;

export const devStoreId = (n: number): string => `demo-store-${pad(n, 2)}`;
export const devStoreName = (n: number): string => `Demo store ${pad(n, 2)}`;

/** department -> leaf category numbers (FIXTURE_CATEGORIES). "unisex" is the lifestyle department. */
const DEPARTMENTS: readonly ShopDepartment[] = ["women", "men", "kids", "unisex"];
const CATEGORIES: Readonly<Record<ShopDepartment, readonly [number, string][]>> = {
  women: [[1, "dresses"], [2, "tops"], [21, "tshirts"], [22, "shirts"], [3, "denim"], [10, "modest"]],
  men: [[21, "tshirts"], [22, "shirts"], [3, "denim"], [4, "outerwear"], [5, "shoes"]],
  kids: [[9, "kids"], [21, "tshirts"], [8, "activewear"], [5, "shoes"]],
  unisex: [[6, "bags"], [7, "accessories"], [71, "watches"], [72, "eyewear"], [5, "shoes"]],
};
const DISCOUNT_CYCLE: readonly (number | null)[] = [null, 10, 20, null, 30, 50, 20, 10, null, 30];
const CONDITION_CYCLE: readonly Condition[] = ["newWithTags", "newWithTags", "newWithoutTags", "newWithTags", "sample", "newWithoutTags", "newWithTags", "minorDefect"];

/** Item n (1-based) of the demo catalogue. */
function row(n: number): FakeSearchRow {
  const dept = DEPARTMENTS[n % 4] as ShopDepartment;
  const cats = CATEGORIES[dept];
  const [catNo, catSlug] = cats[Math.floor(n / 4) % cats.length] as [number, string];
  const store = (n * 7) % DEV_STORE_COUNT + 1;
  const egp = 150 + ((n * 173) % 2850);
  const price = BigInt(egp * 100 - 10);
  const pct = DISCOUNT_CYCLE[n % DISCOUNT_CYCLE.length] ?? null;
  // Reference price rounded UP so the integer verified percent is never overstated (spec 9.3, floor math on piastres).
  const reference = pct === null ? null : (price * 100n + BigInt(100 - pct) - 1n) / BigInt(100 - pct);
  return {
    id: `demo-item-${pad(n, 3)}`,
    title: `Demo item ${pad(n, 3)}`,
    storeName: devStoreName(store),
    storeId: devStoreId(store),
    categoryId: catId(catNo),
    department: dept,
    price,
    verifiedDiscountPct: pct,
    referencePrice: reference,
    sponsored: false,
    inMySize: n % 3 !== 1,
    condition: CONDITION_CYCLE[n % CONDITION_CYCLE.length] as Condition,
    installments: n % 2 === 0,
    creditOk: n % 3 !== 0,
    keywords: `${catSlug} ${dept === "unisex" ? "lifestyle" : dept}`,
    isNew: n % 5 === 0,
    available: n % 11 !== 0,
    freeDelivery: n % 3 === 0,
    // Honest: "lowest in 30 days" only ever accompanies a verified discount.
    lowest30d: pct !== null && n % 4 === 1,
  };
}

export function generateDevCatalog(count: number = DEV_CATALOG_SIZE): readonly FakeSearchRow[] {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => row(i + 1));
}

/** Demo online stores for the store filter, alternating local and global. Stats come from the catalogue only. */
export function generateDevStores(items: readonly FakeSearchRow[] = generateDevCatalog()): readonly StoreSummary[] {
  return Array.from({ length: DEV_STORE_COUNT }, (_, i): StoreSummary => {
    const n = i + 1;
    const mine = items.filter((r) => r.storeId === devStoreId(n));
    const best = mine.reduce((m, r) => Math.max(m, r.verifiedDiscountPct ?? 0), 0);
    return {
      id: devStoreId(n), name: devStoreName(n), kind: n % 2 === 0 ? "global" : "local", status: "active",
      maxVerifiedDiscountPct: best >= 5 ? best : null, rating: null, followerCount: 0, liveDrop: false,
      trendingRank: 100 + n, newestDropAtMs: null, deliveryDays: 1 + (n % 5), isFavourite: false,
    };
  });
}
