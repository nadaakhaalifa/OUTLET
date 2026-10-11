import type { Actor, Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { PurchaseVerificationPort, ReviewStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_STORE = "00000000-0000-0000-0000-000000000000";

export function storeIdsOf(actor: Actor): string[] {
  return actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : []));
}

/** The order line a review is written for: owned by the buyer. Missing and foreign are both null/foreign. */
export class OrderLineResolver implements ResourceResolver {
  constructor(private readonly purchases: PurchaseVerificationPort) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const line = await this.purchases.findDeliveredLine(input.id.toLowerCase());
    if (line === null) return null;
    return { type: "review", id: line.orderLineId, ownerUserId: line.userId, storeId: line.storeId, state: "active" };
  }
}

/** A shopper's own review. Another user's review resolves with another owner, so policy answers 404. */
export class OwnReviewResolver implements ResourceResolver {
  constructor(private readonly store: ReviewStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const r = await this.store.getReview(input.id.toLowerCase());
    if (r === null) return null;
    return { type: "review", id: r.id, ownerUserId: r.userId, storeId: r.storeId, state: "active" };
  }
}

/**
 * A review addressed by a seller. Tenant is the review's store, so another store's review is a
 * 404. Reviews and Q&A are authorized as `store_product` (catalog, manager and owner roles).
 */
export class StoreReviewResolver implements ResourceResolver {
  constructor(private readonly store: ReviewStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const r = await this.store.getReview(input.id.toLowerCase());
    if (r === null) return null;
    return { type: "store_product", id: r.id, storeId: r.storeId, state: "active" };
  }
}

export class StoreQuestionResolver implements ResourceResolver {
  constructor(private readonly store: ReviewStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const q = await this.store.getQuestion(input.id.toLowerCase());
    if (q === null) return null;
    return { type: "store_product", id: q.id, storeId: q.storeId, state: "active" };
  }
}

/** Seller queues are collections: the resource is the actor's first store (nil store fails the role check). */
export class StoreListResolver implements ResourceResolver {
  async resolve(input: { readonly actor: Actor }): Promise<Resource | null> {
    const first = storeIdsOf(input.actor)[0] ?? NIL_STORE;
    return { type: "store_product", id: first, storeId: first, state: "active" };
  }
}

/** The moderation console is platform wide; role gating is the admin rule plus the handler check. */
export class ModerationResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "review-moderation", state: "active" };
  }
}
