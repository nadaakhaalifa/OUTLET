import { randomUUID } from "node:crypto";
import { withDbContext } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESERVE_PICK_SQL } from "../src/index.js";
import { buildWorld } from "./fixtures.js";
import type { World } from "./fixtures.js";

/** BUILD-PROMPT section 3: hot queries are backed by an index. 2,000 rows, statistics gathered, seq scans off. */
let w: World;
let sku: string;
const N = 2000;

beforeAll(async () => {
  w = await buildWorld();
  sku = await w.sku("A", 0);
  const other = await w.sku("A", 0);
  await w.raw.query("INSERT INTO inventory_levels (sku_id, location_id, store_id, market_id, on_hand) VALUES ($1,$2,$3,'EG',$4)", [sku, w.locA, w.storeA, N]);
  const res = randomUUID();
  await w.raw.query("INSERT INTO reservations (id, market_id, user_id, order_group_ref, expires_at, store_ids) VALUES ($1,'EG',$2,'x', now(), ARRAY[$3]::uuid[])", [res, randomUUID(), w.storeA]);
  for (const [s, n] of [[sku, N], [other, N]] as const) {
    await w.raw.query("INSERT INTO inventory_levels (sku_id, location_id, store_id, market_id, on_hand) VALUES ($1,$2,$3,'EG',$4) ON CONFLICT DO NOTHING", [s, w.locA, w.storeA, n]);
    await w.raw.query(
      `INSERT INTO inventory_units (sku_id, location_id, id, store_id, market_id, state, reservation_id, expires_at)
       SELECT $1, $2, gen_random_uuid(), $3, 'EG', (CASE WHEN i % 4 = 0 THEN 'reserved' ELSE 'available' END),
              (CASE WHEN i % 4 = 0 THEN $4::uuid END), (CASE WHEN i % 4 = 0 THEN now() + i * interval '1 second' END)
         FROM generate_series(1, ${String(N)}) AS i`,
      [s, w.locA, w.storeA, res],
    );
  }
  await w.raw.query("ANALYZE inventory_units");
});
afterAll(async () => { await w.close(); });

const plan = (sql: string, params: unknown[]): Promise<string> =>
  withDbContext(w.app, { kind: "store", marketId: "EG", storeId: w.storeA }, async (tx) => {
    await tx.query("SET LOCAL enable_seqscan = off");
    const rows = (await tx.query<Record<string, string>>(`EXPLAIN ${sql}`, params)).rows;
    return rows.map((r) => Object.values(r)[0]).join("\n");
  });

describe("explain", () => {
  it("the reserve pick uses the partial available index, no seq scan", async () => {
    const p = await plan(RESERVE_PICK_SQL, [sku, w.locA, 3, randomUUID(), new Date().toISOString()]);
    expect(p).toContain("inventory_units_available_idx");
    expect(p).not.toMatch(/Seq Scan/);
  });
  it("the sweeper's expiry scans use their indexes", async () => {
    const units = await plan("SELECT id FROM inventory_units WHERE state = 'reserved' AND expires_at <= $1::timestamptz", [new Date(Date.now() + 3600_000).toISOString()]);
    expect(units).toContain("inventory_units_reserved_expiry_idx");
    const idx = await plan("SELECT reservation_id FROM inventory_expiry_index WHERE market_id = 'EG' AND expires_at <= $1::timestamptz ORDER BY expires_at LIMIT 500", [new Date().toISOString()]);
    expect(idx).toContain("inventory_expiry_index_due_idx");
  });
  it("claim / release by reservation use the reservation index", async () => {
    const p = await plan("UPDATE inventory_units SET state = 'available', reservation_id = NULL, expires_at = NULL WHERE reservation_id = $1 AND state = 'reserved'", [randomUUID()]);
    expect(p).toContain("inventory_units_reservation_idx");
  });
});
