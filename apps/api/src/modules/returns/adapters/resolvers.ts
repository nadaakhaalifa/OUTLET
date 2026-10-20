import type { Actor, Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { ReturnRepository, ReturnableLinePort } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_STORE = "00000000-0000-0000-0000-000000000000";

export function storeIdsOf(actor: Actor): string[] {
  return actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : []));
}

/** Brand roles holding return read/write per the store_return policy rules. */
const RETURN_STAFF_ROLES: ReadonlySet<string> = new Set(["owner", "manager", "warehouse", "support"]);

/** Store ids where the actor holds a role allowed to read/work returns (list and detail agree). */
export function returnStoreIdsOf(actor: Actor): string[] {
  return actor.grants.flatMap((g) => (g.kind === "brand" && RETURN_STAFF_ROLES.has(g.role) ? [g.storeId] : []));
}

/** Order line addressed by createReturn: owner is the line's buyer. Foreign and missing are both null owners. */
export class OrderLineResolver implements ResourceResolver {
  constructor(private readonly lines: ReturnableLinePort) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const line = await this.lines.find(input.id.toLowerCase());
    if (line === null) return null;
    return { type: "return_request", id: line.orderLineId, ownerUserId: line.userId, storeId: line.storeId, state: "active" };
  }
}

/** A shopper's own return (read, dispute). */
export class OwnReturnResolver implements ResourceResolver {
  constructor(private readonly repo: ReturnRepository) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const r = await this.repo.findById(input.id.toLowerCase());
    if (r === null) return null;
    return { type: "return_request", id: r.id, ownerUserId: r.userId, storeId: r.storeId, state: "active" };
  }
}

/** A return that belongs to a store (seller inspect). */
export class StoreReturnResolver implements ResourceResolver {
  constructor(private readonly repo: ReturnRepository) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const r = await this.repo.findById(input.id.toLowerCase());
    if (r === null) return null;
    return { type: "store_return", id: r.id, storeId: r.storeId, state: "active" };
  }
}

/**
 * The seller's own return queue is a collection, not an object. The resource is the actor's first
 * store (or a nil store for a caller with no brand grant, who then fails the role check with 403).
 * The handler lists across all of the actor's stores.
 */
export class StoreListResolver implements ResourceResolver {
  async resolve(input: { readonly actor: Actor }): Promise<Resource | null> {
    const first = returnStoreIdsOf(input.actor)[0] ?? NIL_STORE;
    return { type: "store_return", id: first, storeId: first, state: "active" };
  }
}
