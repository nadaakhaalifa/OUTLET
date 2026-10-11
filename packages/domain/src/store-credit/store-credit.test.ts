import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { subBalanceKey, type StoreCreditSub } from "../chart-of-accounts";
import { money } from "../money";
import {
  DAY_MS,
  GiftCardSalesDisabledError,
  addMonthsUtc,
  balancesOf,
  collectStrings,
  expiringSoon,
  expiryFor,
  giftCardSalesGate,
  labelFor,
  parseSubKey,
  planExpirySweep,
  planLotSpend,
  reconcileProjection,
  violatesWording,
  WALLET_TITLE,
  type CreditLot,
} from "./index";

const T0 = Date.UTC(2026, 0, 31, 12);
const lot = (id: string, sub: StoreCreditSub, remaining: bigint, expiresAtMs: number | null, extra: Partial<CreditLot> = {}): CreditLot => ({
  id,
  userId: "u",
  sub,
  granted: remaining,
  remaining,
  held: 0n,
  expiresAtMs,
  createdAtMs: 0,
  ...extra,
});

describe("expiry rules", () => {
  it("12 months, 6 months, 90 days, never, per card", () => {
    expect(expiryFor({ kind: "refund_credit" }, T0)).toBeNull();
    expect(expiryFor({ kind: "cashback_coins" }, T0)).toBe(Date.UTC(2027, 0, 31, 12));
    expect(expiryFor({ kind: "referral_credit" }, T0)).toBe(Date.UTC(2026, 6, 31, 12));
    expect(expiryFor({ kind: "goodwill" }, T0)).toBe(T0 + 90 * DAY_MS);
    expect(expiryFor({ kind: "gift_card", cardId: "c" }, T0, 5)).toBe(5);
    expect(() => expiryFor({ kind: "gift_card", cardId: "c" }, T0)).toThrow();
  });
  it("clamps to month end", () => {
    expect(addMonthsUtc(Date.UTC(2026, 7, 31), 6)).toBe(Date.UTC(2027, 1, 28));
  });
  it("sub keys round trip", () => {
    for (const s of [{ kind: "refund_credit" }, { kind: "gift_card", cardId: "abc" }, { kind: "goodwill" }] as StoreCreditSub[]) {
      expect(parseSubKey(subBalanceKey(s))).toEqual(s);
    }
    expect(() => parseSubKey("cash")).toThrow();
  });
});

