import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cairoLocalToUtc } from "@outlet/domain";
import { DIMENSION_DOMAINS, EXTERNAL_MARGINS, dimensionDomain, externalMarginProblems } from "../domain/external-margins";
import { gatedWindow } from "../domain/gated-window";
import { SELLER_BREAKDOWNS, SELLER_METRICS } from "../domain/series-registry";
import {
  EMPTY_LEDGER,
  K_MIN,
  LedgerConflict,
  RowDomainViolation,
  applyLedger,
  cellKey,
  releaseBreakdown,
  releaseDistinctSeries,
  topRows,
  type BreakdownColumn,
  type Cell,
  type Ledger,
  type LedgerState,
} from "../domain/kanon-table";
import { audit, auditLedger } from "./kanon-oracle";

const shoppers = (from: number, n: number): Set<string> => new Set(Array.from({ length: n }, (_, i) => `s${from + i}`));
const cell = (from: number, n: number, value = n): Cell => ({ value, shoppers: shoppers(from, n) });
const col = (name: string, cells: Record<string, Cell>): BreakdownColumn => ({ col: name, cells: new Map(Object.entries(cells)) });
const seenOf = (cols: readonly BreakdownColumn[]): Map<string, ReadonlySet<string>> => {
  const m = new Map<string, ReadonlySet<string>>();
  for (const c of cols) for (const [r, v] of c.cells) m.set(cellKey(r, c.col), v.shoppers);
  return m;
};

describe("committed counterexample kanon-table.two-way-leak (ADR-0052 issue 3)", () => {
  // a = (r1,d1) 5 shoppers, b = (r1,d2) 60, c = (r2,d1) 70, plus released cells elsewhere.
  const cols = [
    col("d1", { r1: cell(0, 5), r2: cell(1000, 70), r3: cell(2000, 80) }),
    col("d2", { r1: cell(3000, 60), r2: cell(4000, 90), r3: cell(5000, 90) }),
  ];
  const rows = ["r1", "r2", "r3"];
  it("the old per-line two-way rule published row r1 and column d2 margins and the oracle finds the 5-shopper cell", () => {
    const a = cellKey("r1", "d1"), b = cellKey("r1", "d2"), c = cellKey("r2", "d1");
    const hidden = [
      { key: a, col: "d1", shoppers: shoppers(0, 5) },
      { key: b, col: "d2", shoppers: shoppers(3000, 60) },
      { key: c, col: "d1", shoppers: shoppers(1000, 70) },
    ];
    // old published family: row r1 margin (a+b), column d1 margin NOT published (union 75 >= 50 but a alone small), column d2 margin (b).
    const leaks = audit({ hidden, forms: [[a, b], [b]], columnSizes: new Map([["d1", 3], ["d2", 3]]) });
    expect(leaks.some((s) => s.length === 1 && s[0] === a)).toBe(true);
  });
  it("releaseBreakdown passes the same oracle", () => {
    const r = releaseBreakdown(cols, rows);
    expect(r.cells.get(cellKey("r1", "d1"))).toBeNull();
    expect(auditLedger(applyLedger(EMPTY_LEDGER, r.ledgerInserts), rows, ["d1", "d2"], seenOf(cols))).toEqual([]);
  });
});

