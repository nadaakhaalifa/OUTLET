import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { balanceOf } from "../ledger";
import { orderRecognised, refundIssued, type EntryMeta } from "../chart-of-accounts/builders";
import { chart } from "../chart-of-accounts/accounts";
import { money } from "../money";
import {
  PAYOUT_HOLD_AFTER_CLOSE_MS,
  buildStatement,
  latestCycle,
  namesMatch,
  normalizeLegalName,
  planPayout,
  type Clawback,
  type PayableItem,
  type StatementFact,
} from "./index";

const CUTOFF = Date.UTC(2026, 9, 18, 8, 0, 0);
const uniqueIds = (n: number) => Array.from({ length: n }, (_, i) => `id-${String(i).padStart(3, "0")}`);

const itemsArb = fc
  .array(
    fc.record({
      net: fc.bigInt({ min: -1_000n, max: 5_000_000n }),
      closed: fc.boolean(),
      ageMs: fc.integer({ min: 0, max: 10 * 86_400_000 }),
      dispute: fc.boolean(),
    }),
    { maxLength: 25 },
  )
  .map((rows) =>
    rows.map(
      (r, i): PayableItem => ({
        sellerOrderId: uniqueIds(rows.length)[i] ?? `x${i}`,
        storeId: "s1",
        net: r.net,
        status: r.closed ? "CLOSED" : "DELIVERED",
        closedAtMs: r.closed ? CUTOFF - r.ageMs : null,
        openDispute: r.dispute,
      }),
    ),
  );
const clawArb = fc
  .array(fc.record({ amount: fc.bigInt({ min: 1n, max: 3_000_000n }), at: fc.integer({ min: 0, max: 1_000 }) }), { maxLength: 8 })
  .map((rows): Clawback[] =>
    rows.map((r, i) => ({ id: `c-${i}`, storeId: "s1", amount: r.amount, kind: "refund_after_payout", createdAtMs: r.at })),
  );

const shuffle = <T,>(xs: readonly T[], seed: number): T[] =>
  [...xs].map((x, i) => ({ x, k: Math.sin(seed + i * 7919) })).sort((a, b) => a.k - b.k).map((o) => o.x);

describe("planPayout properties", () => {
  it("conserves money: eligible = payout + netted, carry = owed - netted, payout never negative", () => {
    fc.assert(
      fc.property(itemsArb, clawArb, fc.bigInt({ min: 0n, max: 50_000n }), (items, clawbacks, min) => {
        const plan = planPayout({ storeId: "s1", cutoffMs: CUTOFF, items, clawbacks, minimumPayoutMinor: min });
        const owed = clawbacks.reduce((a, c) => a + c.amount, 0n);
        expect(plan.payout).toBeGreaterThanOrEqual(0n);
        if (plan.payable) {
          expect(plan.payout).toBeGreaterThanOrEqual(min);
          expect(plan.eligibleTotal).toBe(plan.payout + plan.nettedTotal);
          expect(plan.carryForward).toBe(owed - plan.nettedTotal);
          for (const a of plan.applied) {
            const c = clawbacks.find((x) => x.id === a.clawbackId);
            expect(c).toBeDefined();
            expect(a.applied + a.remaining).toBe(c?.amount);
          }
        } else {
          expect(plan.payout).toBe(0n);
          expect(plan.nettedTotal).toBe(0n);
          expect(plan.applied).toEqual([]);
          expect(plan.carryForward).toBe(owed);
        }
      }),
    );
  });

  it("is independent of input order and idempotent on replay", () => {
    fc.assert(
      fc.property(itemsArb, clawArb, fc.integer(), (items, clawbacks, seed) => {
        const a = planPayout({ storeId: "s1", cutoffMs: CUTOFF, items, clawbacks });
        const b = planPayout({ storeId: "s1", cutoffMs: CUTOFF, items: shuffle(items, seed), clawbacks: shuffle(clawbacks, seed) });
        expect(b).toEqual(a);
        expect(planPayout({ storeId: "s1", cutoffMs: CUTOFF, items, clawbacks })).toEqual(a);
      }),
    );
  });

  it("never pays an item inside the buffer, in dispute, or not closed", () => {
    fc.assert(
      fc.property(itemsArb, (items) => {
        const plan = planPayout({ storeId: "s1", cutoffMs: CUTOFF, items, clawbacks: [], minimumPayoutMinor: 0n });
        for (const i of plan.eligible) {
          expect(i.status).toBe("CLOSED");
          expect(i.openDispute).toBe(false);
          expect((i.closedAtMs ?? Infinity) + PAYOUT_HOLD_AFTER_CLOSE_MS).toBeLessThanOrEqual(CUTOFF);
          expect(i.net).toBeGreaterThan(0n);
        }
        expect(plan.eligible.length + plan.ineligible.length).toBe(items.length);
      }),
    );
  });

  it("a larger cutoff never shrinks the eligible set", () => {
    fc.assert(
      fc.property(itemsArb, fc.integer({ min: 0, max: 5 * 86_400_000 }), (items, extra) => {
        const a = planPayout({ storeId: "s1", cutoffMs: CUTOFF, items, clawbacks: [], minimumPayoutMinor: 0n });
        const b = planPayout({ storeId: "s1", cutoffMs: CUTOFF + extra, items, clawbacks: [], minimumPayoutMinor: 0n });
        const ids = new Set(b.eligible.map((i) => i.sellerOrderId));
        for (const i of a.eligible) expect(ids.has(i.sellerOrderId)).toBe(true);
      }),
    );
  });
});

