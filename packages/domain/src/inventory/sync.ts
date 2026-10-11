/** Seller stock synchronisation planning (spec 20.2, 19). Pure. */

export const STOCK_REASONS = ["recount", "received", "damaged", "channel_sync", "other"] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export type StockMode = "set" | "adjust";

export interface SyncLevelView {
  readonly onHand: number;
  readonly committed: number;
  readonly reserved: number;
  readonly syncVersion: number;
  readonly sourceVersion: number | null;
}

export interface SyncRequest {
  readonly mode: StockMode;
  readonly quantity: number;
  /** Optimistic concurrency: must equal the level's current `syncVersion`. */
  readonly expectedVersion?: number | undefined;
  /** Monotonic version supplied by a channel integration. Equal or older is a stale no-op. */
  readonly sourceVersion?: number | undefined;
}

export type SyncPlan =
  | { readonly kind: "stale"; readonly currentSourceVersion: number }
  | { readonly kind: "version_conflict"; readonly currentVersion: number }
  | { readonly kind: "negative"; readonly wouldBe: number }
  | {
      readonly kind: "apply";
      readonly newOnHand: number;
      readonly delta: number;
      readonly newSyncVersion: number;
      /** Units already promised (reserved or claimed) that the new on_hand cannot cover. */
      readonly oversoldUnits: number;
    };

export const planStockSync = (level: SyncLevelView | null, req: SyncRequest): SyncPlan => {
  const current = level ?? { onHand: 0, committed: 0, reserved: 0, syncVersion: 0, sourceVersion: null };
  if (req.sourceVersion !== undefined && current.sourceVersion !== null && req.sourceVersion <= current.sourceVersion) {
    return { kind: "stale", currentSourceVersion: current.sourceVersion };
  }
  if (req.expectedVersion !== undefined && req.expectedVersion !== current.syncVersion) {
    return { kind: "version_conflict", currentVersion: current.syncVersion };
  }
  const newOnHand = req.mode === "set" ? req.quantity : current.onHand + req.quantity;
  if (!Number.isSafeInteger(newOnHand) || newOnHand < 0) return { kind: "negative", wouldBe: newOnHand };
  const delta = newOnHand - current.onHand;
  const promised = current.committed + current.reserved;
  return {
    kind: "apply",
    newOnHand,
    delta,
    newSyncVersion: current.syncVersion + 1,
    oversoldUnits: delta < 0 ? Math.max(0, promised - newOnHand) : 0,
  };
};
