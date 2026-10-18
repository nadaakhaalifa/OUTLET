import { beforeEach, describe, expect, it } from "vitest";
import type { IndexedProduct, SearchIndexWriter, SearchPort, SearchRequest } from "../domain/ports";

export interface IndexContext {
  readonly port: SearchPort;
  readonly writer: SearchIndexWriter;
}

export const P = (n: number): string => `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`;
export const S = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
export const C = (n: number): string => `00000000-0000-4000-c000-${String(n).padStart(12, "0")}`;
export const T0 = 1_800_000_000_000;

export const doc = (n: number, over: Partial<IndexedProduct> = {}): IndexedProduct => ({
  productId: P(n),
  storeId: S(1),
  world: "local",
  titleAr: `منتج ${n}`,
  titleEn: `Product ${n}`,
  searchText: `product ${n}`,
  priceAmount: 100_000n,
  colors: [],
  materials: [],
  condition: "new_with_tags",
  categoryIds: [],
  verifiedDiscountPct: null,
  lowest30d: false,
  freeDeliveryEligible: false,
  rating: null,
  sponsored: false,
  inStock: true,
  listedAtMs: T0 - n * 1000,
  ...over,
});

export const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({
  keywords: "",
  filter: {},
  storeScope: null,
  limit: 50,
  offset: 0,
  nowMs: T0,
  ...over,
});

