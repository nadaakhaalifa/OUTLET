import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { PayoutStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (raw: string | undefined): string | null => (raw !== undefined && UUID.test(raw) ? raw.toLowerCase() : null);

/** Seller route over a payout: the resource carries the payout's store, so a foreign store is `not_owned` (404). */
export class StorePayoutResolver implements ResourceResolver {
  constructor(private readonly store: PayoutStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = idOf(input.id);
    if (id === null) return null;
    const loc = await this.store.locate(id);
    return loc === null ? null : { type: "store_payout", id, storeId: loc.storeId, state: "active" };
  }
}

/** Seller route addressed by store id (statements). Any well-formed id resolves; policy checks the grant. */
export class StoreParamResolver implements ResourceResolver {
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = idOf(input.id);
    return id === null ? null : { type: "store_payout", id, storeId: id, state: "active" };
  }
}

/** Admin route over a payout (platform scope, no tenant). Missing is 404. */
export class AdminPayoutResolver implements ResourceResolver {
  constructor(private readonly store: PayoutStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = idOf(input.id);
    if (id === null) return null;
    return (await this.store.locate(id)) === null ? null : { type: "payout", id, state: "active" };
  }
}
