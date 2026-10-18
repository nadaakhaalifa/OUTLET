import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createProduct, type Product, type ProductDraft } from "../../domain/catalog-domain";
import type { ImportRecord, ImportRepository, ProductRepository, TaxonomyRepository } from "../../domain/ports";
import { SEED } from "../../adapters/in-memory";

/** What a persistence adapter must hand the shared suite. All three repositories share one backing store. */
export interface CatalogContractHarness {
  readonly products: ProductRepository;
  readonly taxonomy: TaxonomyRepository;
  readonly imports: ImportRepository;
  /** Runs once the suite is finished with the harness. */
  close(): Promise<void>;
}

export const STORE_A = "0192f3a4-7000-7000-8000-00000000a001";
export const STORE_B = "0192f3a4-7000-7000-8000-00000000b001";
const ACTOR = "0192f3a4-7000-7000-8000-00000000c001";
const T0 = 1_800_000_000_000;

let seq = 0;
export const newUuid = (): string => `0192f3a4-7000-7000-8000-${(0xd00000000000 + (seq += 1)).toString(16)}`;

export function makeProduct(storeId: string, over: Partial<ProductDraft> = {}, nowMs = T0): Product {
  const draft: ProductDraft = {
    title: { ar: "فستان كتان", en: "Linen dress" },
    description: { ar: "فستان كتان خفيف للصيف", en: "Light linen dress" },
    categoryId: SEED.categoryDresses,
    brandId: SEED.brandAcme,
    condition: "new_with_tags",
    material: "linen",
    imageUploadIds: [newUuid(), newUuid()],
    defectPhotoUploadIds: [],
    skus: [
      { sellerSku: `S-${seq}`, sizeLabel: "M", color: "white", price: { amount: 129_900n, currency: "EGP" } },
      { sizeLabel: "L", price: { amount: 139_900n, currency: "EGP" } },
    ],
    ...over,
  };
  return createProduct(draft, { storeId, nowMs, newId: newUuid });
}

/** updated_at is owned by the database trigger (touch_updated_at), so it is excluded from equality. */
const comparable = (p: Product | null) => (p === null ? null : { ...p, updatedAtMs: 0 });

