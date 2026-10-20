import type { LevelView, SyncOutcome } from "../domain/core";
import type { ClockPort, InventoryStore, SkuDirectory } from "../domain/ports";
import { SyncStockInput } from "./schemas";

export type SyncStockResult =
  | { readonly kind: "applied"; readonly level: LevelView; readonly oversoldUnits: number; readonly replayed: boolean }
  | { readonly kind: "stale"; readonly currentSourceVersion: number }
  | { readonly kind: "version_conflict"; readonly currentVersion: number }
  | { readonly kind: "negative"; readonly wouldBe: number }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_input" };

/**
 * Seller (or channel integration) stock update, idempotent and versioned (spec 20.2).
 * Authorization is the policy guard's job; this use case re-checks the SKU against the actor's
 * stores so that a wiring mistake in the guard cannot move another tenant's stock (API1).
 */
export class SyncSellerStock {
  constructor(
    private readonly store: InventoryStore,
    private readonly directory: SkuDirectory,
    private readonly clock: ClockPort,
    private readonly standardPoolId: string,
  ) {}

  async execute(raw: unknown): Promise<SyncStockResult> {
    const p = SyncStockInput.safeParse(raw);
    if (!p.success) return { kind: "invalid_input" };
    const input = p.data;
    const loc = await this.directory.lookup(input.skuId);
    if (loc === null || !input.actorStoreIds.includes(loc.storeId)) return { kind: "not_found" };

    const outcome: SyncOutcome = await this.store.applySync({
      skuId: input.skuId,
      locationId: loc.locationId,
      poolId: this.standardPoolId,
      storeId: loc.storeId,
      mode: input.mode,
      quantity: input.quantity,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: input.expectedVersion,
      sourceVersion: input.sourceVersion,
      actorType: input.actorType,
      actorId: input.actorId,
      nowMs: this.clock.nowMs(),
    });
    switch (outcome.status) {
      case "applied":
        return { kind: "applied", level: outcome.level, oversoldUnits: outcome.oversoldUnits, replayed: outcome.replayed };
      case "stale":
        return { kind: "stale", currentSourceVersion: outcome.currentSourceVersion };
      case "version_conflict":
        return { kind: "version_conflict", currentVersion: outcome.currentVersion };
      case "negative":
        return { kind: "negative", wouldBe: outcome.wouldBe };
    }
  }
}
