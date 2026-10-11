import type { Actor, Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { HubStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_HUB = "00000000-0000-0000-0000-000000000000";

export function hubIdsOf(actor: Actor): string[] {
  return actor.grants.flatMap((g) => (g.kind === "courier" ? [g.hubId] : []));
}

/**
 * `POST /v1/hub/receipts` carries the seller order in the body, which the guard cannot resolve by
 * path. The resource is therefore the operator's own (first) hub: a caller without a courier grant
 * fails the role check with 403, and the handler answers 404 for a leg of any hub the actor lacks.
 */
export class OperatorHubResolver implements ResourceResolver {
  async resolve(input: { readonly actor: Actor }): Promise<Resource | null> {
    const first = hubIdsOf(input.actor)[0] ?? NIL_HUB;
    return { type: "courier_task", id: first, hubId: first, state: "active" };
  }
}

/** A consolidated parcel addressed by path: scoped to its hub. */
export class ParcelResolver implements ResourceResolver {
  constructor(private readonly store: HubStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const p = await this.store.getParcel(input.id.toLowerCase());
    if (p === null) return null;
    return { type: "courier_task", id: p.id, hubId: p.hubId, state: "active" };
  }
}

/** An order group's tracking: owned by the shopper. */
export class OrderGroupResolver implements ResourceResolver {
  constructor(private readonly store: HubStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const g = await this.store.getGroup(input.id.toLowerCase());
    if (g === null) return null;
    return { type: "order", id: g.orderGroupId, ownerUserId: g.userId, state: "active" };
  }
}
