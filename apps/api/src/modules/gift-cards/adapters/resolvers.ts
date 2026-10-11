import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { GiftCardStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (raw: string | undefined): string | null => (raw !== undefined && UUID.test(raw) ? raw.toLowerCase() : null);

/** A card is owned by its purchaser. Unknown and foreign both end as 404 in the policy guard. */
export class CardResolver implements ResourceResolver {
  constructor(private readonly store: GiftCardStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = idOf(input.id);
    if (id === null) return null;
    const c = await this.store.getCard(id);
    return c === null ? null : { type: "gift_card", id, ownerUserId: c.purchaserId, state: "active" };
  }
}

/** A pot is owned by its organiser. */
export class PotResolver implements ResourceResolver {
  constructor(private readonly store: GiftCardStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = idOf(input.id);
    if (id === null) return null;
    const p = await this.store.getPot(id);
    return p === null ? null : { type: "gift_card", id, ownerUserId: p.organiserId, state: "active" };
  }
}
