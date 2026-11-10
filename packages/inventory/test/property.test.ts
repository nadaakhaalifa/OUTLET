import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, counts, staff } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld({ poolCap: 4 }); });
afterAll(async () => { await w.close(); });

type Op =
  | { t: "reserve"; qty: number }
  | { t: "release"; pick: number }
  | { t: "claim"; pick: number }
  | { t: "adjust"; delta: number }
  | { t: "sweep" };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant("reserve" as const), qty: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ t: fc.constant("release" as const), pick: fc.nat(9) }),
  fc.record({ t: fc.constant("claim" as const), pick: fc.nat(9) }),
  fc.record({ t: fc.constant("adjust" as const), delta: fc.integer({ min: -5, max: 8 }).filter((d) => d !== 0) }),
  fc.record({ t: fc.constant("sweep" as const) }),
);

describe("pool invariants under random reserve / release / claim / adjust / sweep sequences", () => {
  it("claimed + reserved + available == rows; committed == claimed; claimed <= on_hand unless a penalty was emitted; no partial reservations", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        const sku = await w.sku("A", 6);
        const user = randomUUID();
        const active: string[] = [];
        let n = 0;
        let oversold = false;
        for (const o of ops) {
          if (o.t === "reserve") {
            const r = await w.res.reserve({ orderGroupRef: `p-${sku}-${String((n += 1))}`, userId: user, items: [{ skuId: sku, locationId: w.locA, storeId: w.storeA, qty: o.qty }], ttlSec: 30 });
            if (r.ok) active.push(r.reservationId);
          } else if (o.t === "release" && active.length > 0) {
            const id = active.splice(o.pick % active.length, 1)[0] ?? "";
            await w.res.release(user, id);
          } else if (o.t === "claim" && active.length > 0) {
            const id = active.splice(o.pick % active.length, 1)[0] ?? "";
            await w.res.claim(user, id);
          } else if (o.t === "adjust") {
            const cur = (await counts(w.raw, sku)).onHand;
            const r = await w.inv.adjustOnHand(staff([w.storeA]), { skuId: sku, locationId: w.locA, storeId: w.storeA, delta: Math.max(o.delta, -cur), idempotencyKey: `a-${sku}-${String((n += 1))}`, source: "seller_edit" }).catch(() => null);
            if (r && r.oversold > 0) oversold = true;
          } else if (o.t === "sweep") {
            w.clock.t += 31_000;
            const s = await w.res.sweepExpired(new Date(w.clock.t));
            for (const id of s.expired) { const i = active.indexOf(id); if (i >= 0) active.splice(i, 1); }
          }
          const c = await counts(w.raw, sku);
          const total = (await w.raw.query<{ n: number }>("SELECT count(*)::int n FROM inventory_units WHERE sku_id = $1", [sku])).rows[0]?.n ?? 0;
          expect(c.claimed + c.reserved + c.available).toBe(total);
          expect(c.claimed).toBe(c.committed);
          expect(c.available).toBeLessThanOrEqual(4); // pool cap
          expect(c.available).toBeLessThanOrEqual(Math.max(0, c.onHand - c.committed - c.reserved));
          if (!oversold) {
            expect(c.claimed).toBeLessThanOrEqual(c.onHand);
            expect(c.committed + c.reserved).toBeLessThanOrEqual(c.onHand);
          }
          const bad = await w.raw.query(
            `SELECT 1 FROM reservations r WHERE r.state = 'ACTIVE' AND r.id IN (SELECT reservation_id FROM reservation_lines WHERE reservation_id IN (SELECT id FROM reservations WHERE order_group_ref LIKE $1))
               AND (SELECT count(*) FROM inventory_units u WHERE u.reservation_id = r.id AND u.state = 'reserved') <> (SELECT sum(qty) FROM reservation_lines l WHERE l.reservation_id = r.id)`,
            [`p-${sku}-%`],
          );
          expect(bad.rows).toHaveLength(0);
        }
      }),
      {
        numRuns: 25,
        // regression: a swept reservation returned its unit above the cap
        examples: [[[{ t: "reserve", qty: 1 }, { t: "adjust", delta: 1 }, { t: "sweep" }]]],
      },
    );
  });
});
