import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { Actor } from "@outlet/policy";
import type { StylistChatStore } from "../domain/chat-ports";
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

const NIL_STORE = "00000000-0000-0000-0000-000000000000";
export const storeIdsOf = (actor: Actor): string[] => actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : []));

/** Seller collection route: the caller's first store; a non-seller falls on the nil store and is refused. */
export class SellerStoreResolver implements ResourceResolver {
  async resolve(input: { readonly actor: Actor }): Promise<Resource | null> {
    const first = storeIdsOf(input.actor)[0] ?? NIL_STORE;
    return { type: "store_order", id: first, storeId: first, state: "active" };
  }
}

/**
 * A shopper's own chat session. Another user's session resolves with another owner, so policy
 * answers 404. As with outfits, `wishlist` (shopper-owned, read/write/delete) stands in until the
 * policy package gains a `chat_session` resource type.
 */
export class ChatSessionResolver implements ResourceResolver {
  constructor(private readonly chat: StylistChatStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const s = await this.chat.getSession(input.id.toLowerCase());
    if (s === null) return null;
    return { type: "wishlist", id: s.id, ownerUserId: s.userId, state: "active" };
  }
}
