/**
 * Erasure of a shopper's pseudonymous analytics keys (H3). `shopper_key` is P2: erasing the user must NULL it in
 * every facts row, for every pseudonym the user ever had inside the retention window.
 */
export interface ShopperPseudonymDeriver {
  /**
   * Every pseudonym of `userKey` for the rotation epoch containing `epochAt`: one per key version still held in
   * KMS. Production wraps `derivePseudonymousId(userKey, epochAt, hmac)` (packages/analytics) per key version.
   */
  derive(userKey: string, epochAt: Date): readonly string[];
}

export interface ShopperFactsEraser {
  /** Remembers the keys for 31 days so an older, unpublished outbox payload cannot re-introduce them (ingest NULLs them). */
  recordErasedKeys(keys: readonly string[], atMs: number): Promise<void>;
  /** NULLs `shopper_key` for at most `limit` fact rows holding one of `keys`. Returns the rows changed. */
  nullShopperKeys(keys: readonly string[], limit: number): Promise<number>;
}
