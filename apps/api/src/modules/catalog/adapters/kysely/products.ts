import { sql, type Selectable, type Transaction } from "kysely";
import type { KyselyTransactionRunner } from "../../../../platform/db";
import { gtinVariantKey, type Product, type Sku } from "../../domain/catalog-domain";
import type { CatalogEvent, ProductPage, ProductRepository } from "../../domain/ports";
import type { DbTx } from "../../../../platform/db";
import type { CatalogDb, ProductsTable, SkusTable } from "./schema";
import type { SessionProvider } from "./session";

type Trx = Transaction<CatalogDb>;

/** snake_case keys, JSON-safe values (arrays of strings, numbers, strings). */
function toJson(o: Record<string, unknown>): Record<string, string | number | string[]> {
  const out: Record<string, string | number | string[]> = {};
  for (const [k, v] of Object.entries(o)) {
    const key = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (typeof v === "string" || typeof v === "number") out[key] = v;
    else if (Array.isArray(v)) out[key] = v.map(String);
  }
  return out;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

export class VersionConflict extends Error {
  override readonly name = "VersionConflict";
}

/** Postgres adapter for ProductRepository. One method = one transaction under the caller's RLS identity. */
export class KyselyProductRepository implements ProductRepository {
  constructor(
    private readonly runner: KyselyTransactionRunner<CatalogDb>,
    private readonly session: SessionProvider,
  ) {}

  private run<T>(process: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.runner.run({ session: this.session(), process, profile: "default" }, (tx) => fn(tx.db));
  }

  private runTx<T>(process: string, fn: (tx: DbTx<CatalogDb>) => Promise<T>): Promise<T> {
    return this.runner.run({ session: this.session(), process, profile: "default" }, fn);
  }

  /** Appends catalog events to the outbox inside the caller's transaction. */
  private async emitAll(tx: DbTx<CatalogDb>, events: readonly CatalogEvent[]): Promise<void> {
    for (const e of events) {
      const { name, productId, occurredAtMs, ...rest } = e;
      await tx.emit({
        aggregateType: "product",
        aggregateId: productId,
        eventType: name,
        payload: { product_id: productId, occurred_at_ms: occurredAtMs, ...toJson(rest) },
      });
    }
  }

  async insert(product: Product, events: readonly CatalogEvent[] = []): Promise<void> {
    if (product.status !== "draft") throw new Error("a product is inserted as draft");
    await this.runTx("catalog.product_insert", async (tx) => {
      const trx = tx.db;
      await trx
        .insertInto("products")
        .values({
          id: product.id,
          store_id: product.storeId,
          brand_id: product.brandId ?? null,
          category_id: product.categoryId,
          title_ar: product.title.ar,
          title_en: product.title.en ?? null,
          description_ar: product.description?.ar ?? null,
          description_en: product.description?.en ?? null,
          condition: product.condition,
          status: "draft",
          material: product.material ?? null,
          size_chart_id: product.sizeChartId ?? null,
          version: product.version,
          published_at: null,
          created_at: isoOf(product.createdAtMs),
          updated_at: isoOf(product.updatedAtMs),
        })
        .execute();
      await this.writeChildren(trx, product);
      await this.emitAll(tx, events);
    });
  }

  private async writeChildren(trx: Trx, p: Product): Promise<void> {
    if (p.skus.length > 0) {
      await trx
        .insertInto("skus")
        .values(
          p.skus.map((s) => ({
            id: s.id,
            product_id: p.id,
            store_id: p.storeId,
            seller_sku: s.sellerSku ?? null,
            gtin: s.gtin ?? null,
            color_code: s.color ?? "",
            size_label: s.sizeLabel,
            list_price_amount: s.price.amount.toString(),
            status: s.status,
            weight_grams: null,
          })),
        )
        .execute();
    }
    await this.writeMedia(trx, p);
  }

  private async writeMedia(trx: Trx, p: Product): Promise<void> {
    if (p.imageUploadIds.length > 0) {
      await trx
        .insertInto("product_media")
        .values(
          p.imageUploadIds.map((id, position) => ({
            product_id: p.id,
            store_id: p.storeId,
            sku_id: null,
            media_asset_id: id,
            position,
            blurhash: null,
          })),
        )
        .execute();
    }
    if (p.defectPhotoUploadIds.length > 0) {
      await trx
        .insertInto("product_defects")
        .values(
          p.defectPhotoUploadIds.map((id) => ({
            product_id: p.id,
            store_id: p.storeId,
            sku_id: null,
            description_ar: null,
            description_en: null,
            media_asset_id: id,
          })),
        )
        .execute();
    }
  }

  async findInStore(storeId: string, id: string): Promise<Product | null> {
    return this.run("catalog.product_read", async (trx) => {
      const row = await trx.selectFrom("products").selectAll().where("id", "=", id).where("store_id", "=", storeId).executeTakeFirst();
      if (row === undefined) return null;
      return (await this.hydrate(trx, [row]))[0] ?? null;
    });
  }

  async findById(id: string): Promise<Product | null> {
    return this.run("catalog.product_read", async (trx) => {
      const row = await trx.selectFrom("products").selectAll().where("id", "=", id).executeTakeFirst();
      if (row === undefined) return null;
      return (await this.hydrate(trx, [row]))[0] ?? null;
    });
  }

  async listByStore(
    storeId: string,
    cursor: { readonly createdAtMs: number; readonly id: string } | null,
    limit: number,
  ): Promise<ProductPage> {
    return this.run("catalog.product_list", async (trx) => {
      let q = trx.selectFrom("products").selectAll().where("store_id", "=", storeId);
      if (cursor !== null) {
        q = q.where(sql<boolean>`(created_at, id) < (${isoOf(cursor.createdAtMs)}::timestamptz, ${cursor.id}::uuid)`);
      }
      const rows = await q.orderBy("created_at", "desc").orderBy("id", "desc").limit(limit + 1).execute();
      const pageRows = rows.slice(0, limit);
      const items = await this.hydrate(trx, pageRows);
      const last = items[items.length - 1];
      const more = rows.length > limit;
      return { items, nextCursor: more && last !== undefined ? `${last.createdAtMs}:${last.id}` : null };
    });
  }

  async replace(next: Product, expectedVersion: number, events: readonly CatalogEvent[] = []): Promise<boolean> {
    try {
      await this.runTx("catalog.product_replace", async (tx) => {
        const trx = tx.db;
        // Lock + compare first so children are never touched for a stale writer.
        const cur = await trx
          .selectFrom("products")
          .select(["id", "version", "store_id"])
          .where("id", "=", next.id)
          .where("store_id", "=", next.storeId)
          .forUpdate()
          .executeTakeFirst();
        if (cur === undefined || cur.version !== expectedVersion) throw new VersionConflict();
        // Children first so the database publish gate sees the new gallery.
        await trx.deleteFrom("product_media").where("product_id", "=", next.id).execute();
        await trx.deleteFrom("product_defects").where("product_id", "=", next.id).execute();
        await this.writeMedia(trx, next);
        for (const s of next.skus) {
          const updated = await trx
            .updateTable("skus")
            .set({
              seller_sku: s.sellerSku ?? null,
              gtin: s.gtin ?? null,
              color_code: s.color ?? "",
              size_label: s.sizeLabel,
              list_price_amount: s.price.amount.toString(),
              status: s.status,
            })
            .where("id", "=", s.id)
            .where("product_id", "=", next.id)
            .returning("id")
            .executeTakeFirst();
          if (updated === undefined) {
            await trx
              .insertInto("skus")
              .values({
                id: s.id,
                product_id: next.id,
                store_id: next.storeId,
                seller_sku: s.sellerSku ?? null,
                gtin: s.gtin ?? null,
                color_code: s.color ?? "",
                size_label: s.sizeLabel,
                list_price_amount: s.price.amount.toString(),
                status: s.status,
                weight_grams: null,
              })
              .execute();
          }
        }
        const done = await trx
          .updateTable("products")
          .set({
            brand_id: next.brandId ?? null,
            category_id: next.categoryId,
            title_ar: next.title.ar,
            title_en: next.title.en ?? null,
            description_ar: next.description?.ar ?? null,
            description_en: next.description?.en ?? null,
            condition: next.condition,
            status: next.status,
            material: next.material ?? null,
            size_chart_id: next.sizeChartId ?? null,
            version: next.version,
            published_at: next.publishedAtMs === undefined ? null : isoOf(next.publishedAtMs),
          })
          .where("id", "=", next.id)
          .where("version", "=", expectedVersion)
          .returning("id")
          .executeTakeFirst();
        // RLS can hide the row for update (foreign tenant): treat as lost race.
        if (done === undefined) throw new VersionConflict();
        await this.emitAll(tx, events);
      });
      return true;
    } catch (e) {
      if (e instanceof VersionConflict) return false;
      throw e;
    }
  }

  async takenGtinVariants(storeId: string): Promise<ReadonlySet<string>> {
    return this.run("catalog.product_gtins", async (trx) => {
      const rows = await trx
        .selectFrom("skus")
        .select(["gtin", "color_code", "size_label"])
        .where("store_id", "=", storeId)
        .where("gtin", "is not", null)
        .execute();
      const out = new Set<string>();
      for (const r of rows) {
        if (r.gtin !== null) out.add(gtinVariantKey(r.gtin, r.color_code === "" ? undefined : r.color_code, r.size_label));
      }
      return out;
    });
  }

  private async hydrate(trx: Trx, rows: readonly Selectable<ProductsTable>[]): Promise<Product[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [skus, media, defects] = await Promise.all([
      trx.selectFrom("skus").selectAll().where("product_id", "in", ids).orderBy("created_at").orderBy("id").execute(),
      trx.selectFrom("product_media").select(["product_id", "media_asset_id", "position"]).where("product_id", "in", ids).where("kind", "=", "image").orderBy("position").execute(),
      trx.selectFrom("product_defects").select(["product_id", "media_asset_id", "created_at", "id"]).where("product_id", "in", ids).orderBy("created_at").orderBy("id").execute(),
    ]);
    return rows.map((r) => {
      const mine = skus.filter((s) => s.product_id === r.id);
      return {
        id: r.id,
        storeId: r.store_id,
        title: { ar: r.title_ar, ...(r.title_en !== null ? { en: r.title_en } : {}) },
        ...(r.description_ar !== null
          ? { description: { ar: r.description_ar, ...(r.description_en !== null ? { en: r.description_en } : {}) } }
          : {}),
        categoryId: r.category_id,
        ...(r.brand_id !== null ? { brandId: r.brand_id } : {}),
        condition: r.condition,
        ...(r.material !== null ? { material: r.material } : {}),
        imageUploadIds: media.filter((m) => m.product_id === r.id).map((m) => m.media_asset_id),
        defectPhotoUploadIds: defects.filter((d) => d.product_id === r.id).map((d) => d.media_asset_id),
        ...(r.size_chart_id !== null ? { sizeChartId: r.size_chart_id } : {}),
        status: r.status,
        version: r.version,
        createdAtMs: r.created_at.getTime(),
        updatedAtMs: r.updated_at.getTime(),
        ...(r.published_at !== null ? { publishedAtMs: r.published_at.getTime() } : {}),
        skus: mine.map(toSku),
      };
    });
  }
}

function toSku(s: Selectable<SkusTable>): Sku {
  return {
    id: s.id,
    productId: s.product_id,
    storeId: s.store_id,
    ...(s.seller_sku !== null ? { sellerSku: s.seller_sku } : {}),
    ...(s.gtin !== null ? { gtin: s.gtin } : {}),
    sizeLabel: s.size_label,
    ...(s.color_code !== "" ? { color: s.color_code } : {}),
    price: { amount: BigInt(s.list_price_amount), currency: "EGP" },
    status: s.status,
  };
}
