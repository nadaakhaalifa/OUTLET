import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import type { InventoryService } from "@outlet/inventory";
import { authorize } from "@outlet/policy";
import type { Action, Principal } from "@outlet/policy";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import { Problems } from "../../platform/problem.js";
import { LOW_STOCK_THRESHOLD } from "./dto.js";
import type { InventoryAdjustmentInput, InventoryLevel, InventoryLevelPage, InventoryQuery } from "./dto.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const SOURCE = { recount: "count", damage: "write_off", received: "seller_edit", correction: "seller_edit", channel_sync: "channel_sync" } as const;

interface LevelRow {
  sku_id: string; location_id: string; seller_sku: string; size_label: string | null; title_ar: string; on_hand: number; committed: number; version: number; updated_at: Date;
}

const LEVEL_SQL = `SELECT s.id AS sku_id, COALESCE(l.location_id, '${NIL}'::uuid) AS location_id, s.seller_sku, s.size_label, p.title_ar,
       COALESCE(l.on_hand, 0) AS on_hand, COALESCE(l.committed, 0) AS committed, COALESCE(l.version, 0) AS version, COALESCE(l.updated_at, s.updated_at) AS updated_at
  FROM skus s JOIN products p ON p.id = s.product_id LEFT JOIN inventory_levels l ON l.sku_id = s.id`;

const wire = (r: LevelRow): InventoryLevel => ({
  sku_id: r.sku_id, location_id: r.location_id === NIL ? null : r.location_id, seller_sku: r.seller_sku, size_label: r.size_label, product_title_ar: r.title_ar,
  on_hand: r.on_hand, committed: r.committed, available: Math.max(r.on_hand - r.committed, 0), low_stock: Math.max(r.on_hand - r.committed, 0) <= LOW_STOCK_THRESHOLD,
  version: r.version, updated_at: r.updated_at.toISOString(),
});

export interface SellerInventoryDeps {
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly inventory: Pick<InventoryService, "adjustOnHand">;
  readonly newId: () => string;
  readonly now: () => Date;
}

/** Seller stock screen: levels per SKU (real counts) and idempotent, versioned adjustments through @outlet/inventory. */
export class SellerInventoryService {
  constructor(private readonly d: SellerInventoryDeps) {}

  private access(actor: Principal, action: Action, storeId: string): void {
    if (actor.kind !== "seller_staff") throw Problems.forbidden();
    const r = authorize(actor, action, { type: "inventory", storeId, marketId: this.d.marketId });
    if (r.effect === "deny") throw r.reason === "not_found" ? Problems.notFound() : Problems.forbidden();
  }

  private store<T>(storeId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "store", marketId: this.d.marketId, storeId }, fn);
  }

  async list(actor: Principal, storeId: string, q: InventoryQuery): Promise<InventoryLevelPage> {
    this.access(actor, "listing.read", storeId);
    const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor, 2);
    const rows = await this.store(storeId, async (tx) =>
      (
        await tx.query<LevelRow>(
          `${LEVEL_SQL}
            WHERE s.store_id = $1 AND s.status <> 'archived' AND ($2::uuid IS NULL OR s.id = $2) AND ($3::uuid IS NULL OR l.location_id = $3)
              AND ($4::uuid IS NULL OR (s.id, COALESCE(l.location_id, '${NIL}'::uuid)) > ($4::uuid, $5::uuid))
            ORDER BY s.id, COALESCE(l.location_id, '${NIL}'::uuid) LIMIT $6`,
          [storeId, q.sku_id ?? null, q.location_id ?? null, after?.[0] ?? null, after?.[1] ?? null, q.limit + 1],
        )
      ).rows,
    );
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    return { items: items.map(wire), next_cursor: rows.length > q.limit && last !== undefined ? encodeCursor(last.sku_id, last.location_id) : null };
  }

  async adjust(actor: Principal, storeId: string, idempotencyKey: string, input: InventoryAdjustmentInput): Promise<InventoryLevel> {
    this.access(actor, "listing.write", storeId);
    const locationId = await this.store(storeId, async (tx) => {
      if ((await tx.query("SELECT 1 FROM skus WHERE id = $1 AND store_id = $2", [input.sku_id, storeId])).rows.length === 0) throw Problems.notFound();
      if (input.location_id !== undefined) {
        if ((await tx.query("SELECT 1 FROM inventory_locations WHERE id = $1 AND store_id = $2 AND active", [input.location_id, storeId])).rows.length === 0) throw Problems.notFound();
        return input.location_id;
      }
      const existing = (await tx.query<{ id: string }>("SELECT id FROM inventory_locations WHERE store_id = $1 AND active ORDER BY created_at, id LIMIT 1", [storeId])).rows[0];
      if (existing !== undefined) return existing.id;
      const id = this.d.newId();
      await tx.query("INSERT INTO inventory_locations (id, market_id, store_id, created_at) VALUES ($1, $2, $3, $4::timestamptz)", [id, this.d.marketId, storeId, this.d.now().toISOString()]);
      return id;
    });
    if (input.expected_version !== undefined) {
      const v = await this.store(storeId, async (tx) => (await tx.query<{ version: number }>("SELECT version FROM inventory_levels WHERE sku_id = $1 AND location_id = $2", [input.sku_id, locationId])).rows[0]?.version ?? 0);
      if (v !== input.expected_version) throw Problems.conflict("version-conflict");
    }
    await this.d.inventory.adjustOnHand(actor, { skuId: input.sku_id, locationId, storeId, delta: input.delta, idempotencyKey, source: SOURCE[input.reason] });
    const row = await this.store(storeId, async (tx) => (await tx.query<LevelRow>(`${LEVEL_SQL} WHERE s.id = $1 AND s.store_id = $2 AND l.location_id = $3`, [input.sku_id, storeId, locationId])).rows[0]);
    if (row === undefined) throw Problems.notFound();
    return wire(row);
  }
}
