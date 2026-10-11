import type { TransferOutcome } from "../domain/core";
import type { ClockPort, InventoryStore, SkuDirectory } from "../domain/ports";
import { TransferPoolInput } from "./schemas";

export type TransferResult = TransferOutcome | { readonly status: "not_found" } | { readonly status: "invalid_input" };

/**
 * Allocates free stock between the STANDARD and FAWRY pools (ADR-0011 pool size limit). Internal
 * and operator-driven: there is no seller endpoint, because the Fawry allocation is a platform
 * decision (open product question in docs/specs/inventory.md).
 */
export class TransferBetweenPools {
  constructor(
    private readonly store: InventoryStore,
    private readonly directory: SkuDirectory,
    private readonly clock: ClockPort,
    private readonly pools: { readonly standard: string; readonly fawry: string },
  ) {}

  async execute(raw: unknown): Promise<TransferResult> {
    const p = TransferPoolInput.safeParse(raw);
    if (!p.success) return { status: "invalid_input" };
    const loc = await this.directory.lookup(p.data.skuId);
    if (loc === null) return { status: "not_found" };
    const toFawry = p.data.toPool === "FAWRY";
    return this.store.transfer({
      skuId: p.data.skuId,
      locationId: loc.locationId,
      fromPoolId: toFawry ? this.pools.standard : this.pools.fawry,
      toPoolId: toFawry ? this.pools.fawry : this.pools.standard,
      storeId: loc.storeId,
      qty: p.data.qty,
      idempotencyKey: p.data.idempotencyKey,
      nowMs: this.clock.nowMs(),
    });
  }
}
