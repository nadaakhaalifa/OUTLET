// Targeted tests for store-credit lots, expiry rules, spend order and the sales gate. Written to kill
// Stryker survivors (ADR-0019). Ordering is asserted with exact lists, boundaries with exact milliseconds.
import { describe, expect, it } from "vitest";
import { planStoreCreditSpend, type StoreCreditSub } from "../chart-of-accounts";
import { InsufficientCreditError, InvalidChartInputError } from "../chart-of-accounts/errors";
import { money } from "../money";
import {
  DAY_MS,
  EXPIRING_PLATFORM_KINDS,
  SUB_RULES,
  addMonthsUtc,
  availableOf,
  balancesOf,
  expiringSoon,
  expiryFor,
  giftCardSalesGate,
  isExpired,
  parseSubKey,
  planExpirySweep,
  planLotSpend,
  reconcileProjection,
  type CreditLot,
} from "./index";

const NOW = 1_000_000;
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
const GOOD: StoreCreditSub = { kind: "goodwill" };
const CASH: StoreCreditSub = { kind: "cashback_coins" };
const REF: StoreCreditSub = { kind: "referral_credit" };
const RC: StoreCreditSub = { kind: "refund_credit" };
const gc = (id: string): StoreCreditSub => ({ kind: "gift_card", cardId: id });

describe("gate", () => {
  it("is off unless exactly true and says so", () => {
    expect(giftCardSalesGate(true).enabled()).toBe(true);
    expect(giftCardSalesGate(false).enabled()).toBe(false);
    expect(giftCardSalesGate(undefined).enabled()).toBe(false);
    expect(() => giftCardSalesGate(undefined).assertEnabled()).toThrow("gift card sales are switched off");
    expect(() => giftCardSalesGate(true).assertEnabled()).not.toThrow();
  });
});

describe("rules", () => {
  it("rule table is exact", () => {
    expect(SUB_RULES).toEqual({
      refund_credit: { kind: "refund_credit", expiryMonths: null, expiryDays: null, perCardExpiry: false },
      gift_card: { kind: "gift_card", expiryMonths: null, expiryDays: null, perCardExpiry: true },
      cashback_coins: { kind: "cashback_coins", expiryMonths: 12, expiryDays: null, perCardExpiry: false },
      referral_credit: { kind: "referral_credit", expiryMonths: 6, expiryDays: null, perCardExpiry: false },
      goodwill: { kind: "goodwill", expiryMonths: null, expiryDays: 90, perCardExpiry: false },
    });
    expect([...EXPIRING_PLATFORM_KINDS]).toEqual(["cashback_coins", "referral_credit", "goodwill"]);
  });
  it("gift card lot needs the card expiry (undefined and null), and returns it verbatim", () => {
    expect(() => expiryFor(gc("c"), 0)).toThrow("a gift card lot needs the card's expiry");
    expect(() => expiryFor(gc("c"), 0, null)).toThrow("a gift card lot needs the card's expiry");
    expect(expiryFor(gc("c"), 0, 0)).toBe(0);
    expect(expiryFor(gc("c"), 123, 456)).toBe(456);
  });
  it("platform kinds ignore a card expiry", () => {
    expect(expiryFor(GOOD, 0, 5)).toBe(90 * DAY_MS);
    expect(expiryFor(RC, 7, 5)).toBeNull();
  });
  it("addMonthsUtc keeps time of day and rolls the year", () => {
    const t = Date.UTC(2026, 10, 15, 13, 14, 15, 16);
    expect(addMonthsUtc(t, 3)).toBe(Date.UTC(2027, 1, 15, 13, 14, 15, 16));
    expect(addMonthsUtc(Date.UTC(2024, 0, 31), 1)).toBe(Date.UTC(2024, 1, 29));
    expect(addMonthsUtc(Date.UTC(2026, 0, 30), 1)).toBe(Date.UTC(2026, 1, 28));
    expect(addMonthsUtc(Date.UTC(2026, 0, 31), 0)).toBe(Date.UTC(2026, 0, 31));
  });
  it("parseSubKey: every kind, gift card ids, and messages", () => {
    expect(parseSubKey("refund_credit")).toEqual(RC);
    expect(parseSubKey("cashback_coins")).toEqual(CASH);
    expect(parseSubKey("referral_credit")).toEqual(REF);
    expect(parseSubKey("goodwill")).toEqual(GOOD);
    expect(parseSubKey("gift_card:abc:def")).toEqual({ kind: "gift_card", cardId: "abc:def" });
    expect(() => parseSubKey("gift_card:")).toThrow("gift card sub-balance needs a card id");
    expect(() => parseSubKey("gift_card")).toThrow('unknown sub-balance "gift_card"');
    expect(() => parseSubKey("nope")).toThrow('unknown sub-balance "nope"');
  });
});

