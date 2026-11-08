import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InventoryError, RESERVE_PICK_SQL } from "../src/index.js";
import { buildWorld, counts, defectCard, staff } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld({ poolCap: 1000 }); });
afterAll(async () => { await w.close(); });

const adj = (sku: string, delta: number, key: string, extra: Record<string, unknown> = {}) =>
  w.inv.adjustOnHand(staff([w.storeA]), { skuId: sku, locationId: w.locA, storeId: w.storeA, delta, idempotencyKey: key, source: "seller_edit", ...extra });

describe("lock order", () => {
  it("adjustOnHand takes the SKU advisory lock before locking the level row", async () => {
    const s = await w.sku("A", 5);
    w.statements.length = 0;
    await adj(s, 1, "lo-" + s);
    const adv = w.statements.findIndex((q) => q.includes("pg_advisory_xact_lock"));
    const lvl = w.statements.findIndex((q) => q.includes("FROM inventory_levels") && q.includes("FOR UPDATE"));
    expect(adv).toBeGreaterThanOrEqual(0);
    expect(lvl).toBeGreaterThan(adv);
  });
});

describe("adjustOnHand", () => {
  it("creates the level and a pool of min(on_hand, 1000) rows; caps at 1000", async () => {
    const s = await w.sku("A", 2500);
    const c = await counts(w.raw, s);
    expect(c).toMatchObject({ onHand: 2500, available: 1000, committed: 0 });
    const lv = await w.inv.getLevel(staff([w.storeA]), w.storeA, s, w.locA);
    expect(lv).toMatchObject({ onHand: 2500, poolTarget: 1000, available: 1000 });
  });
  it("is idempotent on the key and rejects a reused key with another delta", async () => {
    const s = await w.sku("A", 10);
    const again = await adj(s, 10, `seed-${s}`);
    expect(again).toMatchObject({ applied: false, replayed: true, onHand: 10 });
    await expect(adj(s, 99, `seed-${s}`)).rejects.toMatchObject({ code: "conflict" });
    expect((await counts(w.raw, s)).onHand).toBe(10);
  });
  it("grows and shrinks the available pool in the same transaction", async () => {
    const s = await w.sku("A", 10);
    await adj(s, 5, "up-" + s);
    expect(await counts(w.raw, s)).toMatchObject({ onHand: 15, available: 15 });
    await adj(s, -12, "down-" + s);
    expect(await counts(w.raw, s)).toMatchObject({ onHand: 3, available: 3 });
  });
  it("refuses to go below zero and rolls the adjustment back", async () => {
    const s = await w.sku("A", 2);
    await expect(adj(s, -3, "neg-" + s)).rejects.toMatchObject({ code: "insufficient_stock" });
    expect((await counts(w.raw, s)).onHand).toBe(2);
    expect((await w.raw.query("SELECT 1 FROM inventory_adjustments WHERE idempotency_key = $1", ["neg-" + s])).rows).toHaveLength(0);
  });
  it("ignores stale channel-sync versions", async () => {
    const s = await w.sku("A", 5);
    const base = { source: "channel_sync" as const };
    const a = await w.inv.adjustOnHand(staff([w.storeA]), { skuId: s, locationId: w.locA, storeId: w.storeA, delta: 1, idempotencyKey: "v5-" + s, externalVersion: 5, ...base });
    expect(a.applied).toBe(true);
    const stale = await w.inv.adjustOnHand(staff([w.storeA]), { skuId: s, locationId: w.locA, storeId: w.storeA, delta: 7, idempotencyKey: "v4-" + s, externalVersion: 4, ...base });
    expect(stale).toMatchObject({ applied: false, stale: true, onHand: 6 });
  });
  it("negative adjustment with reserved and claimed units honours them and emits seller_oversell_penalty", async () => {
    const s = await w.sku("A", 4);
    const u1 = randomUUID();
    const r1 = await w.res.reserve({ orderGroupRef: "og-" + s, userId: u1, items: [{ skuId: s, locationId: w.locA, storeId: w.storeA, qty: 2 }] });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    await w.res.claim(u1, r1.reservationId); // committed 2
    const r2 = await w.res.reserve({ orderGroupRef: "og2-" + s, userId: u1, items: [{ skuId: s, locationId: w.locA, storeId: w.storeA, qty: 1 }] });
    expect(r2.ok).toBe(true); // 1 reserved
    const out = await adj(s, -4, "cut-" + s); // on_hand 0 but 2 claimed + 1 reserved
    expect(out).toMatchObject({ applied: true, onHand: 0, oversold: 3 });
    const c = await counts(w.raw, s);
    expect(c).toMatchObject({ claimed: 2, reserved: 1, available: 0, committed: 2, onHand: 0 });
    const ev = await w.raw.query<{ payload: { oversold_units: number } }>("SELECT payload FROM outbox_events WHERE event_type = 'inventory.seller_oversell_penalty' AND aggregate_id = $1", [s]);
    expect(ev.rows[0]?.payload.oversold_units).toBe(3);
    // the reserved unit can still be claimed (honoured)
    if (r2.ok) expect((await w.res.claim(u1, r2.reservationId)).outcome).toBe("claimed");
  });
  it("rejects invalid input, foreign stores and wrong roles", async () => {
    const s = await w.sku("A", 1);
    await expect(adj(s, 0, "z")).rejects.toMatchObject({ code: "validation" });
    await expect(w.inv.adjustOnHand(staff([w.storeB]), { skuId: s, locationId: w.locA, storeId: w.storeA, delta: 1, idempotencyKey: "x", source: "seller_edit" })).rejects.toMatchObject({ code: "not_found" });
    await expect(w.inv.adjustOnHand(staff([w.storeA], ["support"]), { skuId: s, locationId: w.locA, storeId: w.storeA, delta: 1, idempotencyKey: "x", source: "seller_edit" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(w.inv.adjustOnHand({ kind: "shopper", userId: randomUUID(), marketId: "EG", roles: [], scopes: [] }, { skuId: s, locationId: w.locA, storeId: w.storeA, delta: 1, idempotencyKey: "x", source: "seller_edit" })).rejects.toBeInstanceOf(InventoryError);
  });
  it("a store cannot touch another store's SKU or location", async () => {
    const sB = await w.sku("B", 3);
    await expect(w.inv.adjustOnHand(staff([w.storeA]), { skuId: sB, locationId: w.locA, storeId: w.storeA, delta: 1, idempotencyKey: "cross-" + sB, source: "seller_edit" })).rejects.toMatchObject({ code: "not_found" });
    await expect(w.inv.adjustOnHand(staff([w.storeA]), { skuId: sB, locationId: w.locA, storeId: w.storeA, delta: -1, idempotencyKey: "cross2-" + sB, source: "seller_edit" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("serialised units and the replenisher", () => {
  it("a defect-graded one-off unit is its own row, never trimmed or duplicated by the pool", async () => {
    const s = await w.sku("A", 0);
    const card = await defectCard(w.raw, s);
    const a = await w.inv.addSerializedUnit(staff([w.storeA]), { skuId: s, locationId: w.locA, storeId: w.storeA, defectCardId: card, idempotencyKey: "ser-" + s });
    const replay = await w.inv.addSerializedUnit(staff([w.storeA]), { skuId: s, locationId: w.locA, storeId: w.storeA, defectCardId: card, idempotencyKey: "ser-" + s });
    expect(replay).toEqual({ unitId: a.unitId, replayed: true });
    expect(await counts(w.raw, s)).toMatchObject({ onHand: 1, available: 1 });
    const u = await w.raw.query<{ defect_card_id: string }>("SELECT defect_card_id FROM inventory_units WHERE sku_id = $1", [s]);
    expect(u.rows).toEqual([{ defect_card_id: card }]);
    await expect(adj(s, 3, "plus-" + s)).rejects.toMatchObject({ code: "conflict" }); // a SKU is never fungible and serialised at once
    await expect(w.raw.query("INSERT INTO inventory_units (sku_id, location_id, id, store_id, market_id) SELECT $1, $2, $3, $4, 'EG'", [s, w.locA, randomUUID(), w.storeA])).rejects.toThrow(/serialised/);
    expect(await counts(w.raw, s)).toMatchObject({ onHand: 1, available: 1 });
    expect((await w.raw.query("SELECT 1 FROM inventory_units WHERE sku_id = $1 AND defect_card_id IS NOT NULL", [s])).rows).toHaveLength(1);
  });
  it("a fungible SKU refuses a serialised unit (service and trigger), and reserve never takes graded units", async () => {
    const s = await w.sku("A", 3);
    const card = await defectCard(w.raw, s);
    await expect(w.inv.addSerializedUnit(staff([w.storeA]), { skuId: s, locationId: w.locA, storeId: w.storeA, defectCardId: card, idempotencyKey: "mix-" + s })).rejects.toMatchObject({ code: "conflict" });
    await expect(w.raw.query("INSERT INTO inventory_units (sku_id, location_id, id, store_id, market_id, defect_card_id) SELECT $1, $2, $3, $4, 'EG', $5", [s, w.locA, randomUUID(), w.storeA, card])).rejects.toThrow(/fungible/);
    // the pick statement itself filters graded units even if one were present
    expect(RESERVE_PICK_SQL).toContain("defect_card_id IS NULL");
    const t = await w.sku("A", 0);
    const c2 = await defectCard(w.raw, t);
    await w.inv.addSerializedUnit(staff([w.storeA]), { skuId: t, locationId: w.locA, storeId: w.storeA, defectCardId: c2, idempotencyKey: "ser2-" + t });
    const r = await w.res.reserve({ orderGroupRef: "og-ser-" + t, userId: randomUUID(), items: [{ skuId: t, locationId: w.locA, storeId: w.storeA, qty: 1 }] });
    expect(r.ok).toBe(false); // graded units are not fungible stock
  });
  it("replenish tops up after claims drained the pool, and replenishStore / replenishAll cover levels", async () => {
    const small = await buildWorld({ poolCap: 3 });
    try {
      const s = await small.sku("A", 10);
      expect((await counts(small.raw, s)).available).toBe(3);
      const u = randomUUID();
      const r = await small.res.reserve({ orderGroupRef: "og", userId: u, items: [{ skuId: s, locationId: small.locA, storeId: small.storeA, qty: 3 }] });
      if (r.ok) await small.res.claim(u, r.reservationId);
      expect((await counts(small.raw, s))).toMatchObject({ available: 0, claimed: 3, committed: 3 });
      expect(await small.inv.replenish(small.storeA, s, small.locA)).toEqual({ added: 3, removed: 0 });
      expect((await counts(small.raw, s)).available).toBe(3);
      expect(await small.inv.replenish(small.storeA, s, small.locA)).toEqual({ added: 0, removed: 0 });
      await small.raw.query("DELETE FROM inventory_units WHERE sku_id = $1 AND state = 'available'", [s]);
      expect(await small.inv.replenishStore(small.storeA)).toBe(3);
      await small.raw.query("DELETE FROM inventory_units WHERE sku_id = $1 AND state = 'available'", [s]);
      await small.raw.query("INSERT INTO catalog_public_stores (id, market_id, slug, display_name_ar, kind, status, verified_badge, ships_from_country, followers_count, discount_display_mode, legal_identity, updated_at) VALUES ($1,'EG','a','أ','local','ACTIVE',false,'EG',0,'verified_only','{}'::jsonb, now())", [small.storeA]);
      expect(await small.inv.replenishAll()).toBe(3);
      await expect(small.inv.replenish(small.storeA, randomUUID(), small.locA)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await small.close();
    }
  });
  it("sold-out flag is set only when nothing is left to sell, and cleared when stock returns", async () => {
    const s2 = await w.sku("A", 1);
    const u = randomUUID();
    const r = await w.res.reserve({ orderGroupRef: "og-flag-" + s2, userId: u, items: [{ skuId: s2, locationId: w.locA, storeId: w.storeA, qty: 1 }] });
    expect(w.flags.has(s2, w.locA)).toBe(false); // reserved is not sold out: it can come back
    if (r.ok) await w.res.claim(u, r.reservationId);
    expect(w.flags.has(s2, w.locA)).toBe(true);
    await adj(s2, 5, "restock-" + s2);
    expect(w.flags.has(s2, w.locA)).toBe(false);
  });
});
