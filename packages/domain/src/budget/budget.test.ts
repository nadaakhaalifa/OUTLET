import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  breakdown,
  cairoLocalDate,
  computeRemaining,
  cycleFor,
  cycleTotals,
  effectiveCommitments,
  evaluateCap,
  installmentsDue,
  nextCycle,
  paydayIn,
  planPurchases,
  previousCycle,
  priceCeiling,
  unlockAt,
  validateBudget,
  type Commitment,
  type Cycle,
  type PlanItem,
  type SpendEvent,
} from "./index";

const at = (iso: string): number => Date.parse(iso);
const DAY = 86_400_000;

describe("cycleFor", () => {
  it("payday 31 in a 30-day month: the cycle ends on the 30th (the last day)", () => {
    const c = cycleFor(31, at("2026-04-15T10:00:00Z"));
    expect(c.startDate).toBe("2026-03-31");
    expect(c.endDate).toBe("2026-04-30");
  });
  it("payday 31 in February uses the 28th (or 29th in a leap year)", () => {
    expect(cycleFor(31, at("2026-02-10T10:00:00Z")).endDate).toBe("2026-02-28");
    expect(cycleFor(31, at("2028-02-10T10:00:00Z")).endDate).toBe("2028-02-29");
    expect(paydayIn(2026, 2, 30).day).toBe(28);
  });
  it("the payday itself starts the new cycle", () => {
    const c = cycleFor(25, at("2026-06-25T00:30:00+03:00"));
    expect(c.startDate).toBe("2026-06-25");
    expect(c.endDate).toBe("2026-07-25");
  });
  it("is stable across the year end", () => {
    const c = cycleFor(25, at("2026-01-10T10:00:00Z"));
    expect(c.startDate).toBe("2025-12-25");
    expect(c.endDate).toBe("2026-01-25");
  });
  it("uses Cairo midnight, including across a DST change", () => {
    // Cairo is UTC+2 in winter and UTC+3 in summer: boundaries differ by one hour in UTC.
    const winter = cycleFor(10, at("2026-01-20T12:00:00Z"));
    const summer = cycleFor(10, at("2026-07-20T12:00:00Z"));
    expect(winter.startMs).toBe(at("2026-01-09T22:00:00Z"));
    expect(summer.startMs).toBe(at("2026-07-09T21:00:00Z"));
  });
  it("rejects an invalid payday", () => {
    expect(() => cycleFor(0, 0)).toThrow(RangeError);
    expect(() => cycleFor(32, 0)).toThrow(RangeError);
    expect(() => cycleFor(1.5, 0)).toThrow(RangeError);
  });

  it("property: contains now, and consecutive cycles tile time without gaps", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 31 }), fc.integer({ min: at("2024-01-01T00:00:00Z"), max: at("2030-12-31T00:00:00Z") }), (payday, now) => {
        const c = cycleFor(payday, now);
        expect(c.startMs).toBeLessThanOrEqual(now);
        expect(now).toBeLessThan(c.endMs);
        expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(27 * DAY - 2 * 3_600_000);
        expect(c.endMs - c.startMs).toBeLessThanOrEqual(31 * DAY + 2 * 3_600_000);
        const n = nextCycle(payday, c);
        expect(n.startMs).toBe(c.endMs);
        expect(previousCycle(payday, n).startMs).toBe(c.startMs);
        expect(cairoLocalDate(c.startMs).day).toBe(Math.min(payday, new Date(Date.UTC(cairoLocalDate(c.startMs).year, cairoLocalDate(c.startMs).month, 0)).getUTCDate()));
      }),
      { numRuns: 300 },
    );
  });
});