describe("planLotSpend", () => {
  const lots = [
    lot("rc", { kind: "refund_credit" }, 1000n, null),
    lot("gc", { kind: "gift_card", cardId: "c1" }, 1000n, T0 + 400 * DAY_MS),
    lot("cb-late", { kind: "cashback_coins" }, 500n, T0 + 300 * DAY_MS),
    lot("cb-soon", { kind: "cashback_coins" }, 500n, T0 + 10 * DAY_MS),
    lot("gw", { kind: "goodwill" }, 300n, T0 + 5 * DAY_MS),
  ];
  it("soonest expiring first, refund credit last", () => {
    const plan = planLotSpend(lots, money(2200n), T0);
    expect(plan.map((p) => p.lotId)).toEqual(["gw", "cb-soon", "cb-late", "gc"]);
    expect(plan.reduce((a, p) => a + p.amount.amount, 0n)).toBe(2200n);
    expect(planLotSpend(lots, money(3300n), T0).at(-1)?.lotId).toBe("rc");
  });
  it("skips expired and held, and is short when credit is insufficient", () => {
    const l = [lot("a", { kind: "goodwill" }, 100n, T0 - 1), lot("b", { kind: "goodwill" }, 100n, T0 + 1, { held: 60n })];
    expect(planLotSpend(l, money(40n), T0)).toEqual([{ lotId: "b", sub: { kind: "goodwill" }, amount: money(40n) }]);
    expect(() => planLotSpend(l, money(41n), T0)).toThrow();
  });
  it("never spends more than available and sums exactly (property)", () => {
    const lotArb = fc.record({
      kind: fc.constantFrom("refund_credit", "cashback_coins", "referral_credit", "goodwill"),
      rem: fc.bigInt({ min: 1n, max: 10_000n }),
      held: fc.bigInt({ min: 0n, max: 100n }),
      exp: fc.option(fc.integer({ min: -5, max: 400 }), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(lotArb, { minLength: 1, maxLength: 8 }), fc.bigInt({ min: 1n, max: 20_000n }), (xs, want) => {
        const all = xs.map((x, i) =>
          lot(`l${i}`, { kind: x.kind }, x.rem, x.exp === null ? null : T0 + x.exp * DAY_MS, { held: x.held > x.rem ? x.rem : x.held }),
        );
        const avail = all.reduce((a, l) => a + (l.expiresAtMs !== null && l.expiresAtMs <= T0 ? 0n : l.remaining - l.held), 0n);
        if (want > avail) {
          expect(() => planLotSpend(all, money(want), T0)).toThrow();
          return;
        }
        const plan = planLotSpend(all, money(want), T0);
        expect(plan.reduce((a, p) => a + p.amount.amount, 0n)).toBe(want);
        for (const p of plan) {
          const l = all.find((x) => x.id === p.lotId);
          expect(p.amount.amount <= (l ? l.remaining - l.held : 0n)).toBe(true);
          expect(p.amount.amount).toBeGreaterThan(0n);
        }
        expect(planLotSpend(all, money(want), T0)).toEqual(plan);
      }),
      { numRuns: 300 },
    );
  });
});

describe("views, sweep and reconciliation", () => {
  const lots = [
    lot("a", { kind: "cashback_coins" }, 100n, T0 + 5 * DAY_MS),
    lot("b", { kind: "cashback_coins" }, 50n, T0 - DAY_MS),
    lot("c", { kind: "gift_card", cardId: "x" }, 70n, T0 - DAY_MS),
    lot("d", { kind: "refund_credit" }, 10n, null, { held: 4n }),
  ];
  it("balances exclude expired lots and split held", () => {
    const v = balancesOf(lots, T0);
    expect(v.map((x) => [subBalanceKey(x.sub), x.available, x.held])).toEqual([
      ["cashback_coins", 100n, 0n],
      ["refund_credit", 6n, 4n],
    ]);
  });
  it("expiring soon is windowed and sorted", () => {
    expect(expiringSoon(lots, T0, 7 * DAY_MS).map((e) => e.lotId)).toEqual(["a"]);
    expect(expiringSoon(lots, T0, DAY_MS)).toEqual([]);
  });
  it("sweeps only expired platform credit, never gift cards or refund credit", () => {
    expect(planExpirySweep(lots, T0).map((l) => l.id)).toEqual(["b"]);
    const after = lots.map((l) => (l.id === "b" ? { ...l, remaining: 0n } : l));
    expect(planExpirySweep(after, T0)).toEqual([]);
  });
  it("reconciles projection against the ledger, tolerating captured-unposted", () => {
    const l = [lot("a", { kind: "goodwill" }, 100n, null)];
    expect(reconcileProjection({ lots: l, ledgerBySub: new Map([["goodwill", 100n]]), capturedUnposted: new Map() })).toEqual([]);
    expect(
      reconcileProjection({ lots: l, ledgerBySub: new Map([["goodwill", 130n]]), capturedUnposted: new Map([["goodwill", 30n]]) }),
    ).toEqual([]);
    expect(reconcileProjection({ lots: l, ledgerBySub: new Map([["goodwill", 90n]]), capturedUnposted: new Map() })).toEqual([
      { subKey: "goodwill", projection: 100n, ledger: 90n, drift: 10n },
    ]);
  });
});

describe("wording and kill switch", () => {
  it("no label or title says cash or money", () => {
    const subs: StoreCreditSub[] = [{ kind: "refund_credit" }, { kind: "gift_card", cardId: "c" }, { kind: "cashback_coins" }, { kind: "referral_credit" }, { kind: "goodwill" }];
    for (const s of subs) for (const t of collectStrings(labelFor(s))) expect(violatesWording(t)).toBe(false);
    for (const t of collectStrings(WALLET_TITLE)) expect(violatesWording(t)).toBe(false);
    expect(violatesWording("Withdraw cash")).toBe(true);
    expect(violatesWording("حوّل فلوسك")).toBe(true);
  });
  it("gift card sales are off unless explicitly enabled", () => {
    expect(giftCardSalesGate(undefined).enabled()).toBe(false);
    expect(() => giftCardSalesGate(undefined).assertEnabled()).toThrow(GiftCardSalesDisabledError);
    expect(() => giftCardSalesGate(true).assertEnabled()).not.toThrow();
  });
});
