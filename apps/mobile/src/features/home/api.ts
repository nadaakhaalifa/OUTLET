import { dataOf } from "../../services/api-client";
import { guard, money, ms, pick, type AdapterContext, type GuestSignals } from "../../services/wire";
import { affinityScore, rerankByAffinity } from "../guest/affinity";
import { inferKind, type HeroDrop, type HomeData, type HomePort, type HomeProduct } from "./model";

/**
 * Signed out "For you": the public feed order (never personalised by the server), re-ranked on the phone by the
 * device's own store counters. Null (rail hidden) when nothing on the phone points anywhere: the public order is not "for you".
 */
export function guestForYou(products: readonly HomeProduct[], feedIds: readonly string[], signals: GuestSignals | null): readonly string[] | null {
  if (signals === null) return null;
  const byId = new Map(products.map((p) => [p.id, p]));
  const pool = (feedIds.length > 0 ? feedIds.flatMap((id) => { const p = byId.get(id); return p === undefined ? [] : [p]; }) : products);
  const affinity = { stores: signals.stores, categories: signals.categories };
  const ranked = rerankByAffinity(pool, affinity, (p) => ({ storeId: p.storeId, categoryId: null }));
  const lead = ranked[0];
  if (lead === undefined || affinityScore(affinity, lead.storeId, null) === 0) return null;
  return ranked.map((p) => p.id);
}

/**
 * Home composes three reads: GET /v1/drops (hero, server_time), GET /v1/search (catalogue, server order)
 * and GET /v1/feed (For you ids; `personalized` false hides the rail). The wire has no listing created-at or
 * offer end time, so "New drops" follows the server's order and "Ending soon" stays empty until the API exposes
 * an end time (docs/plan/api-client-gap.md, home rails).
 */
export class ApiHomePort implements HomePort {
  constructor(private readonly ctx: AdapterContext) {}

  load(): Promise<HomeData> {
    return guard(async () => {
      const guest = (await this.ctx.isGuest?.()) === true;
      // Signed out: public search and the non-personalised public feed only. Personalisation stays on the phone (see below).
      const c = this.ctx.client;
      const drops = await c.listPublicDrops({ query: { limit: 10 } });
      const d = dataOf(drops);
      const s = guest ? dataOf(await c.searchPublic({ query: { limit: 40 } })) : dataOf(await c.search({ query: { limit: 40 } }));
      const f: { readonly personalized: boolean; readonly items: readonly { readonly product_id: string }[] } | null = guest
        ? await c.getPublicFeed({ query: { limit: 12 } }).then((r) => dataOf(r), () => null)
        : dataOf(await c.getFeed({ query: { personalized: "true", limit: 12 } }));
      const lang = this.ctx.locale();
      const nowMs = this.ctx.nowMs();
      const first = d.items.find((x) => !x.paused);
      const serverNowMs = first !== undefined ? ms(first.server_time) : nowMs;
      const hero: HeroDrop | null =
        first === undefined
          ? null
          : { id: first.id, title: first.title, storeName: "", variant: "drop", startsAtMs: ms(first.starts_at) > serverNowMs ? ms(first.starts_at) : null, live: first.state.toLowerCase() === "live" };
      const dropList: HeroDrop[] = d.items
        .filter((x) => !x.paused)
        .map((x) => ({ id: x.id, title: x.title, storeName: "", variant: "drop" as const, startsAtMs: ms(x.starts_at) > serverNowMs ? ms(x.starts_at) : null, live: x.state.toLowerCase() === "live" }));
      const products = s.items.map((p, i): HomeProduct => {
        const ref = p.price.badge === "verified_discount" ? p.price.reference_price ?? null : null;
        return {
          id: p.id,
          title: pick(p.title, lang),
          storeId: p.store.id,
          storeName: pick(p.store.name, lang),
          kind: inferKind(pick(p.title, "en")),
          price: money(p.price.price),
          referencePrice: ref === null ? null : money(ref),
          verifiedPct: p.price.badge === "verified_discount" ? p.price.discount_pct ?? null : null,
          isLaunchPrice: p.price.badge === "launch_price",
          createdAtMs: nowMs - i * 1000,
          endsAtMs: null,
          sponsored: p.sponsored,
        };
      });
      if (guest) {
        const signals = this.ctx.guestSignals !== undefined ? await this.ctx.guestSignals().catch(() => null) : null;
        return { serverNowMs, hero, drops: dropList, products, forYouIds: guestForYou(products, f?.items.map((x) => x.product_id) ?? [], signals) };
      }
      return { serverNowMs, hero, drops: dropList, products, forYouIds: f !== null && f.personalized ? f.items.map((x) => x.product_id) : null };
    });
  }
}
