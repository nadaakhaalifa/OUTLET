import type { Queryable } from "@outlet/db";
import { money } from "@outlet/money";
import type { Principal } from "@outlet/policy";
import { optionValueIssues } from "../domain/attributes.js";
import { SkuInput, SkuPatch } from "../domain/dto.js";
import type { SellerSku, SkuInput as SkuIn, SkuPatch as SkuPatchIn } from "../domain/dto.js";
import { CatalogError, notFound, validation } from "../domain/errors.js";
import { PUBLIC_STATUSES } from "../domain/listing-state.js";
import type { ListingStatus } from "../domain/listing-state.js";
import { SKU_COLS, loadAttributeSet } from "./data.js";
import type { SkuRow } from "./data.js";
import { asStore, isUniqueViolation, makeEnv } from "./env.js";
import type { CatalogDeps, Env } from "./env.js";
import { emit, emitPriceChanged } from "./events.js";
import { projectListing } from "./projection.js";

interface ProductLock {
  status: ListingStatus;
  attributes: Record<string, unknown>;
  primary_category_id: string;
}

const dto = (s: SkuRow): SellerSku => ({
  id: s.id,
  seller_sku: s.seller_sku,
  gtin: s.gtin,
  option_values: s.option_values,
  size_label: s.size_label,
  price: { amount_minor: s.price_minor, currency: s.currency },
  status: s.status,
  version: s.version,
});

/** Variants (skus). Price is VAT-inclusive integer piastres; no "was" price is stored here (Price Watch owns references). */
export class VariantService {
  private readonly env: Env;
  constructor(deps: CatalogDeps) {
    this.env = makeEnv(deps);
  }

  async list(actor: Principal, storeId: string, productId: string): Promise<SellerSku[]> {
    return await asStore(this.env, actor, "listing.read", storeId, async (tx) => {
      await this.product(tx, productId);
      return (await tx.query<SkuRow>(`SELECT ${SKU_COLS} FROM skus WHERE product_id = $1 ORDER BY created_at, id`, [productId])).rows.map(dto);
    });
  }

  async create(actor: Principal, storeId: string, productId: string, raw: SkuIn): Promise<SellerSku> {
    const input = SkuInput.parse(raw);
    const price = this.price(input.price);
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      const p = await this.product(tx, productId);
      await this.assertOptions(tx, p, input.option_values);
      if ((await tx.query("SELECT 1 FROM skus WHERE product_id = $1 AND option_values = $2::jsonb AND status <> 'archived'", [productId, JSON.stringify(input.option_values)])).rows.length > 0) {
        throw new CatalogError("conflict", "a variant with the same options already exists");
      }
      const id = this.env.newId();
      const at = this.env.now();
      try {
        await tx.query("SAVEPOINT sku_insert");
        await tx.query(
          `INSERT INTO skus (id, product_id, store_id, market_id, seller_sku, gtin, option_values, price_minor, currency, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$10)`,
          [id, productId, storeId, this.env.marketId, input.seller_sku, input.gtin ?? null, JSON.stringify(input.option_values), price.amountMinor.toString(), price.currency, at],
        );
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        await tx.query("ROLLBACK TO SAVEPOINT sku_insert");
        throw new CatalogError("conflict", "seller_sku already used in this store");
      }
      await emitPriceChanged(this.env, tx, { skuId: id, productId, storeId, oldPriceMinor: null, newPriceMinor: price.amountMinor, currency: price.currency, source: "seller" });
      await this.after(tx, p, productId, storeId);
      return dto(await this.sku(tx, id));
    });
  }

  /** Optimistic: expectedVersion is the sku version. Emits price.changed only when the price really changed. */
  async update(actor: Principal, storeId: string, productId: string, skuId: string, expectedVersion: number, raw: SkuPatchIn): Promise<SellerSku> {
    const patch = SkuPatch.parse(raw);
    const price = patch.price === undefined ? undefined : this.price(patch.price);
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      const p = await this.product(tx, productId);
      const cur = (await tx.query<SkuRow>(`SELECT ${SKU_COLS} FROM skus WHERE id = $1 AND product_id = $2 FOR UPDATE`, [skuId, productId])).rows[0];
      if (cur === undefined) throw notFound("variant");
      if (cur.version !== expectedVersion) throw new CatalogError("conflict", "stale variant version", [`current=${String(cur.version)}`, `expected=${String(expectedVersion)}`]);
      if (patch.option_values !== undefined) await this.assertOptions(tx, p, patch.option_values);
      const newPrice = price?.amountMinor ?? BigInt(cur.price_minor);
      await tx.query(
        `UPDATE skus SET gtin = $2, option_values = $3::jsonb, price_minor = $4, status = $5, version = version + 1, updated_at = $6 WHERE id = $1`,
        [skuId, patch.gtin ?? cur.gtin, JSON.stringify(patch.option_values ?? cur.option_values), newPrice.toString(), patch.status ?? cur.status, this.env.now()],
      );
      if (newPrice !== BigInt(cur.price_minor)) {
        await emitPriceChanged(this.env, tx, { skuId, productId, storeId, oldPriceMinor: BigInt(cur.price_minor), newPriceMinor: newPrice, currency: cur.currency, source: "seller" });
      }
      await this.after(tx, p, productId, storeId);
      return dto(await this.sku(tx, skuId));
    });
  }

  // ---------------------------------------------------------------- internals
  private price(wire: { amount_minor: string; currency: string }): ReturnType<typeof money> {
    if (wire.currency !== this.env.currency) throw validation(`price currency must be ${this.env.currency}`);
    const m = money(BigInt(wire.amount_minor), this.env.currency);
    if (m.amountMinor <= 0n) throw validation("price must be positive");
    return m;
  }

  private async product(tx: Queryable, id: string): Promise<ProductLock> {
    const p = (await tx.query<ProductLock>("SELECT status, attributes, primary_category_id FROM products WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (p === undefined) throw notFound("listing");
    if (p.status === "ARCHIVED" || p.status === "BLOCKED") throw new CatalogError("conflict", `listing is ${p.status} and cannot be edited`);
    return p;
  }

  private async assertOptions(tx: Queryable, p: ProductLock, options: Record<string, unknown>): Promise<void> {
    const issues = optionValueIssues(await loadAttributeSet(tx, p.primary_category_id), p.attributes, options);
    if (issues.length > 0) throw new CatalogError("validation", "variant options do not match the product attributes", issues);
  }

  private async sku(tx: Queryable, id: string): Promise<SkuRow> {
    const s = (await tx.query<SkuRow>(`SELECT ${SKU_COLS} FROM skus WHERE id = $1`, [id])).rows[0];
    if (s === undefined) throw notFound("variant");
    return s;
  }

  /** Variant changes refresh the search version and, for shopper-visible listings, the read model plus a listing.updated event. */
  private async after(tx: Queryable, p: ProductLock, productId: string, storeId: string): Promise<void> {
    await tx.query("UPDATE products SET search_version = search_version + 1, updated_at = $2 WHERE id = $1", [productId, this.env.now()]);
    if (!PUBLIC_STATUSES.includes(p.status)) return;
    await projectListing(this.env, tx, productId);
    const v = (await tx.query<{ version: number }>("SELECT version FROM products WHERE id = $1", [productId])).rows[0];
    await emit(this.env, tx, "listing.updated", "listing", productId, { listing_id: productId, store_id: storeId, version: v?.version ?? 0, status: p.status });
  }
}
