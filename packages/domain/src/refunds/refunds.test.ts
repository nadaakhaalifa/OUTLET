import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "../money";
import { trialBalance, balanceOf } from "../ledger";
import { chart } from "../chart-of-accounts";
import { buildEntry } from "../ledger-posting";
import { defineMachine } from "../state-machine";
import {
  CASH_CHANNELS,
  CREDIT_CHANNELS,
  PAYMENT_METHODS,
  RefundExceedsRefundableError,
  aggregateStatus,
  attributeLegsToLines,
  planRefundLegs,
  initiationDeadline,
  legalDeadline,
  nextFailureEvent,
  publicStatus,
  refundMachine,
  retryDelayMs,
  routeRefund,
  sloState,
  sumRoutes,
  type OriginalTender,
  type PaymentMethod,
  type RefundChoice,
  type RefundRouterConfig,
} from "./index";

const tender = (id: string, method: PaymentMethod, amount: bigint, extra: Partial<OriginalTender> = {}): OriginalTender => ({
  id,
  method,
  amount: money(amount),
  refundedBefore: money(0n),
  psp: "paymob",
  provider: "valu",
  courier: "bosta",
  ...extra,
});

const methodArb = fc.constantFrom(...PAYMENT_METHODS);
const choiceArb: fc.Arbitrary<RefundChoice> = fc.record({
  preference: fc.constantFrom("original_method", "store_credit"),
  cod: fc.constantFrom("store_credit", "bank_transfer", "wallet_transfer"),
});
const configArb: fc.Arbitrary<RefundRouterConfig> = fc.record({
  fawry: fc.constantFrom("store_credit", "fawry_voucher"),
  pspReverse: fc.record({ mobile_wallet: fc.boolean(), instapay: fc.boolean() }),
});
const tendersArb = fc
  .array(fc.tuple(methodArb, fc.bigInt({ min: 1n, max: 5_000_000n })), { minLength: 1, maxLength: 5 })
  .map((xs) => xs.map(([m, a], i) => tender(`t${i}`, m, a)));

describe("routeRefund rules", () => {
  it("card, Apple Pay and Meeza go to the original instrument by default", () => {
    for (const m of ["card", "apple_pay", "meeza"] as const) {
      const [r] = routeRefund({ amount: money(1000n), tenders: [tender("t", m, 1000n)] });
      expect(r?.channel).toBe("psp_original");
    }
  });
  it("the shopper may choose instant credit instead", () => {
    const [r] = routeRefund({
      amount: money(1000n),
      tenders: [tender("t", "card", 1000n)],
      choice: { preference: "store_credit", cod: "store_credit" },
    });
    expect(r).toMatchObject({ channel: "store_credit", creditSub: { kind: "refund_credit" } });
  });
  it("wallet and InstaPay reverse at the PSP only where supported, else verified IBAN transfer", () => {
    const on = { fawry: "store_credit", pspReverse: { mobile_wallet: true, instapay: true } } as const;
    expect(routeRefund({ amount: money(10n), tenders: [tender("t", "instapay", 10n)], config: on })[0]?.channel).toBe("psp_reverse");
    const r = routeRefund({ amount: money(10n), tenders: [tender("t", "mobile_wallet", 10n)] })[0];
    expect(r).toMatchObject({ channel: "bank_transfer_iban", needsPayoutDetails: true, verify: "VR-RF-01" });
  });
  it("Fawry goes per config", () => {
    expect(routeRefund({ amount: money(10n), tenders: [tender("t", "fawry", 10n)] })[0]?.channel).toBe("store_credit");
    const cfg = { fawry: "fawry_voucher", pspReverse: { mobile_wallet: false, instapay: false } } as const;
    expect(routeRefund({ amount: money(10n), tenders: [tender("t", "fawry", 10n)], config: cfg })[0]?.channel).toBe("fawry_voucher");
  });
  it("BNPL is provider cancellation even when the shopper asks for credit", () => {
    const [r] = routeRefund({
      amount: money(500n),
      tenders: [tender("t", "bnpl", 500n)],
      choice: { preference: "store_credit", cod: "bank_transfer" },
    });
    expect(r).toMatchObject({ channel: "bnpl_cancel", note: "preference_ignored_bnpl_provider_only" });
  });
  it("COD defaults to instant credit, transfer only by explicit choice", () => {
    expect(routeRefund({ amount: money(10n), tenders: [tender("t", "cod", 10n)] })[0]?.channel).toBe("store_credit");
    const r = routeRefund({
      amount: money(10n),
      tenders: [tender("t", "cod", 10n)],
      choice: { preference: "original_method", cod: "wallet_transfer" },
    })[0];
    expect(r).toMatchObject({ channel: "wallet_transfer", needsPayoutDetails: true });
  });
  it("credit and gift-card tenders return to the same sub-balance", () => {
    const [r] = routeRefund({
      amount: money(10n),
      tenders: [tender("t", "gift_card", 10n, { creditSub: { kind: "gift_card", cardId: "c1" } })],
    });
    expect(r).toMatchObject({ channel: "store_credit_original_sub", creditSub: { kind: "gift_card", cardId: "c1" } });
  });
  it("split tender: pro rata and exact", () => {
    const routes = routeRefund({
      amount: money(1001n),
      tenders: [tender("a", "card", 3000n), tender("b", "store_credit", 1000n, { creditSub: { kind: "goodwill" } })],
    });
    expect(routes.map((r) => r.amount.amount)).toEqual([751n, 250n]);
  });
  it("rejects a refund above what is left", () => {
    expect(() =>
      routeRefund({ amount: money(11n), tenders: [{ ...tender("t", "card", 10n) }] }),
    ).toThrow(RefundExceedsRefundableError);
    expect(() =>
      routeRefund({ amount: money(6n), tenders: [{ ...tender("t", "card", 10n), refundedBefore: money(5n) }] }),
    ).toThrow(RefundExceedsRefundableError);
  });
  it("rejects non-positive amounts", () => {
    expect(() => routeRefund({ amount: money(0n), tenders: [tender("t", "card", 10n)] })).toThrow();
  });
});

