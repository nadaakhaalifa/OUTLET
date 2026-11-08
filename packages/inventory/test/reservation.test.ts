import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InventoryError } from "../src/index.js";
import { buildWorld, counts } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const item = (w0: World, store: "A" | "B", sku: string, qty: number) => ({ skuId: sku, locationId: store === "A" ? w0.locA : w0.locB, storeId: store === "A" ? w0.storeA : w0.storeB, qty });

describe("reserve", () => {
  it("reserves exactly qty units across two stores in one transaction", async () => {
    const a = await w.sku("A", 5);
    const b = await w.sku("B", 5);
    const user = randomUUID();
    const r = await w.res.reserve({ orderGroupRef: "og-two", userId: user, items: [item(w, "A", a, 2), item(w, "B", b, 3)] });
    expect(r.ok).toBe(true);
    expect(await counts(w.raw, a)).toMatchObject({ reserved: 2, available: 3 });
    expect(await counts(w.raw, b)).toMatchObject({ reserved: 3, available: 2 });
    if (!r.ok) return;
    const row = (await w.raw.query<{ state: string; expires_at: string }>("SELECT state, expires_at FROM reservations WHERE id = $1", [r.reservationId])).rows[0];
    expect(row?.state).toBe("ACTIVE");
    expect(new Date(r.expiresAt).getTime()).toBe(w.clock.t + 600_000);
    expect((await w.raw.query("SELECT 1 FROM inventory_expiry_index WHERE reservation_id = $1", [r.reservationId])).rows).toHaveLength(1);
  });

  it("is idempotent per order group: same ref replays, a settled ref conflicts", async () => {
    const a = await w.sku("A", 4);
    const user = randomUUID();
    const first = await w.res.reserve({ orderGroupRef: "og-idem", userId: user, items: [item(w, "A", a, 1)] });
    const second = await w.res.reserve({ orderGroupRef: "og-idem", userId: user, items: [item(w, "A", a, 1)] });
    expect(second).toMatchObject({ ok: true, replayed: true });
    expect(first.ok && second.ok && first.reservationId === second.reservationId).toBe(true);
    expect((await counts(w.raw, a)).reserved).toBe(1);
    if (first.ok) await w.res.release(user, first.reservationId);
    await expect(w.res.reserve({ orderGroupRef: "og-idem", userId: user, items: [item(w, "A", a, 1)] })).rejects.toMatchObject({ code: "conflict" });
  });

  it("a shortfall on any SKU rolls the whole reservation back and lists the shortfall", async () => {
    const a = await w.sku("A", 5);
    const b = await w.sku("B", 1);
    const r = await w.res.reserve({ orderGroupRef: "og-short", userId: randomUUID(), items: [item(w, "A", a, 2), item(w, "B", b, 3)] });
    expect(r).toEqual({ ok: false, shortfalls: [{ skuId: b, locationId: w.locB, requested: 3, available: 1 }] });
    expect(await counts(w.raw, a)).toMatchObject({ reserved: 0, available: 5 });
    expect(await counts(w.raw, b)).toMatchObject({ reserved: 0, available: 1 });
    expect((await w.raw.query("SELECT 1 FROM reservations WHERE order_group_ref = 'og-short'")).rows).toHaveLength(0);
    expect((await w.raw.query("SELECT 1 FROM reservation_lines WHERE sku_id = $1", [a])).rows).toHaveLength(0);
  });

  it("a wrong store id on a line finds nothing (shortfall), never another store's units", async () => {
    const a = await w.sku("A", 3);
    const r = await w.res.reserve({ orderGroupRef: "og-wrongstore", userId: randomUUID(), items: [{ skuId: a, locationId: w.locA, storeId: w.storeB, qty: 1 }] });
    expect(r.ok).toBe(false);
    expect((await counts(w.raw, a)).reserved).toBe(0);
  });

  it("locks SKUs in sorted order regardless of the order sent, and merges duplicate lines", async () => {
    const skus = [await w.sku("A", 5), await w.sku("A", 5), await w.sku("A", 5)];
    const sorted = [...skus].sort();
    w.picks.length = 0;
    const r = await w.res.reserve({ orderGroupRef: "og-order", userId: randomUUID(), items: [item(w, "A", sorted[2] ?? "", 1), item(w, "A", sorted[0] ?? "", 1), item(w, "A", sorted[1] ?? "", 1), item(w, "A", sorted[0] ?? "", 1)] });
    expect(r.ok).toBe(true);
    expect(w.picks).toEqual(sorted);
    expect((await counts(w.raw, sorted[0] ?? "")).reserved).toBe(2);
  });

  it("one SKU in two stores is rejected; invalid input is a validation error", async () => {
    const a = await w.sku("A", 2);
    await expect(w.res.reserve({ orderGroupRef: "x", userId: randomUUID(), items: [item(w, "A", a, 1), { ...item(w, "A", a, 1), storeId: w.storeB }] })).rejects.toMatchObject({ code: "validation" });
    await expect(w.res.reserve({ orderGroupRef: "", userId: randomUUID(), items: [] })).rejects.toBeInstanceOf(InventoryError);
  });

  it("30 concurrent reservations of 1 on 10 units: exactly 10 succeed, none oversold (PGlite serialises; see stress script)", async () => {
    const a = await w.sku("A", 10);
    const out = await Promise.all(Array.from({ length: 30 }, (_, n) => w.res.reserve({ orderGroupRef: `og-c-${a}-${String(n)}`, userId: randomUUID(), items: [item(w, "A", a, 1)] })));
    expect(out.filter((x) => x.ok)).toHaveLength(10);
    expect(await counts(w.raw, a)).toMatchObject({ reserved: 10, available: 0 });
  });

  it("inline replenisher refills a drained pool while stock remains", async () => {
    const small = await buildWorld({ poolCap: 5 });
    try {
      const s = await small.sku("A", 12);
      expect((await counts(small.raw, s)).available).toBe(5);
      const r = await small.res.reserve({ orderGroupRef: "og-hot", userId: randomUUID(), items: [item(small, "A", s, 4)] });
      const r2 = await small.res.reserve({ orderGroupRef: "og-hot2", userId: randomUUID(), items: [item(small, "A", s, 4)] }); // pool has 1 left: the inline replenisher adds 4 (cap 5 available)
      expect(r.ok && r2.ok).toBe(true);
      expect(await counts(small.raw, s)).toMatchObject({ reserved: 8, onHand: 12 });
      expect((await counts(small.raw, s)).available).toBe(2);
    } finally {
      await small.close();
    }
  });

  it("the reserve path sets statement_timeout 2 s", async () => {
    const a = await w.sku("A", 1);
    w.statements.length = 0;
    await w.res.reserve({ orderGroupRef: "og-timeout-" + a, userId: randomUUID(), items: [item(w, "A", a, 1)] });
    expect(w.statements.some((s) => s.includes("statement_timeout"))).toBe(true);
  });
});

