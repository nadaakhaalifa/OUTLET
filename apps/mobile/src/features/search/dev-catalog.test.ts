import { describe, expect, it } from "vitest";
import { EGYPT_AREAS } from "../stores-directory/egypt-areas";
import { DEV_OUTLET_AREAS, generateDevOutlets } from "../stores-directory/dev-outlets";
import { DEV_CATALOG_SIZE, DEV_DISCOUNT_STEPS, DEV_STORE_COUNT, generateDevCatalog, generateDevStores } from "./dev-catalog";
import { CONDITIONS, EMPTY_FILTER, InMemorySearchPort, SHOP_DEPARTMENTS, type SearchFilter } from "./model";

const catalog = generateDevCatalog();
const port = new InMemorySearchPort(catalog);
const f = (o: Partial<SearchFilter>): SearchFilter => ({ ...EMPTY_FILTER, world: "everything", ...o });

describe("dev catalogue generator", () => {
  it("is deterministic and sized", () => {
    expect(catalog.length).toBe(DEV_CATALOG_SIZE);
    expect(generateDevCatalog()).toEqual(catalog);
    expect(generateDevStores(catalog)).toEqual(generateDevStores(generateDevCatalog()));
  });
  it("has unique ids, synthetic names, sane integer money", () => {
    expect(new Set(catalog.map((r) => r.id)).size).toBe(catalog.length);
    for (const r of catalog) {
      expect(r.title).toMatch(/^Demo item \d{3}$/);
      expect(r.storeName).toMatch(/^Demo store \d{2}$/);
      expect(r.price > 0n).toBe(true);
      expect(r.sponsored).toBe(false);
      expect(r.brand ?? null).toBeNull();
    }
  });
  it("uses only allowed verified discount steps with an exact reference", () => {
    const seen = new Set<number>();
    for (const r of catalog) {
      if (r.verifiedDiscountPct === null) { expect(r.referencePrice).toBeNull(); expect(r.lowest30d).toBe(false); continue; }
      expect(DEV_DISCOUNT_STEPS).toContain(r.verifiedDiscountPct as 10);
      seen.add(r.verifiedDiscountPct);
      const ref = r.referencePrice as bigint;
      expect(Number(((ref - r.price) * 100n) / ref)).toBe(r.verifiedDiscountPct);
    }
    expect([...seen].sort()).toEqual([10, 20, 30, 50]);
  });
  it("covers every facet value", () => {
    for (const d of SHOP_DEPARTMENTS) expect(catalog.some((r) => r.department === d), d).toBe(true);
    for (const c of CONDITIONS) expect(catalog.some((r) => r.condition === c), c).toBe(true);
    expect(catalog.some((r) => r.freeDelivery)).toBe(true);
    expect(catalog.some((r) => r.isNew)).toBe(true);
    expect(catalog.some((r) => r.lowest30d)).toBe(true);
    expect(new Set(catalog.map((r) => r.storeId)).size).toBe(DEV_STORE_COUNT);
    expect(new Set(catalog.map((r) => r.categoryId)).size).toBeGreaterThan(8);
  });
  it("stores match the catalogue", () => {
    const stores = generateDevStores(catalog);
    expect(stores.length).toBe(DEV_STORE_COUNT);
    const ids = new Set(stores.map((s) => s.id));
    for (const r of catalog) expect(ids.has(r.storeId as string)).toBe(true);
    for (const s of stores) { expect(s.rating).toBeNull(); expect(s.followerCount).toBe(0); }
  });
});

describe("fake search port with the demo catalogue", () => {
  it("paginates at 50 and loadMore gets the rest without overlap", async () => {
    const p1 = await port.search("", f({}), null);
    expect(p1.items.length).toBe(50);
    expect(p1.total).toBe(60);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await port.search("", f({}), p1.nextCursor);
    expect(p2.items.length).toBe(10);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(60);
  });
  it("honours price, discount floor, flags, conditions, department, categories, stores and query", async () => {
    const all = async (filter: SearchFilter, q = "") => { const o = []; let c: string | null = null; do { const p = await port.search(q, filter, c); o.push(...p.items); c = p.nextCursor; } while (c !== null); return o; };
    expect((await all(f({ priceMin: 100_000n, priceMax: 200_000n }))).every((i) => i.price >= 100_000n && i.price <= 200_000n)).toBe(true);
    const d30 = await all(f({ minVerifiedDiscountPct: 30 }));
    expect(d30.length).toBeGreaterThan(0);
    expect(d30.every((i) => (i.verifiedDiscountPct ?? 0) >= 30)).toBe(true);
    expect(d30.length).toBeLessThan(60);
    expect((await all(f({ freeDeliveryEligible: true }))).length).toBe(catalog.filter((r) => r.freeDelivery).length);
    expect((await all(f({ newArrivals: true }))).length).toBe(catalog.filter((r) => r.isNew).length);
    expect((await all(f({ lowest30dOnly: true }))).length).toBe(catalog.filter((r) => r.lowest30d).length);
    expect((await all(f({ conditions: ["sample"] }))).every((i) => catalog.find((r) => r.id === i.id)?.condition === "sample")).toBe(true);
    expect((await all(f({ department: "kids" }))).every((i) => i.department === "kids")).toBe(true);
    const cat = catalog[0]?.categoryId as string;
    expect((await all(f({ categoryIds: [cat] }))).every((i) => i.categoryId === cat)).toBe(true);
    expect((await all(f({ storeIds: ["demo-store-03"] }))).every((i) => i.storeId === "demo-store-03")).toBe(true);
    expect((await all(f({}), "demo item 042")).map((i) => i.id)).toEqual(["demo-item-042"]);
    expect(await port.count("", f({ minVerifiedDiscountPct: 30 }))).toBe(d30.length);
  });
});

describe("dev outlets generator", () => {
  const outlets = generateDevOutlets();
  it("makes 15 deterministic, unique, synthetic outlets over six governorates", () => {
    expect(outlets.length).toBe(15);
    expect(generateDevOutlets()).toEqual(outlets);
    expect(new Set(outlets.map((o) => o.id)).size).toBe(15);
    expect(new Set(outlets.map((o) => o.governorateId))).toEqual(new Set(["EG-C", "EG-GZ", "EG-ALX", "EG-QH", "EG-BA", "EG-JS"]));
    for (const o of outlets) { expect(o.name).toMatch(/^Demo outlet \d{2}$/); expect(Number.isFinite(o.distanceKm)).toBe(true); }
  });
  it("every area id exists in egypt-areas with a matching governorate", () => {
    const ids = new Map(EGYPT_AREAS.map((a) => [a.id, a.governorateId]));
    for (const id of DEV_OUTLET_AREAS) expect(ids.has(id), id).toBe(true);
    for (const o of outlets) expect(ids.get(o.areaId)).toBe(o.governorateId);
  });
});
