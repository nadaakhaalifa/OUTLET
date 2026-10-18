// Targeted tests that pin exact outputs, guards and error messages of the refund router, leg planning,
// allocation and SLO schedule. Written to kill Stryker survivors (ADR-0019), not for coverage.
import { describe, expect, it } from "vitest";
import { balanceOf } from "../ledger";
import { chart } from "../chart-of-accounts";
import { buildEntry } from "../ledger-posting";
import { money } from "../money";
import {
  DAY_MS,
  HOUR_MS,
  InvalidRefundInputError,
  RefundExceedsRefundableError,
  aggregateStatus,
  attributeLegsToLines,
  isInternalChannel,
  nextRetryAt,
  planRefundLegs,
  retryDelayMs,
  routeRefund,
  sloState,
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
const orig: RefundChoice = { preference: "original_method", cod: "store_credit" };
const one = (t: OriginalTender, choice: RefundChoice = orig, config?: RefundRouterConfig) => {
  const r = routeRefund({ amount: money(100n), tenders: [{ ...t, amount: money(1_000n) }], choice, ...(config ? { config } : {}) });
  expect(r).toHaveLength(1);
  return r[0]!;
};

describe("decideRoute: every field of every branch", () => {
  it("bnpl", () => {
    const r = one(tender("t", "bnpl", 1n));
    expect(r).toMatchObject({ channel: "bnpl_cancel", creditSub: null, needsPayoutDetails: false, verify: "VR-RF-03", note: null });
    expect(one(tender("t", "bnpl", 1n), { preference: "store_credit", cod: "store_credit" }).note).toBe("preference_ignored_bnpl_provider_only");
  });
  it("store credit and gift card return to the original sub-balance", () => {
    for (const m of ["store_credit", "gift_card"] as const) {
      expect(one(tender("t", m, 1n))).toMatchObject({
        channel: "store_credit_original_sub",
        creditSub: { kind: "refund_credit" },
        needsPayoutDetails: false,
        verify: null,
        note: null,
      });
    }
    const sub = { kind: "cashback_coins" } as const;
    expect(one(tender("t", "store_credit", 1n, { creditSub: sub })).creditSub).toEqual(sub);
  });
  it("card family", () => {
    for (const m of ["card", "apple_pay", "meeza"] as const) {
      expect(one(tender("t", m, 1n))).toMatchObject({ channel: "psp_original", creditSub: null, needsPayoutDetails: false, verify: null, note: null });
      expect(one(tender("t", m, 1n), { preference: "store_credit", cod: "store_credit" })).toMatchObject({
        channel: "store_credit",
        creditSub: { kind: "refund_credit" },
        needsPayoutDetails: false,
        verify: null,
        note: null,
      });
    }
  });
  it("wallet and instapay: reverse where supported, else bank transfer with payout details", () => {
    const rev: RefundRouterConfig = { fawry: "store_credit", pspReverse: { mobile_wallet: true, instapay: true } };
    const none: RefundRouterConfig = { fawry: "store_credit", pspReverse: { mobile_wallet: false, instapay: false } };
    for (const m of ["mobile_wallet", "instapay"] as const) {
      expect(one(tender("t", m, 1n), orig, rev)).toMatchObject({
        channel: "psp_reverse",
        creditSub: null,
        needsPayoutDetails: false,
        verify: "VR-RF-01",
        note: null,
      });
      expect(one(tender("t", m, 1n), orig, none)).toMatchObject({
        channel: "bank_transfer_iban",
        creditSub: null,
        needsPayoutDetails: true,
        verify: "VR-RF-01",
        note: null,
      });
      // store credit preference wins even when reverse is supported
      expect(one(tender("t", m, 1n), { preference: "store_credit", cod: "bank_transfer" }, rev)).toMatchObject({
        channel: "store_credit",
        verify: null,
        needsPayoutDetails: false,
      });
    }
    const onlyWallet: RefundRouterConfig = { fawry: "store_credit", pspReverse: { mobile_wallet: true, instapay: false } };
    expect(one(tender("t", "mobile_wallet", 1n), orig, onlyWallet).channel).toBe("psp_reverse");
    expect(one(tender("t", "instapay", 1n), orig, onlyWallet).channel).toBe("bank_transfer_iban");
  });
  it("fawry", () => {
    const v: RefundRouterConfig = { fawry: "fawry_voucher", pspReverse: { mobile_wallet: false, instapay: false } };
    expect(one(tender("t", "fawry", 1n), orig, v)).toMatchObject({
      channel: "fawry_voucher",
      creditSub: null,
      needsPayoutDetails: false,
      verify: "VR-RF-02",
      note: null,
    });
    expect(one(tender("t", "fawry", 1n), { preference: "store_credit", cod: "store_credit" }, v)).toMatchObject({
      channel: "store_credit",
      verify: "VR-RF-02",
    });
    expect(one(tender("t", "fawry", 1n))).toMatchObject({ channel: "store_credit", verify: "VR-RF-02" });
  });
  it("cod", () => {
    expect(one(tender("t", "cod", 1n))).toMatchObject({ channel: "store_credit", verify: null, needsPayoutDetails: false });
    expect(one(tender("t", "cod", 1n), { preference: "original_method", cod: "bank_transfer" })).toMatchObject({
      channel: "bank_transfer_iban",
      creditSub: null,
      needsPayoutDetails: true,
      verify: "VR-RF-04",
      note: null,
    });
    expect(one(tender("t", "cod", 1n), { preference: "original_method", cod: "wallet_transfer" })).toMatchObject({
      channel: "wallet_transfer",
      needsPayoutDetails: true,
      verify: "VR-RF-04",
    });
    expect(one(tender("t", "cod", 1n), { preference: "store_credit", cod: "bank_transfer" }).channel).toBe("store_credit");
  });
});

describe("routeRefund guards", () => {
  const t = (over: Partial<OriginalTender> = {}) => tender("t1", "card", 1_000n, over);
  it("rejects non-EGP refund amounts with a specific message", () => {
    expect(() => routeRefund({ amount: money(1n, "USD" as never), tenders: [t()] })).toThrow(InvalidRefundInputError);
    expect(() => routeRefund({ amount: money(1n, "USD" as never), tenders: [t()] })).toThrow("only EGP is supported");
  });
  it("rejects zero and negative amounts", () => {
    expect(() => routeRefund({ amount: money(0n), tenders: [t()] })).toThrow("refund amount must be positive");
    expect(() => routeRefund({ amount: money(-1n), tenders: [t()] })).toThrow("refund amount must be positive");
  });
  it("rejects tenders in another currency (either field)", () => {
    expect(() => routeRefund({ amount: money(1n), tenders: [t({ amount: money(1_000n, "USD" as never) })] })).toThrow(/tender t1: only EGP/);
    expect(() => routeRefund({ amount: money(1n), tenders: [t({ refundedBefore: money(0n, "USD" as never) })] })).toThrow(/tender t1: only EGP/);
  });
  it("rejects negative tender amounts and over-refunded tenders", () => {
    expect(() => routeRefund({ amount: money(1n), tenders: [t({ amount: money(-5n) })] })).toThrow(/amounts must not be negative/);
    expect(() => routeRefund({ amount: money(1n), tenders: [t({ refundedBefore: money(-1n) })] })).toThrow(/amounts must not be negative/);
    expect(() => routeRefund({ amount: money(1n), tenders: [t({ refundedBefore: money(1_001n) })] })).toThrow(/refunded more than was paid/);
    // exactly fully refunded is not an error for the tender (the aggregate check reports it)
    expect(() => routeRefund({ amount: money(1n), tenders: [t({ refundedBefore: money(1_000n) })] })).toThrow(RefundExceedsRefundableError);
  });
  it("exceeding refundable reports both numbers", () => {
    expect(() => routeRefund({ amount: money(1_001n), tenders: [t()] })).toThrow("refund 1001 exceeds refundable 1000");
    expect(routeRefund({ amount: money(1_000n), tenders: [t()] })).toHaveLength(1);
  });
  it("skips fully refunded tenders and zero parts", () => {
    const spent = tender("spent", "card", 500n, { refundedBefore: money(500n) });
    const open = tender("open", "meeza", 700n);
    const r = routeRefund({ amount: money(700n), tenders: [spent, open] });
    expect(r.map((x) => x.tenderId)).toEqual(["open"]);
    expect(r[0]?.amount.amount).toBe(700n);
    // a 1 piastre refund across two tenders lands on exactly one of them
    const two = routeRefund({ amount: money(1n), tenders: [tender("a", "card", 100n), tender("b", "meeza", 100n)] });
    expect(two).toHaveLength(1);
    expect(two[0]?.amount.amount).toBe(1n);
  });
  it("spreads a refund across tenders proportionally to what is left", () => {
    const r = routeRefund({
      amount: money(300n),
      tenders: [tender("a", "card", 1_000n, { refundedBefore: money(400n) }), tender("b", "meeza", 600n)],
    });
    expect(r.map((x) => [x.tenderId, x.amount.amount])).toEqual([
      ["a", 150n],
      ["b", 150n],
    ]);
    expect(r[0]?.method).toBe("card");
  });
});

describe("isInternalChannel", () => {
  it("is true only for the two store-credit channels", () => {
    expect(isInternalChannel("store_credit")).toBe(true);
    expect(isInternalChannel("store_credit_original_sub")).toBe(true);
    for (const c of ["psp_original", "psp_reverse", "bank_transfer_iban", "wallet_transfer", "fawry_voucher", "bnpl_cancel"] as const) {
      expect(isInternalChannel(c)).toBe(false);
    }
  });
});

describe("aggregateStatus", () => {
  it("covers every ordering rule", () => {
    expect(aggregateStatus([])).toBe("REQUESTED");
    expect(aggregateStatus(["CANCELLED", "CANCELLED"])).toBe("CANCELLED");
    expect(aggregateStatus(["CANCELLED", "COMPLETED"])).toBe("COMPLETED");
    expect(aggregateStatus(["COMPLETED", "COMPLETED"])).toBe("COMPLETED");
    expect(aggregateStatus(["COMPLETED", "MANUAL_REVIEW", "FAILED"])).toBe("MANUAL_REVIEW");
    expect(aggregateStatus(["COMPLETED", "FAILED", "SUBMITTED"])).toBe("FAILED");
    expect(aggregateStatus(["COMPLETED", "SUBMITTED"])).toBe("PROCESSING");
    expect(aggregateStatus(["REQUESTED", "REQUESTED"])).toBe("REQUESTED");
    expect(aggregateStatus(["CANCELLED", "REQUESTED"])).toBe("REQUESTED");
    expect(aggregateStatus(["REQUESTED", "COMPLETED"])).toBe("APPROVED");
    expect(aggregateStatus(["LEDGER_POSTED", "REQUESTED"])).toBe("APPROVED");
    expect(aggregateStatus(["CANCELLED", "LEDGER_POSTED"])).toBe("APPROVED");
  });
});

describe("attributeLegsToLines guards and order", () => {
  const L = (id: string, n: bigint) => ({ orderLineId: id, net: money(n) });
  const G = (k: string, n: bigint) => ({ legKey: k, amount: money(n) });
  it("reports both totals on mismatch", () => {
    expect(() => attributeLegsToLines([L("a", 10n)], [G("x", 9n)])).toThrow("legs 9 differ from lines 10");
  });
  it("rejects negative lines and negative legs even when totals match", () => {
    expect(() => attributeLegsToLines([L("a", 15n), L("b", -5n)], [G("x", 10n)])).toThrow("negative line net");
    expect(() => attributeLegsToLines([L("a", 5n)], [G("x", 15n), G("y", -10n)])).toThrow("negative leg amount");
  });
  it("fills lines in order and splits across leg boundaries exactly", () => {
    const s = attributeLegsToLines([L("a", 30n), L("b", 0n), L("c", 70n)], [G("x", 50n), G("y", 50n)]);
    expect(s.map((x) => [x.legKey, x.orderLineId, x.amount.amount])).toEqual([
      ["x", "a", 30n],
      ["x", "c", 20n],
      ["y", "c", 50n],
    ]);
  });
  it("takes a whole line when leg equals line (no zero-size share)", () => {
    const s = attributeLegsToLines([L("a", 40n), L("b", 60n)], [G("x", 40n), G("y", 60n)]);
    expect(s.map((x) => [x.legKey, x.orderLineId, x.amount.amount])).toEqual([
      ["x", "a", 40n],
      ["y", "b", 60n],
    ]);
  });
  it("returns nothing for empty input", () => {
    expect(attributeLegsToLines([], [])).toEqual([]);
  });
});

describe("schedule boundaries", () => {
  const rx = 1_000_000;
  it("paid exactly at the legal deadline is on time; one ms later is breached", () => {
    const legal = rx + 14 * DAY_MS;
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: rx, paidAtMs: legal, nowMs: legal + 5 })).toBe("on_track");
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: rx, paidAtMs: legal + 1, nowMs: legal + 5 })).toBe("legal_deadline_breached");
  });
  it("unpaid: now exactly at the deadline is on time; after is breached", () => {
    const legal = rx + 14 * DAY_MS;
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: rx, paidAtMs: null, nowMs: legal })).toBe("on_track");
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: rx, paidAtMs: null, nowMs: legal + 1 })).toBe("legal_deadline_breached");
  });
  it("a late paidAt breaches even when now is early (paid wins over now)", () => {
    const legal = rx + 14 * DAY_MS;
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: rx, paidAtMs: legal + 1, nowMs: rx })).toBe("legal_deadline_breached");
    // an old paidAt in time, with a far-future now, must stay on track
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: rx, paidAtMs: rx + HOUR_MS, nowMs: legal + 10 * DAY_MS })).toBe("on_track");
  });
  it("initiation exactly at 24h is on time; one ms later is breached; not yet initiated uses now", () => {
    const slo = rx + 24 * HOUR_MS;
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: slo, paidAtMs: null, nowMs: slo })).toBe("on_track");
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: slo + 1, paidAtMs: null, nowMs: slo + 1 })).toBe("initiation_breached");
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: null, paidAtMs: null, nowMs: slo + 1 })).toBe("initiation_breached");
    expect(sloState({ receivedAtMs: rx, initiatedAtMs: null, paidAtMs: null, nowMs: slo })).toBe("on_track");
  });
  it("retry delay clamps attempt to >= 1 and floors fractions; nextRetryAt adds", () => {
    expect(retryDelayMs(0, 0)).toBe(30_000);
    expect(retryDelayMs(-5, 0)).toBe(30_000);
    expect(retryDelayMs(1.9, 0)).toBe(30_000);
    expect(retryDelayMs(2, 0)).toBe(60_000);
    expect(nextRetryAt(1_000, 1, 0)).toBe(31_000);
    expect(nextRetryAt(1_000, 100, 0)).toBe(1_000 + 30 * 60_000);
  });
});

