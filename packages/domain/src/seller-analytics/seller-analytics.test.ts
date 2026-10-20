import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGING_THRESHOLDS_DAYS,
  FRESHNESS_SLO_MS,
  K_ANONYMITY_MIN,
  MARKDOWN_NOTICE,
  agingAlerts,
  buildWatermarkedCsv,
  computeFunnel,
  csvCell,
  freshnessOf,
  gateByShoppers,
  kAnonymize,
  kAnonymizeAdditive,
  snapToDays,
  recommendMarkdown,
  returnRateBps,
  sellThroughBps,
  sizeCurve,
  summarizeSales,
} from "./index";

describe("k-anonymity", () => {
  it("uses 50 distinct shoppers as a fixed threshold", () => {
    expect(K_ANONYMITY_MIN).toBe(50);
    const r = kAnonymize([
      { key: "cairo", distinctShoppers: 50, value: 1 },
      { key: "giza", distinctShoppers: 49, value: 2 },
    ]);
    expect(r.released.map((c) => c.key)).toEqual(["cairo"]);
    expect(r.suppressedCells).toBe(1);
    expect(JSON.stringify(r)).not.toContain("giza");
  });
  it("property: no released cell has fewer than 50 shoppers", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ key: fc.string(), distinctShoppers: fc.nat(200), value: fc.nat() })), (cells) => {
        const r = kAnonymize(cells);
        expect(r.released.every((c) => c.distinctShoppers >= 50)).toBe(true);
        expect(r.released.length + r.suppressedCells).toBe(cells.length);
      }),
    );
  });
  it("rejects invalid counts and gates single statistics", () => {
    expect(() => kAnonymize([{ key: "x", distinctShoppers: -1, value: 0 }])).toThrow();
    expect(gateByShoppers(49, 1)).toEqual({ suppressed: true });
    expect(gateByShoppers(50, 7)).toEqual({ suppressed: false, value: 7 });
  });
});

describe("funnel", () => {
  it("computes stage conversion in bps and flags skipped stages", () => {
    const f = computeFunnel({ impression: 1000, view: 200, save: 0, bag: 30, checkout: 15, purchase: 6 });
    expect(f.steps[1]?.fromPreviousBps).toBe(2000);
    expect(f.steps[3]?.fromPreviousBps).toBeNull();
    expect(f.steps[3]?.exceedsPrevious).toBe(true);
    expect(f.overallBps).toBe(60);
  });
  it("returns nulls on an empty funnel and rejects bad counts", () => {
    expect(computeFunnel({ impression: 0, view: 0, save: 0, bag: 0, checkout: 0, purchase: 0 }).overallBps).toBeNull();
    expect(() => computeFunnel({ impression: -1, view: 0, save: 0, bag: 0, checkout: 0, purchase: 0 })).toThrow();
  });
});

describe("sales", () => {
  const base = { gmvMinor: 1_000_001n, commissionMinor: 100_000n, units: 10, orders: 2, distinctShoppers: 60, repeatShoppers: 6 };
  it("derives net, AOV with banker's rounding and a gated repeat rate", () => {
    const s = summarizeSales(base);
    expect(s.netMinor).toBe(900_001n);
    expect(s.aovMinor).toBe(500_000n); // 1_000_001 / 2 = 500_000.5 -> even
    expect(s.repeatRateBps).toEqual({ suppressed: false, value: 1000 });
  });
  it("suppresses the repeat rate under 50 shoppers and survives zero orders", () => {
    expect(summarizeSales({ ...base, distinctShoppers: 10, repeatShoppers: 5 }).repeatRateBps).toEqual({ suppressed: true });
    expect(summarizeSales({ ...base, gmvMinor: 0n, commissionMinor: 0n, orders: 0, units: 0 }).aovMinor).toBeNull();
  });
  it("rejects impossible totals", () => {
    expect(() => summarizeSales({ ...base, commissionMinor: 2_000_000n })).toThrow();
    expect(() => summarizeSales({ ...base, repeatShoppers: 61 })).toThrow();
  });
});

describe("stock", () => {
  it("sell-through and return rate", () => {
    expect(sellThroughBps(3, 7)).toBe(3000);
    expect(sellThroughBps(0, 0)).toBeNull();
    expect(returnRateBps(1, 8)).toBe(1250);
  });
  it("size curve compares sold share with stocked share", () => {
    const c = sizeCurve(
      [
        { size: "L", soldUnits: 1, onHandUnits: 9 },
        { size: "M", soldUnits: 9, onHandUnits: 1 },
      ],
      ["S", "M", "L"],
    );
    expect(c.rows.map((r) => r.size)).toEqual(["M", "L"]);
    expect(c.rows[0]?.soldShareBps).toBe(9000);
    expect(c.rows[0]?.gapBps).toBeGreaterThan(0);
    expect(c.rows[1]?.gapBps).toBeLessThan(0);
  });
  it("raises aging alerts only for stocked SKUs at 30/60/90 days", () => {
    const now = 100 * 86_400_000;
    const at = (d: number) => now - d * 86_400_000;
    const a = agingAlerts(
      [
        { skuId: "a", productId: "p", onHand: 1, listedAtMs: at(29), soldUnits: 0 },
        { skuId: "b", productId: "p", onHand: 1, listedAtMs: at(AGING_THRESHOLDS_DAYS.watch), soldUnits: 0 },
        { skuId: "c", productId: "p", onHand: 2, listedAtMs: at(61), soldUnits: 2 },
        { skuId: "d", productId: "p", onHand: 0, listedAtMs: at(200), soldUnits: 2 },
        { skuId: "e", productId: "p", onHand: 5, listedAtMs: at(95), soldUnits: 5 },
      ],
      now,
    );
    expect(a.map((x) => [x.skuId, x.severity])).toEqual([
      ["e", "critical"],
      ["c", "aging"],
      ["b", "watch"],
    ]);
  });
});