describe("availableOf / isExpired", () => {
  it("expiry is inclusive of the expiry instant", () => {
    expect(isExpired(lot("a", GOOD, 5n, NOW), NOW)).toBe(true);
    expect(isExpired(lot("a", GOOD, 5n, NOW + 1), NOW)).toBe(false);
    expect(isExpired(lot("a", GOOD, 5n, null), NOW)).toBe(false);
    expect(availableOf(lot("a", GOOD, 5n, NOW), NOW)).toBe(0n);
  });
  it("available is remaining minus held, floored at zero", () => {
    expect(availableOf(lot("a", GOOD, 10n, null, { held: 3n }), NOW)).toBe(7n);
    expect(availableOf(lot("a", GOOD, 10n, null, { held: 10n }), NOW)).toBe(0n);
    expect(availableOf(lot("a", GOOD, 10n, null, { held: 12n }), NOW)).toBe(0n);
    expect(availableOf(lot("a", GOOD, 10n, null), NOW)).toBe(10n);
  });
});

describe("planLotSpend order", () => {
  it("sub order: expiring soonest, then non-expiring platform/gift, then refund credit last", () => {
    const lots = [
      lot("rc", RC, 100n, null),
      lot("never", { kind: "gift_card", cardId: "z" }, 100n, null),
      lot("late", CASH, 100n, NOW + 9 * DAY_MS),
      lot("soon", GOOD, 100n, NOW + 2 * DAY_MS),
    ];
    const takes = planLotSpend(lots, money(350n), NOW);
    expect(takes.map((t) => [t.lotId, t.amount.amount])).toEqual([
      ["soon", 100n],
      ["late", 100n],
      ["never", 100n],
      ["rc", 50n],
    ]);
    expect(takes.map((t) => t.sub.kind)).toEqual(["goodwill", "cashback_coins", "gift_card", "refund_credit"]);
  });
  it("within a sub: expiry, then createdAt, then id; null expiry last", () => {
    const lots = [
      lot("z-null", GOOD, 10n, null, { createdAtMs: 1 }),
      lot("b", GOOD, 10n, NOW + 5, { createdAtMs: 9 }),
      lot("a2", GOOD, 10n, NOW + 5, { createdAtMs: 3 }),
      lot("a1", GOOD, 10n, NOW + 5, { createdAtMs: 3 }),
      lot("early", GOOD, 10n, NOW + 1, { createdAtMs: 99 }),
    ];
    const takes = planLotSpend(lots, money(50n), NOW);
    expect(takes.map((t) => t.lotId)).toEqual(["early", "a1", "a2", "b", "z-null"]);
  });
  it("a fully held or expired lot neither joins the plan nor skews the sub's expiry", () => {
    const lots = [
      // GOOD has a fully held lot that would expire first if it were counted
      lot("held", GOOD, 100n, NOW + 1 * DAY_MS, { held: 100n }),
      lot("g", GOOD, 100n, NOW + 10 * DAY_MS),
      lot("c", CASH, 100n, NOW + 5 * DAY_MS),
      lot("dead", REF, 100n, NOW - 1),
    ];
    const takes = planLotSpend(lots, money(150n), NOW);
    expect(takes.map((t) => [t.lotId, t.amount.amount])).toEqual([
      ["c", 100n],
      ["g", 50n],
    ]);
  });
  it("earliest expiry, not latest, ranks the sub; non-expiring lots in an expiring sub do not count", () => {
    const lots = [
      lot("a-null", GOOD, 100n, null),
      lot("a-soon", GOOD, 100n, NOW + 1 * DAY_MS),
      lot("a-late", GOOD, 100n, NOW + 30 * DAY_MS),
      lot("b", CASH, 100n, NOW + 10 * DAY_MS),
    ];
    const takes = planLotSpend(lots, money(100n), NOW);
    expect(takes.map((t) => t.lotId)).toEqual(["a-soon"]);
    const none = planLotSpend([lot("n", GOOD, 100n, null), lot("b", CASH, 100n, NOW + 10 * DAY_MS)], money(50n), NOW);
    expect(none.map((t) => t.lotId)).toEqual(["b"]);
  });
  it("never emits zero takes and stops when the amount is met", () => {
    const takes = planLotSpend([lot("a", GOOD, 40n, NOW + 5), lot("b", GOOD, 40n, NOW + 6), lot("c", GOOD, 40n, NOW + 7)], money(40n), NOW);
    expect(takes.map((t) => [t.lotId, t.amount.amount])).toEqual([["a", 40n]]);
    const partial = planLotSpend([lot("a", GOOD, 40n, NOW + 5, { held: 15n }), lot("b", GOOD, 40n, NOW + 6)], money(30n), NOW);
    expect(partial.map((t) => [t.lotId, t.amount.amount])).toEqual([
      ["a", 25n],
      ["b", 5n],
    ]);
  });
  it("throws when the credit is insufficient (held credit is not spendable)", () => {
    expect(() => planLotSpend([lot("a", GOOD, 40n, null, { held: 40n })], money(1n), NOW)).toThrow(InsufficientCreditError);
    expect(() => planLotSpend([lot("a", GOOD, 40n, null)], money(0n), NOW)).toThrow(InvalidChartInputError);
  });
});