/** Behaviour every SearchPort + SearchIndexWriter must have. In-memory is the reference semantics. */
export function describeSearchIndexContract(name: string, make: () => Promise<IndexContext>): void {
  describe(`SearchPort contract: ${name}`, () => {
    let c: IndexContext;
    beforeEach(async () => {
      c = await make();
    });
    const ids = async (r: Partial<SearchRequest>): Promise<string[]> =>
      (await c.port.search(req(r))).hits.map((h) => h.productId).sort();

    const B1 = "00000000-0000-4000-d000-000000000001";
    const B2 = "00000000-0000-4000-d000-000000000002";

    it("brand_ids filter matches only documents that carry one of the brands; no brand never matches", async () => {
      await c.writer.upsert(doc(1, { brandId: B1 }));
      await c.writer.upsert(doc(2, { brandId: B2 }));
      await c.writer.upsert(doc(3));
      await c.writer.upsert(doc(4, { brandId: null }));
      expect(await ids({ filter: { brandIds: [B1] } })).toEqual([P(1)]);
      expect(await ids({ filter: { brandIds: [B1, B2] } })).toEqual([P(1), P(2)]);
      expect(await ids({ filter: { brandIds: ["00000000-0000-4000-d000-0000000000ff"] } })).toEqual([]);
    });

    it("re-indexing is idempotent and updates or clears the brand", async () => {
      await c.writer.upsert(doc(1, { brandId: B1 }));
      await c.writer.upsert(doc(1, { brandId: B1 }));
      expect(await ids({ filter: { brandIds: [B1] } })).toEqual([P(1)]);
      expect(await ids({})).toEqual([P(1)]);
      await c.writer.upsert(doc(1, { brandId: B2 }));
      expect(await ids({ filter: { brandIds: [B1] } })).toEqual([]);
      expect(await ids({ filter: { brandIds: [B2] } })).toEqual([P(1)]);
      await c.writer.upsert(doc(1));
      expect(await ids({ filter: { brandIds: [B2] } })).toEqual([]);
    });

    it("returns in-stock documents newest first when there is no keyword", async () => {
      await c.writer.upsert(doc(1));
      await c.writer.upsert(doc(2));
      await c.writer.upsert(doc(3, { inStock: false }));
      const r = await c.port.search(req());
      expect(r.hits.map((h) => h.productId)).toEqual([P(1), P(2)]);
      expect(r.total).toBe(2);
    });

    it("upsert is idempotent and replaces; remove deletes", async () => {
      await c.writer.upsert(doc(1));
      await c.writer.upsert(doc(1, { priceAmount: 5n }));
      expect((await c.port.search(req())).total).toBe(1);
      await c.writer.remove(P(1));
      expect((await c.port.search(req())).total).toBe(0);
      await c.writer.remove(P(1));
    });

    it("matches keywords across Arabic, English and Franco forms of one concept", async () => {
      await c.writer.upsert(doc(1, { searchText: "فستان سهرة أبيض" }));
      await c.writer.upsert(doc(2, { searchText: "white linen Dress" }));
      await c.writer.upsert(doc(3, { searchText: "جزمة جلد" }));
      expect(await ids({ keywords: "dress" })).toEqual([P(1), P(2)]);
      expect(await ids({ keywords: "shoes" })).toEqual([P(3)]);
      expect(await ids({ keywords: "dress shoes" })).toEqual([]);
    });

    it("normalizes document text on write (diacritics, ta marbuta, digits)", async () => {
      await c.writer.upsert(doc(1, { searchText: "فُسْتَان" }));
      await c.writer.upsert(doc(2, { searchText: "ساعة ١٢٣" }));
      expect(await ids({ keywords: "dress" })).toEqual([P(1)]);
      expect(await ids({ keywords: "watch" })).toEqual([P(2)]);
      expect(await ids({ keywords: "123" })).toEqual([P(2)]);
    });

    it("prefix matches", async () => {
      await c.writer.upsert(doc(1, { searchText: "sneakers running" }));
      expect(await ids({ keywords: "runn" })).toEqual([P(1)]);
      expect(await ids({ keywords: "qwxz" })).toEqual([]);
    });

    it("filters by price, budget and facets", async () => {
      await c.writer.upsert(doc(1, { priceAmount: 50_000n, colors: ["white"], materials: ["linen"], condition: "sample" }));
      await c.writer.upsert(doc(2, { priceAmount: 150_000n, colors: ["black"], categoryIds: [C(1)] }));
      expect(await ids({ filter: { priceMax: 100_000n } })).toEqual([P(1)]);
      expect(await ids({ filter: { priceMin: 100_000n } })).toEqual([P(2)]);
      expect(await ids({ filter: { budgetMax: 50_000n } })).toEqual([P(1)]);
      expect(await ids({ filter: { colors: ["white", "red"] } })).toEqual([P(1)]);
      expect(await ids({ filter: { materials: ["linen"] } })).toEqual([P(1)]);
      expect(await ids({ filter: { conditions: ["sample"] } })).toEqual([P(1)]);
      expect(await ids({ filter: { categoryIds: [C(1)] } })).toEqual([P(2)]);
      expect(await ids({ filter: { colors: ["white"], priceMin: 100_000n } })).toEqual([]);
    });

    it("filters by world, store scope and explicit stores", async () => {
      await c.writer.upsert(doc(1, { world: "local", storeId: S(1) }));
      await c.writer.upsert(doc(2, { world: "global", storeId: S(2) }));
      expect(await ids({ filter: { world: "global" } })).toEqual([P(2)]);
      expect(await ids({ filter: { world: "everything" } })).toEqual([P(1), P(2)]);
      expect(await ids({ storeScope: [S(1)] })).toEqual([P(1)]);
      expect(await ids({ storeScope: [] })).toEqual([]);
      expect(await ids({ filter: { storeIds: [S(2)] } })).toEqual([P(2)]);
      expect(await ids({ storeScope: [S(1)], filter: { storeIds: [S(2)] } })).toEqual([]);
    });

    it("filters by verified discount, lowest 30d, rating, free delivery, new arrivals", async () => {
      await c.writer.upsert(doc(1, { verifiedDiscountPct: 40, lowest30d: true, rating: 4.5, freeDeliveryEligible: true }));
      await c.writer.upsert(doc(2, { verifiedDiscountPct: 10, rating: 3.0, listedAtMs: T0 - 30 * 86_400_000 }));
      expect(await ids({ filter: { verifiedDiscountOnly: true } })).toEqual([P(1), P(2)]);
      expect(await ids({ filter: { minVerifiedDiscountPct: 20 } })).toEqual([P(1)]);
      expect(await ids({ filter: { lowest30dOnly: true } })).toEqual([P(1)]);
      expect(await ids({ filter: { minRating: 4 } })).toEqual([P(1)]);
      expect(await ids({ filter: { freeDeliveryEligible: true } })).toEqual([P(1)]);
      expect(await ids({ filter: { newArrivals: true } })).toEqual([P(1)]);
    });

    it("pages with limit and offset and reports the total", async () => {
      for (let i = 1; i <= 5; i += 1) await c.writer.upsert(doc(i));
      const p1 = await c.port.search(req({ limit: 2, offset: 0 }));
      const p2 = await c.port.search(req({ limit: 2, offset: 2 }));
      const p3 = await c.port.search(req({ limit: 2, offset: 4 }));
      expect(p1.total).toBe(5);
      expect([...p1.hits, ...p2.hits, ...p3.hits].map((h) => h.productId)).toEqual([P(1), P(2), P(3), P(4), P(5)]);
    });

    it("carries the sponsored flag", async () => {
      await c.writer.upsert(doc(1, { sponsored: true }));
      expect((await c.port.search(req())).hits[0]?.sponsored).toBe(true);
    });

    it("does not treat query syntax in keywords as operators", async () => {
      await c.writer.upsert(doc(1, { searchText: "plain dress" }));
      expect(await ids({ keywords: "dress | ' ; drop table & !" })).toEqual([]);
      expect(await ids({ keywords: "'); select 1; --" })).toEqual([]);
      expect((await c.port.search(req({ keywords: "dress" }))).total).toBe(1);
    });

    it("suggests listing titles by prefix", async () => {
      await c.writer.upsert(doc(1, { titleAr: "فستان صيفي", searchText: "فستان صيفي" }));
      await c.writer.upsert(doc(2, { titleAr: "جزمة", searchText: "جزمة" }));
      expect(await c.port.suggest("فست", 5)).toEqual(["فستان صيفي"]);
    });
  });
}