describe("cycle properties", () => {
  it("latest cycle is at or before now, within 7 days, on the configured weekday, and stable", () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2028, 0, 1) }), fc.integer({ min: 0, max: 6 }), (now, weekday) => {
        const cfg = { weekday, hour: 10 };
        const c = latestCycle(now, cfg);
        expect(c.runAtMs).toBeLessThanOrEqual(now);
        expect(now - c.runAtMs).toBeLessThan(7 * 86_400_000 + 3_600_000);
        expect(latestCycle(c.runAtMs, cfg).key).toBe(c.key);
        expect(latestCycle(c.runAtMs + 1, cfg).key).toBe(c.key);
      }),
    );
  });
});

describe("name matching properties", () => {
  it("is symmetric and normalization is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (a, b) => {
        expect(namesMatch(a, b)).toBe(namesMatch(b, a));
        const n = normalizeLegalName(a);
        expect(normalizeLegalName(n)).toBe(n);
      }),
    );
  });
});

describe("statement properties", () => {
  const meta = (k: string): EntryMeta => ({ id: k, idempotencyKey: k, occurredAt: new Date(0), ref: { type: "t", id: k } });

  it("closing = opening + sum of net, consecutive periods chain, order does not matter", () => {
    const factArb = fc.array(
      fc.record({
        kind: fc.constantFrom("order", "promo_netting", "payout", "payout_reversal", "clawback"),
        at: fc.integer({ min: 0, max: 100 }),
        amount: fc.bigInt({ min: 1n, max: 2_000_000n }),
        bps: fc.bigInt({ min: 0n, max: 3_000n }),
      }),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(factArb, fc.integer({ min: 1, max: 99 }), fc.integer(), (rows, split, seed) => {
        const facts: StatementFact[] = rows.map((r, i) =>
          r.kind === "order"
            ? { type: "order", id: `f${i}`, storeId: "s", atMs: r.at, merchandise: r.amount, commissionBps: r.bps, vatBps: 1_400n }
            : { type: r.kind, id: `f${i}`, storeId: "s", atMs: r.at, amount: r.amount },
        );
        const one = buildStatement({ storeId: "s", fromMs: 0, toMs: 101, facts });
        expect(one.closing).toBe(one.opening + one.totals.net);
        expect(one.totals.net).toBe(one.lines.reduce((a, l) => a + l.net, 0n));
        const a = buildStatement({ storeId: "s", fromMs: 0, toMs: split, facts });
        const b = buildStatement({ storeId: "s", fromMs: split, toMs: 101, facts: shuffle(facts, seed) });
        expect(b.opening).toBe(a.closing);
        expect(b.closing).toBe(one.closing);
        expect(buildStatement({ storeId: "s", fromMs: 0, toMs: 101, facts: shuffle(facts, seed) })).toEqual(one);
      }),
    );
  });

  it("agrees with the ledger: order and refund lines equal the seller_payable postings", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 100n, max: 5_000_000n }),
        fc.bigInt({ min: 0n, max: 3_000n }),
        fc.bigInt({ min: 1n, max: 99n }),
        (merch, bps, pct) => {
          const goods = (merch * pct) / 100n === 0n ? 1n : (merch * pct) / 100n;
          const order = orderRecognised(
            {
              sellerOrders: [{ storeId: "s", merchandise: money(merch), commissionBps: bps }],
              shippingGross: money(0n),
              vatBps: 1_400n,
              tenders: [{ kind: "psp", psp: "fake", amount: money(merch) }],
            },
            meta("o"),
          );
          const refund = refundIssued(
            {
              storeId: "s",
              commissionBps: bps,
              vatBps: 1_400n,
              goodsRefunded: money(goods),
              goodsRefundedBefore: money(0n),
              destinations: [{ kind: "psp", psp: "fake", amount: money(goods) }],
            },
            meta("r"),
          );
          const st = buildStatement({
            storeId: "s",
            fromMs: 0,
            toMs: 10,
            facts: [
              { type: "order", id: "o", storeId: "s", atMs: 1, merchandise: merch, commissionBps: bps, vatBps: 1_400n },
              { type: "refund", id: "r", storeId: "s", atMs: 2, goodsRefunded: goods, goodsRefundedBefore: 0n, commissionBps: bps, vatBps: 1_400n },
            ],
          });
          const payable = chart.sellerPayable("s");
          // seller_payable is credit-normal: raw is negative when owed to the seller.
          expect(st.lines[0]?.net).toBe(-balanceOf(payable, [order]).amount);
          expect(st.lines[1]?.net).toBe(-balanceOf(payable, [refund]).amount);
          expect(st.closing).toBe(-balanceOf(payable, [order, refund]).amount);
        },
      ),
    );
  });
});
