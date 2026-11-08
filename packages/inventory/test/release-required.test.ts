import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDbContext } from "@outlet/db";
import { ReleaseRequiredConsumer } from "../src/index.js";
import { buildWorld, counts } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
let consumer: ReleaseRequiredConsumer;
beforeAll(async () => {
  w = await buildWorld();
  consumer = new ReleaseRequiredConsumer({ client: w.app, marketId: "EG", now: () => new Date(w.clock.t) });
});
afterAll(async () => { await w.close(); });

/** A claimed order for `qty` units of a fresh SKU in store A (committed == qty). */
const claimed = async (onHand: number, qty: number) => {
  const sku = await w.sku("A", onHand);
  const user = randomUUID();
  const r = await w.res.reserve({ orderGroupRef: `og-${randomUUID()}`, userId: user, items: [{ skuId: sku, locationId: w.locA, storeId: w.storeA, qty }] });
  if (!r.ok) throw new Error("reserve failed");
  await w.res.claim(user, r.reservationId);
  return { sku, reservationId: r.reservationId };
};
const ev = (sku: string, qty: number, over: Record<string, unknown> = {}) => ({
  id: randomUUID(), payload: { seller_order_id: randomUUID(), store_id: w.storeA, reservation_id: null, lines: [{ sku_id: sku, qty }], ...over },
});
const released = async (sellerOrderId: string) =>
  (await w.raw.query<{ payload: { released: unknown[]; clamped: boolean } }>("SELECT payload FROM outbox_events WHERE event_type = 'inventory.committed_released' AND aggregate_id = $1", [sellerOrderId])).rows;

describe("ReleaseRequiredConsumer", () => {
  it("lowers committed by the cancelled qty, keeps the claimed rows archived, and the replenisher re-mints the pool", async () => {
    const { sku, reservationId } = await claimed(5, 3);
    expect(await counts(w.raw, sku)).toMatchObject({ claimed: 3, committed: 3, onHand: 5 });
    const e = ev(sku, 2, { reservation_id: reservationId });
    expect(await consumer.handle(e)).toBe("processed");
    expect(await counts(w.raw, sku)).toMatchObject({ claimed: 3, committed: 1, onHand: 5 });
    const out = await released(e.payload.seller_order_id);
    expect(out).toHaveLength(1);
    expect(out[0]?.payload).toMatchObject({ clamped: false, released: [{ sku_id: sku, location_id: w.locA, qty: 2 }] });
    await w.inv.replenish(w.storeA, sku, w.locA);
    expect((await counts(w.raw, sku)).available).toBe(4);
  });

  it("is idempotent by event id and by seller order id", async () => {
    const { sku } = await claimed(4, 4);
    const e = ev(sku, 1);
    expect(await consumer.handle(e)).toBe("processed");
    expect(await consumer.handle(e)).toBe("duplicate");
    expect(await consumer.handle({ id: randomUUID(), payload: e.payload })).toBe("duplicate");
    expect((await counts(w.raw, sku)).committed).toBe(3);
    expect(await released(e.payload.seller_order_id as string)).toHaveLength(1);
  });

  it("never goes below zero: an oversized request is clamped and flagged", async () => {
    const { sku } = await claimed(3, 2);
    const e = ev(sku, 9);
    await consumer.handle(e);
    expect((await counts(w.raw, sku)).committed).toBe(0);
    expect((await released(e.payload.seller_order_id as string))[0]?.payload).toMatchObject({ clamped: true, released: [{ qty: 2 }] });
    const again = ev(sku, 1);
    await consumer.handle(again);
    expect((await counts(w.raw, sku)).committed).toBe(0);
    expect((await released(again.payload.seller_order_id as string))[0]?.payload).toMatchObject({ clamped: true, released: [] });
  });

  it("sums repeated lines, caps at the reservation line, and ignores another store's SKU", async () => {
    const { sku, reservationId } = await claimed(6, 3);
    const other = await w.sku("B", 3);
    const e = ev(sku, 1, { reservation_id: reservationId, lines: [{ sku_id: sku, qty: 1 }, { sku_id: sku, qty: 1 }, { sku_id: other, qty: 2 }] });
    await consumer.handle(e);
    expect((await counts(w.raw, sku)).committed).toBe(1);
    expect((await counts(w.raw, other)).committed).toBe(0);
    expect((await released(e.payload.seller_order_id as string))[0]?.payload.clamped).toBe(true);
    // a reservation line smaller than the request caps what this order may release
    const small = await claimed(6, 1);
    const big = ev(small.sku, 3, { reservation_id: small.reservationId });
    await consumer.handle(big);
    expect((await counts(w.raw, small.sku)).committed).toBe(0);
  });

  it("rejects a malformed payload", async () => {
    await expect(consumer.handle({ id: randomUUID(), payload: { seller_order_id: "x" } })).rejects.toThrow();
    await expect(consumer.handle(ev(randomUUID(), 0))).rejects.toThrow();
  });

  it("property: committed never goes negative and equals max(0, start - sum of released qty)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 6 }), async (start, qtys) => {
        const { sku } = await claimed(start + 1, start);
        let expected = start;
        for (const q of qtys) {
          await consumer.handle(ev(sku, q));
          expected = Math.max(0, expected - q);
          const c = await counts(w.raw, sku);
          expect(c.committed).toBeGreaterThanOrEqual(0);
          expect(c.committed).toBe(expected);
          expect(c.claimed).toBe(start);
        }
      }),
      { numRuns: 15 },
    );
  });

  it("runs as outlet_app in the event's store context: it cannot change on_hand and another store's levels are untouched", async () => {
    const { sku } = await claimed(3, 1);
    await expect(withDbContext(w.app, { kind: "store", marketId: "EG", storeId: w.storeA }, (tx) => tx.query("UPDATE inventory_levels SET on_hand = on_hand WHERE sku_id = $1", [sku]))).resolves.toBeDefined();
    // an event that names the wrong store finds no level rows (RLS) and releases nothing
    const wrong = ev(sku, 1, { store_id: w.storeB });
    expect(await consumer.handle(wrong)).toBe("processed");
    expect((await counts(w.raw, sku)).committed).toBe(1);
    expect((await released(wrong.payload.seller_order_id as string))[0]?.payload).toMatchObject({ clamped: true, released: [] });
  });

  it("uses default clock, id generator and outbox when not injected", async () => {
    const { sku } = await claimed(2, 1);
    const plain = new ReleaseRequiredConsumer({ client: w.app, marketId: "EG" });
    expect(await plain.handle(ev(sku, 1))).toBe("processed");
  });
});
