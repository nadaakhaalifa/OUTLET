import type { KyselyTransactionRunner } from "../../../../platform/db";
import type { SkuFacts, SkuLookupReader } from "../../domain/ports";
import type { CatalogDb } from "./schema";
import type { SessionProvider } from "./session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CODES = 500;

/**
 * Read-only SKU lookups for other modules (composition adapters). Runs under the session it is
 * given (system for workers). It never writes and never returns another store's SKU for a
 * store-scoped question: `bySellerSku` filters on the store id.
 */
export class KyselySkuLookup implements SkuLookupReader {
  constructor(
    private readonly runner: KyselyTransactionRunner<CatalogDb>,
    private readonly session: SessionProvider,
  ) {}

  async bySellerSku(storeId: string, codes: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(codes)].filter((c) => c.length > 0 && c.length <= 64).slice(0, MAX_CODES);
    if (unique.length === 0 || !UUID.test(storeId)) return out;
    const rows = await this.runner.run({ session: this.session(), process: "catalog.sku_lookup", profile: "default" }, (tx) =>
      tx.db
        .selectFrom("skus")
        .select(["id", "seller_sku"])
        .where("store_id", "=", storeId)
        .where("seller_sku", "in", unique)
        .where("status", "<>", "delisted")
        .execute(),
    );
    for (const r of rows) if (r.seller_sku !== null) out.set(r.seller_sku, r.id);
    return out;
  }

  async skuFacts(skuId: string): Promise<SkuFacts | null> {
    if (!UUID.test(skuId)) return null;
    const row = await this.runner.run({ session: this.session(), process: "catalog.sku_facts", profile: "default" }, (tx) =>
      tx.db
        .selectFrom("skus")
        .innerJoin("products", "products.id", "skus.product_id")
        .select([
          "skus.id as sku_id",
          "skus.product_id",
          "skus.store_id",
          "skus.size_label",
          "products.title_ar",
          "products.title_en",
          "skus.list_price_amount",
          "skus.currency",
          "skus.status as sku_status",
          "products.status as product_status",
        ])
        .where("skus.id", "=", skuId)
        .executeTakeFirst(),
    );
    if (row === undefined) return null;
    return {
      skuId: row.sku_id,
      productId: row.product_id,
      storeId: row.store_id,
      sizeLabel: row.size_label,
      titleAr: row.title_ar,
      titleEn: row.title_en,
      priceAmount: BigInt(row.list_price_amount),
      currency: row.currency,
      skuStatus: row.sku_status,
      productStatus: row.product_status,
    };
  }
}
