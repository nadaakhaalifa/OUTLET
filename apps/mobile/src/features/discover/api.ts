import { dataOf } from "../../services/api-client";
import { guard, money, pick, piastres, type AdapterContext } from "../../services/wire";
import { inferKind, type HomeProduct } from "../home/model";
import { affinityScore, rerankByAffinity } from "../guest/affinity";
import { MODULE_LIMIT, feedQuery, type DiscoverData, type DiscoverPort, type DiscoverSettings, type FeedResult, type RecItem } from "./model";

type RecWire = { product_id: string; store_id?: string | undefined; reason: string; price_drop?: { seen_price_piastres: string; drop_piastres: string } | undefined };

function rec(i: RecWire): RecItem {
  return {
    productId: i.product_id,
    storeId: i.store_id ?? null,
    reason: i.reason.length > 0 ? i.reason : null,
    priceDrop: i.price_drop === undefined ? null : { seenPrice: piastres(i.price_drop.seen_price_piastres), dropBy: piastres(i.price_drop.drop_piastres) },
  };
}
const feedOf = (f: { personalized: boolean; degraded: readonly unknown[]; items: readonly RecWire[] }): FeedResult => ({ personalized: f.personalized, degraded: f.degraded.length > 0, items: f.items.map(rec) });

/** A module read that fails hides only that module. */
async function soft<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run(); } catch { return null; }
}

/**
 * Reads, all through existing operations: GET /v1/me/history (settings), GET /v1/search (catalogue to resolve ids),
 * GET /v1/feed, GET /v1/me/wishlists(+detail), GET /v1/cart, GET /v1/products/{id}/similar and GET /v1/me/recently-viewed.
 * With personalization off only the settings, catalogue, `feed?personalized=false` and recently-viewed are called.
 * No budget operation is imported or called (spec section 12).
 */
export class ApiDiscoverPort implements DiscoverPort {
  constructor(private readonly ctx: AdapterContext) {}

  /**
   * Signed out (ADR-0055): only GET /v1/public/search and GET /v1/public/feed (never personalised, so nothing about the
   * shopper reaches the server). "Picked for you" is the public feed re-ranked on the phone by the device's own store
   * counters; with no counters it is absent and the plain public order shows as "Popular". Recently viewed is the device list.
   * No /v1/me/* and no bearer-only route is called.
   */
  private async loadGuest(known: boolean | null): Promise<DiscoverData> {
    const c = this.ctx.client;
    const lang = this.ctx.locale();
    const signals = this.ctx.guestSignals !== undefined ? await this.ctx.guestSignals().catch(() => null) : null;
    const settings: DiscoverSettings = { personalization: known ?? true, historyPaused: false };
    // Paused: nothing new is recorded, but the recently viewed list is left as it is and existing counters still order the picks.
    const [search, popular] = await Promise.all([
      c.searchPublic({ query: { limit: 40 } }),
      soft(async () => feedOf(dataOf(await c.getPublicFeed({ query: { limit: MODULE_LIMIT * 2 } })))),
    ]);
    const catalogue: HomeProduct[] = dataOf(search).items.map((p, i): HomeProduct => {
      const verified = p.price.badge === "verified_discount";
      return {
        id: p.id, title: pick(p.title, lang), storeId: p.store.id, storeName: pick(p.store.name, lang), kind: inferKind(pick(p.title, "en")),
        price: money(p.price.price), referencePrice: verified && p.price.reference_price !== undefined && p.price.reference_price !== null ? money(p.price.reference_price) : null,
        verifiedPct: verified ? p.price.discount_pct ?? null : null, isLaunchPrice: p.price.badge === "launch_price",
        createdAtMs: this.ctx.nowMs() - i * 1000, endsAtMs: null, sponsored: p.sponsored,
      };
    });
    const publicFeed = popular;
    let feed: FeedResult | null = null;
    if (settings.personalization && signals !== null && popular !== null && popular.items.length > 0) {
      const affinity = { stores: signals.stores, categories: signals.categories };
      const storeOf = new Map(catalogue.map((p) => [p.id, p.storeId]));
      const keyOf = (i: RecItem) => ({ storeId: i.storeId ?? storeOf.get(i.productId) ?? "", categoryId: null });
      const ranked = rerankByAffinity(popular.items, affinity, keyOf);
      const lead = ranked[0];
      if (lead !== undefined && affinityScore(affinity, keyOf(lead).storeId, null) > 0) {
        // `personalized: true` here means "ordered on this phone from this phone's own counters", nothing the server knows.
        feed = { personalized: true, degraded: false, items: ranked };
      }
    }
    const recent = signals === null ? null : signals.viewed.slice(0, MODULE_LIMIT);
    return { settings, catalogue, saved: null, goesWithBag: null, feed, popular: publicFeed, recentlyViewed: recent !== null && recent.length > 0 ? recent : null };
  }