describe("planStoreCreditSpend ordering and guards", () => {
  const st = (sub: StoreCreditSub, bal: bigint, exp: Date | null) => ({ sub, balance: money(bal), expiresAt: exp });
  it("orders by rank, then expiry, then key; skips empty balances", () => {
    const d = (n: number) => new Date(NOW + n);
    const plan = planStoreCreditSpend(
      [st(RC, 10n, null), st(gc("b"), 10n, null), st(gc("a"), 10n, null), st(CASH, 10n, d(5)), st(GOOD, 10n, d(1)), st(REF, 0n, d(0))],
      money(50n),
    );
    expect(plan.map((p) => [p.sub.kind, p.sub.kind === "gift_card" ? p.sub.cardId : "", p.amount.amount])).toEqual([
      ["goodwill", "", 10n],
      ["cashback_coins", "", 10n],
      ["gift_card", "a", 10n],
      ["gift_card", "b", 10n],
      ["refund_credit", "", 10n],
    ]);
  });
  it("breaks equal-expiry ties by key and is partial on the last sub", () => {
    const e = new Date(NOW);
    const plan = planStoreCreditSpend([st(REF, 10n, e), st(CASH, 10n, e)], money(15n));
    expect(plan.map((p) => [p.sub.kind, p.amount.amount])).toEqual([
      ["cashback_coins", 10n],
      ["referral_credit", 5n],
    ]);
  });
  it("a sub with a null expiry never outranks a dated one, even when it sorts first by key", () => {
    const plan = planStoreCreditSpend([st(CASH, 10n, null), st(GOOD, 10n, new Date(NOW))], money(10n));
    expect(plan.map((p) => p.sub.kind)).toEqual(["goodwill"]);
  });
  it("exact cover consumes every sub and errors on any shortfall with the number", () => {
    expect(planStoreCreditSpend([st(GOOD, 10n, null)], money(10n))).toHaveLength(1);
    expect(() => planStoreCreditSpend([st(GOOD, 10n, null)], money(11n))).toThrow("short by 1 piastres of store credit");
    expect(() => planStoreCreditSpend([st(GOOD, 10n, null)], money(0n))).toThrow("spend amount must be positive");
    expect(() => planStoreCreditSpend([st(GOOD, 10n, null)], money(-1n))).toThrow("spend amount must be positive");
  });
});

