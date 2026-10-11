import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { StylistStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A shopper's own outfit. Another user's outfit resolves with another owner, so policy answers 404.
 * NOTE: policy has no `outfit` resource type yet; `wishlist` (shopper-owned, read/write) stands in
 * until the integrator adds one (see Build notes in the spec).
 */
export class OutfitResolver implements ResourceResolver {
  constructor(private readonly store: StylistStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const o = await this.store.getOutfit(input.id.toLowerCase());
    if (o === null) return null;
    return { type: "wishlist", id: o.id, ownerUserId: o.userId, state: "active" };
  }
}