export function describeCatalogRepositoryContract(label: string, make: () => Promise<CatalogContractHarness>): void {
  describe(`catalog repository contract: ${label}`, () => {
    let h: CatalogContractHarness;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.close();
    });

    it("round-trips a product with its SKUs, images and defect photos", async () => {
      const p = makeProduct(STORE_A, { condition: "minor_defect", defectPhotoUploadIds: [newUuid()] });
      await h.products.insert(p);
      expect(comparable(await h.products.findInStore(STORE_A, p.id))).toEqual(comparable(p));
      expect(comparable(await h.products.findById(p.id))).toEqual(comparable(p));
    });

    it("never returns another store's product from findInStore", async () => {
      const p = makeProduct(STORE_A);
      await h.products.insert(p);
      expect(await h.products.findInStore(STORE_B, p.id)).toBeNull();
      expect(await h.products.findInStore(STORE_A, newUuid())).toBeNull();
    });

    it("lists newest first with a stable keyset cursor and no cross-store rows", async () => {
      const made: Product[] = [];
      for (let i = 0; i < 5; i += 1) {
        const p = makeProduct(STORE_A, {}, T0 + i * 1000);
        made.push(p);
        await h.products.insert(p);
      }
      await h.products.insert(makeProduct(STORE_B, {}, T0 + 99_000));
      const expected = [...made].reverse().map((p) => p.id);

      const first = await h.products.listByStore(STORE_A, null, 2);
      expect(first.items.map((p) => p.id)).toEqual(expected.slice(0, 2));
      expect(first.nextCursor).not.toBeNull();
      const [ms, id] = (first.nextCursor ?? "").split(":");
      const second = await h.products.listByStore(STORE_A, { createdAtMs: Number(ms), id: id ?? "" }, 2);
      expect(second.items.map((p) => p.id)).toEqual(expected.slice(2, 4));
      const [ms2, id2] = (second.nextCursor ?? "").split(":");
      const third = await h.products.listByStore(STORE_A, { createdAtMs: Number(ms2), id: id2 ?? "" }, 2);
      expect(third.items.map((p) => p.id)).toEqual(expected.slice(4));
      expect(third.nextCursor).toBeNull();
    });

    it("replace is compare-and-set on version", async () => {
      const p = makeProduct(STORE_A);
      await h.products.insert(p);
      const v2: Product = { ...p, title: { ar: "فستان جديد" }, version: 2, material: "cotton", imageUploadIds: [p.imageUploadIds[0] ?? newUuid()] };
      expect(await h.products.replace(v2, 1)).toBe(true);
      expect(comparable(await h.products.findInStore(STORE_A, p.id))).toEqual(comparable(v2));
      // A second writer that read version 1 loses.
      const loser: Product = { ...p, title: { ar: "خاسر" }, version: 2 };
      expect(await h.products.replace(loser, 1)).toBe(false);
      expect((await h.products.findInStore(STORE_A, p.id))?.title.ar).toBe("فستان جديد");
    });

    it("persists job-backed image variants with insert and replace, and keeps one job on one image", async () => {
      const job = newUuid();
      const up = newUuid();
      const p = makeProduct(STORE_A, { imageUploadIds: [up, job] });
      const v = { jobId: job, imageRef: "catalog/2026/10/img-0001", cutoutRef: "catalog/2026/10/cut-0001" };
      await h.products.insert(p, [], [v]);
      expect((await h.products.imageVariants([p.id])).get(p.id)).toEqual([v]);
      expect((await h.products.imageVariants([newUuid()])).size).toBe(0);
      // Replace rewrites the gallery with exactly the variants given (none = plain images only).
      const v2: Product = { ...p, version: 2, imageUploadIds: [up] };
      expect(await h.products.replace(v2, 1, [], [])).toBe(true);
      expect((await h.products.imageVariants([p.id])).size).toBe(0);
      // The same job on another product's image is refused by the unique index (kysely) or by the claim (port).
      const q = makeProduct(STORE_A, { imageUploadIds: [job] });
      await h.products.insert(q, [], [v]);
      expect((await h.products.imageVariants([q.id])).get(q.id)).toEqual([v]);
    });

    it("replace publishes and pauses with the status and published time persisted", async () => {
      const p = makeProduct(STORE_A);
      await h.products.insert(p);
      const live: Product = { ...p, status: "active", version: 2, publishedAtMs: T0 + 5000, updatedAtMs: T0 + 5000 };
      expect(await h.products.replace(live, 1)).toBe(true);
      const read = await h.products.findInStore(STORE_A, p.id);
      expect(read?.status).toBe("active");
      expect(read?.publishedAtMs).toBe(T0 + 5000);
      const paused: Product = { ...live, status: "paused", version: 3 };
      expect(await h.products.replace(paused, 2)).toBe(true);
      expect((await h.products.findInStore(STORE_A, p.id))?.status).toBe("paused");
    });

    it("listActiveStubs returns only active products across stores, ordered by id, with offset paging", async () => {
      const draft = makeProduct(STORE_A);
      const a1 = makeProduct(STORE_A);
      const b1 = makeProduct(STORE_B);
      for (const p of [draft, a1, b1]) await h.products.insert(p);
      for (const p of [a1, b1]) {
        expect(await h.products.replace({ ...p, status: "active", version: 2, publishedAtMs: T0 + 1, updatedAtMs: T0 + 1 }, 1)).toBe(true);
      }
      const all = await h.products.listActiveStubs(0, 50);
      const ids = all.map((s) => s.id);
      expect(ids).toEqual([a1.id, b1.id].sort());
      expect(ids).not.toContain(draft.id);
      for (const s of all) expect(Object.keys(s).sort()).toEqual(["id", "storeId", "updatedAtMs"]);
      expect((await h.products.listActiveStubs(1, 50)).map((s) => s.id)).toEqual(ids.slice(1));
      expect(await h.products.listActiveStubs(0, 1)).toHaveLength(1);
    });

    it("takenGtinVariants is per store and keyed by gtin, colour and size", async () => {
      const p = makeProduct(STORE_A, {
        skus: [
          { gtin: "6221234567891", sizeLabel: " M ", color: "White", price: { amount: 100n, currency: "EGP" } },
          { gtin: "6221234567891", sizeLabel: "L", price: { amount: 100n, currency: "EGP" } },
          { sizeLabel: "XL", price: { amount: 100n, currency: "EGP" } },
        ],
      });
      await h.products.insert(p);
      const taken = await h.products.takenGtinVariants(STORE_A);
      expect([...taken].sort()).toEqual(["6221234567891|white|m", "6221234567891||l"].sort());
      expect((await h.products.takenGtinVariants(STORE_B)).size).toBe(0);
    });

    it("serves taxonomy by id and slug, including inactive categories", async () => {
      const dresses = await h.taxonomy.categoryById(SEED.categoryDresses);
      expect(dresses).toMatchObject({ slug: "dresses", returnClass: "standard", requiresSizeChart: false, active: true });
      expect((await h.taxonomy.categoryBySlug("underwear"))?.returnClass).toBe("hygiene");
      expect((await h.taxonomy.categoryById(SEED.categoryInactive))?.active).toBe(false);
      expect(await h.taxonomy.categoryById(newUuid())).toBeNull();
      expect((await h.taxonomy.brandById(SEED.brandAcme))?.slug).toBe("acme");
      expect((await h.taxonomy.allCategories()).map((c) => c.slug).sort()).toEqual(["dresses", "retired", "shoes", "underwear"]);
      expect((await h.taxonomy.allBrands()).map((b) => b.slug)).toEqual(["acme"]);
    });

    const importRecord = (over: Partial<ImportRecord> = {}): ImportRecord => ({
      id: newUuid(),
      storeId: STORE_A,
      actorId: ACTOR,
      uploadId: newUuid(),
      status: "dry_run_complete",
      dryRun: true,
      rowsTotal: 3,
      rowsOk: 2,
      rowsFailed: 1,
      errors: [{ row: 3, column: "barcode_gtin", code: "invalid_value" }, { row: 4, code: "csv_malformed" }],
      createdAtMs: T0,
      ...over,
    });

    it("saves, updates and finds an import record with its error report", async () => {
      const r = importRecord();
      await h.imports.save(r);
      expect(await h.imports.find(r.id)).toEqual(r);
      const done: ImportRecord = { ...r, status: "failed" };
      await h.imports.save(done);
      expect(await h.imports.find(r.id)).toEqual(done);
      expect(await h.imports.find(newUuid())).toBeNull();
    });

    it("claims each product ref once per import and survives attach", async () => {
      const r = importRecord({ dryRun: false, status: "applying", errors: [], rowsFailed: 0, rowsOk: 3 });
      await h.imports.save(r);
      expect(await h.imports.claimProduct(r.id, "REF-1")).toBe(true);
      expect(await h.imports.claimProduct(r.id, "REF-1")).toBe(false);
      expect(await h.imports.claimProduct(r.id, "REF-2")).toBe(true);
      const p = makeProduct(STORE_A);
      await h.products.insert(p);
      await h.imports.attachProduct(r.id, "REF-1", p.id);
      await h.imports.attachProduct(r.id, "REF-1", p.id);
      expect(await h.imports.claimProduct(r.id, "REF-1")).toBe(false);
    });
  });
}
