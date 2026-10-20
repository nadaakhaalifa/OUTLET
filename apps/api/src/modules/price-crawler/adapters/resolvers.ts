import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The route addresses a store. The resource carries the addressed store id and policy compares it
 * with the caller's brand grants, so another seller's store is indistinguishable from a missing
 * one (404); a role without the right (for example catalog staff on settings) gets 403.
 */
export class CrawlStoreResolver implements ResourceResolver {
  constructor(private readonly type: "store_settings" | "store_product") {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const id = input.id.toLowerCase();
    return { type: this.type, id, storeId: id, state: "active" };
  }
}

/** The platform matching config is a singleton: admin ops only. */
export class MatchingConfigResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "feature_flag", id: "00000000-0000-4000-8000-0000000000c1", state: "active" };
  }
}

/** Admin console reads are not object scoped; role is checked in the controller. */
export class CrawlAdminResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "price-crawler", state: "active" };
  }
}
