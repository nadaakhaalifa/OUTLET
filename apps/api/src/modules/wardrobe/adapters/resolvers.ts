import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { WardrobeStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A shopper's own wardrobe item. Another user's item resolves with another owner, so policy answers
 * 404. NOTE: policy has no wardrobe resource type yet; `wishlist` (shopper owned, read, write and
 * delete) stands in, as for stylist outfits, chat sessions and calendar events.
 */
export class WardrobeItemResolver implements ResourceResolver {
  constructor(private readonly store: WardrobeStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const i = await this.store.getItem(input.id.toLowerCase());
    if (i === null) return null;
    return { type: "wishlist", id: i.id, ownerUserId: i.userId, state: "active" };
  }
}