describe("releaseBreakdown rules", () => {
  it("per column: hides below K, then hides the smallest tentative cell until the union covers K", () => {
    const r = releaseBreakdown([col("m", { a: cell(0, 60), b: cell(100, 10), c: cell(200, 70) })], ["a", "b", "c"]);
    expect(r.cells.get(cellKey("b", "m"))).toBeNull();
    expect(r.cells.get(cellKey("a", "m"))).toBeNull();
    expect(r.cells.get(cellKey("c", "m"))).toBe(70);
    expect(r.counts).toEqual({ primary: 1, complementary: 1, memo: 0, pinned: 0 });
  });
  it("no complementary hiding when hidden union already covers K; whole-column hidden is allowed", () => {
    const ok = releaseBreakdown([col("m", { a: cell(0, 30), b: cell(100, 30), c: cell(200, 80) })], ["a", "b", "c"]);
    expect(ok.counts.complementary).toBe(0);
    const whole = releaseBreakdown([col("m", { a: cell(0, 10), b: cell(100, 10) })], ["a", "b"]);
    expect(whole.wholeSeries).toBe(true);
    expect(whole.counts.complementary).toBe(0);
  });
  it("union, not sum: cells sharing the same shoppers do not cover K", () => {
    const sh = cell(0, 30);
    const r = releaseBreakdown([col("m", { a: sh, b: { value: 30, shoppers: sh.shoppers }, c: cell(500, 70), d: cell(700, 90) })], ["a", "b", "c", "d"]);
    expect(r.counts.complementary).toBe(1);
    expect(r.cells.get(cellKey("c", "m"))).toBeNull();
  });
  it("has no row, column or grand totals in its type", () => {
    const r = releaseBreakdown([col("m", { a: cell(0, 60) })], ["a"]);
    expect(Object.keys(r).sort()).toEqual(["cells", "counts", "drift", "ledgerInserts", "residualColumns", "wholeSeries"]);
  });
  it("pinned values are served unchanged, drift is reported, hidden stays hidden and is never a candidate", () => {
    const first = releaseBreakdown([col("m", { a: cell(0, 40), b: cell(100, 80), c: cell(300, 90) })], ["a", "b", "c"]);
    const ledger = applyLedger(EMPTY_LEDGER, first.ledgerInserts);
    const later = [col("m", { a: cell(0, 400), b: cell(100, 85), c: cell(300, 90, 999) })];
    const second = releaseBreakdown(later, ["a", "b", "c"], ledger);
    for (const [k, v] of first.cells) expect(second.cells.get(k)).toBe(v);
    expect(second.drift).toEqual([cellKey("c", "m")]);
    expect(second.ledgerInserts.size).toBe(0);
    expect(second.counts.memo).toBeGreaterThanOrEqual(1);
    expect(second.counts.pinned).toBeGreaterThanOrEqual(1);
  });
  it("residual: nothing new is released when a hidden set falls under K after erasure and no tentative cell is left", () => {
    const ledger: Ledger = new Map<string, LedgerState>([
      [cellKey("a", "m"), { state: "hidden", reason: "primary" }],
      [cellKey("b", "m"), { state: "released", value: 70 }],
    ]);
    const r = releaseBreakdown([col("m", { a: cell(0, 5), b: cell(100, 70) })], ["a", "b"], ledger);
    expect(r.residualColumns).toEqual(["m"]);
    expect(r.cells.get(cellKey("b", "m"))).toBe(70);
    expect(r.ledgerInserts.size).toBe(0);
  });
  it("topRows ranks by released cells and other_released sums only released cells", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `r${String(i).padStart(2, "0")}`);
    const cells: Record<string, Cell> = {};
    rows.forEach((r, i) => (cells[r] = cell(i * 100, 60, 1000 - i)));
    cells["r11"] = cell(5000, 10, 7);
    const rel = releaseBreakdown([col("c", cells)], rows);
    const { top, otherReleased } = topRows(rel, rows, ["c"]);
    expect(top).toHaveLength(10);
    const rest = rows.filter((r) => !top.includes(r));
    const expected = rest.reduce((s, r) => s + (rel.cells.get(cellKey(r, "c")) ?? 0), 0);
    expect(otherReleased.get("c")).toBe(expected);
  });
});

describe("releaseDistinctSeries and applyLedger", () => {
  it("primary below K, pinned afterwards, hidden forever", () => {
    const r1 = releaseDistinctSeries([{ bucket: "2026-09-01", value: 80, shoppers: 80 }, { bucket: "2026-09-02", value: 20, shoppers: 20 }]);
    expect(r1.points.get("2026-09-02")).toBeNull();
    const ledger = applyLedger(EMPTY_LEDGER, r1.ledgerInserts);
    const r2 = releaseDistinctSeries([{ bucket: "2026-09-01", value: 70, shoppers: 70 }, { bucket: "2026-09-02", value: 500, shoppers: 500 }], ledger);
    expect(r2.points.get("2026-09-01")).toBe(80);
    expect(r2.points.get("2026-09-02")).toBeNull();
    expect(r2.drift).toEqual(["2026-09-01"]);
  });
  it("applyLedger rejects any conflicting insert and accepts identical ones", () => {
    const led = applyLedger(EMPTY_LEDGER, new Map<string, LedgerState>([["k", { state: "released", value: 5 }]]));
    expect(() => applyLedger(led, new Map<string, LedgerState>([["k", { state: "released", value: 6 }]]))).toThrow(LedgerConflict);
    expect(() => applyLedger(led, new Map<string, LedgerState>([["k", { state: "hidden", reason: "primary" }]]))).toThrow(LedgerConflict);
    expect(applyLedger(led, new Map<string, LedgerState>([["k", { state: "released", value: 5 }]])).size).toBe(1);
  });
});

