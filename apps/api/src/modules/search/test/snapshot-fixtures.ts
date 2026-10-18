import type { ListingSnapshot, ListingSnapshotPort } from "../domain/ports";
import { P, S, C } from "./index-contract";

export const BRAND = "00000000-0000-4000-d000-000000000001";
type Listed = Extract<ListingSnapshot, { listed: true }>;
const egp = (n: bigint) => ({ amount: n, currency: "EGP" as const });

export const listed = (n: number, over: Partial<Listed> = {}): Listed => ({
  listed: true,
  productId: P(n),
  storeId: S(1),
  version: 1,
  createdAtMs: 1_700_000_000_000,
  publishedAtMs: 1_700_000_100_000,
  title: { ar: `فستان ${n}`, en: `Dress ${n}` },
  categoryId: C(1),
  brandId: BRAND,
  brand: { id: BRAND, nameAr: "أكمي", nameEn: "Acme" },
  condition: "new_with_tags",
  department: "women",
  material: "linen",
  storeKind: "local",
  storeOpen: true,
  imageUrl: null,
  blurhash: null,
  skus: [{ id: `sku-${n}`, price: egp(150_000n), available: true, color: "white", priceBlock: { badge: "none", referencePrice: null, discountPct: null, claimId: null } }],
  ...over,
});

export const unlisted = (n: number, version: number): ListingSnapshot => ({
  listed: false,
  productId: P(n),
  storeId: S(1),
  version,
});

export class FakeSnapshots implements ListingSnapshotPort {
  readonly map = new Map<string, ListingSnapshot>();
  calls = 0;
  set(s: ListingSnapshot): void {
    this.map.set(s.productId, s);
  }
  async snapshot(id: string): Promise<ListingSnapshot | null> {
    this.calls += 1;
    return this.map.get(id) ?? null;
  }
}
