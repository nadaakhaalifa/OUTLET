/**
 * "For you" (round-2 item 5). Pure model: which modules show, and from what. No UI imports.
 *
 * Rules (spec section 13, 12, 18):
 * - Personalization OFF = non-personalised modules only. No saved, bag or similar data is read, the feed is requested with
 *   personalized=false and no user features are sent.
 * - Budget data (section 12) is never an input: the port has no budget method and the feed is never asked for `affordable`.
 * - A module with no resolvable products is hidden. Nothing is invented: a recommended id the catalogue cannot resolve is dropped.
 */
import type { HomeProduct } from "../home/model";
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export const MODULE_LIMIT = 10;

export type DiscoverModuleId = "becauseSaved" | "goesWithBag" | "priceDropped" | "picked" | "popular" | "recentlyViewed";

/** One server recommendation. The wire carries ids only; titles come from the catalogue. */
export interface RecItem {
  readonly productId: string;
  /** Owning store when the wire carries it (public feed); used only for the on-device guest re-rank. */
  readonly storeId?: string | null;
  /** Server reason text, used as a caption only when present. */
  readonly reason: string | null;
  /** A real server-reported drop; null when the item has none. */
  readonly priceDrop: { readonly seenPrice: bigint; readonly dropBy: bigint } | null;
}

export interface FeedResult {
  readonly personalized: boolean;
  readonly degraded: boolean;
  readonly items: readonly RecItem[];
}

export interface DiscoverSettings {
  readonly personalization: boolean;
  readonly historyPaused: boolean;
}

/** Everything the port read. Fields that were not requested (or failed) are null and hide their module. */
export interface DiscoverData {
  readonly settings: DiscoverSettings;
  /** Products the wire ids can be resolved against. */
  readonly catalogue: readonly HomeProduct[];
  /** Newest saved item's title and its similar items. Null when nothing is saved. */
  readonly saved: { readonly title: string; readonly similar: readonly RecItem[] } | null;
  /** Items that go with the bag (from the newest bag product). Null when the bag is empty. */
  readonly goesWithBag: readonly RecItem[] | null;
  readonly feed: FeedResult | null;
  /** Non-personalised feed. */
  readonly popular: FeedResult | null;
  readonly recentlyViewed: readonly string[] | null;
}

export interface DiscoverFlags {
  /** kill.stylist is open. The server also enforces it: a blocked endpoint fails and the module hides. */
  readonly stylistOpen: boolean;
}
export const DEFAULT_FLAGS: DiscoverFlags = { stylistOpen: true };

export interface DiscoverModule {
  readonly id: DiscoverModuleId;
  readonly products: readonly HomeProduct[];
  /** For becauseSaved. */
  readonly savedTitle?: string;
  /** Server reasons keyed by product id (picked only). */
  readonly captions?: Readonly<Record<string, string>>;
}

export interface DiscoverPort {
  /** `personalization` decides what is read at all. Off: only the non-personalised feed and the device history are touched. */
  load(personalization: boolean | null): Promise<DiscoverData>;
}

function resolve(ids: readonly string[], catalogue: readonly HomeProduct[], limit = MODULE_LIMIT): readonly HomeProduct[] {
  const byId = new Map(catalogue.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: HomeProduct[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Module-visibility matrix, top to bottom. Each module is hidden when its products are empty.
 * | module        | needs                                                                     |
 * | becauseSaved  | personalization on, a saved item, similar items                           |
 * | goesWithBag   | personalization on, bag not empty, stylist kill switch open               |
 * | priceDropped  | personalization on, server price_drop on feed items                       |
 * | picked        | personalization on, feed.personalized, not degraded                       |
 * | popular       | personalization off, or the personalised feed is empty or degraded        |
 * | recentlyViewed| history not paused                                                        |
 */
export function buildModules(data: DiscoverData, flags: DiscoverFlags = DEFAULT_FLAGS): readonly DiscoverModule[] {
  const on = data.settings.personalization;
  const out: DiscoverModule[] = [];
  const add = (m: DiscoverModule): void => { if (m.products.length > 0) out.push(m); };

  if (on && data.saved !== null) {
    add({ id: "becauseSaved", savedTitle: data.saved.title, products: resolve(data.saved.similar.map((i) => i.productId), data.catalogue) });
  }
  if (on && flags.stylistOpen && data.goesWithBag !== null) {
    add({ id: "goesWithBag", products: resolve(data.goesWithBag.map((i) => i.productId), data.catalogue) });
  }
  const feed = on ? data.feed : null;
  const dropped = feed !== null && feed.personalized ? feed.items.filter((i) => i.priceDrop !== null && i.priceDrop.dropBy > 0n) : [];
  add({ id: "priceDropped", products: resolve(dropped.map((i) => i.productId), data.catalogue) });

  const pickedItems = feed !== null && feed.personalized && !feed.degraded ? feed.items : [];
  const picked = resolve(pickedItems.map((i) => i.productId), data.catalogue);
  const captions: Record<string, string> = {};
  for (const i of pickedItems) if (i.reason !== null && i.reason.trim().length > 0) captions[i.productId] = i.reason.trim();
  add({ id: "picked", products: picked, captions });

  if (!on || picked.length === 0) {
    // A feed that claims to be personalised is never shown as "Popular now" when personalization is off.
    const pop = data.popular;
    add({ id: "popular", products: pop !== null && !pop.personalized ? resolve(pop.items.map((i) => i.productId), data.catalogue) : [] });
  }
  if (!data.settings.historyPaused && data.recentlyViewed !== null) {
    add({ id: "recentlyViewed", products: resolve(data.recentlyViewed, data.catalogue) });
  }
  return out;
}

export type DiscoverScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly data: DiscoverData };

export function discoverFailure(e: unknown): DiscoverScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/** The feed query. Built in one place so a test can prove budget data and user features are never part of it. */
export function feedQuery(personalization: boolean, limit: number = MODULE_LIMIT): { readonly personalized: "true" | "false"; readonly limit: number } {
  return { personalized: personalization ? "true" : "false", limit: Math.min(50, Math.max(1, Math.floor(limit))) };
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

export class InMemoryDiscoverPort implements DiscoverPort {
  readonly calls: { personalization: boolean | null }[] = [];
  constructor(private data: DiscoverData, private failure: PortFailure | null = null) {}
  setData(d: DiscoverData): void { this.data = d; }
  setFailure(f: PortFailure | null): void { this.failure = f; }
  async load(personalization: boolean | null): Promise<DiscoverData> {
    this.calls.push({ personalization });
    if (this.failure !== null) throw new PortError(this.failure);
    const on = personalization ?? this.data.settings.personalization;
    if (on) return { ...this.data, settings: { ...this.data.settings, personalization: on } };
    return { ...this.data, settings: { ...this.data.settings, personalization: false }, saved: null, goesWithBag: null, feed: null };
  }
}

export const EMPTY_DISCOVER: DiscoverData = {
  settings: { personalization: true, historyPaused: false },
  catalogue: [], saved: null, goesWithBag: null, feed: null, popular: null, recentlyViewed: null,
};
