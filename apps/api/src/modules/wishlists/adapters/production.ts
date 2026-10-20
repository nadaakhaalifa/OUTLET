import type { ProductFactsReader } from "../../catalog";
import type { CatalogProduct, CatalogReadPort, JsonValue, OwnerProfilePort, ProductSummaryView } from "../domain/ports";

function toJson(v: unknown): JsonValue {
  if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "object" && v !== undefined) {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toJson(x);
    return out;
  }
  return null;
}

/**
 * Product facts through the catalog's public surface (never its tables). A missing id is absent; a
 * product that is not purchasable is returned with `listed: false` so the item shows as a ghost.
 */
export class CatalogBackedProductRead implements CatalogReadPort {
  constructor(private readonly catalog: ProductFactsReader) {}

  async products(ids: readonly string[]): Promise<ReadonlyMap<string, CatalogProduct>> {
    const facts = await this.catalog.facts(ids);
    const out = new Map<string, CatalogProduct>();
    for (const [id, f] of facts) {
      const summary: ProductSummaryView = { ...(toJson(f.summary) as { [key: string]: JsonValue }), id };
      out.set(id, { id, listed: f.listed, currentPrice: f.currentPrice, skuIds: f.skuIds, summary });
    }
    return out;
  }
}

/**
 * The auth module stores no public nickname (users carry no profile columns), so no owner has
 * one: shared lists show the title only. Never a legal name or a phone number.
 */
export class NoOwnerNicknames implements OwnerProfilePort {
  async nickname(): Promise<string | null> {
    return null;
  }
}