describe("routeRefund properties", () => {
  it("BNPL never routes to credit or cash for any input", () => {
    fc.assert(
      fc.property(tendersArb, choiceArb, configArb, fc.bigInt({ min: 1n, max: 10_000_000n }), (tenders, choice, config, want) => {
        const total = tenders.reduce((a, t) => a + t.amount.amount, 0n);
        const amount = want > total ? total : want;
        const routes = routeRefund({ amount: money(amount), tenders, choice, config });
        for (const r of routes) {
          if (r.method === "bnpl") {
            expect(r.channel).toBe("bnpl_cancel");
            expect(CREDIT_CHANNELS).not.toContain(r.channel);
            expect(CASH_CHANNELS).not.toContain(r.channel);
            expect(r.creditSub).toBeNull();
          } else {
            expect(r.channel).not.toBe("bnpl_cancel");
          }
        }
      }),
      { numRuns: 400 },
    );
  });
  it("parts sum to the total and never exceed a tender's refundable amount", () => {
    fc.assert(
      fc.property(tendersArb, choiceArb, fc.double({ min: 0.0001, max: 1, noNaN: true }), (tenders, choice, frac) => {
        const total = tenders.reduce((a, t) => a + t.amount.amount, 0n);
        const amount = BigInt(Math.max(1, Math.floor(Number(total) * frac)));
        const routes = routeRefund({ amount: money(amount), tenders, choice });
        expect(sumRoutes(routes)).toBe(amount);
        for (const r of routes) {
          const t = tenders.find((x) => x.id === r.tenderId);
          expect(r.amount.amount).toBeGreaterThan(0n);
          expect(r.amount.amount <= (t?.amount.amount ?? 0n)).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });
  it("repeated routing of the same input is identical (idempotent replay)", () => {
    fc.assert(
      fc.property(tendersArb, choiceArb, (tenders, choice) => {
        const total = tenders.reduce((a, t) => a + t.amount.amount, 0n);
        const input = { amount: money(total), tenders, choice };
        expect(routeRefund(input)).toEqual(routeRefund(input));
      }),
    );
  });
});

describe("planRefundLegs: one allocation shared by ledger and legs", () => {
  const line = (id: string, gross: bigint, before = 0n) => ({ lineId: id, gross: money(gross), refundedBefore: money(before) });
  const base = (over: Partial<Parameters<typeof planRefundLegs>[0]> = {}): Parameters<typeof planRefundLegs>[0] => ({
    userId: "u1",
    storeId: "s1",
    commissionBps: 1500n,
    vatBps: 1400n,
    lines: [line("l1", 10_000n), line("l2", 5_000n)],
    items: [{ lineId: "l1", goods: money(10_000n) }],
    platformVoucher: money(600n),
    sellerVoucher: money(900n),
    shippingGross: money(0n),
    tenders: [tender("a", "card", 9_000n), tender("b", "store_credit", 6_000n, { creditSub: { kind: "refund_credit" } })],
    ...over,
  });

  it("legs sum to the ledger total and the entry balances", () => {
    const r = planRefundLegs(base());
    expect(sumRoutes([...r.routes])).toBe(r.plan.total.amount);
    const e = buildEntry({ type: "refund", refundId: "r1", ...r.input }, { id: "00000000-0000-4000-8000-000000000001", occurredAt: new Date(0) });
    expect([...trialBalance([e]).values()].every((v) => v === 0n)).toBe(true);
    expect(e.idempotencyKey).toBe("refund:r1:s1");
  });

  it("rejects refunding a line above its value, across partial refunds", () => {
    expect(() => planRefundLegs(base({ lines: [line("l1", 10_000n, 1n), line("l2", 5_000n)] }))).toThrow();
  });

  it("rejects when tenders can no longer cover the refund", () => {
    const spent = [tender("a", "card", 9_000n, { refundedBefore: money(9_000n) }), tender("b", "card", 6_000n, { refundedBefore: money(6_000n) })];
    expect(() => planRefundLegs(base({ tenders: spent }))).toThrow();
  });

  it("BNPL goes back to the provider whatever the shopper prefers", () => {
    const r = planRefundLegs(
      base({
        tenders: [tender("a", "bnpl", 15_000n)],
        choice: { preference: "store_credit", cod: "store_credit" },
      }),
    );
    expect(r.routes.every((x) => x.channel === "bnpl_cancel")).toBe(true);
    const e = buildEntry({ type: "refund", refundId: "r2", ...r.input }, { id: "00000000-0000-4000-8000-000000000002", occurredAt: new Date(0) });
    expect(e.postings.some((p) => p.account === chart.bnplClearing("valu"))).toBe(true);
    expect(e.postings.some((p) => p.account.startsWith("store_credit"))).toBe(false);
  });

  it("credit choice moves value to refund credit, in the entry and the legs alike", () => {
    const r = planRefundLegs(base({ tenders: [tender("a", "card", 15_000n)], choice: { preference: "store_credit", cod: "store_credit" } }));
    expect(r.routes.every((x) => x.channel === "store_credit")).toBe(true);
    const e = buildEntry({ type: "refund", refundId: "r3", ...r.input }, { id: "00000000-0000-4000-8000-000000000003", occurredAt: new Date(0) });
    expect(balanceOf(chart.storeCredit("u1", { kind: "refund_credit" }), [e]).amount).toBe(-r.plan.total.amount);
  });

  it("voucher shares telescope: full refund in two steps releases the whole voucher", () => {
    const first = planRefundLegs(base({ items: [{ lineId: "l1", goods: money(4_000n) }] }));
    const second = planRefundLegs(
      base({
        lines: [line("l1", 10_000n, 4_000n), line("l2", 5_000n)],
        items: [{ lineId: "l1", goods: money(6_000n) }, { lineId: "l2", goods: money(5_000n) }],
      }),
    );
    const whole = planRefundLegs(base({ items: [{ lineId: "l1", goods: money(10_000n) }, { lineId: "l2", goods: money(5_000n) }] }));
    const sellerFirst = first.plan.sellerShare.amount + second.plan.sellerShare.amount;
    expect(sellerFirst + first.plan.platformShare.amount + second.plan.platformShare.amount).toBeLessThanOrEqual(1_500n);
    expect(whole.plan.sellerShare.amount + whole.plan.platformShare.amount).toBe(1_500n);
  });
});

describe("attributeLegsToLines", () => {
  it("both marginals are exact for any amounts", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 100_000n }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 4 }),
        (nets, legCount) => {
          const total = nets.reduce((a, b) => a + b, 0n);
          fc.pre(total > 0n);
          const cuts = Array.from({ length: legCount }, (_, i) => (total * BigInt(i + 1)) / BigInt(legCount));
          const legs = cuts.map((c, i) => ({ legKey: `l${i}`, amount: money(c - (cuts[i - 1] ?? 0n)) }));
          const lines = nets.map((n, i) => ({ orderLineId: `o${i}`, net: money(n) }));
          const shares = attributeLegsToLines(lines, legs);
          for (const l of legs) {
            expect(shares.filter((s) => s.legKey === l.legKey).reduce((a, s) => a + s.amount.amount, 0n)).toBe(l.amount.amount);
          }
          for (const l of lines) {
            expect(shares.filter((s) => s.orderLineId === l.orderLineId).reduce((a, s) => a + s.amount.amount, 0n)).toBe(l.net.amount);
          }
        },
      ),
    );
  });
  it("rejects mismatched totals", () => {
    expect(() => attributeLegsToLines([{ orderLineId: "a", net: money(10n) }], [{ legKey: "x", amount: money(9n) }])).toThrow();
  });
});

