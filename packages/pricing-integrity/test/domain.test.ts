import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DAY_MS, claimAllowed, claimTypeOf, computeWindow, discountPct, displayDecision, vrpFromInternal } from "../src/index.js";
import type { BrandMode, PriceEventInput, Viewer } from "../src/index.js";

const HOUR = 3_600_000;
const NOW = new Date("2026-12-01T12:00:00.000Z");
const at = (daysAgo: number): Date => new Date(NOW.getTime() - daysAgo * DAY_MS);
const ev = (daysAgo: number, price: number): PriceEventInput => ({ priceMinor: BigInt(price), validFrom: at(daysAgo) });
const RUNS = { numRuns: 1000 };

describe("held price and isLowest30d", () => {
  it("a price held 30 days becomes regular: the next cut references it, not the older higher price", () => {
    // 1000 (day 80) -> 900 (day 70) held 40 days -> 800 (day 5): fresh run, reference 900
    const w = computeWindow([ev(80, 1000), ev(70, 900), ev(5, 800)], NOW);
    expect(w.reference).toBe(900n);
    expect(w.referenceRunStart).toEqual(at(5));
  });
  it("a price held under 30 days keeps the successive-discount reference", () => {
    const w = computeWindow([ev(80, 1000), ev(25, 900), ev(5, 800)], NOW);
    expect(w.reference).toBe(1000n);
  });
  it("isLowest30d needs a strictly higher price in the window", () => {
    expect(computeWindow([ev(60, 500)], NOW).isLowest30d).toBe(false);
    expect(computeWindow([ev(60, 500), ev(10, 500)], NOW).isLowest30d).toBe(false);
    expect(computeWindow([ev(60, 900), ev(10, 500)], NOW).isLowest30d).toBe(true);
    expect(computeWindow([ev(60, 500), ev(10, 900)], NOW).isLowest30d).toBe(false);
    expect(computeWindow([ev(60, 900), ev(20, 500), ev(5, 700)], NOW).isLowest30d).toBe(false);
  });
});

describe("computeWindow", () => {
  it("is empty and launch with no events", () => {
    const w = computeWindow([], NOW);
    expect(w).toMatchObject({ currentPrice: null, low30d: null, launchPrice: true, reference: null });
  });

  it("reports current, 30 day low, first seen and last increase", () => {
    const w = computeWindow([ev(50, 1000), ev(40, 900), ev(20, 1100), ev(5, 950)], NOW);
    expect(w.currentPrice).toBe(950n);
    expect(w.low30d).toBe(900n);
    expect(w.firstSeenAt).toEqual(at(50));
    expect(w.lastIncreaseAt).toEqual(at(20));
    expect(w.launchPrice).toBe(false);
  });

  it("the price in effect at the window start counts toward the low", () => {
    const w = computeWindow([ev(60, 500), ev(10, 900)], NOW);
    expect(w.low30d).toBe(500n);
    expect(w.low30dFrom).toEqual(at(60));
  });

  it("treats under 30 days of history as launch, exactly 30 days as verified-capable", () => {
    expect(computeWindow([ev(29.9, 1000)], NOW).launchPrice).toBe(true);
    expect(computeWindow([ev(30, 1000)], NOW).launchPrice).toBe(false);
  });

  it("ignores future events, collapses equal consecutive prices, rejects non-positive prices", () => {
    const w = computeWindow([ev(40, 100), ev(30, 100), ev(-5, 50)], NOW);
    expect(w.currentPrice).toBe(100n);
    expect(w.lastIncreaseAt).toBeNull();
    expect(() => computeWindow([ev(1, 0)], NOW)).toThrow(RangeError);
  });

  it("honours an explicit firstSeenAt when events were truncated", () => {
    const w = computeWindow([ev(10, 900)], NOW, { firstSeenAt: at(90) });
    expect(w.launchPrice).toBe(false);
  });
});

