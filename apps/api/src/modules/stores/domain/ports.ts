import type { FavoriteRow } from "./favorites";
import type { Store } from "./store";

export interface Clock {
  nowMs(): number;
}

export interface StoreRepository {
  /** All stores, any status. Callers apply visibility. */
  all(): Promise<readonly Store[]>;
  findById(id: string): Promise<Store | null>;
  bySeller(sellerId: string): Promise<readonly Store[]>;
  save(store: Store): Promise<void>;
}

export interface FavoriteRepository {
  list(userId: string): Promise<readonly FavoriteRow[]>;
  /** Atomically replaces the whole list for one user. */
  replace(userId: string, rows: readonly FavoriteRow[]): Promise<void>;
  /** Number of users who favourited each store (derived follower_count). */
  followerCounts(): Promise<ReadonlyMap<string, number>>;
}

/** Source of "new since last visit" counters (catalog events once that module exists). */
export interface StoreActivityFeed {
  occurredAtMsByStore(storeIds: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>>;
}
