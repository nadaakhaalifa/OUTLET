import type { Queryable } from "@outlet/db";
import { poolTarget } from "../domain/pool.js";
import type { Env } from "./env.js";

/** ADR-0005 / master prompt 20.2 reserve statement. Runs in a store context; the partial index inventory_units_available_idx serves it. */
export const RESERVE_PICK_SQL = `WITH picked AS (
  SELECT id FROM inventory_units
   WHERE sku_id = $1 AND location_id = $2 AND state = 'available'
   ORDER BY id LIMIT $3::int FOR UPDATE SKIP LOCKED)
UPDATE inventory_units u
   SET state = 'reserved', reservation_id = $4, expires_at = $5::timestamptz
  FROM picked
 WHERE u.sku_id = $1 AND u.location_id = $2 AND u.id = picked.id
RETURNING u.id`;

export interface ReplenishResult {
  readonly added: number;
  readonly removed: number;
  readonly target: number;
  /** on_hand - committed: stock that is neither claimed nor (necessarily) in the pool. */
  readonly free: number;
}

/**
 * Tops the fungible AVAILABLE pool up to min(on_hand - committed - reserved - serialised available, cap), or trims surplus
 * available rows (reserved units do not use the cap, so in-flight checkouts never starve the pool). Must run in a
 * store context. One replenisher per SKU at a time via pg_advisory_xact_lock(hashtext(sku)); the level row is not locked,
 * so claims are never blocked by a top-up. Serialised (defect-graded) units are never created or trimmed here.
 */
export const replenishIn = async (env: Env, tx: Queryable, skuId: string, locationId: string): Promise<ReplenishResult | null> => {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [skuId]);
  const lvl = (await tx.query<{ on_hand: number; committed: number }>("SELECT on_hand, committed FROM inventory_levels WHERE sku_id = $1 AND location_id = $2", [skuId, locationId])).rows[0];
  if (!lvl) return null;
  const c = (
    await tx.query<{ fung: number; ser: number; res: number }>(
      `SELECT (count(*) FILTER (WHERE state = 'available' AND defect_card_id IS NULL))::int AS fung,
              (count(*) FILTER (WHERE state = 'available' AND defect_card_id IS NOT NULL))::int AS ser,
              (count(*) FILTER (WHERE state = 'reserved'))::int AS res
         FROM inventory_units WHERE sku_id = $1 AND location_id = $2 AND state <> 'claimed'`,
      [skuId, locationId],
    )
  ).rows[0];
  const fung = c?.fung ?? 0;
  // Reserved units (any kind) and available serialised units already account for part of on_hand - committed.
  const target = poolTarget(Math.max(0, lvl.on_hand - (c?.ser ?? 0) - (c?.res ?? 0)), lvl.committed, env.poolCap);
  let added = 0;
  let removed = 0;
  if (fung < target) {
    added = target - fung;
    const ids = Array.from({ length: added }, () => env.newId());
    await tx.query(
      `INSERT INTO inventory_units (sku_id, location_id, id, store_id, market_id)
       SELECT $1, $2, u.id, l.store_id, l.market_id FROM unnest($3::uuid[]) AS u(id), inventory_levels l WHERE l.sku_id = $1 AND l.location_id = $2`,
      [skuId, locationId, ids],
    );
  } else if (fung > target) {
    const r = await tx.query<{ id: string }>(
      `DELETE FROM inventory_units WHERE (sku_id, location_id, id) IN (
         SELECT sku_id, location_id, id FROM inventory_units
          WHERE sku_id = $1 AND location_id = $2 AND state = 'available' AND defect_card_id IS NULL
          ORDER BY id DESC LIMIT $3::int FOR UPDATE SKIP LOCKED) RETURNING id`,
      [skuId, locationId, fung - target],
    );
    removed = r.rows.length;
  }
  await tx.query("UPDATE inventory_levels SET pool_target = $3 WHERE sku_id = $1 AND location_id = $2", [skuId, locationId, target]);
  return { added, removed, target, free: lvl.on_hand - lvl.committed };
};