describe("expiry, release and sweep", () => {
  it("sweeps expired reservations back to the pool in batches, leaves live ones", async () => {
    const a = await w.sku("A", 6);
    const u = randomUUID();
    const old1 = await w.res.reserve({ orderGroupRef: "sw1-" + a, userId: u, items: [item(w, "A", a, 2)], ttlSec: 30 });
    const old2 = await w.res.reserve({ orderGroupRef: "sw2-" + a, userId: randomUUID(), items: [item(w, "A", a, 1)], ttlSec: 30 });
    const live = await w.res.reserve({ orderGroupRef: "sw3-" + a, userId: u, items: [item(w, "A", a, 1)], ttlSec: 3600 });
    expect(await counts(w.raw, a)).toMatchObject({ reserved: 4, available: 2 });
    const none = await w.res.sweepExpired(new Date(w.clock.t));
    expect(none.expired).toEqual([]);
    const first = await w.res.sweepExpired(new Date(w.clock.t + 31_000), 1);
    expect(first.expired).toHaveLength(1);
    const rest = await w.res.sweepExpired(new Date(w.clock.t + 31_000));
    expect(rest.expired).toHaveLength(1);
    expect(await counts(w.raw, a)).toMatchObject({ reserved: 1, available: 5 });
    const st = (await w.raw.query<{ state: string }>("SELECT state FROM reservations WHERE order_group_ref LIKE $1 ORDER BY order_group_ref", [`%${a}`])).rows.map((r) => r.state);
    expect(st).toEqual(["EXPIRED", "EXPIRED", "ACTIVE"]);
    expect(old1.ok && old2.ok && live.ok).toBe(true);
    await expect(w.res.sweepExpired(new Date(), 0)).rejects.toMatchObject({ code: "validation" });
  });

  it("sweep skips a reservation that was claimed meanwhile", async () => {
    const a = await w.sku("A", 2);
    const u = randomUUID();
    const r = await w.res.reserve({ orderGroupRef: "sk-" + a, userId: u, items: [item(w, "A", a, 1)], ttlSec: 30 });
    if (!r.ok) throw new Error("reserve failed");
    await w.raw.query("UPDATE reservations SET state = 'CLAIMED' WHERE id = $1", [r.reservationId]);
    const s = await w.res.sweepExpired(new Date(w.clock.t + 60_000));
    expect(s.skipped).toBeGreaterThanOrEqual(1);
    expect(s.expired).not.toContain(r.reservationId);
  });

  it("release frees units, is idempotent, and cannot release a claimed reservation", async () => {
    const a = await w.sku("A", 3);
    const u = randomUUID();
    const r = await w.res.reserve({ orderGroupRef: "rl-" + a, userId: u, items: [item(w, "A", a, 2)] });
    if (!r.ok) throw new Error("reserve failed");
    expect(await w.res.release(u, r.reservationId)).toEqual({ state: "RELEASED" });
    expect(await w.res.release(u, r.reservationId)).toEqual({ state: "RELEASED" });
    expect(await counts(w.raw, a)).toMatchObject({ reserved: 0, available: 3 });
    const r2 = await w.res.reserve({ orderGroupRef: "rl2-" + a, userId: u, items: [item(w, "A", a, 1)] });
    if (!r2.ok) throw new Error("reserve failed");
    await w.res.claim(u, r2.reservationId);
    await expect(w.res.release(u, r2.reservationId)).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(w.res.release(u, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    // an expired reservation: release is a no-op
    const r3 = await w.res.reserve({ orderGroupRef: "rl3-" + a, userId: u, items: [item(w, "A", a, 1)], ttlSec: 30 });
    await w.res.sweepExpired(new Date(w.clock.t + 60_000));
    if (r3.ok) expect(await w.res.release(u, r3.reservationId)).toEqual({ state: "EXPIRED" });
  });
});

describe("claim", () => {
  it("claims units, bumps committed, emits inventory.claimed, and is idempotent", async () => {
    const a = await w.sku("A", 5);
    const b = await w.sku("B", 2);
    const u = randomUUID();
    const r = await w.res.reserve({ orderGroupRef: "cl-" + a, userId: u, items: [item(w, "A", a, 2), item(w, "B", b, 2)] });
    if (!r.ok) throw new Error("reserve failed");
    const c1 = await w.res.claim(u, r.reservationId);
    expect(c1.outcome).toBe("claimed");
    const c2 = await w.res.claim(u, r.reservationId);
    expect(c2.outcome).toBe("already_claimed");
    expect(await counts(w.raw, a)).toMatchObject({ claimed: 2, committed: 2, reserved: 0, available: 3 });
    expect(await counts(w.raw, b)).toMatchObject({ claimed: 2, committed: 2 });
    const ev = await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'inventory.claimed' AND aggregate_id = $1", [r.reservationId]);
    expect(ev.rows).toHaveLength(1);
    expect((await w.raw.query("SELECT 1 FROM inventory_expiry_index WHERE reservation_id = $1", [r.reservationId])).rows).toHaveLength(0);
    expect(w.flags.has(b, w.locB)).toBe(true); // B is fully committed
    expect(w.flags.has(a, w.locA)).toBe(false);
  });

  it("claimIn runs inside the caller's transaction: a later failure rolls the claim back and keeps the caller's context", async () => {
    const a = await w.sku("A", 3);
    const u = randomUUID();
    const r = await w.res.reserve({ orderGroupRef: "ci-" + a, userId: u, items: [item(w, "A", a, 1)] });
    if (!r.ok) throw new Error("reserve failed");
    const { withDbContext } = await import("@outlet/db");
    await expect(
      withDbContext(w.app, { kind: "user", marketId: "EG", userId: u }, async (tx) => {
        await w.res.claimIn(tx, r.reservationId);
        const ctx = (await tx.query<{ s: string; u: string; c: string }>("SELECT current_setting('app.current_store_id') s, current_setting('app.current_user_id') u, current_setting('app.ctx') c")).rows[0];
        expect(ctx).toEqual({ s: "", u, c: "user" });
        throw new Error("ledger failed");
      }),
    ).rejects.toThrow("ledger failed");
    expect(await counts(w.raw, a)).toMatchObject({ claimed: 0, committed: 0, reserved: 1 });
  });

  it("late payment after expiry auto-claims when stock is still there, else reports unavailable", async () => {
    const a = await w.sku("A", 2);
    const u = randomUUID();
    const r = await w.res.reserve({ orderGroupRef: "lt-" + a, userId: u, items: [item(w, "A", a, 2)], ttlSec: 30 });
    if (!r.ok) throw new Error("reserve failed");
    await w.res.sweepExpired(new Date(w.clock.t + 60_000));
    const late = await w.res.claim(u, r.reservationId);
    expect(late.outcome).toBe("late_claimed");
    expect(await counts(w.raw, a)).toMatchObject({ claimed: 2, committed: 2, available: 0 });
    // second case: someone else took the stock
    const b = await w.sku("A", 1);
    const r2 = await w.res.reserve({ orderGroupRef: "lt2-" + b, userId: u, items: [item(w, "A", b, 1)], ttlSec: 30 });
    if (!r2.ok) throw new Error("reserve failed");
    await w.res.sweepExpired(new Date(w.clock.t + 60_000));
    const other = await w.res.reserve({ orderGroupRef: "lt3-" + b, userId: randomUUID(), items: [item(w, "A", b, 1)] });
    expect(other.ok).toBe(true);
    const lost = await w.res.claim(u, r2.reservationId);
    expect(lost).toMatchObject({ outcome: "unavailable", shortfalls: [{ skuId: b, requested: 1, available: 0 }] });
    expect(await counts(w.raw, b)).toMatchObject({ claimed: 0, committed: 0, reserved: 1 });
    const st = (await w.raw.query<{ state: string }>("SELECT state FROM reservations WHERE id = $1", [r2.reservationId])).rows[0];
    expect(st?.state).toBe("EXPIRED");
    await w.res.publish(lost);
  });

  it("another user cannot claim or release someone's reservation (user isolation)", async () => {
    const a = await w.sku("A", 2);
    const r = await w.res.reserve({ orderGroupRef: "iso-" + a, userId: randomUUID(), items: [item(w, "A", a, 1)] });
    if (!r.ok) throw new Error("reserve failed");
    await expect(w.res.claim(randomUUID(), r.reservationId)).rejects.toMatchObject({ code: "not_found" });
    await expect(w.res.release(randomUUID(), r.reservationId)).rejects.toMatchObject({ code: "not_found" });
  });
});