// ---------- property tests ----------
const cellArb = (poolBase: number): fc.Arbitrary<Cell> =>
  fc.record({ off: fc.integer({ min: 0, max: 120 }), n: fc.integer({ min: 0, max: 130 }) }).map(({ off, n }) => cell(poolBase + off, n, n + off));

describe("k-anonymity properties (shared Gaussian-elimination audit)", () => {
  const tableArb = fc
    .record({ nr: fc.integer({ min: 1, max: 4 }), nc: fc.integer({ min: 1, max: 4 }) })
    .chain(({ nr, nc }) => fc.array(fc.array(cellArb(0), { minLength: nr, maxLength: nr }), { minLength: nc, maxLength: nc }));
  it("single request: audit passes, no released cell < K, deterministic", () => {
    fc.assert(
      fc.property(tableArb, (grid) => {
        const rows = (grid[0] ?? []).map((_, i) => `r${i}`);
        const cols = grid.map((cells, ci) => col(`m${ci}`, Object.fromEntries(cells.map((c, ri) => [`r${ri}`, c]))));
        const rel = releaseBreakdown(cols, rows);
        expect(releaseBreakdown(cols, rows).ledgerInserts).toEqual(rel.ledgerInserts);
        for (const c of cols) for (const r of rows) if (rel.cells.get(cellKey(r, c.col)) !== null) expect((c.cells.get(r) as Cell).shoppers.size).toBeGreaterThanOrEqual(K_MIN);
        const led = applyLedger(EMPTY_LEDGER, rel.ledgerInserts);
        expect(auditLedger(led, rows, cols.map((c) => c.col), seenOf(cols))).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it("overlapping requests with late facts and erasure: one value per aggregate, audit passes", () => {
    const MONTHS = 4;
    const rows = ["r0", "r1", "r2", "r3"];
    const eventArb = fc.oneof(
      fc.record({ t: fc.constant("late" as const), m: fc.nat(MONTHS - 1), r: fc.nat(3), off: fc.nat(150), n: fc.integer({ min: 1, max: 60 }) }),
      fc.record({ t: fc.constant("erase" as const), m: fc.nat(MONTHS - 1), r: fc.nat(3), k: fc.integer({ min: 1, max: 40 }) }),
      fc.record({ t: fc.constant("request" as const), months: fc.subarray([0, 1, 2, 3], { minLength: 1 }) }),
    );
    fc.assert(
      fc.property(fc.array(fc.array(cellArb(0), { minLength: 4, maxLength: 4 }), { minLength: MONTHS, maxLength: MONTHS }), fc.array(eventArb, { minLength: 3, maxLength: 14 }), (grid, events) => {
        const facts = grid.map((cs) => cs.map((c) => ({ value: c.value, set: new Set(c.shoppers) })));
        const seen = new Map<string, Set<string>>();
        const remember = (m: number, r: number): void => {
          const s = seen.get(cellKey(`r${r}`, `m${m}`)) ?? new Set<string>();
          for (const x of (facts[m] as { set: Set<string> }[])[r]?.set ?? []) s.add(x);
          seen.set(cellKey(`r${r}`, `m${m}`), s);
        };
        for (let m = 0; m < MONTHS; m++) for (let r = 0; r < 4; r++) remember(m, r);
        const requested = new Set<number>();
        let ledger: Ledger = EMPTY_LEDGER;
        const served = new Map<string, number | null>();
        for (const e of events) {
          if (e.t === "late" && !requested.has(e.m)) {
            const f = (facts[e.m] as { value: number; set: Set<string> }[])[e.r] as { value: number; set: Set<string> };
            for (const x of shoppers(e.off, e.n)) f.set.add(x);
            f.value += e.n;
            remember(e.m, e.r);
          } else if (e.t === "erase") {
            const f = (facts[e.m] as { value: number; set: Set<string> }[])[e.r] as { set: Set<string> };
            for (const x of [...f.set].slice(0, e.k)) f.set.delete(x);
          } else if (e.t === "request") {
            const cols = e.months.map((m) => col(`m${m}`, Object.fromEntries(rows.map((r, ri) => [r, { value: (facts[m] as { value: number }[])[ri]?.value ?? 0, shoppers: new Set((facts[m] as { set: Set<string> }[])[ri]?.set) }]))));
            const rel = releaseBreakdown(cols, rows, ledger);
            ledger = applyLedger(ledger, rel.ledgerInserts);
            for (const [k, v] of rel.cells) {
              if (served.has(k)) expect(v).toBe(served.get(k));
              else served.set(k, v);
            }
            e.months.forEach((m) => requested.add(m));
          }
        }
        const cols = [...requested].sort().map((m) => `m${m}`);
        expect(auditLedger(ledger, rows, cols, seen)).toEqual([]);
      }),
      { numRuns: 80 },
    );
  });
});

describe("registry completeness", () => {
  it("every additive gated breakdown declares an ungated additive external margin", () => {
    expect(externalMarginProblems()).toEqual([]);
    for (const [metric, dims] of Object.entries(SELLER_BREAKDOWNS)) {
      for (const d of dims) expect(EXTERNAL_MARGINS[metric]?.dimension).toBe(d);
    }
    for (const m of Object.values(EXTERNAL_MARGINS)) for (const id of m.externalMetrics) expect(SELLER_METRICS.some((x) => x.def.id === id && !x.gated && x.def.additive)).toBe(true);
    expect(EXTERNAL_MARGINS["seller.traffic.views"]?.externalMetrics).toEqual(["seller.traffic.store_views", "seller.traffic.product_views"]);
    for (const metric of Object.keys(SELLER_BREAKDOWNS)) expect(DIMENSION_DOMAINS[metric]?.length).toBeGreaterThan(0);
  });
});

describe("rows must be the whole fixed dimension domain (chief-reviewer H3)", () => {
  const domain = ["a", "b", "c", "d"];
  it("a cell outside rows (filtered or top-N rows) throws RowDomainViolation", () => {
    const c = col("m", { a: cell(0, 10), b: cell(100, 10), c: cell(200, 90), d: cell(400, 90) });
    expect(() => releaseBreakdown([c], ["a", "b"])).toThrow(RowDomainViolation);
    expect(() => releaseBreakdown([c], ["a", "a", "b", "c", "d"])).toThrow(RowDomainViolation);
    expect(() => releaseBreakdown([c], domain)).not.toThrow();
    expect(dimensionDomain("seller.traffic.views")).toContain("unknown");
    expect(() => dimensionDomain("nope")).toThrow(RangeError);
  });
  it("property: any proper subset of rows that drops a populated row throws; full domain never does", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 120 }), { minLength: 4, maxLength: 4 }), fc.subarray(domain, { minLength: 0, maxLength: 3 }), (sizes, subset) => {
        const cells: Record<string, Cell> = {};
        domain.forEach((r, i) => { if ((sizes[i] as number) > 0) cells[r] = cell(i * 1000, sizes[i] as number); });
        const c = col("m", cells);
        const dropsPopulated = Object.keys(cells).some((r) => !subset.includes(r));
        if (dropsPopulated) expect(() => releaseBreakdown([c], subset)).toThrow(RowDomainViolation);
        else expect(() => releaseBreakdown([c], subset)).not.toThrow();
        expect(() => releaseBreakdown([c], domain)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
  it("oracle: with the whole domain the ledger passes; the old 'whole = the subset' accounting would leak", () => {
    // domain a..d; a,b small (hidden, 5 + 5 shoppers), c,d released. Public total minus released = a+b: 10 < K.
    const cols = [col("m", { a: cell(0, 5), b: cell(100, 5), c: cell(200, 90), d: cell(400, 90) })];
    const r = releaseBreakdown(cols, domain);
    expect(r.cells.get(cellKey("c", "m"))).toBeNull();
    const ledger = applyLedger(EMPTY_LEDGER, r.ledgerInserts);
    expect(auditLedger(ledger, domain, ["m"], seenOf(cols))).toEqual([]);
    // Old behaviour modelled: rows = [a,b] only, so {a,b} counted as the "whole column" and the leak went unnoticed.
    const hidden = [
      { key: cellKey("a", "m"), col: "m", shoppers: shoppers(0, 5) },
      { key: cellKey("b", "m"), col: "m", shoppers: shoppers(100, 5) },
    ];
    expect(audit({ hidden, forms: [[hidden[0]!.key, hidden[1]!.key]], columnSizes: new Map([["m", 2]]) })).toEqual([]);
    expect(audit({ hidden, forms: [[hidden[0]!.key, hidden[1]!.key]], columnSizes: new Map([["m", domain.length]]) }).length).toBeGreaterThan(0);
  });
});

describe("gatedWindow", () => {
  const ep = (y: number, m: number, d: number, h = 0): number => cairoLocalToUtc(y, m, d, h, 0);
  it("settle horizon: month 2026-09 releases exactly at month end + 48h", () => {
    const end = ep(2026, 10, 1);
    const at = (ms: number) => gatedWindow({ preset: "month:2026-09" }, ms);
    expect(at(end + 48 * 3_600_000 - 1)).toEqual({ ok: true, window: { months: [], unsettled: ["2026-09"] } });
    expect(at(end + 48 * 3_600_000)).toEqual({ ok: true, window: { months: ["2026-09"], unsettled: [] } });
    expect(() => gatedWindow({ preset: "month:2026-09" }, end, 23)).toThrow(RangeError);
  });
  it("presets and errors", () => {
    const now = ep(2026, 10, 16);
    expect(gatedWindow({ preset: "last_full_months:3" }, now)).toEqual({ ok: true, window: { months: ["2026-07", "2026-08", "2026-09"], unsettled: [] } });
    expect(gatedWindow({ preset: "last_full_months:2" }, now)).toEqual({ ok: false, error: "window_not_on_grid" });
    expect(gatedWindow({ from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }, now)).toEqual({ ok: false, error: "invalid_window" });
  });
  const iso = (ms: number, offsetMin: number): string => {
    const d = new Date(ms + offsetMin * 60_000).toISOString().slice(0, 19);
    const sign = offsetMin < 0 ? "-" : "+";
    const a = Math.abs(offsetMin);
    return `${d}${offsetMin === 0 ? "Z" : `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`}`;
  };
  it("aligned custom ranges resolve to the same month set in any offset, around DST", () => {
    const now = ep(2028, 1, 1);
    const months: [number, number][] = [[2026, 3], [2026, 4], [2026, 9], [2026, 10], [2026, 11], [2027, 4]];
    fc.assert(
      fc.property(fc.constantFrom(...months), fc.integer({ min: 0, max: 3 }), (start, span) => {
        const [y, m] = start;
        const from = ep(y, m, 1);
        const endIdx = new Date(Date.UTC(y, m - 1 + span + 1, 1));
        const to = ep(endIdx.getUTCFullYear(), endIdx.getUTCMonth() + 1, 1);
        const results = [0, 120, 180, -300].map((o) => JSON.stringify(gatedWindow({ from: iso(from, o), to: iso(to, o) }, now)));
        expect(new Set(results).size).toBe(1);
        const w = gatedWindow({ from: iso(from, 0), to: iso(to, 0) }, now);
        expect(w.ok && w.window.months.length).toBe(span + 1);
      }),
      { numRuns: 100 },
    );
  });
  it("partial-month custom ranges are window_not_on_grid, never silently expanded", () => {
    const now = ep(2028, 1, 1);
    const cases: [number, number][] = [
      [ep(2026, 9, 2), ep(2026, 10, 1)],
      [ep(2026, 9, 1), ep(2026, 9, 30)],
      [ep(2026, 9, 1) + 1000, ep(2026, 10, 1)],
      [ep(2026, 9, 1), ep(2026, 10, 1) + 1000],
      [ep(2026, 9, 10), ep(2026, 9, 20)],
    ];
    for (const [f, t] of cases) expect(gatedWindow({ from: iso(f, 0), to: iso(t, 0) }, now)).toEqual({ ok: false, error: "window_not_on_grid" });
  });
  it("Cairo DST: month end settles at the true local midnight (spring and autumn)", () => {
    const H = 3_600_000;
    const cases: [string, string][] = [
      ["2026-04", "2026-04-30T21:00:00Z"], // +03 already (DST starts last Friday of April): May 1 00:00 +03
      ["2026-09", "2026-09-30T21:00:00Z"], // +03
      ["2026-10", "2026-10-31T22:00:00Z"], // DST ended 29 Oct, so Nov 1 00:00 is +02
      ["2026-03", "2026-03-31T22:00:00Z"], // +02, before spring DST
    ];
    for (const [month, endIso] of cases) {
      const end = Date.parse(endIso);
      const at = (ms: number) => gatedWindow({ preset: `month:${month}` }, ms);
      expect(at(end + 48 * H - 1)).toEqual({ ok: true, window: { months: [], unsettled: [month] } });
      expect(at(end + 48 * H)).toEqual({ ok: true, window: { months: [month], unsettled: [] } });
    }
  });
  it("a full Cairo month written in any offset equals the month preset", () => {
    const now = ep(2028, 1, 1);
    for (const [y, m] of [[2026, 4], [2026, 10], [2027, 4]] as const) {
      const from = ep(y, m, 1), to = ep(y, m + 1, 1);
      const preset = gatedWindow({ preset: `month:${y}-${String(m).padStart(2, "0")}` }, now);
      for (const o of [0, 120, 180]) expect(gatedWindow({ from: iso(from, o), to: iso(to, o) }, now)).toEqual(preset);
    }
  });
});
