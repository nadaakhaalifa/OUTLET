import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { InventoryService } from "@outlet/inventory";
import type { Principal } from "@outlet/policy";
import type { RestockPort } from "./ports.js";

/**
 * RestockPort over @outlet/inventory: a returned unit that passes inspection goes back on the shelf (on_hand + 1 per unit, source
 * return_restock, idempotent per return item). Write-off, donation and open-box relisting (Phase 2 lane) are recorded on return_items only:
 * the unit never re-enters sellable stock.
 */
export class InventoryRestock implements RestockPort {
  private readonly service: InventoryService;
  private readonly actor: Principal;
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string) {
    this.service = new InventoryService({ client, marketId });
    this.actor = { kind: "system", marketId, roles: [], scopes: ["listing.write"] };
  }

  async apply(req: Parameters<RestockPort["apply"]>[0]): Promise<void> {
    if (req.decision !== "restock") return;
    const loc = await withDbContext(this.client, { kind: "store", marketId: this.marketId, storeId: req.storeId }, async (tx) =>
      (await tx.query<{ location_id: string }>("SELECT location_id FROM inventory_levels WHERE sku_id = $1 ORDER BY location_id LIMIT 1", [req.skuId])).rows[0],
    );
    if (loc === undefined) return;
    await this.service.adjustOnHand(this.actor, { skuId: req.skuId, locationId: loc.location_id, storeId: req.storeId, delta: req.qty, idempotencyKey: req.idempotencyKey, source: "return_restock" });
  }
}