describe("vrpFromInternal", () => {
  it("no reference without a price reduction", () => {
    expect(vrpFromInternal(computeWindow([ev(40, 1000), ev(5, 1200)], NOW), NOW)).toBeNull();
    expect(vrpFromInternal(computeWindow([ev(40, 1000)], NOW), NOW)).toBeNull();
  });

  it("simple verified discount: 1000 for 40 days then 700", () => {
    const w = computeWindow([ev(40, 1000), ev(2, 700)], NOW);
    const vrp = vrpFromInternal(w, NOW);
    expect(vrp).toBe(1000n);
    expect(discountPct(1000n, 700n)).toBe(30);
    expect(claimAllowed(vrp, 700n)).toBe(true);
  });

  it("successive discounts keep the starting reference", () => {
    const vrp = vrpFromInternal(computeWindow([ev(50, 1000), ev(10, 800), ev(3, 700)], NOW), NOW);
    expect(vrp).toBe(1000n);
  });

  it("a price that went back up resets the reference to the lowest price of that window", () => {
    const vrp = vrpFromInternal(computeWindow([ev(50, 1000), ev(12, 800), ev(8, 900), ev(2, 700)], NOW), NOW);
    expect(vrp).toBe(800n);
  });

  it("raise then cut: 100 -> 200 -> 120 gives no claim; the reference is the true low 100", () => {
    const w = computeWindow([ev(60, 100), ev(10, 200), ev(2, 120)], NOW);
    const vrp = vrpFromInternal(w, NOW);
    expect(vrp).toBe(100n);
    expect(claimAllowed(vrp, 120n)).toBe(false);
  });

  it("needs 30 days of history before the first reduction", () => {
    expect(vrpFromInternal(computeWindow([ev(32, 1000), ev(2, 700)], NOW), NOW)).toBe(1000n);
    expect(vrpFromInternal(computeWindow([ev(25, 1000), ev(2, 700)], NOW), NOW)).toBeNull();
    // history >= 30 days overall but the cut happened before 30 days of prior data existed
    expect(vrpFromInternal(computeWindow([ev(34, 1000), ev(20, 700)], NOW), NOW)).toBeNull();
  });

  it("a discount older than 30 days is the regular price again", () => {
    expect(vrpFromInternal(computeWindow([ev(90, 1000), ev(31, 700)], NOW), NOW)).toBeNull();
  });

  it("re-checks validity against a later now", () => {
    const w = computeWindow([ev(40, 1000), ev(2, 700)], NOW);
    expect(vrpFromInternal(w, new Date(NOW.getTime() + 29 * DAY_MS))).toBeNull();
  });
});

describe("discountPct / claimAllowed", () => {
  it("floors on integer minor units", () => {
    expect(discountPct(3n, 2n)).toBe(33);
    expect(discountPct(1000n, 950n)).toBe(5);
    expect(discountPct(1000n, 951n)).toBe(4);
    expect(discountPct(1000n, 1000n)).toBe(0);
    expect(discountPct(1000n, 1200n)).toBe(0);
    expect(discountPct(0n, 1n)).toBe(0);
  });
  it("needs a reference and at least 5 percent", () => {
    expect(claimAllowed(null, 1n)).toBe(false);
    expect(claimAllowed(1000n, 950n)).toBe(true);
    expect(claimAllowed(1000n, 951n)).toBe(false);
  });
});

describe("displayDecision table", () => {
  const base = { vrp: 1000n, price: 700n, launch: false } as const;
  const cases: readonly [string, Parameters<typeof displayDecision>[0], { showPercent: boolean; label: string; pct?: number }][] = [
    ["public anonymous", { ...base, brandMode: "public", viewer: "anonymous" }, { showPercent: true, label: "verified", pct: 30 }],
    ["public member", { ...base, brandMode: "public", viewer: "member" }, { showPercent: true, label: "verified", pct: 30 }],
    ["member_only anonymous", { ...base, brandMode: "member_only", viewer: "anonymous" }, { showPercent: false, label: "plain" }],
    ["member_only member", { ...base, brandMode: "member_only", viewer: "member" }, { showPercent: true, label: "verified", pct: 30 }],
    ["hidden member", { ...base, brandMode: "hidden", viewer: "member" }, { showPercent: false, label: "plain" }],
    ["launch", { ...base, launch: true, brandMode: "public", viewer: "member" }, { showPercent: false, label: "launch_price" }],
    ["no vrp", { ...base, vrp: null, brandMode: "public", viewer: "member" }, { showPercent: false, label: "plain" }],
    ["below 5 percent, lowest", { ...base, price: 980n, isLowest30d: true, brandMode: "public", viewer: "member" }, { showPercent: false, label: "lowest_30d" }],
    ["hidden but lowest", { ...base, isLowest30d: true, brandMode: "hidden", viewer: "member" }, { showPercent: false, label: "lowest_30d" }],
  ];
  it.each(cases)("%s", (_n, input, want) => {
    expect(displayDecision(input)).toEqual(want);
  });
  it("claimTypeOf records the evidence class regardless of brand mode", () => {
    expect(claimTypeOf({ vrp: 1000n, price: 700n, launch: false })).toBe("verified_discount");
    expect(claimTypeOf({ vrp: null, price: 700n, launch: true })).toBe("launch_price");
    expect(claimTypeOf({ vrp: null, price: 700n, launch: false, isLowest30d: true })).toBe("lowest_30d");
    expect(claimTypeOf({ vrp: null, price: 700n, launch: false })).toBe("plain");
  });
});

