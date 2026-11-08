import { randomUUID } from "node:crypto";
import { assertTenantTablesProtected, listRlsExceptions, listTenantTables, withDbContext } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
let skuA: string;
let skuB: string;
const user = randomUUID();
let resId = "";

beforeAll(async () => {
  w = await buildWorld();
  skuA = await w.sku("A", 3);
  skuB = await w.sku("B", 3);
  const r = await w.res.reserve({ orderGroupRef: "t-1", userId: user, items: [{ skuId: skuA, locationId: w.locA, storeId: w.storeA, qty: 1 }] });
  if (!r.ok) throw new Error("reserve failed");
  resId = r.reservationId;
});
afterAll(async () => { await w.close(); });

const asStore = (storeId: string, sql: string, params: unknown[] = []): Promise<number> =>
  withDbContext(w.app, { kind: "store", marketId: "EG", storeId }, async (tx) => (await tx.query(sql, params)).rows.length);

describe("tenant isolation (outlet_app, FORCE RLS)", () => {
  for (const table of ["inventory_locations", "inventory_levels", "inventory_units", "inventory_adjustments"]) {
    it(`${table}: seller A sees own rows, seller B sees none of A's`, async () => {
      expect(await asStore(w.storeA, `SELECT 1 FROM ${table} WHERE store_id = $1`, [w.storeA])).toBeGreaterThan(0);
      expect(await asStore(w.storeB, `SELECT 1 FROM ${table} WHERE store_id = $1`, [w.storeA])).toBe(0);
    });
  }
  it("reservation_lines follow the store; a shopper context with no store sees no stock rows at all", async () => {
    expect(await asStore(w.storeA, "SELECT 1 FROM reservation_lines")).toBe(1);
    expect(await asStore(w.storeB, "SELECT 1 FROM reservation_lines")).toBe(0);
    const n = await withDbContext(w.app, { kind: "user", marketId: "EG", userId: user }, async (tx) => {
      let total = 0;
      for (const t of ["inventory_units", "inventory_levels", "inventory_locations", "reservation_lines", "inventory_adjustments"]) total += (await tx.query(`SELECT 1 FROM ${t}`)).rows.length;
      return total;
    });
    expect(n).toBe(0);
  });
  it("seller B cannot update or delete seller A's units or levels", async () => {
    expect(await asStore(w.storeB, "UPDATE inventory_units SET state = 'claimed' WHERE sku_id = $1 RETURNING 1", [skuA])).toBe(0);
    expect(await asStore(w.storeB, "DELETE FROM inventory_units WHERE sku_id = $1 RETURNING 1", [skuA])).toBe(0);
    expect(await asStore(w.storeB, "UPDATE inventory_levels SET on_hand = 999 WHERE sku_id = $1 RETURNING 1", [skuA])).toBe(0);
    await expect(asStore(w.storeB, "INSERT INTO inventory_levels (sku_id, location_id, store_id, market_id, on_hand) VALUES ($1,$2,$3,'EG',1)", [skuB, w.locB, w.storeA])).rejects.toThrow();
  });
  it("wrong market context sees nothing", async () => {
    const n = await withDbContext(w.app, { kind: "store", marketId: "SA", storeId: w.storeA }, async (tx) => (await tx.query("SELECT 1 FROM inventory_levels")).rows.length);
    expect(n).toBe(0);
  });
  it("reservations are user-isolated", async () => {
    const mine = await withDbContext(w.app, { kind: "user", marketId: "EG", userId: user }, async (tx) => (await tx.query("SELECT 1 FROM reservations WHERE id = $1", [resId])).rows.length);
    const other = await withDbContext(w.app, { kind: "user", marketId: "EG", userId: randomUUID() }, async (tx) => (await tx.query("SELECT 1 FROM reservations WHERE id = $1", [resId])).rows.length);
    expect([mine, other]).toEqual([1, 0]);
  });
  it("the adjustment history is append-only for the application role", async () => {
    await expect(asStore(w.storeA, "UPDATE inventory_adjustments SET delta = 1")).rejects.toThrow(/permission denied/);
    await expect(asStore(w.storeA, "DELETE FROM inventory_adjustments")).rejects.toThrow(/permission denied/);
  });
});

describe("RLS audit (ADR-0011) stays unchanged", () => {
  it("every inventory table with a tenant key is fully protected and the audit passes", async () => {
    await expect(assertTenantTablesProtected(w.raw)).resolves.toBeDefined();
    const rows = (await listTenantTables(w.raw)).filter((r) => /^(inventory_|reservation)/.test(r.table));
    expect(rows.map((r) => r.table).sort()).toEqual(["inventory_adjustments", "inventory_levels", "inventory_locations", "inventory_units", "reservation_lines", "reservations"]);
    for (const r of rows) expect(r).toMatchObject({ rlsEnabled: true, rlsForced: true, problems: [] });
  });
  it("adds no exception policy", async () => {
    const exc = await listRlsExceptions(w.raw);
    expect(exc.filter((e) => /^(inventory_|reservation)/.test(e.table))).toEqual([]);
  });
  it("the expiry index is the only unprotected inventory table and carries no tenant key column", async () => {
    const cols = (await w.raw.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_expiry_index'")).rows.map((r) => r.column_name);
    expect(cols).not.toContain("store_id");
    expect(cols).not.toContain("user_id");
  });
});
