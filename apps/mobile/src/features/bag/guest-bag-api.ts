import type { OutletClient } from "../../services/api-client";
import { money } from "../../services/wire";
import type { LiveSku, SkuLiveReader } from "./guest-bag";

/** GET /v1/public/skus?ids= (no bearer). Up to 50 ids per read. */
export class ApiSkuLiveReader implements SkuLiveReader {
  constructor(private readonly client: OutletClient) {}

  async read(skuIds: readonly string[]): Promise<ReadonlyMap<string, LiveSku>> {
    const out = new Map<string, LiveSku>();
    const r = await this.client.listPublicSkus({ query: { ids: skuIds.slice(0, 50).join(",") } });
    if (r.notModified) return out;
    for (const i of r.data.items) out.set(i.id, { unitPrice: money(i.price), available: i.available, storeOpen: i.store.open });
    return out;
  }
}