// ---------------------------------------------------------------- properties
const historyArb = fc
  .record({
    startHoursAgo: fc.integer({ min: 1, max: 120 * 24 }),
    steps: fc.array(fc.record({ gapHours: fc.integer({ min: 1, max: 400 }), level: fc.integer({ min: 1, max: 40 }) }), { minLength: 1, maxLength: 12 }),
  })
  .map(({ startHoursAgo, steps }) => {
    let t = NOW.getTime() - startHoursAgo * HOUR;
    const events: PriceEventInput[] = [];
    steps.forEach((s, i) => {
      if (i > 0) t += s.gapHours * HOUR;
      if (t <= NOW.getTime()) events.push({ priceMinor: BigInt(s.level) * 100n, validFrom: new Date(t) });
    });
    return events;
  })
  .filter((e) => e.length > 0);

/** Independent oracle: price in effect at hourly instants (events sit on whole hours, so this is exact). */
const priceAt = (events: readonly PriceEventInput[], t: number): bigint | undefined => {
  let p: bigint | undefined;
  for (const e of events) if (e.validFrom.getTime() <= t) p = e.priceMinor;
  return p;
};
const oracleMin = (events: readonly PriceEventInput[], from: number, to: number): bigint | undefined => {
  let m: bigint | undefined;
  for (let t = from; t < to; t += HOUR) {
    const p = priceAt(events, t);
    if (p !== undefined && (m === undefined || p < m)) m = p;
  }
  return m;
};

/** Independent oracle for the start of the current discount run: derived here from the raw events, not from the implementation. */
const oracleRunStart = (events: readonly PriceEventInput[]): number | undefined => {
  const sorted = [...events].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  const ps: { p: bigint; t: number }[] = [];
  for (const e of sorted) if (ps[ps.length - 1]?.p !== e.priceMinor) ps.push({ p: e.priceMinor, t: e.validFrom.getTime() });
  let i = ps.length - 1;
  for (;;) {
    const cur = ps[i];
    const prev = ps[i - 1];
    if (cur === undefined || prev === undefined || cur.p >= prev.p) break;
    i--;
    if (cur.t - prev.t >= 30 * DAY_MS) break; // prev was held 30 days or more: regular price
  }
  return ps[i + 1]?.t;
};