describe("markdown recommendation", () => {
  it("states the new price will not show % off and never claims one", () => {
    const r = recommendMarkdown({ currentPriceMinor: 100_000n, severity: "aging", sellThroughBps: 1000 });
    expect(r.action).toBe("markdown");
    expect(r.suggestedPriceMinor).toBe(80_000n);
    expect(r.showsPercentOff).toBe(false);
    expect(r.notice).toBe(MARKDOWN_NOTICE);
    expect(MARKDOWN_NOTICE.en).toMatch(/will NOT show a % off/);
    expect(r.basis).toBe("heuristic_v1");
  });
  it("holds for healthy sell-through and respects the floor", () => {
    expect(recommendMarkdown({ currentPriceMinor: 100_000n, severity: "critical", sellThroughBps: 7000 }).action).toBe("hold");
    const r = recommendMarkdown({ currentPriceMinor: 100_000n, severity: "critical", sellThroughBps: 0, floorPriceMinor: 90_000n });
    expect(r.suggestedPriceMinor).toBe(90_000n);
    expect(recommendMarkdown({ currentPriceMinor: 100_000n, severity: "critical", sellThroughBps: 0, floorPriceMinor: 100_000n }).action).toBe("hold");
  });
  it("property: suggestion is a whole pound below the current price", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 100n, max: 10_000_000n }), fc.constantFrom("watch", "aging", "critical" as const), (price, sev) => {
        const r = recommendMarkdown({ currentPriceMinor: price, severity: sev, sellThroughBps: 0 });
        if (r.suggestedPriceMinor !== null) {
          expect(r.suggestedPriceMinor < price).toBe(true);
          expect(r.suggestedPriceMinor % 100n).toBe(0n);
        }
        expect(r.showsPercentOff).toBe(false);
      }),
    );
  });
});

describe("watermarked csv", () => {
  it("carries seller id in header and every row, and guards formulas", () => {
    const csv = buildWatermarkedCsv({
      sellerId: "store-1",
      report: "sales",
      generatedAtIso: "2026-01-01T00:00:00.000Z",
      watermark: "wm-abc",
      columns: ["name", "n"],
      rows: [
        ["=HYPERLINK(1)", 1n],
        ['a,"b"', 2],
      ],
    });
    expect(csv).toContain("# seller_id: store-1");
    expect(csv).toContain("# watermark: wm-abc");
    const body = csv.split("\n").filter((l) => !l.startsWith("#") && l !== "");
    expect(body[0]).toBe("name,n,exported_for_seller,watermark");
    expect(body.slice(1).every((l) => l.endsWith(",store-1,wm-abc"))).toBe(true);
    expect(body[1]).toContain("'=HYPERLINK(1)");
    expect(body[2]).toContain('"a,""b"""');
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell(null)).toBe("");
  });
  it("rejects ragged rows", () => {
    expect(() =>
      buildWatermarkedCsv({ sellerId: "s", report: "r", generatedAtIso: "t", watermark: "w", columns: ["a"], rows: [[1, 2]] }),
    ).toThrow();
  });
});

describe("freshness", () => {
  it("reports lag against the 15 minute SLO", () => {
    expect(freshnessOf(null, null, 10).withinSlo).toBe(false);
    expect(freshnessOf(1_000, 900, 1_000 + FRESHNESS_SLO_MS)).toMatchObject({ withinSlo: true, lagMs: FRESHNESS_SLO_MS });
    expect(freshnessOf(1_000, 900, 1_001 + FRESHNESS_SLO_MS).withinSlo).toBe(false);
  });
});

describe("k-anonymity differencing", () => {
  const add = (a: number, b: number) => a + b;
  it("property: total minus released is 0 whenever anything is released; never an isolated cell", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ key: fc.string({ minLength: 1 }), distinctShoppers: fc.nat(120), value: fc.nat(1000) }), {
          selector: (c) => c.key,
        }),
        (cells) => {
          const r = kAnonymizeAdditive(cells, add);
          const total = cells.reduce((n, c) => n + c.value, 0);
          const released = r.released.reduce((n, c) => n + c.value, 0);
          expect(r.released.every((c) => c.distinctShoppers >= 50)).toBe(true);
          if (r.released.length > 0) expect(total - released).toBe(0);
          else expect(r.suppressedCells).toBe(cells.length);
          // any residual (none here) would have to include a >= 50 shopper cell
          const anySuppressed = cells.some((c) => c.distinctShoppers < 50);
          if (anySuppressed && r.released.length > 0) {
            expect(r.released.some((c) => c.includesSuppressed === true)).toBe(true);
          }
        },
      ),
    );
  });
  it("merges into the smallest released cell", () => {
    const r = kAnonymizeAdditive(
      [
        { key: "a", distinctShoppers: 90, value: 10 },
        { key: "b", distinctShoppers: 50, value: 5 },
        { key: "c", distinctShoppers: 1, value: 3 },
      ],
      add,
    );
    expect(r.released.find((c) => c.key === "b")?.value).toBe(8);
    expect(r.released.find((c) => c.key === "a")?.value).toBe(10);
  });
  it("snaps windows to whole UTC days (min granularity: day)", () => {
    const D = 86_400_000;
    expect(snapToDays(5 * D + 1000, 5 * D + 2000)).toEqual({ fromMs: 5 * D, toMs: 6 * D });
    expect(snapToDays(5 * D, 6 * D)).toEqual({ fromMs: 5 * D, toMs: 6 * D });
  });
});
