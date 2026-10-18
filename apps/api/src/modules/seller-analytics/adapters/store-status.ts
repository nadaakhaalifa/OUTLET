import type { StoreStatus, StoreStatusLookup } from "../domain/store-status";

/** In-memory lookup for tests and the dev stack. `reads` counts lookups so tests can prove none happened. */
export class StaticStoreStatusLookup implements StoreStatusLookup {
  private readonly map = new Map<string, StoreStatus>();
  readonly reads: (readonly string[])[] = [];
  set(storeId: string, status: StoreStatus): void {
    this.map.set(storeId, status);
  }
  async statusesOf(storeIds: readonly string[]): Promise<ReadonlyMap<string, StoreStatus>> {
    this.reads.push([...storeIds]);
    const out = new Map<string, StoreStatus>();
    for (const id of storeIds) {
      const s = this.map.get(id);
      if (s !== undefined) out.set(id, s);
    }
    return out;
  }
}

/** Production default until composition binds the stores repository: fails closed (503), never guesses a status. */
export class UnconfiguredStoreStatusLookup implements StoreStatusLookup {
  async statusesOf(): Promise<ReadonlyMap<string, StoreStatus>> {
    throw new Error("seller-analytics StoreStatusLookup is not bound (production composition must supply storeStatus)");
  }
}
