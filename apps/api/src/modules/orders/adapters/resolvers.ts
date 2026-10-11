import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { OrderRepository } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (raw: string | undefined): string | null =>
  raw !== undefined && UUID.test(raw) ? raw.toLowerCase() : null;

/** Shopper route over an order group: the engine decides on the real owner; unknown and foreign both become 404. */
export class OrderGroupResolver implements ResourceResolver {
  constructor(private readonly repo: OrderRepository) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = idOf(input.id);
    if (id === null) return null;
    const owner = await this.repo.groupOwner(id);
    return owner === null ? null : { type: "order", id, ownerUserId: owner, state: "active" };
  }
}

/** Seller routes: resource carries the order's store so a foreign store resolves to `not_owned` (404). */
export class SellerOrderResolver implements ResourceResolver {
  constructor(private readonly repo: OrderRepository) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = idOf(input.id);
    if (id === null) return null;
    const loc = await this.repo.locate(id);
    return loc === null ? null : { type: "store_order", id, storeId: loc.storeId, state: "active" };
  }
}

/** Shopper cancel: the seller order is owned by the shopper who placed the group. */
export class ShopperSellerOrderResolver implements ResourceResolver {
  constructor(private readonly repo: OrderRepository) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = idOf(input.id);
    if (id === null) return null;
    const loc = await this.repo.locate(id);
    return loc === null ? null : { type: "order", id, ownerUserId: loc.userId, state: "active" };
  }
}