describe("balancesOf", () => {
  it("aggregates per sub, sorted by key, with earliest expiry and held totals", () => {
    const lots = [
      lot("g2", GOOD, 30n, NOW + 9, { held: 5n }),
      lot("c1", CASH, 20n, NOW + 4),
      lot("g1", GOOD, 10n, NOW + 3),
      lot("gn", GOOD, 7n, null),
      lot("r", RC, 1n, null),
      lot("zero", GOOD, 0n, NOW + 1),
      lot("dead", GOOD, 99n, NOW),
    ];
    const b = balancesOf(lots, NOW);
    expect(b.map((x) => x.sub.kind)).toEqual(["cashback_coins", "goodwill", "refund_credit"]);
    expect(b[0]).toMatchObject({ available: 20n, held: 0n, nextExpiryMs: NOW + 4 });
    expect(b[1]).toMatchObject({ available: 25n + 10n + 7n, held: 5n, nextExpiryMs: NOW + 3 });
    expect(b[2]).toMatchObject({ available: 1n, held: 0n, nextExpiryMs: null });
  });
  it("sorts gift cards by key and keeps the later of two sequentially larger expiries", () => {
    const b = balancesOf([lot("b", gc("b"), 1n, NOW + 2), lot("a", gc("a"), 1n, NOW + 5), lot("a2", gc("a"), 1n, NOW + 9)], NOW);
    expect(b.map((x) => (x.sub.kind === "gift_card" ? x.sub.cardId : "?"))).toEqual(["a", "b"]);
    expect(b[0]?.nextExpiryMs).toBe(NOW + 5);
    const rev = balancesOf([lot("a2", gc("a"), 1n, NOW + 9), lot("a", gc("a"), 1n, NOW + 5)], NOW);
    expect(rev[0]?.nextExpiryMs).toBe(NOW + 5);
    const nullFirst = balancesOf([lot("n", gc("a"), 1n, null), lot("a", gc("a"), 1n, NOW + 5)], NOW);
    expect(nullFirst[0]?.nextExpiryMs).toBe(NOW + 5);
    const nullLast = balancesOf([lot("a", gc("a"), 1n, NOW + 5), lot("n", gc("a"), 1n, null)], NOW);
    expect(nullLast[0]?.nextExpiryMs).toBe(NOW + 5);
  });
  it("a held-only lot still shows its held amount", () => {
    const b = balancesOf([lot("a", GOOD, 10n, null, { held: 10n })], NOW);
    expect(b[0]).toMatchObject({ available: 0n, held: 10n });
  });
});

describe("expiringSoon", () => {
  it("window is inclusive, expired and empty lots are excluded, sorted by expiry then id", () => {
    const W = 1000;
    const lots = [
      lot("z", GOOD, 3n, NOW + 10),
      lot("a", CASH, 2n, NOW + 10),
      lot("edge", GOOD, 4n, NOW + W),
      lot("out", GOOD, 5n, NOW + W + 1),
      lot("dead", GOOD, 6n, NOW),
      lot("never", GOOD, 7n, null),
      lot("empty", GOOD, 0n, NOW + 5),
      lot("first", REF, 1n, NOW + 1),
    ];
    const r = expiringSoon(lots, NOW, W);
    expect(r.map((x) => x.lotId)).toEqual(["first", "a", "z", "edge"]);
    expect(r[0]).toMatchObject({ amount: money(1n), expiresAtMs: NOW + 1, sub: REF });
  });
  it("uses remaining, not available, for the amount", () => {
    const r = expiringSoon([lot("a", GOOD, 9n, NOW + 5, { held: 4n })], NOW, 10);
    expect(r[0]?.amount.amount).toBe(9n);
  });
});

describe("planExpirySweep", () => {
  it("only expired, unheld, positive platform lots, ordered by expiry then id", () => {
    const lots = [
      lot("b", GOOD, 1n, NOW - 5),
      lot("a", CASH, 1n, NOW - 5),
      lot("old", REF, 1n, NOW - 50),
      lot("held", GOOD, 1n, NOW - 9, { held: 1n }),
      lot("zero", GOOD, 0n, NOW - 9),
      lot("live", GOOD, 1n, NOW + 1),
      lot("rc", RC, 1n, NOW - 9),
      lot("card", gc("x"), 1n, NOW - 9),
      lot("never", GOOD, 1n, null),
      lot("exact", GOOD, 1n, NOW),
    ];
    expect(planExpirySweep(lots, NOW).map((l) => l.id)).toEqual(["old", "a", "b", "exact"]);
  });
});

describe("reconcileProjection", () => {
  it("adds captured-but-unposted, reports only drift, in key order, with signed drift", () => {
    const lots = [lot("a", GOOD, 10n, null), lot("b", GOOD, 5n, null), lot("c", CASH, 7n, null), lot("d", RC, 4n, null)];
    const r = reconcileProjection({
      lots,
      ledgerBySub: new Map([
        ["goodwill", 15n],
        ["cashback_coins", 10n],
        ["refund_credit", 1n],
        ["referral_credit", 3n],
      ]),
      capturedUnposted: new Map([["refund_credit", 3n]]),
    });
    expect(r).toEqual([
      { subKey: "cashback_coins", projection: 7n, ledger: 10n, drift: -3n },
      { subKey: "referral_credit", projection: 0n, ledger: 3n, drift: -3n },
      { subKey: "refund_credit", projection: 7n, ledger: 1n, drift: 6n },
    ]);
  });
  it("a key only in captured-unposted counts", () => {
    const r = reconcileProjection({ lots: [], ledgerBySub: new Map(), capturedUnposted: new Map([["goodwill", 2n]]) });
    expect(r).toEqual([{ subKey: "goodwill", projection: 2n, ledger: 0n, drift: 2n }]);
  });
});
