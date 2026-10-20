import { ApiError, type OutletClient } from "../../services/api-client";
import { money, pick, type AdapterContext } from "../../services/wire";
import type { SavedProductInfo, SavedProductReader } from "./guest-wishlists";

const BATCH = 6;

/** GET /v1/public/products/{id} (no bearer), a few at a time. A 404 marks the product delisted; any other failure leaves it unknown. */
export class ApiSavedProductReader implements SavedProductReader {
  constructor(private readonly client: OutletClient, private readonly ctx: Pick<AdapterContext, "locale">) {}

  async read(productIds: readonly string[]): Promise<ReadonlyMap<string, SavedProductInfo>> {
    const out = new Map<string, SavedProductInfo>();
    const lang = this.ctx.locale();
    for (let i = 0; i < productIds.length; i += BATCH) {
      await Promise.all(productIds.slice(i, i + BATCH).map(async (id) => {
        try {
          const r = await this.client.getPublicProduct({ path: { productId: id } });
          if (r.notModified) return;
          const p = r.data;
          out.set(id, {
            title: pick(p.title, lang), storeId: p.store.id, storeName: pick(p.store.name, lang), storeVerified: p.store.verified_badge,
            price: money(p.price.price), listed: p.skus.some((s) => s.available) || p.skus.length === 0,
            sizes: new Map(p.skus.map((s) => [s.id, { label: s.size_label, price: money(s.price.price) }])),
          });
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) out.set(id, { title: "", storeId: "", storeName: "", storeVerified: false, price: 0n, listed: false, sizes: new Map() });
        }
      }));
    }
    return out;
  }
}
