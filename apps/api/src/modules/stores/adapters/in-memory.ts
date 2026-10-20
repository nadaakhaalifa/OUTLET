import type { FavoriteRow } from "../domain/favorites";
import type { FavoriteRepository, StoreActivityFeed, StoreRepository } from "../domain/ports";
import type { Store } from "../domain/store";

export class InMemoryStoreRepository implements StoreRepository {
  private readonly byId = new Map<string, Store>();

  constructor(seed: readonly Store[] = []) {
    for (const s of seed) this.byId.set(s.id, s);
  }

  async all(): Promise<readonly Store[]> {
    return [...this.byId.values()];
  }

  async findById(id: string): Promise<Store | null> {
    return this.byId.get(id) ?? null;
  }

  async bySeller(sellerId: string): Promise<readonly Store[]> {
    return [...this.byId.values()].filter((s) => s.sellerId === sellerId);
  }

  async save(store: Store): Promise<void> {
    this.byId.set(store.id, store);
  }
}

export class InMemoryFavoriteRepository implements FavoriteRepository {
  private readonly byUser = new Map<string, readonly FavoriteRow[]>();

  async list(userId: string): Promise<readonly FavoriteRow[]> {
    return this.byUser.get(userId) ?? [];
  }

  async replace(userId: string, rows: readonly FavoriteRow[]): Promise<void> {
    if (rows.length === 0) this.byUser.delete(userId);
    else this.byUser.set(userId, rows.map((r) => ({ ...r })));
  }

  async followerCounts(): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    for (const rows of this.byUser.values()) {
      for (const r of rows) counts.set(r.storeId, (counts.get(r.storeId) ?? 0) + 1);
    }
    return counts;
  }
}

export class InMemoryStoreActivityFeed implements StoreActivityFeed {
  private readonly events = new Map<string, number[]>();

  /** Test and dev hook; production appends from catalog outbox events. */
  record(storeId: string, occurredAtMs: number): void {
    const list = this.events.get(storeId) ?? [];
    list.push(occurredAtMs);
    this.events.set(storeId, list);
  }

  async occurredAtMsByStore(storeIds: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>> {
    return new Map(storeIds.map((id) => [id, this.events.get(id) ?? []]));
  }
}