describe("computeRemaining", () => {
  it("subtracts spend, installments and (optionally) the bag", () => {
    const r = computeRemaining({ budget: 5000_00n, spent: 1200_00n, bagTotal: 800_00n, includeBag: true, installmentsDue: 620_00n });
    expect(r.remaining).toBe(2380_00n);
    expect(computeRemaining({ budget: 5000_00n, spent: 1200_00n, bagTotal: 800_00n, includeBag: false, installmentsDue: 0n }).remaining).toBe(3800_00n);
  });
  it("clamps display and reports over by", () => {
    const r = computeRemaining({ budget: 1000n, spent: 1500n, bagTotal: 0n, includeBag: false, installmentsDue: 0n });
    expect(r.remaining).toBe(-500n);
    expect(r.remainingDisplay).toBe(0n);
    expect(r.overBy).toBe(500n);
    expect(priceCeiling(r).ceiling).toBe(0n);
    expect(priceCeiling(null).ceiling).toBeNull();
  });
  it("property: remaining + spent + bag + installments = budget; display and overBy are complementary", () => {
    const n = fc.bigInt({ min: 0n, max: 10_000_000n });
    fc.assert(
      fc.property(n, n, n, n, fc.boolean(), (budget, spent, bag, inst, includeBag) => {
        const r = computeRemaining({ budget, spent, bagTotal: bag, includeBag, installmentsDue: inst });
        expect(r.remaining + r.spent + r.bag + r.installments).toBe(budget);
        expect(r.remainingDisplay - r.overBy).toBe(r.remaining);
        expect(r.remainingDisplay * r.overBy).toBe(0n);
      }),
    );
  });
});

const cycle: Cycle = cycleFor(25, at("2026-06-28T10:00:00Z"));
const prev: Cycle = previousCycle(25, cycle);
const ev = (key: string, kind: SpendEvent["kind"], amount: bigint, placed: number, occurred: number, over: Partial<SpendEvent> = {}): SpendEvent => ({
  key,
  kind,
  amount,
  orderPlacedAtMs: placed,
  occurredAtMs: occurred,
  lines: [],
  verifiedSavings: 0n,
  plusSavings: 0n,
  ...over,
});
const inCur = cycle.startMs + 3 * DAY;
const inPrev = prev.startMs + 3 * DAY;

describe("cycleTotals", () => {
  it("counts COD at placement and reverses it on refusal", () => {
    const events = [ev("o1", "placed", 900n, inCur, inCur), ev("o1:r", "cod_refusal", 900n, inCur, inCur + DAY)];
    const t = cycleTotals(events, cycle);
    expect(t.placed).toBe(900n);
    expect(t.spentNow).toBe(0n);
    expect(t.netSpentReport).toBe(0n);
  });
  it("a refund in the next cycle credits the original cycle in reports and lifts available now", () => {
    const events = [ev("o1", "placed", 1000n, inPrev, inPrev), ev("o2", "placed", 400n, inCur, inCur), ev("o1:r", "refund", 700n, inPrev, inCur + DAY)];
    const original = cycleTotals(events, prev);
    expect(original.netSpentReport).toBe(300n);
    const current = cycleTotals(events, cycle);
    expect(current.netSpentReport).toBe(400n); // report for the current cycle is untouched
    expect(current.spentNow).toBe(0n); // 400 spent - 700 refunded received, clamped
    const without = cycleTotals(events.slice(0, 2), cycle);
    expect(without.spentNow).toBe(400n);
  });
  it("collects verified savings only from placements in the cycle", () => {
    const t = cycleTotals([ev("a", "placed", 10n, inCur, inCur, { verifiedSavings: 5n, plusSavings: 2n }), ev("b", "placed", 10n, inPrev, inPrev, { verifiedSavings: 99n })], cycle);
    expect(t.verifiedSavings).toBe(5n);
    expect(t.plusSavings).toBe(2n);
  });
  it("property: net report never exceeds gross placed and never goes negative", () => {
    const e = fc.record({
      kind: fc.constantFrom("placed", "refund", "cod_refusal" as const),
      amount: fc.bigInt({ min: 1n, max: 100_000n }),
      placed: fc.integer({ min: prev.startMs, max: cycle.endMs - 1 }),
      occurred: fc.integer({ min: prev.startMs, max: cycle.endMs - 1 }),
    });
    fc.assert(
      fc.property(fc.array(e, { maxLength: 30 }), (rows) => {
        const events = rows.map((r, i) => ev(`k${i}`, r.kind, r.amount, r.placed, r.occurred));
        for (const c of [prev, cycle]) {
          const t = cycleTotals(events, c);
          expect(t.netSpentReport).toBeGreaterThanOrEqual(0n);
          expect(t.netSpentReport).toBeLessThanOrEqual(t.placed);
          expect(t.spentNow).toBeGreaterThanOrEqual(0n);
          expect(t.spentNow).toBeLessThanOrEqual(t.placed);
        }
      }),
    );
  });
  it("breakdown nets refunds by category and store", () => {
    const lines = [
      { storeId: "s1", categoryId: "dress", amount: 600n },
      { storeId: "s2", categoryId: "shoes", amount: 400n },
    ];
    const b = breakdown([ev("o", "placed", 1000n, inCur, inCur, { lines }), ev("r", "refund", 400n, inCur, inCur, { lines: [{ storeId: "s2", categoryId: "shoes", amount: 400n }] })], cycle);
    expect(b.byCategory).toEqual([{ id: "dress", amount: 600n }]);
    expect(b.topStores).toEqual([{ id: "s1", amount: 600n }]);
  });
});

