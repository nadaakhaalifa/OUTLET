import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { CalendarStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A shopper's own calendar event. Another user's event resolves with another owner, so policy answers 404.
 * NOTE: policy has no calendar resource type yet; `wishlist` (shopper owned, read and write) stands in,
 * as for stylist outfits, until the integrator adds one.
 */
export class EventResolver implements ResourceResolver {
  constructor(private readonly store: CalendarStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const e = await this.store.getEvent(input.id.toLowerCase());
    if (e === null) return null;
    return { type: "wishlist", id: e.id, ownerUserId: e.userId, state: "active" };
  }
}
