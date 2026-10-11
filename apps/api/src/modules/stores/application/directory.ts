import { pageOf, positionOf, widenHint, worldFilter, type DirectoryItem, type Ordering, type Position, type WidenHint } from "../domain/directory";
import { isShopperVisible, type Sort, type World } from "../domain/store";
import type { FavoriteRepository, StoreRepository } from "../domain/ports";
import type { StoreView } from "./views";

export interface ListStoresInput {
  readonly userId: string;
  readonly world: World;
  /** Undefined means "not requested": my_stores then keeps the user's own order. */
  readonly sort: Sort | undefined;
  readonly after: Position | null;
  readonly limit: number;
}

export interface ListStoresOutput {
  readonly items: readonly StoreView[];
  readonly hasMore: boolean;
  readonly last: Position | null;
  readonly ordering: Ordering;
  readonly hint: WidenHint | null;
}

export class ListStores {
  constructor(
    private readonly stores: StoreRepository,
    private readonly favorites: FavoriteRepository,
  ) {}

  async execute(input: ListStoresInput): Promise<ListStoresOutput> {
    const [all, favs, followers] = await Promise.all([
      this.stores.all(),
      this.favorites.list(input.userId),
      this.favorites.followerCounts(),
    ]);
    const position = new Map(favs.map((f) => [f.storeId, f.position]));
    const ordering = orderingFor(input.world, input.sort);
    const candidates: DirectoryItem[] = all
      .filter(isShopperVisible)
      .map((store) => ({ store, favoritePosition: position.get(store.id) ?? null }))
      .filter((it) => worldFilter(input.world, it));
    const page = pageOf(candidates, ordering, input.after, input.limit);
    const total = candidates.length;
    return {
      items: page.items.map((it) => ({
        store: it.store,
        isFavorite: it.favoritePosition !== null,
        followerCount: followers.get(it.store.id) ?? 0,
      })),
      hasMore: page.hasMore,
      last: page.last,
      ordering,
      hint: widenHint(input.world, total),
    };
  }
}

export function orderingFor(world: World, sort: Sort | undefined): Ordering {
  if (sort !== undefined) return sort;
  return world === "my_stores" ? "favorite_position" : "trending";
}

export { positionOf };

export class GetStore {
  constructor(
    private readonly stores: StoreRepository,
    private readonly favorites: FavoriteRepository,
  ) {}

  /** Null for missing, draft, suspended and under-review stores alike. */
  async execute(userId: string, storeId: string): Promise<StoreView | null> {
    const store = await this.stores.findById(storeId);
    if (store === null || !isShopperVisible(store)) return null;
    const [favs, followers] = await Promise.all([this.favorites.list(userId), this.favorites.followerCounts()]);
    return {
      store,
      isFavorite: favs.some((f) => f.storeId === store.id),
      followerCount: followers.get(store.id) ?? 0,
    };
  }
}
