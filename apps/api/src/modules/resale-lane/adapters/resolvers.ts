import type { Actor, Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_HUB = "00000000-0000-0000-0000-000000000000";

export function hubIdsOf(actor: Actor): string[] {
  return actor.grants.flatMap((g) => (g.kind === "courier" ? [g.hubId] : []));
}

/**
 * Listing a returned unit carries the return id in the body, which the guard cannot resolve by
 * path. The resource is the operator's own (first) hub: a caller without a courier grant fails the
 * role check (403) and the handler answers 404 for a unit inspected at any hub the actor lacks.
 */
export class ResaleOperatorResolver implements ResourceResolver {
  async resolve(input: { readonly actor: Actor }): Promise<Resource | null> {
    const first = hubIdsOf(input.actor)[0] ?? NIL_HUB;
    return { type: "courier_task", id: first, hubId: first, state: "active" };
  }
}

/** A store route: another seller's store is indistinguishable from a missing one (404). */
export class ResaleStoreResolver implements ResourceResolver {
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const id = input.id.toLowerCase();
    return { type: "store_product", id, storeId: id, state: "active" };
  }
}

/** Admin console collections (no object id): any admin grant passes the policy; the handler narrows roles. */
export class ResaleAdminResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "resale", state: "active" };
  }
}
