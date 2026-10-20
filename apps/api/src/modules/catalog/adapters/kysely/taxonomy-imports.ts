import { sql, type Selectable, type Transaction } from "kysely";
import type { KyselyTransactionRunner } from "../../../../platform/db";
import type {
  BrandRecord,
  CategoryRecord,
  ImportErrorRow,
  ImportRecord,
  ImportRepository,
  TaxonomyRepository,
} from "../../domain/ports";
import type { BrandsTable, CatalogDb, CategoriesTable } from "./schema";
import type { SessionProvider } from "./session";

const toCategory = (r: Selectable<CategoriesTable>): CategoryRecord => ({
  id: r.id,
  slug: r.slug,
  nameAr: r.name_ar,
  ...(r.name_en !== null ? { nameEn: r.name_en } : {}),
  ...(r.parent_id !== null ? { parentId: r.parent_id } : {}),
  productType: r.product_type,
  returnClass: r.return_class,
  requiresSizeChart: r.requires_size_chart,
  active: r.active,
});

const toBrand = (r: Selectable<BrandsTable>): BrandRecord => ({
  id: r.id,
  slug: r.slug,
  nameAr: r.name_ar,
  ...(r.name_en !== null ? { nameEn: r.name_en } : {}),
});

export class KyselyTaxonomy implements TaxonomyRepository {
  constructor(
    private readonly runner: KyselyTransactionRunner<CatalogDb>,
    private readonly session: SessionProvider,
  ) {}

  private run<T>(fn: (tx: Transaction<CatalogDb>) => Promise<T>): Promise<T> {
    return this.runner.run({ session: this.session(), process: "catalog.taxonomy_read", profile: "read" }, (tx) => fn(tx.db));
  }

  categoryById(id: string): Promise<CategoryRecord | null> {
    return this.run(async (db) => {
      const r = await db.selectFrom("categories").selectAll().where("id", "=", id).executeTakeFirst();
      return r === undefined ? null : toCategory(r);
    });
  }
  categoryBySlug(slug: string): Promise<CategoryRecord | null> {
    return this.run(async (db) => {
      const r = await db.selectFrom("categories").selectAll().where("slug", "=", slug).executeTakeFirst();
      return r === undefined ? null : toCategory(r);
    });
  }
  brandById(id: string): Promise<BrandRecord | null> {
    return this.run(async (db) => {
      const r = await db.selectFrom("brands").selectAll().where("id", "=", id).executeTakeFirst();
      return r === undefined ? null : toBrand(r);
    });
  }
  allCategories(): Promise<readonly CategoryRecord[]> {
    return this.run(async (db) => (await db.selectFrom("categories").selectAll().orderBy("sort_order").orderBy("slug").execute()).map(toCategory));
  }
  allBrands(): Promise<readonly BrandRecord[]> {
    return this.run(async (db) => (await db.selectFrom("brands").selectAll().orderBy("slug").execute()).map(toBrand));
  }
}

export class KyselyImportRepository implements ImportRepository {
  constructor(
    private readonly runner: KyselyTransactionRunner<CatalogDb>,
    private readonly session: SessionProvider,
  ) {}

  private run<T>(process: string, fn: (tx: Transaction<CatalogDb>) => Promise<T>): Promise<T> {
    return this.runner.run({ session: this.session(), process, profile: "default" }, (tx) => fn(tx.db));
  }

  async save(r: ImportRecord): Promise<void> {
    await this.run("catalog.import_save", async (db) => {
      const existing = await db.selectFrom("catalog_imports").select("id").where("id", "=", r.id).where("store_id", "=", r.storeId).forUpdate().executeTakeFirst();
      if (existing === undefined) {
        await db
          .insertInto("catalog_imports")
          .values({
            id: r.id,
            store_id: r.storeId,
            actor_id: r.actorId,
            upload_id: r.uploadId,
            status: r.status,
            dry_run: r.dryRun,
            rows_total: r.rowsTotal,
            rows_ok: r.rowsOk,
            rows_failed: r.rowsFailed,
            created_at: new Date(r.createdAtMs).toISOString(),
          })
          .execute();
      } else {
        await db
          .updateTable("catalog_imports")
          .set({ status: r.status, rows_total: r.rowsTotal, rows_ok: r.rowsOk, rows_failed: r.rowsFailed })
          .where("id", "=", r.id)
          .execute();
      }
      // The error report is written once (append-only grant); a later save keeps it.
      const have = await db.selectFrom("catalog_import_errors").select("id").where("import_id", "=", r.id).limit(1).executeTakeFirst();
      if (have === undefined && r.errors.length > 0) {
        await db
          .insertInto("catalog_import_errors")
          .values(
            r.errors.map((e) => ({
              import_id: r.id,
              store_id: r.storeId,
              row_number: e.row,
              column_name: e.column ?? null,
              code: e.code,
            })),
          )
          .execute();
      }
    });
  }

  async find(id: string): Promise<ImportRecord | null> {
    return this.run("catalog.import_read", async (db) => {
      const r = await db.selectFrom("catalog_imports").selectAll().where("id", "=", id).executeTakeFirst();
      if (r === undefined) return null;
      const errs = await db
        .selectFrom("catalog_import_errors")
        .select(["row_number", "column_name", "code"])
        .where("import_id", "=", id)
        .orderBy("id")
        .execute();
      const errors: ImportErrorRow[] = errs.map((e) => ({
        row: e.row_number,
        ...(e.column_name !== null ? { column: e.column_name } : {}),
        code: e.code,
      }));
      return {
        id: r.id,
        storeId: r.store_id,
        actorId: r.actor_id,
        uploadId: r.upload_id,
        status: r.status,
        dryRun: r.dry_run,
        rowsTotal: r.rows_total,
        rowsOk: r.rows_ok,
        rowsFailed: r.rows_failed,
        errors,
        createdAtMs: r.created_at.getTime(),
      };
    });
  }

  async claimProduct(importId: string, productRef: string): Promise<boolean> {
    return this.run("catalog.import_claim", async (db) => {
      const imp = await db.selectFrom("catalog_imports").select("store_id").where("id", "=", importId).executeTakeFirst();
      if (imp === undefined) throw new Error("import not found: save the import record before claiming products");
      const res = await db
        .insertInto("catalog_import_products")
        .values({ import_id: importId, store_id: imp.store_id, product_ref: productRef, product_id: null })
        .onConflict((oc) => oc.columns(["import_id", "product_ref"]).doNothing())
        .returning("product_ref")
        .executeTakeFirst();
      return res !== undefined;
    });
  }

  async attachProduct(importId: string, productRef: string, productId: string): Promise<void> {
    await this.run("catalog.import_attach", async (db) => {
      await db
        .updateTable("catalog_import_products")
        .set({ product_id: productId })
        .where("import_id", "=", importId)
        .where("product_ref", "=", productRef)
        .where(sql<boolean>`product_id is null`)
        .execute();
    });
  }
}
