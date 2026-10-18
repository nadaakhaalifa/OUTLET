import { pageOf, type Ordering, type Position } from "../domain/directory";
import { isShopperVisible, type Sort, type Store } from "../domain/store";
import type { FavoriteRepository, StoreRepository } from "../domain/ports";

/**
 * Anonymous store reads (spec P3-06). Strictly narrower than the shopper directory: only ACTIVE stores
 * with an approved seller and a published legal identity are visible. PAUSED (vacation), SUSPENDED,
 * draft and under-review stores are indistinguishable from a missing store. Nothing here reads a
 * user's favourites, so no per-user value can reach the response.
 */
export function isPubliclyListed(store: Pick<Store, "status" | "sellerKycState" | "legalIdentity">): boolean {
  return store.status === "ACTIVE" && isShopperVisible(store);
}

export type PublicWorld = "local" | "global" | "everything";

export interface PublicStoreView {
  readonly store: Store;
  readonly followerCount: number;
}

export interface ListPublicStoresInput {
  readonly world: PublicWorld;
  readonly sort: Sort;
  readonly after: Position | null;
  readonly limit: number;
}

export interface ListPublicStoresOutput {
  readonly items: readonly PublicStoreView[];
  readonly hasMore: boolean;
  readonly last: Position | null;
  readonly ordering: Ordering;
}

export class ListPublicStores {
  constructor(
    private readonly stores: StoreRepository,
    private readonly favorites: Pick<FavoriteRepository, "followerCounts">,
  ) {}

  async execute(input: ListPublicStoresInput): Promise<ListPublicStoresOutput> {
    const [all, followers] = await Promise.all([this.stores.all(), this.favorites.followerCounts()]);
    const candidates = all
      .filter(isPubliclyListed)
      .filter((s) => input.world === "everything" || s.kind === input.world)
      .map((store) => ({ store, favoritePosition: null }));
    const page = pageOf(candidates, input.sort, input.after, input.limit);
    return {
      items: page.items.map((it) => ({ store: it.store, followerCount: followers.get(it.store.id) ?? 0 })),
      hasMore: page.hasMore,
      last: page.last,
      ordering: input.sort,
    };
  }
}

export class GetPublicStore {
  constructor(
    private readonly stores: StoreRepository,
    private readonly favorites: Pick<FavoriteRepository, "followerCounts">,
  ) {}

  /** Null for every non-public state alike (missing, draft, paused, suspended, under review). */
  async execute(storeId: string): Promise<PublicStoreView | null> {
    const store = await this.stores.findById(storeId);
    if (store === null || !isPubliclyListed(store)) return null;
    const followers = await this.favorites.followerCounts();
    return { store, followerCount: followers.get(store.id) ?? 0 };
  }
}

export const SITEMAP_PAGE_SIZE = 500;
export const SITEMAP_MAX_PAGE = 1000;

export class ListPublicStoreSitemap {
  constructor(private readonly stores: StoreRepository) {}

  /** 1-based page over public store ids ordered by id. `lastmod` is not tracked for stores and is omitted. */
  async execute(page: number): Promise<{ readonly items: readonly { readonly id: string; readonly slug: string }[]; readonly hasMore: boolean }> {
    const ids = (await this.stores.all())
      .filter(isPubliclyListed)
      .map((s) => ({ id: s.id, slug: s.slug }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const start = (page - 1) * SITEMAP_PAGE_SIZE;
    return { items: ids.slice(start, start + SITEMAP_PAGE_SIZE), hasMore: start + SITEMAP_PAGE_SIZE < ids.length };
  }
}

