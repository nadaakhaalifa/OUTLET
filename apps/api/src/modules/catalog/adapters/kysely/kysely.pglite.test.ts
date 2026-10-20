import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryImportRepository, InMemoryProductRepository, InMemoryTaxonomy, SEED_BRANDS, SEED_CATEGORIES } from "../in-memory";
import {
  STORE_A,
  STORE_B,
  describeCatalogRepositoryContract,
  makeProduct,
  newUuid,
} from "../../test/contract/repositories.contract";
import { createCatalogPglite, type CatalogPglite } from "../../test/pglite-fixture";
import { CATALOG_COLUMNS } from "./schema";

// The same suite, two adapters.
describeCatalogRepositoryContract("in-memory", async () => ({
  products: new InMemoryProductRepository(),
  taxonomy: new InMemoryTaxonomy(SEED_CATEGORIES, SEED_BRANDS),
  imports: new InMemoryImportRepository(),
  close: async () => undefined,
}));
describeCatalogRepositoryContract("kysely + pglite (system session)", createCatalogPglite);

const U = (n: number): string => `0192f3a4-7000-7000-8000-${String(n).padStart(12, "0")}`;
const SELLER_A = { userId: U(1), role: "seller", storeIds: [STORE_A] } as const;
const SELLER_B = { userId: U(2), role: "seller", storeIds: [STORE_B] } as const;
const CUSTOMER = { userId: U(3), role: "customer" } as const;
const ANON = { userId: null, role: null } as const;

describe("catalog RLS context (kysely + pglite, role app_user)", () => {
  let h: CatalogPglite;
  const draftA = makeProduct(STORE_A);
  const liveB = makeProduct(STORE_B);
  beforeAll(async () => {
    h = await createCatalogPglite();
    await h.products.insert(draftA);
    await h.products.insert(liveB);
    await h.products.replace({ ...liveB, status: "active", version: 2, publishedAtMs: 1_800_000_001_000 }, 1);
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  it("a foreign seller cannot read, list, replace or probe store A's drafts", async () => {
    h.setSession(SELLER_B);
    expect(await h.products.findInStore(STORE_A, draftA.id)).toBeNull();
    expect(await h.products.findById(draftA.id)).toBeNull();
    expect((await h.products.listByStore(STORE_A, null, 10)).items).toEqual([]);
    expect((await h.products.takenGtinVariants(STORE_A)).size).toBe(0);
    expect(await h.products.replace({ ...draftA, title: { ar: "اختراق" }, version: 2 }, 1)).toBe(false);
  });

  it("a foreign seller cannot insert into store A", async () => {
    h.setSession(SELLER_B);
    await expect(h.products.insert(makeProduct(STORE_A))).rejects.toThrow();
  });

  it("the foreign write left the row untouched", async () => {
    h.setSession(SELLER_A);
    const row = await h.products.findInStore(STORE_A, draftA.id);
    expect(row?.title.ar).toBe(draftA.title.ar);
    expect(row?.version).toBe(1);
  });

  it("a shopper sees active products only", async () => {
    h.setSession(CUSTOMER);
    expect((await h.products.findById(liveB.id))?.status).toBe("active");
    expect(await h.products.findById(draftA.id)).toBeNull();
    expect((await h.products.listByStore(STORE_A, null, 10)).items).toEqual([]);
    expect(await h.products.replace({ ...liveB, status: "paused", version: 3 }, 2)).toBe(false);
  });

  it("an anonymous session sees nothing, taxonomy included", async () => {
    h.setSession(ANON);
    expect(await h.products.findById(liveB.id)).toBeNull();
    expect(await h.taxonomy.allCategories()).toEqual([]);
    expect(await h.taxonomy.brandById(SEED_BRANDS[0]?.id ?? "")).toBeNull();
  });

  it("imports are tenant scoped", async () => {
    h.setSession(SELLER_A);
    const id = newUuid();
    await h.imports.save({
      id, storeId: STORE_A, actorId: U(1), uploadId: newUuid(), status: "queued", dryRun: true,
      rowsTotal: 0, rowsOk: 0, rowsFailed: 0, errors: [], createdAtMs: 1_800_000_000_000,
    });
    expect((await h.imports.find(id))?.storeId).toBe(STORE_A);
    h.setSession(SELLER_B);
    expect(await h.imports.find(id)).toBeNull();
    await expect(h.imports.claimProduct(id, "REF-1")).rejects.toThrow();
  });

  it("column maps match information_schema (drift)", async () => {
    for (const [table, expected] of Object.entries(CATALOG_COLUMNS)) {
      const r = await h.raw.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by column_name`,
        [table],
      );
      expect(r.rows.map((x) => x.column_name), table).toEqual([...expected]);
    }
  });

  it("the database publish gate still guards a bypassed application check", async () => {
    h.setSession(SELLER_A);
    const noImage = makeProduct(STORE_A, { imageUploadIds: [] });
    await h.products.insert(noImage);
    await expect(h.products.replace({ ...noImage, status: "active", version: 2 }, 1)).rejects.toThrow(/image/);
  });
});