  load(known: boolean | null): Promise<DiscoverData> {
    return guard(async () => {
      if ((await this.ctx.isGuest?.()) === true) return this.loadGuest(known);
      const c = this.ctx.client;
      const lang = this.ctx.locale();
      const [history, search] = await Promise.all([c.listMyHistory({ query: { limit: 1 } }), c.search({ query: { limit: 40 } })]);
      const hs = dataOf(history).settings;
      const settings: DiscoverSettings = { personalization: known ?? hs.personalization, historyPaused: hs.history_paused };
      const on = settings.personalization && hs.personalization;
      const catalogue: HomeProduct[] = dataOf(search).items.map((p, i): HomeProduct => {
        const verified = p.price.badge === "verified_discount";
        return {
          id: p.id, title: pick(p.title, lang), storeId: p.store.id, storeName: pick(p.store.name, lang), kind: inferKind(pick(p.title, "en")),
          price: money(p.price.price), referencePrice: verified && p.price.reference_price !== undefined && p.price.reference_price !== null ? money(p.price.reference_price) : null,
          verifiedPct: verified ? p.price.discount_pct ?? null : null, isLaunchPrice: p.price.badge === "launch_price",
          createdAtMs: this.ctx.nowMs() - i * 1000, endsAtMs: null, sponsored: p.sponsored,
        };
      });

      const feed = on ? await soft(async () => feedOf(dataOf(await c.getFeed({ query: feedQuery(true) })))) : null;
      const needPopular = !on || feed === null || !feed.personalized || feed.degraded || feed.items.length === 0;
      const popular = needPopular ? await soft(async () => feedOf(dataOf(await c.getFeed({ query: feedQuery(false) })))) : null;
      const recent = settings.historyPaused ? null : await soft(async () => dataOf(await c.listMyRecentlyViewed({ query: { limit: MODULE_LIMIT } })).items.map((i) => i.product_id));
      if (!on) return { settings: { ...settings, personalization: false }, catalogue, saved: null, goesWithBag: null, feed: null, popular, recentlyViewed: recent };

      const saved = await soft(async () => {
        const lists = dataOf(await c.listWishlists({ query: { limit: 20 } })).items;
        const newest = [...lists].filter((l) => l.item_count > 0).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        if (newest === undefined) return null;
        const detail = dataOf(await c.getWishlist({ path: { wishlistId: newest.id } }));
        const item = [...detail.items].reverse().find((i) => i.state === "active");
        if (item === undefined) return null;
        const similar = dataOf(await c.getSimilarProducts({ path: { productId: item.product_id }, query: { mode: "similar", limit: MODULE_LIMIT } }));
        return { title: item.product !== undefined ? pick(item.product.title, lang) : "", similar: similar.items.map(rec) };
      });
      const goesWithBag = await soft(async () => {
        const cart = dataOf(await c.getCart({}));
        const line = cart.groups.flatMap((g) => g.lines).find((l) => l.availability === "available");
        if (line === undefined) return null;
        return dataOf(await c.getSimilarProducts({ path: { productId: line.product_id }, query: { mode: "goes_with", limit: MODULE_LIMIT } })).items.map(rec);
      });
      return {
        settings, catalogue, saved: saved !== null && saved.title.length > 0 ? saved : null, goesWithBag, feed, popular, recentlyViewed: recent,
      };
    });
  }
}
