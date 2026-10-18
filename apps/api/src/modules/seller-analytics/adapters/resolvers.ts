import type { Actor, Resource } from "@outlet/policy";
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

const NIL_STORE = "00000000-0000-0000-0000-000000000000";

/** `/seller/me` has no object id: the caller's first store, or the nil store (refused) for a non-seller. */
export class SellerMeResolver implements ResourceResolver {
  async resolve(input: { readonly actor: Actor }): Promise<Resource | null> {
    const first = input.actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : []))[0] ?? NIL_STORE;
    return { type: "store_product", id: first, storeId: first, state: "active" };
  }
}

/**
 * `/seller/stores/{storeId}/me`: authorisation comes from the token alone (M8). A malformed id and a
 * store the caller holds no brand grant on both resolve to null, so they share one path, one body
 * and no database read. The store row is read by the controller only after policy allowed.
 */
export class SellerStoreMeResolver implements ResourceResolver {
  async resolve(input: { readonly id: string | undefined; readonly actor: Actor }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const id = input.id.toLowerCase();
    const held = input.actor.grants.some((g) => g.kind === "brand" && g.storeId.toLowerCase() === id);
    return held ? { type: "store_product", id, storeId: id, state: "active" } : null;
  }
}
