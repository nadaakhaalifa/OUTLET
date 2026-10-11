import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The route addresses a store. The resource carries the addressed store id and policy compares it
 * with the caller's brand grants, so another seller's store is indistinguishable from a missing
 * one (404). `type` selects the policy rule: dashboards use store_order (owner, manager, warehouse,
 * support, finance); the CSV export is the narrower store_settings (owner, manager).
 */
export class AnalyticsStoreResolver implements ResourceResolver {
  constructor(private readonly type: "store_order" | "store_settings") {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const id = input.id.toLowerCase();
    return { type: this.type, id, storeId: id, state: "active" };
  }
}
