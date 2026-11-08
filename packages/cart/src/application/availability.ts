import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";

export interface AvailabilityQuery {
  /** Sku ids to check, per store (the store id is the line's catalog store). */
  readonly skuIdsByStore: ReadonlyMap<string, readonly string[]>;
}

/** Returns the sku ids that can still be bought (at least one unit free). Read only: the bag never reserves (checkout does). */
export interface AvailabilityPort {
  availableSkus(q: AvailabilityQuery): Promise<ReadonlySet<string>>;
}

/** Default: every sku is as available as its published listing says (the cart query already applied that). */
export const listingStatusAvailability: AvailabilityPort = {
  availableSkus: (q) => Promise.resolve(new Set([...q.skuIdsByStore.values()].flat())),
};

/**
 * Reads inventory_levels. Those rows are store-isolated (RLS), so the read re-binds a store context per store, one statement per
 * store and never per line (the same trust model as @outlet/inventory: the store id comes from the line's catalog row).
 * A public availability read model in inventory would replace this with a single statement.
 */
export const pgInventoryAvailability = (client: RoleSqlClient<"outlet_app">, marketId: string): AvailabilityPort => ({
  async availableSkus(q) {
    const out = new Set<string>();
    for (const [storeId, skuIds] of q.skuIdsByStore) {
      if (skuIds.length === 0) continue;
      const rows = await withDbContext(client, { kind: "store", marketId, storeId }, async (tx) =>
        (
          await tx.query<{ sku_id: string }>(
            `SELECT sku_id FROM inventory_levels WHERE sku_id = ANY($1::uuid[]) GROUP BY sku_id HAVING SUM(on_hand - committed) >= 1`,
            [skuIds],
          )
        ).rows,
      );
      for (const r of rows) out.add(r.sku_id);
    }
    return out;
  },
});
