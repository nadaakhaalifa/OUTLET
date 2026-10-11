import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { SkuDirectory } from "../domain/ports";

/**
 * Loads the SKU a route addresses so the policy engine decides on real ownership. Unknown SKU
 * and another store's SKU are both resolved so that the engine answers 404 (API1, API5): this
 * resolver never reveals which of the two it was.
 */
export class SkuStockResolver implements ResourceResolver {
  constructor(private readonly directory: SkuDirectory) {}

  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !/^[0-9a-fA-F-]{36}$/.test(input.id)) return null;
    const loc = await this.directory.lookup(input.id.toLowerCase());
    if (loc === null) return null;
    return { type: "store_inventory", id: input.id.toLowerCase(), storeId: loc.storeId, state: "active" };
  }
}
