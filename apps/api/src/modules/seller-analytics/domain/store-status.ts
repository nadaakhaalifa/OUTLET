/** `stores.status` (migration 0013_stores.sql). The wire uses the lower-case form. */
export type StoreStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "SUSPENDED";

/** Read-only lookup of store lifecycle status for stores a caller already holds a grant on. */
export interface StoreStatusLookup {
  /** One indexed query for the ids; ids without a row are absent from the map. */
  statusesOf(storeIds: readonly string[]): Promise<ReadonlyMap<string, StoreStatus>>;
}
