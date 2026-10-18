import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The route addresses a store; policy compares the addressed store with the caller's brand grants,
 * so another seller's store is indistinguishable from a missing one (404) and a role without the
 * settings right gets 403 (same rule as crawl targets and channels).
 */
export class OdooStoreResolver implements ResourceResolver {
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const id = input.id.toLowerCase();
    return { type: "store_settings", id, storeId: id, state: "active" };
  }
}