describe("status, SLO and retry", () => {
  it("maps engine states to the public vocabulary", () => {
    expect(publicStatus("LEDGER_POSTED")).toBe("APPROVED");
    expect(publicStatus("SUBMITTED")).toBe("PROCESSING");
    expect(publicStatus("MANUAL_REVIEW")).toBe("MANUAL_REVIEW");
  });
  it("aggregates leg states with attention first", () => {
    expect(aggregateStatus(["COMPLETED", "COMPLETED"])).toBe("COMPLETED");
    expect(aggregateStatus(["COMPLETED", "SUBMITTED"])).toBe("PROCESSING");
    expect(aggregateStatus(["COMPLETED", "FAILED"])).toBe("FAILED");
    expect(aggregateStatus(["FAILED", "MANUAL_REVIEW"])).toBe("MANUAL_REVIEW");
    expect(aggregateStatus(["REQUESTED", "REQUESTED"])).toBe("REQUESTED");
    expect(aggregateStatus(["LEDGER_POSTED", "COMPLETED"])).toBe("APPROVED");
    expect(aggregateStatus([])).toBe("REQUESTED");
  });
  it("uses the shared Refund machine: retry below the cap, escalate at it", () => {
    expect(refundMachine.transition("FAILED", "RETRY", { attempts: 2 })).toBe("SUBMITTED");
    expect(() => refundMachine.transition("FAILED", "RETRY", { attempts: 3 })).toThrow();
    expect(refundMachine.transition("FAILED", "ESCALATE", { attempts: 3 })).toBe("MANUAL_REVIEW");
    expect(nextFailureEvent(2)).toBe("RETRY");
    expect(nextFailureEvent(3)).toBe("ESCALATE");
    expect(defineMachine).toBeTypeOf("function");
  });
  it("deadlines", () => {
    expect(initiationDeadline(1000)).toBe(1000 + 86_400_000);
    expect(legalDeadline(0)).toBe(14 * 86_400_000);
    const base = { receivedAtMs: 0, paidAtMs: null } as const;
    expect(sloState({ ...base, initiatedAtMs: 3_600_000, nowMs: 4_000_000 })).toBe("on_track");
    expect(sloState({ ...base, initiatedAtMs: 90_000_000, nowMs: 91_000_000 })).toBe("initiation_breached");
    expect(sloState({ ...base, initiatedAtMs: null, nowMs: 90_000_000 })).toBe("initiation_breached");
    expect(sloState({ ...base, initiatedAtMs: 1, nowMs: 15 * 86_400_000 })).toBe("legal_deadline_breached");
    expect(sloState({ receivedAtMs: 0, initiatedAtMs: 1, paidAtMs: 13 * 86_400_000, nowMs: 20 * 86_400_000 })).toBe("on_track");
  });
  it("backoff is bounded, monotonic in attempt and jitter-bounded", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), fc.double({ min: 0, max: 0.999, noNaN: true }), (n, j) => {
        const d = retryDelayMs(n, j);
        expect(d).toBeGreaterThanOrEqual(30_000);
        expect(d).toBeLessThanOrEqual(3_600_000);
        expect(retryDelayMs(n + 1, 0)).toBeGreaterThanOrEqual(retryDelayMs(n, 0));
      }),
    );
    expect(retryDelayMs(1, 0)).toBe(30_000);
    expect(retryDelayMs(1, 0.999999)).toBe(59_999);
  });
});
