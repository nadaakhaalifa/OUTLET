import type { Actor, Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { DropStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_STORE = "00000000-0000-0000-0000-000000000000";

export function storeIdsOf(actor: Actor): string[] {
  return actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : []));
}

/** A drop addressed by a seller. Tenant is the drop's store, so another store's drop is a 404. */
export class DropResolver implements ResourceResolver {
  constructor(private readonly store: DropStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const d = await this.store.get(input.id.toLowerCase());
    if (d === null) return null;
    return { type: "store_product", id: d.id, storeId: d.storeId, state: "active" };
  }
}

/** Collections and creates: the actor's first store; a non-seller falls on the nil store and is refused. */
export class StoreListResolver implements ResourceResolver {
  async resolve(input: { readonly actor: Actor }): Promise<Resource | null> {
    const first = storeIdsOf(input.actor)[0] ?? NIL_STORE;
    return { type: "store_product", id: first, storeId: first, state: "active" };
  }
}

export class AdminConsoleResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "drops", state: "active" };
  }
}