describe("properties (1000 runs)", () => {
  it("a claim is never above the true minimum of the 30 days before the discount started (independent oracle)", () => {
    fc.assert(
      fc.property(historyArb, (events) => {
        const w = computeWindow(events, NOW);
        const vrp = vrpFromInternal(w, NOW);
        const runStart = oracleRunStart(events);
        const firstSeen = Math.min(...events.map((e) => e.validFrom.getTime()));
        const eligible = runStart !== undefined && runStart >= NOW.getTime() - 30 * DAY_MS && firstSeen <= runStart - 30 * DAY_MS;
        const truth = eligible ? oracleMin(events, runStart - 30 * DAY_MS, runStart) : undefined;
        expect(vrp).toBe(truth ?? null);
        if (vrp === null || w.currentPrice === null || runStart === undefined) return true;
        expect(w.referenceRunStart?.getTime()).toBe(runStart);
        // never above the cheapest price in effect in [now-30d, runStart): the part of the window before the current run
        const priorLow = oracleMin(events, NOW.getTime() - 30 * DAY_MS, runStart);
        if (priorLow !== undefined) expect(vrp).toBeLessThanOrEqual(priorLow);
        if (claimAllowed(vrp, w.currentPrice)) {
          expect(w.currentPrice).toBeLessThan(truth ?? 0n);
          expect(discountPct(vrp, w.currentPrice)).toBeLessThanOrEqual(discountPct(truth ?? 0n, w.currentPrice));
        }
        return true;
      }),
      RUNS,
    );
  });

  it("the 61 day load slice gives the same window as the full history", () => {
    fc.assert(
      fc.property(historyArb, (events) => {
        // the ingestor never stores two consecutive rows with the same price, so the slice is compared on such histories
        const sorted = [...events].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime()).filter((e, i, arr) => arr[i - 1]?.priceMinor !== e.priceMinor);
        const full = computeWindow(sorted, NOW);
        const since = NOW.getTime() - 61 * DAY_MS;
        const slice = sorted.filter((_e, i) => (sorted[i + 1]?.validFrom.getTime() ?? Infinity) >= since);
        const cut = computeWindow(slice, NOW, { firstSeenAt: sorted[0]?.validFrom ?? NOW });
        // lastIncreaseAt is only tracked inside the slice (nothing uses an increase older than 30 days)
        const fullInSlice = full.lastIncreaseAt !== null && full.lastIncreaseAt.getTime() < since ? { ...full, lastIncreaseAt: null } : full;
        expect(cut).toEqual(fullInSlice);
        return true;
      }),
      RUNS,
    );
  });

  it("raise-then-cut within 30 days never claims above the true 30-day minimum (section 9.7)", () => {
    fc.assert(
      fc.property(
        fc.record({
          p0: fc.integer({ min: 10, max: 5000 }),
          raise: fc.integer({ min: 1, max: 5000 }),
          cutBelow: fc.integer({ min: 1, max: 5000 }),
          d1: fc.integer({ min: 2, max: 28 }),
          dGap: fc.integer({ min: 1, max: 27 }),
          first: fc.integer({ min: 31, max: 90 }),
        }),
        ({ p0, raise, cutBelow, d1, dGap, first }) => {
          const p1 = p0 + raise;
          const p2 = Math.max(1, p1 - cutBelow);
          const d2 = Math.max(0, d1 - dGap);
          const events = [ev(first, p0), ev(d1, p1), ev(d2, p2)];
          const w = computeWindow(events, NOW);
          const vrp = vrpFromInternal(w, NOW);
          // true minimum over the last 30 days before the cut (p0 was in effect then)
          if (vrp !== null) expect(vrp).toBeLessThanOrEqual(BigInt(p0));
          if (claimAllowed(vrp, BigInt(p2))) expect(discountPct(BigInt(p0), BigInt(p2))).toBeGreaterThanOrEqual(5);
          if (p2 >= p0) expect(claimAllowed(vrp, BigInt(p2))).toBe(false);
          return true;
        },
      ),
      RUNS,
    );
  });

  const modeArb = fc.constantFrom<BrandMode>("public", "member_only", "hidden");
  const viewerArb = fc.constantFrom<Viewer>("anonymous", "member");

  it("launch items never show a percentage; hidden never; member_only only to members; a shown percent is always a verified claim", () => {
    fc.assert(
      fc.property(fc.option(fc.bigInt({ min: 1n, max: 10_000n }), { nil: null }), fc.bigInt({ min: 1n, max: 10_000n }), fc.boolean(), modeArb, viewerArb, fc.boolean(), (vrp, price, launch, brandMode, viewer, low) => {
        const d = displayDecision({ vrp, price, launch, brandMode, viewer, isLowest30d: low });
        if (launch) expect(d.showPercent).toBe(false);
        if (brandMode === "hidden") expect(d.showPercent).toBe(false);
        if (brandMode === "member_only" && viewer === "anonymous") expect(d.showPercent).toBe(false);
        if (d.showPercent) {
          expect(claimAllowed(vrp, price)).toBe(true);
          expect(d.label).toBe("verified");
          expect(d.pct).toBe(discountPct(vrp ?? 0n, price));
        } else expect(d.pct).toBeUndefined();
        return true;
      }),
      RUNS,
    );
  });

  it("windows with under 30 days of history never yield a VRP", () => {
    fc.assert(
      fc.property(historyArb, (events) => {
        const w = computeWindow(events, NOW);
        if (w.launchPrice) expect(vrpFromInternal(w, NOW)).toBeNull();
        return true;
      }),
      RUNS,
    );
  });
});