describe("installments", () => {
  const c = (provider: string, monthly: bigint, source: Commitment["source"], s = cycle.startMs - DAY, e = cycle.endMs + DAY): Commitment => ({
    provider,
    monthly,
    source,
    startsAtMs: s,
    endsAtMs: e,
  });
  it("provider data wins over a user entry for the same provider", () => {
    const list = [c("valU", 620n, "user"), c("valu", 640n, "provider"), c("Sympl", 100n, "user")];
    expect(effectiveCommitments(list).map((x) => x.monthly)).toEqual([640n, 100n]);
    expect(installmentsDue(list, cycle)).toBe(740n);
  });
  it("only commitments active in the cycle are due", () => {
    expect(installmentsDue([c("a", 10n, "user", cycle.endMs + 1, cycle.endMs + DAY), c("b", 5n, "user", 0, cycle.startMs - 1)], cycle)).toBe(0n);
  });
});

describe("planPurchases", () => {
  const cycles = [0, 1, 2].map((i) => ({ index: i, startMs: i * 100, endMs: i * 100 + 100, capacity: 1000n }));
  const it_ = (id: string, priority: PlanItem["priority"], price: bigint, dueAtMs: number | null = null): PlanItem => ({ id, priority, price, dueAtMs });
  it("orders Need > dated > Want > Treat, first fit", () => {
    const p = planPurchases([it_("treat", "treat", 600n), it_("want", "want", 600n), it_("dated", "dated", 600n, 50), it_("need", "need", 600n)], cycles);
    const idx = Object.fromEntries(p.planned.map((x) => [x.id, x.cycleIndex]));
    expect(idx).toEqual({ need: 0, dated: 1, want: 2 });
    expect(p.unplanned).toEqual([{ id: "treat", reason: "no_capacity" }]);
  });
  it("flags missed dates, deferred items and oversize items", () => {
    const p = planPurchases([it_("a", "need", 900n), it_("b", "dated", 900n, 5), it_("big", "want", 5000n)], cycles);
    expect(p.planned.find((x) => x.id === "b")).toMatchObject({ cycleIndex: 1, missesDate: true, watchPriceDrop: true });
    expect(p.planned.find((x) => x.id === "a")?.watchPriceDrop).toBe(false);
    expect(p.unplanned).toEqual([{ id: "big", reason: "exceeds_every_cycle" }]);
  });
  it("property: capacity is respected, each item at most once, higher priority is never later than a same-size lower one", () => {
    const item = fc.record({
      id: fc.uuid(),
      priority: fc.constantFrom("need", "dated", "want", "treat" as const),
      price: fc.bigInt({ min: 1n, max: 1500n }),
      dueAtMs: fc.option(fc.integer({ min: 0, max: 400 }), { nil: null }),
    });
    fc.assert(
      fc.property(fc.uniqueArray(item, { selector: (x) => x.id, maxLength: 25 }), fc.array(fc.bigInt({ min: -50n, max: 2000n }), { minLength: 1, maxLength: 6 }), (items, caps) => {
        const cs = caps.map((capacity, i) => ({ index: i, startMs: i * 100, endMs: i * 100 + 100, capacity }));
        const p = planPurchases(items, cs);
        const ids = [...p.planned.map((x) => x.id), ...p.unplanned.map((x) => x.id)];
        expect(new Set(ids).size).toBe(items.length);
        expect(ids.length).toBe(items.length);
        p.usedByCycle.forEach((u, i) => expect(u).toBeLessThanOrEqual((caps[i] ?? 0n) < 0n ? 0n : (caps[i] ?? 0n)));
        const rank = { need: 0, dated: 1, want: 2, treat: 3 } as const;
        for (const a of p.planned) {
          for (const b of p.planned) {
            if (rank[a.priority] < rank[b.priority] && a.price === b.price) expect(a.cycleIndex).toBeLessThanOrEqual(b.cycleIndex);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
  it("is deterministic regardless of input order", () => {
    const items = [it_("a", "want", 300n), it_("b", "want", 300n), it_("c", "need", 800n)];
    expect(planPurchases(items, cycles)).toEqual(planPurchases([...items].reverse(), cycles));
  });
});

describe("evaluateCap", () => {
  const base = { remaining: 1000n, orderTotal: 1500n, nowMs: cycle.startMs + 5 * DAY, cycle, softHeldSinceMs: null, holdUntilMs: null } as const;
  it("off and within budget allow", () => {
    expect(evaluateCap({ ...base, capMode: "off" })).toEqual({ kind: "allow", reason: "cap_off" });
    expect(evaluateCap({ ...base, capMode: "hard", orderTotal: 1000n })).toEqual({ kind: "allow", reason: "within_budget" });
  });
  it("soft needs a 10 second hold the server can verify", () => {
    expect(evaluateCap({ ...base, capMode: "soft" })).toEqual({ kind: "soft_hold", holdSeconds: 10, overBy: 500n });
    expect(evaluateCap({ ...base, capMode: "soft", softHeldSinceMs: base.nowMs - 9_999 }).kind).toBe("soft_hold");
    expect(evaluateCap({ ...base, capMode: "soft", softHeldSinceMs: base.nowMs - 10_000 }).kind).toBe("allow");
    expect(evaluateCap({ ...base, capMode: "soft", softHeldSinceMs: base.nowMs + 1000 }).kind).toBe("soft_hold");
    expect(evaluateCap({ ...base, capMode: "soft", softHeldSinceMs: base.nowMs - 11 * 60_000 }).kind).toBe("soft_hold");
  });
  it("hard blocks until payday; a matured unlock lifts it only inside its cycle", () => {
    expect(evaluateCap({ ...base, capMode: "hard" })).toMatchObject({ kind: "blocked", unlockAtMs: null, cycleEndMs: cycle.endMs });
    const requested = base.nowMs;
    expect(evaluateCap({ ...base, capMode: "hard", holdUntilMs: unlockAt(requested), nowMs: requested + 1000 })).toMatchObject({ kind: "blocked", unlockAtMs: unlockAt(requested) });
    expect(evaluateCap({ ...base, capMode: "hard", holdUntilMs: unlockAt(requested), nowMs: unlockAt(requested) })).toEqual({ kind: "allow", reason: "hard_unlocked" });
    const nextCyc = nextCycle(25, cycle);
    expect(evaluateCap({ ...base, capMode: "hard", holdUntilMs: unlockAt(requested), nowMs: nextCyc.startMs + DAY, cycle: nextCyc }).kind).toBe("blocked");
  });
  it("property: hard cap never allows an over-budget order without a matured unlock in this cycle", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -100n, max: 5000n }), fc.bigInt({ min: 1n, max: 6000n }), fc.option(fc.integer({ min: cycle.startMs - 3 * DAY, max: cycle.endMs + DAY }), { nil: null }), (remaining, total, hold) => {
        const d = evaluateCap({ ...base, capMode: "hard", remaining, orderTotal: total, holdUntilMs: hold });
        if (total > remaining && d.kind === "allow") {
          expect(hold).not.toBeNull();
          expect(hold as number).toBeLessThanOrEqual(base.nowMs);
          expect(hold as number).toBeGreaterThanOrEqual(cycle.startMs);
        }
      }),
    );
  });
});

describe("validateBudget", () => {
  it("accepts a valid budget and rejects bad ones", () => {
    expect(validateBudget({ amount: 100_000n, payday: 31, capMode: "hard", perCategory: { dresses: 40_000n } }).ok).toBe(true);
    const bad = validateBudget({ amount: 0n, payday: 0, capMode: "x", perCategory: { "": 1n } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.field).sort()).toEqual(["amount", "cap_mode", "payday", "per_category."]);
  });
});
