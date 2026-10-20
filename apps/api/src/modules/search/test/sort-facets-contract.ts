import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SEARCH_SORTS, type IndexedProduct, type SearchSort } from "../domain/ports";
import { compareDocs } from "../adapters/matching";
import { C, S, doc, req, type IndexContext } from "./index-contract";

const arbDoc = (n: number) =>
  fc
    .record({
      store: fc.integer({ min: 1, max: 3 }),
      cats: fc.subarray([1, 2, 3, 4]),
      price: fc.integer({ min: 1, max: 5 }),
      disc: fc.option(fc.integer({ min: 5, max: 60 }), { nil: null }),
      age: fc.integer({ min: 0, max: 4 }),
      inStock: fc.boolean(),
    })
    .map((r): IndexedProduct =>
      doc(n, {
        storeId: S(r.store),
        categoryIds: r.cats.map(C),
        priceAmount: BigInt(r.price) * 10_000n,
        verifiedDiscountPct: r.disc,
        listedAtMs: doc(0).listedAtMs - r.age * 1000,
        inStock: r.inStock,
      }),
    );

/** Sort order and facet counts must agree with the reference semantics on every engine. */
export function describeSortAndFacetContract(name: string, make: () => Promise<IndexContext>, runs = 15): void {
  describe(`sort and facet counts: ${name}`, () => {
    it("every sort equals the reference ordering and pages are stable and disjoint", async () => {
      await fc.assert(
        fc.asyncProperty(fc.tuple(...Array.from({ length: 12 }, (_, i) => arbDoc(i + 1))), async (docs) => {
          const c = await make();
          for (const d of docs) await c.writer.upsert(d);
          for (const sort of SEARCH_SORTS as readonly SearchSort[]) {
            const expected = docs
              .filter((d) => d.inStock)
              .sort((a, b) => compareDocs(sort, a, b))
              .map((d) => d.productId);
            const all = (await c.port.search(req({ sort }))).hits.map((h) => h.productId);
            expect(all).toEqual(expected);
            const paged: string[] = [];
            for (let off = 0; off < expected.length; off += 5) {
              paged.push(...(await c.port.search(req({ sort, limit: 5, offset: off }))).hits.map((h) => h.productId));
            }
            expect(paged).toEqual(expected);
          }
        }),
        { numRuns: runs },
      );
    });

    it("facet counts equal the real result counts, with own selection ignored by the caller", async () => {
      await fc.assert(
        fc.asyncProperty(fc.tuple(...Array.from({ length: 12 }, (_, i) => arbDoc(i + 1))), fc.integer({ min: 1, max: 5 }), async (docs, maxPrice) => {
          const c = await make();
          if (c.port.facetCounts === undefined) throw new Error("engine must count");
          for (const d of docs) await c.writer.upsert(d);
          const filter = { priceMax: BigInt(maxPrice) * 10_000n };
          const matching = docs.filter((d) => d.inStock && d.priceAmount <= (filter.priceMax ?? 0n));
          const cats = await c.port.facetCounts(req({ filter }), "categories", 50);
          for (const b of cats) expect(b.count).toBe(matching.filter((d) => d.categoryIds.includes(b.id)).length);
          for (const id of [1, 2, 3, 4].map(C)) {
            const real = matching.filter((d) => d.categoryIds.includes(id)).length;
            expect(cats.find((b) => b.id === id)?.count ?? 0).toBe(real);
            // the count equals what filtering by that category really returns
            expect((await c.port.search(req({ filter: { ...filter, categoryIds: [id] } }))).total).toBe(real);
          }
          const stores = await c.port.facetCounts(req({ filter }), "stores", 50);
          for (const sid of [1, 2, 3].map(S)) {
            expect(stores.find((b) => b.id === sid)?.count ?? 0).toBe(matching.filter((d) => d.storeId === sid).length);
          }
          expect(stores.map((b) => b.count)).toEqual([...stores.map((b) => b.count)].sort((a, b) => b - a));
        }),
        { numRuns: runs },
      );
    });

    it("caps buckets", async () => {
      const c = await make();
      if (c.port.facetCounts === undefined) throw new Error("engine must count");
      for (let i = 1; i <= 6; i += 1) await c.writer.upsert(doc(i, { storeId: S(i) }));
      expect((await c.port.facetCounts(req(), "stores", 3)).length).toBe(3);
    });
  });
}
