import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { ProductMediaStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collection routes address a store: another seller's store is indistinguishable from a missing one (404). */
export class ProductMediaStoreResolver implements ResourceResolver {
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const id = input.id.toLowerCase();
    return { type: "store_product", id, storeId: id, state: "active" };
  }
}

/** Job routes load the job so that policy decides against its real store. */
export class ProductMediaJobResolver implements ResourceResolver {
  constructor(private readonly store: ProductMediaStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const job = await this.store.getJob(input.id.toLowerCase());
    if (job === null) return null;
    return { type: "store_product", id: job.id, storeId: job.storeId, state: "active" };
  }
}
