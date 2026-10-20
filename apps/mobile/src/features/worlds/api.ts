import { collectPages, type schemas } from "../../services/api-client";
import { guard, pick, type AdapterContext } from "../../services/wire";
import type { StoreSummary, WorldsPort } from "./model";

/**
 * GET /v1/stores. The wire has no trending rank, newest-drop time, delivery days or suspended status
 * (suspended stores are hidden by the server, spec §3): rank follows the server's trending order and the
 * other sort keys are null, which the view model sorts last. See docs/plan/api-client-gap.md (listStores).
 */
export class ApiWorldsPort implements WorldsPort {
  constructor(private readonly ctx: AdapterContext) {}

  listStores(): Promise<readonly StoreSummary[]> {
    return guard(async () => {
      // Signed out: the public store directory (no bearer, no favourites). Same shape minus `is_favorite`.
      const guest = (await this.ctx.isGuest?.()) === true;
      const stores: readonly (schemas.PublicStoreSummary & { readonly is_favorite?: boolean })[] = guest
        ? await collectPages((cursor) => this.ctx.client.listPublicStores({ query: { world: "everything", sort: "trending", limit: 50, ...(cursor !== undefined ? { cursor } : {}) } }), 10)
        : await collectPages((cursor) => this.ctx.client.listStores({ query: { world: "everything", sort: "trending", limit: 50, ...(cursor !== undefined ? { cursor } : {}) } }), 10);
      return stores.map((s, i): StoreSummary => ({
        id: s.id,
        name: pick(s.name, this.ctx.locale()),
        kind: s.kind,
        status: "active",
        maxVerifiedDiscountPct: s.max_verified_discount_pct ?? null,
        rating: s.rating ?? null,
        followerCount: s.follower_count ?? 0,
        liveDrop: s.live_drop,
        trendingRank: i + 1,
        newestDropAtMs: null,
        deliveryDays: null,
        isFavourite: s.is_favorite === true,
        verified: s.verified_badge,
      }));
    });
  }
}
