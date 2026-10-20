import { advanceLastSeen, newSince, replaceFavorites, type FavoriteRow, type ReplaceFavoritesError } from "../domain/favorites";
import { hiddenReason, isShopperVisible, type HiddenReason } from "../domain/store";
import type { Clock, FavoriteRepository, StoreActivityFeed, StoreRepository } from "../domain/ports";
import type { StoreView } from "./views";

export interface HiddenFavorite {
  readonly storeId: string;
  readonly reason: HiddenReason;
}

export interface FavoritesState {
  readonly visible: readonly StoreView[];
  readonly hidden: readonly HiddenFavorite[];
}

async function load(
  stores: StoreRepository,
  favorites: FavoriteRepository,
  userId: string,
): Promise<{ state: FavoritesState; rows: readonly FavoriteRow[] }> {
  const [rows, followers] = await Promise.all([favorites.list(userId), favorites.followerCounts()]);
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  const visible: StoreView[] = [];
  const hidden: HiddenFavorite[] = [];
  for (const row of ordered) {
    const store = await stores.findById(row.storeId);
    if (store === null) {
      hidden.push({ storeId: row.storeId, reason: "unavailable" });
      continue;
    }
    const reason = hiddenReason(store);
    if (reason !== null) hidden.push({ storeId: store.id, reason });
    else visible.push({ store, isFavorite: true, followerCount: followers.get(store.id) ?? 0 });
  }
  return { state: { visible, hidden }, rows: ordered };
}

export class ListFavorites {
  constructor(
    private readonly stores: StoreRepository,
    private readonly favorites: FavoriteRepository,
  ) {}

  async execute(userId: string): Promise<FavoritesState> {
    return (await load(this.stores, this.favorites, userId)).state;
  }
}

export type ReplaceFavoritesOutcome =
  | { readonly kind: "ok"; readonly state: FavoritesState }
  | { readonly kind: "rejected"; readonly error: ReplaceFavoritesError };

export class ReplaceFavoriteStores {
  constructor(
    private readonly stores: StoreRepository,
    private readonly favorites: FavoriteRepository,
    private readonly clock: Clock,
  ) {}

  async execute(userId: string, storeIds: readonly string[]): Promise<ReplaceFavoritesOutcome> {
    const all = await this.stores.all();
    const visibleIds = new Set(all.filter(isShopperVisible).map((s) => s.id));
    const current = await this.favorites.list(userId);
    const result = replaceFavorites(current, storeIds, (id) => visibleIds.has(id), this.clock.nowMs());
    if (!result.ok) return { kind: "rejected", error: result.error };
    await this.favorites.replace(userId, result.rows);
    return { kind: "ok", state: (await load(this.stores, this.favorites, userId)).state };
  }
}

export interface NewCount {
  readonly storeId: string;
  readonly newSinceLastVisit: number;
}

export class GetNewCounts {
  constructor(
    private readonly stores: StoreRepository,
    private readonly favorites: FavoriteRepository,
    private readonly activity: StoreActivityFeed,
  ) {}

  async execute(userId: string): Promise<readonly NewCount[]> {
    const { state, rows } = await load(this.stores, this.favorites, userId);
    const seen = new Map(rows.map((r) => [r.storeId, r.lastSeenAtMs]));
    const ids = state.visible.map((v) => v.store.id);
    const events = await this.activity.occurredAtMsByStore(ids);
    return ids.map((storeId) => ({
      storeId,
      newSinceLastVisit: newSince(events.get(storeId) ?? [], seen.get(storeId) ?? 0),
    }));
  }
}

export class MarkFavoriteSeen {
  constructor(
    private readonly stores: StoreRepository,
    private readonly favorites: FavoriteRepository,
    private readonly clock: Clock,
  ) {}

  /** False when the store is not a visible favourite of this user (404 at the edge, no distinction). */
  async execute(userId: string, storeId: string): Promise<boolean> {
    const rows = await this.favorites.list(userId);
    const row = rows.find((r) => r.storeId === storeId);
    if (row === undefined) return false;
    const store = await this.stores.findById(storeId);
    if (store === null || !isShopperVisible(store)) return false;
    const next = advanceLastSeen(row, this.clock.nowMs());
    if (next !== row) {
      await this.favorites.replace(
        userId,
        rows.map((r) => (r.storeId === storeId ? next : r)),
      );
    }
    return true;
  }
}