describe("planRefundLegs: exact legs, tenders and errors", () => {
  const line = (id: string, gross: bigint) => ({ lineId: id, gross: money(gross), refundedBefore: money(0n) });
  const base = (tenders: OriginalTender[], over: Partial<Parameters<typeof planRefundLegs>[0]> = {}): Parameters<typeof planRefundLegs>[0] => ({
    userId: "u1",
    storeId: "s1",
    commissionBps: 1500n,
    vatBps: 1400n,
    lines: [line("l1", 10_000n)],
    items: [{ lineId: "l1", goods: money(10_000n) }],
    platformVoucher: money(0n),
    sellerVoucher: money(0n),
    shippingGross: money(0n),
    tenders,
    ...over,
  });
  const entry = (r: ReturnType<typeof planRefundLegs>, id: string) =>
    buildEntry({ type: "refund", refundId: id, ...r.input }, { id: "00000000-0000-4000-8000-0000000000aa", occurredAt: new Date(0) });

  it("always plans against the original tender with the shopper choice already applied", () => {
    const r = planRefundLegs(base([tender("a", "card", 10_000n)]));
    expect(r.input.choice).toBe("original");
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0]).toMatchObject({ tenderId: "a", method: "card", channel: "psp_original" });
    expect(r.routes[0]?.amount.amount).toBe(10_000n);
  });
  it("uses the default config and choice when none is given", () => {
    const r = planRefundLegs(base([tender("a", "fawry", 10_000n)]));
    expect(r.routes[0]?.channel).toBe("store_credit");
    const r2 = planRefundLegs(base([tender("a", "fawry", 10_000n)], { config: { fawry: "fawry_voucher", pspReverse: { mobile_wallet: false, instapay: false } } }));
    expect(r2.routes[0]?.channel).toBe("fawry_voucher");
  });
  it("COD refunded to bank: courier cod tender, uncollected", () => {
    const r = planRefundLegs(base([tender("a", "cod", 10_000n)], { choice: { preference: "original_method", cod: "bank_transfer" } }));
    expect(r.routes[0]?.channel).toBe("bank_transfer_iban");
    expect(r.input.tenders[0]).toEqual({ tender: { kind: "cod", courier: "bosta", amount: money(10_000n) }, refunded: money(0n), collected: false });
    const w = planRefundLegs(base([tender("a", "cod", 10_000n)], { choice: { preference: "original_method", cod: "wallet_transfer" } }));
    expect(w.routes[0]?.channel).toBe("wallet_transfer");
    expect(w.input.tenders[0]).toMatchObject({ tender: { kind: "cod", courier: "bosta" }, collected: false });
  });
  it("psp-backed cash channels use the psp tender", () => {
    const rev: RefundRouterConfig = { fawry: "fawry_voucher", pspReverse: { mobile_wallet: true, instapay: false } };
    const a = planRefundLegs(base([tender("a", "mobile_wallet", 10_000n)], { config: rev }));
    expect(a.routes[0]?.channel).toBe("psp_reverse");
    expect(a.input.tenders[0]).toEqual({ tender: { kind: "psp", psp: "paymob", amount: money(10_000n) }, refunded: money(0n) });
    const b = planRefundLegs(base([tender("a", "instapay", 10_000n)], { config: rev }));
    expect(b.routes[0]?.channel).toBe("bank_transfer_iban");
    expect(b.input.tenders[0]).toEqual({ tender: { kind: "psp", psp: "paymob", amount: money(10_000n) }, refunded: money(0n) });
    const c = planRefundLegs(base([tender("a", "fawry", 10_000n)], { config: rev }));
    expect(c.routes[0]?.channel).toBe("fawry_voucher");
    expect(c.input.tenders[0]).toMatchObject({ tender: { kind: "psp", psp: "paymob" } });
  });
  it("bnpl uses the provider; store credit keeps its sub and the original refunded amount", () => {
    const b = planRefundLegs(base([tender("a", "bnpl", 10_000n, { provider: "sympl" })]));
    expect(b.input.tenders[0]).toEqual({ tender: { kind: "bnpl", provider: "sympl", amount: money(10_000n) }, refunded: money(0n) });
    const sub = { kind: "gift_card", cardId: "gc1" } as never;
    const s = planRefundLegs(base([tender("a", "store_credit", 10_000n, { creditSub: sub })]));
    expect(s.input.tenders[0]).toMatchObject({ tender: { kind: "store_credit", userId: "u1", sub } });
    const s2 = planRefundLegs(base([tender("a", "store_credit", 10_000n)]));
    expect(s2.input.tenders[0]).toMatchObject({ tender: { kind: "store_credit", userId: "u1", sub: { kind: "refund_credit" } } });
    expect(balanceOf(chart.storeCredit("u1", { kind: "refund_credit" }), [entry(s2, "rs")]).amount).toBe(-10_000n);
  });
  it("carries refundedBefore into the ledger tender", () => {
    const r = planRefundLegs(
      base([tender("a", "card", 12_000n, { refundedBefore: money(2_000n) })], { lines: [line("l1", 10_000n)] }),
    );
    expect(r.input.tenders[0]?.refunded).toEqual(money(2_000n));
  });
  it("missing psp, provider and courier are named in the error", () => {
    const noPsp = { ...tender("a", "card", 10_000n) } as { psp?: string } & OriginalTender;
    delete noPsp.psp;
    expect(() => planRefundLegs(base([noPsp]))).toThrow("tender has no psp");
    expect(() => planRefundLegs(base([tender("a", "card", 10_000n, { psp: "" })]))).toThrow("tender has no psp");
    expect(() => planRefundLegs(base([tender("a", "bnpl", 10_000n, { provider: "" })]))).toThrow("tender has no bnpl provider");
    expect(() =>
      planRefundLegs(base([tender("a", "cod", 10_000n, { courier: "" })], { choice: { preference: "original_method", cod: "bank_transfer" } })),
    ).toThrow("tender has no courier");
  });
  it("routes only the tenders actually drawn, keyed by their own id", () => {
    const r = planRefundLegs(
      base([tender("a", "card", 6_000n), tender("b", "meeza", 4_000n)], {
        lines: [line("l1", 10_000n)],
        items: [{ lineId: "l1", goods: money(10_000n) }],
      }),
    );
    expect(r.routes.map((x) => [x.tenderId, x.method])).toEqual([
      ["a", "card"],
      ["b", "meeza"],
    ]);
    expect(r.routes.reduce((s, x) => s + x.amount.amount, 0n)).toBe(r.plan.total.amount);
  });
});
