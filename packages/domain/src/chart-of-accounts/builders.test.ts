import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { trialBalance } from "../ledger";
import { money } from "../money";
import { chart, derivedBalance } from "./accounts";
import {
  orderRecognised,
  planPlusRecognition,
  refundIssued,
  storeCreditExpired,
  type EntryMeta,
} from "./builders";
import { InsufficientCreditError, InvalidChartInputError } from "./errors";
import { planStoreCreditSpend } from "./spend";

let n = 0;
const meta = (): EntryMeta => {
  n += 1;
  return {
    id: `e${n}`,
    idempotencyKey: `k${n}`,
    occurredAt: new Date("2026-10-10T00:00:00Z"),
    ref: { type: "t", id: "1" },
  };
};

describe("orderRecognised properties", () => {
  it("always balances and credits sellers exactly merchandise - commission - VAT", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 100n, max: 50_000_000n }), { minLength: 1, maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 3_000n }),
        fc.bigInt({ min: 0n, max: 2_500n }),
        fc.bigInt({ min: 0n, max: 100_000n }),
        (goods, commissionBps, vatBps, shipping) => {
          const total = goods.reduce((a, g) => a + g, 0n) + shipping;
          const e = orderRecognised(
            {
              sellerOrders: goods.map((g, i) => ({ storeId: `s${i}`, merchandise: money(g), commissionBps })),
              shippingGross: money(shipping),
              vatBps,
              tenders: [{ kind: "psp", psp: "p", amount: money(total) }],
            },
            meta(),
          );
          expect(trialBalance([e]).get("EGP") ?? 0n).toBe(0n);
          const credited = e.postings.filter((p) => p.amount.amount < 0n);
          expect(credited.reduce((a, p) => a - p.amount.amount, 0n)).toBe(total);
        },
      ),
    );
  });
});

describe("refundIssued properties", () => {
  const NUM_RUNS = Number(process.env["FC_RUNS"] ?? 2_000);
  const SEED = process.env["FC_SEED"] === undefined ? undefined : Number(process.env["FC_SEED"]);
  const accounts = [
    chart.sellerPayable("s"),
    chart.platformCommission,
    chart.platformVatOutput,
    chart.pspClearing("p"),
  ];
  const refund = (goods: bigint, before: bigint, commissionBps: bigint, vatBps: bigint) =>
    refundIssued(
      {
        storeId: "s",
        commissionBps,
        vatBps,
        goodsRefunded: money(goods),
        goodsRefundedBefore: money(before),
        destinations: [{ kind: "psp", psp: "p", amount: money(goods) }],
      },
      meta(),
    );

  it("any partition of a full refund reproduces the order and equals one whole refund", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.constantFrom(0n, 1_400n, 10_000n, 100_000n),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 7 }),
        (goods, commissionBps, vatBps, weights) => {
          let order;
          try {
            order = orderRecognised(
              {
                sellerOrders: [{ storeId: "s", merchandise: money(goods), commissionBps }],
                shippingGross: money(0n),
                vatBps,
                tenders: [{ kind: "psp", psp: "p", amount: money(goods) }],
              },
              meta(),
            );
          } catch (e) {
            if (e instanceof InvalidChartInputError) return fc.pre(false);
            throw e;
          }
          const wsum = weights.reduce((a, w) => a + w, 0);
          const parts: bigint[] = [];
          let assigned = 0n;
          weights.forEach((w, i) => {
            parts.push(i === weights.length - 1 ? goods - assigned : (goods * BigInt(w)) / BigInt(wsum));
            assigned += parts[i] ?? 0n;
          });
          let before = 0n;
          const slices = [];
          for (const part of parts) {
            if (part === 0n) continue;
            slices.push(refund(part, before, commissionBps, vatBps));
            before += part;
          }
          for (const e of slices) {
            for (const a of [chart.platformCommission, chart.platformVatOutput]) {
              expect(e.postings.filter((p) => p.account === a).every((p) => p.amount.amount >= 0n)).toBe(true);
            }
          }
          const entries = [order, ...slices];
          expect(trialBalance(entries).get("EGP") ?? 0n).toBe(0n);
          for (const acct of accounts) expect(derivedBalance(acct, entries).amount).toBe(0n);
          const whole = [refund(goods, 0n, commissionBps, vatBps)];
          for (const acct of accounts) {
            expect(derivedBalance(acct, slices).amount).toBe(derivedBalance(acct, whole).amount);
          }
        },
      ),
      { numRuns: NUM_RUNS, ...(SEED === undefined ? {} : { seed: SEED }) },
    );
  }, 600_000);
});

describe("input validation", () => {
  it("rejects discounts above merchandise and commission rates above 100%", () => {
    const base = {
      shippingGross: money(0n),
      vatBps: 1_400n,
      tenders: [{ kind: "psp" as const, psp: "p", amount: money(1n) }],
    };
    expect(() =>
      orderRecognised(
        {
          ...base,
          sellerOrders: [
            { storeId: "s", merchandise: money(100n), commissionBps: 0n, platformFundedDiscount: money(101n) },
          ],
        },
        meta(),
      ),
    ).toThrow(InvalidChartInputError);
    expect(() =>
      orderRecognised(
        { ...base, sellerOrders: [{ storeId: "s", merchandise: money(100n), commissionBps: 10_001n }] },
        meta(),
      ),
    ).toThrow(InvalidChartInputError);
  });

  it("rejects expiry of nothing", () => {
    expect(() =>
      storeCreditExpired({ userId: "u", sub: { kind: "goodwill" }, amount: money(0n) }, meta()),
    ).toThrow(InvalidChartInputError);
  });
});

describe("planStoreCreditSpend", () => {
  it("throws when credit is short and never overspends a sub-balance", () => {
    const states = [
      { sub: { kind: "goodwill" } as const, balance: money(500n), expiresAt: new Date("2026-12-01") },
    ];
    expect(() => planStoreCreditSpend(states, money(501n))).toThrow(InsufficientCreditError);
    expect(planStoreCreditSpend(states, money(300n))[0]?.amount.amount).toBe(300n);
  });

  it("always sums to the amount and respects balances", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 10_000n }), { minLength: 1, maxLength: 4 }),
        fc.bigInt({ min: 1n, max: 40_000n }),
        (bals, amount) => {
          const kinds = ["goodwill", "referral_credit", "cashback_coins", "refund_credit"] as const;
          const states = bals.map((b, i) => ({
            sub: { kind: kinds[i] ?? "goodwill" } as const,
            balance: money(b),
            expiresAt: i === 3 ? null : new Date(2027, i, 1),
          }));
          const total = bals.reduce((a, b) => a + b, 0n);
          if (amount > total) {
            expect(() => planStoreCreditSpend(states, money(amount))).toThrow(InsufficientCreditError);
            return;
          }
          const plan = planStoreCreditSpend(states, money(amount));
          expect(plan.reduce((a, p) => a + p.amount.amount, 0n)).toBe(amount);
          plan.forEach((p) => {
            const state = states.find((s) => s.sub.kind === p.sub.kind);
            expect(p.amount.amount <= (state?.balance.amount ?? 0n)).toBe(true);
          });
        },
      ),
    );
  });
});

describe("planPlusRecognition", () => {
  it("sums exactly to the net for any term", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10_000_000n }), fc.integer({ min: 1, max: 36 }), (net, periods) => {
        const plan = planPlusRecognition(money(net), periods);
        expect(plan).toHaveLength(periods);
        expect(plan.reduce((a, m) => a + m.amount, 0n)).toBe(net);
      }),
    );
  });
});
