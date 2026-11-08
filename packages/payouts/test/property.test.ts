import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnconfiguredPayoutDestinations, UnconfiguredPayoutRail } from "../src/index.js";
import { FakePayoutDestinations, FakePayoutRail } from "../src/testing.js";
import { DAY, MONDAY, T0, buildWorld, fundClosed, ownPayout } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

type Op =
  | { readonly kind: "close"; readonly amount: bigint; readonly eligible: boolean }
  | { readonly kind: "clawback"; readonly amount: bigint }
  | { readonly kind: "cycle" };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("close" as const), amount: fc.bigInt({ min: 1n, max: 60_000n }), eligible: fc.boolean() }),
  fc.record({ kind: fc.constant("clawback" as const), amount: fc.bigInt({ min: 1n, max: 40_000n }) }),
  fc.constant({ kind: "cycle" as const }),
);

let week = 0;

/** Direct approval below the threshold; the two-key path otherwise (amounts here stay below it, the dual path is covered in payouts.test.ts). */
const approveFully = async (id: string): Promise<void> => {
  const fin = await w.finance();
  const r = await w.svc.approve(fin, id);
  if (r.status === "approval_required") {
    await w.admin.approve(await w.finance(), r.requestId);
    await w.admin.approve(await w.finance(), r.requestId);
    await w.svc.completeApproval(fin, id);
  }
};

describe("property: money paid out equals money moved to seller_available", () => {
  it("for random sequences of closes, post-payout clawbacks and weekly cycles: every payout <= available, and sum(payouts) = closes - clawbacks - remaining balance", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 7 }), async (ops) => {
        const s = await w.newStore();
        let closed = 0n;
        let clawed = 0n;
        let paid = 0n;
        for (const o of ops) {
          if (o.kind === "close") {
            const now = new Date(MONDAY.getTime() + week * 7 * DAY);
            // eligible: closed long ago; otherwise closed one day before the run (still inside the 3-day grace)
            await fundClosed(w, s, o.amount, o.eligible ? T0 : new Date(now.getTime() - DAY));
            closed += o.amount;
          } else if (o.kind === "clawback") {
            await w.post("refund_issued", `claw:${s}:${String(clawed)}:${o.amount.toString()}:${String(week)}`, [["seller_available", o.amount, s], ["psp_clearing", -o.amount, "paymob"]]);
            clawed += o.amount;
          } else {
            week += 1;
            const now = new Date(MONDAY.getTime() + week * 7 * DAY);
            w.clock.now = now;
            const before = -(await w.balance("seller_available", s));
            const built = await w.svc.buildCycle("EG", now);
            const id = await ownPayout(w, s, built.payoutIds);
            if (id === undefined) continue;
            const p = await w.svc.get("EG", id);
            expect(p.netMinor).toBeGreaterThan(0n);
            expect(p.netMinor).toBeLessThanOrEqual(before); // I12
            expect(p.netMinor).toBe(p.grossMinor + p.adjustmentsMinor);
            await approveFully(id);
            await w.svc.send("EG", id);
            await w.svc.settle("EG", id);
            paid += p.netMinor;
          }
        }
        const remaining = -(await w.balance("seller_available", s));
        expect(paid).toBe(closed - clawed - remaining);
        const rows = await w.raw.query<{ total: string }>("SELECT COALESCE(sum(net_minor), 0)::text AS total FROM payouts WHERE store_id = $1 AND status = 'SETTLED'", [s]);
        expect(BigInt(rows.rows[0]?.total ?? "0")).toBe(paid);
      }),
      { numRuns: 20 },
    );
    expect((await w.integrity.run("EG", new Date(MONDAY.getTime() + 1000 * DAY))).ok).toBe(true);
  });
});

describe("test doubles and fail-closed adapters", () => {
  it("production adapters stay unconfigured (ADR-0029)", async () => {
    await expect(new UnconfiguredPayoutRail().send()).rejects.toThrow(/not configured/);
    expect(await new UnconfiguredPayoutDestinations().resolve()).toBeNull();
  });
  it("the fake rail is idempotent by key and the fake destination store is replaceable", async () => {
    const rail = new FakePayoutRail();
    const dest = { instrumentId: "i", ibanLast4: "1111", accountHolderName: "A", legalName: "A" };
    const req = { idempotencyKey: "k", payoutId: "p", storeId: "s", amount: { amountMinor: 5n, currency: "EGP" as const }, destination: dest };
    const a = await rail.send(req);
    expect(await rail.send(req)).toEqual(a);
    expect(rail.transfers).toBe(1);
    const d = new FakePayoutDestinations();
    d.set("s", dest);
    expect(await d.resolve("s")).toEqual(dest);
    d.set("s", null);
    expect(await d.resolve("s")).toBeNull();
  });
});
