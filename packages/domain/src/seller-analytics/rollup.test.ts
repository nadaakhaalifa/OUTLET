import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  aggregateDeltas,
  aggregateFacts,
  compareKeys,
  diffRollups,
  factDeltas,
  hourStart,
  keyString,
  orderDeltas,
  repairedValues,
  type AggregatableFact,
  type RollupKey,
  type RollupRowState,
} from "./rollup";

const STORE = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const HOUR = 3_600_000;

describe("factDeltas", () => {
  it("counts funnel events in the hour of the event", () => {
    const at = T0 + 25 * 60_000;
    expect(factDeltas({ kind: "view", storeId: STORE, occurredAtMs: at })).toEqual([
      { key: { scope: "seller", storeId: STORE, metric: "product_views", hourUtcMs: T0 }, delta: 1n },
    ]);
    expect(factDeltas({ kind: "store_view", storeId: STORE, occurredAtMs: at })[0]?.key.metric).toBe("store_views");
    expect(factDeltas({ kind: "impression", storeId: STORE, occurredAtMs: at })[0]?.key.metric).toBe("impressions");
  });

  it("a purchase adds money and units for the seller and for the platform, in piastres", () => {
    const d = factDeltas({ kind: "purchase", storeId: STORE, occurredAtMs: T0, qty: 3, grossMinor: 2_500_000_000_000_000_001n, commissionMinor: 250n });
    const byMetric = Object.fromEntries(d.map((x) => [`${x.key.scope}.${x.key.metric}`, x.delta]));
    expect(byMetric).toEqual({
      "seller.gmv_minor": 2_500_000_000_000_000_001n,
      "seller.commission_minor": 250n,
      "seller.units": 3n,
      "seller.purchases": 1n,
      "platform.units_purchased": 3n,
      "platform.gmv_purchased_minor": 2_500_000_000_000_000_001n,
    });
  });

  it("returns add returned units; search clicks and stock snapshots add nothing", () => {
    expect(factDeltas({ kind: "return", storeId: STORE, occurredAtMs: T0, qty: 2 })[0]).toMatchObject({ delta: 2n, key: { metric: "returned_units" } });
    expect(factDeltas({ kind: "search_click", storeId: STORE, occurredAtMs: T0 })).toEqual([]);
    expect(factDeltas({ kind: "stock_snapshot", storeId: STORE, occurredAtMs: T0 })).toEqual([]);
  });
});

describe("orderDeltas: a seller order counts once, in the hour of its earliest purchase fact", () => {
  it("first fact counts +1", () => {
    expect(orderDeltas(STORE, null, T0 + 5)).toEqual([{ key: { scope: "seller", storeId: STORE, metric: "orders", hourUtcMs: T0 }, delta: 1n }]);
  });
  it("a later fact of the same order changes nothing", () => {
    expect(orderDeltas(STORE, T0, T0 + 3 * HOUR)).toEqual([]);
    expect(orderDeltas(STORE, T0, T0)).toEqual([]);
  });
  it("an earlier fact arriving late moves the order to the earlier hour", () => {
    const d = orderDeltas(STORE, T0 + 2 * HOUR, T0);
    expect(d.map((x) => [x.key.hourUtcMs, x.delta])).toEqual([[T0 + 2 * HOUR, -1n], [T0, 1n]]);
  });
  it("an earlier fact in the same hour changes nothing", () => {
    expect(orderDeltas(STORE, T0 + 40 * 60_000, T0 + 10 * 60_000)).toEqual([]);
  });
});

describe("aggregateDeltas", () => {
  it("merges per key, drops zero sums and sorts by key", () => {
    const k = (store: string, metric: string, h: number): RollupKey => ({ scope: "seller", storeId: store, metric, hourUtcMs: h });
    const out = aggregateDeltas([
      { key: k(OTHER, "orders", T0), delta: 1n },
      { key: k(STORE, "units", T0 + HOUR), delta: 2n },
      { key: k(STORE, "units", T0 + HOUR), delta: 3n },
      { key: k(STORE, "orders", T0), delta: 1n },
      { key: k(STORE, "orders", T0), delta: -1n },
    ]);
    expect(out.map((d) => [d.key.storeId, d.key.metric, d.delta])).toEqual([[STORE, "units", 5n], [OTHER, "orders", 1n]]);
    const keys = out.map((d) => d.key);
    expect([...keys].sort(compareKeys)).toEqual(keys);
  });
});

describe("diffRollups and repairedValues", () => {
  const key: RollupKey = { scope: "seller", storeId: STORE, metric: "units", hourUtcMs: T0 };
  const state = (value: bigint, held = 0n, version = 4n): RollupRowState => ({ value, held, version });
  const facts = (total: bigint) => new Map([[keyString(key), { key, total }]]);
  const rows = (s: RollupRowState) => new Map([[keyString(key), { key, state: s }]]);

  it("no difference when value plus held equals the facts", () => {
    expect(diffRollups(facts(10n), rows(state(7n, 3n)))).toEqual([]);
  });
  it("a changed existing row, a row without facts and a new key are reported", () => {
    expect(diffRollups(facts(10n), rows(state(9n)))).toEqual([{ kind: "existing", key, expected: 10n, actual: state(9n) }]);
    expect(diffRollups(new Map(), rows(state(2n)))).toEqual([{ kind: "existing", key, expected: 0n, actual: state(2n) }]);
    expect(diffRollups(facts(5n), new Map())).toEqual([{ kind: "new_key", key, expected: 5n }]);
  });
  it("repair preserves the held part while it fits", () => {
    expect(repairedValues(10n, 3n)).toEqual({ value: 7n, held: 3n });
    expect(repairedValues(2n, 3n)).toEqual({ value: 0n, held: 2n });
    expect(repairedValues(0n, 0n)).toEqual({ value: 0n, held: 0n });
  });
});

describe("aggregateFacts (the facts side of reconciliation)", () => {
  const f = (kind: string, at: number, extra: Partial<AggregatableFact> = {}): AggregatableFact => ({ kind, storeId: STORE, occurredAtMs: at, ...extra });

  it("counts a seller order once, in the hour of its earliest fact, even when later lines fall in other hours", () => {
    const facts: AggregatableFact[] = [
      f("purchase", T0 + 10, { sellerOrderId: "o1", qty: 1, grossMinor: 100n, commissionMinor: 10n }),
      f("purchase", T0 + 2 * HOUR, { sellerOrderId: "o1", qty: 2, grossMinor: 200n, commissionMinor: 20n }),
      f("purchase", T0 + 2 * HOUR + 5, { sellerOrderId: "o2", qty: 1, grossMinor: 50n, commissionMinor: 5n }),
    ];
    const agg = aggregateFacts("seller", facts, T0, T0 + 3 * HOUR);
    const get = (metric: string, h: number) => agg.get(keyString({ scope: "seller", storeId: STORE, metric, hourUtcMs: h }))?.total;
    expect(get("orders", T0)).toBe(1n);
    expect(get("orders", T0 + 2 * HOUR)).toBe(1n);
    expect(get("units", T0 + 2 * HOUR)).toBe(3n);
    expect(get("gmv_minor", T0)).toBe(100n);
  });

  it("an order whose earliest fact is before the window is not counted inside it", () => {
    const facts = [f("purchase", T0 - HOUR, { sellerOrderId: "o1", qty: 1, grossMinor: 1n, commissionMinor: 0n }), f("purchase", T0 + 5, { sellerOrderId: "o1", qty: 1, grossMinor: 1n, commissionMinor: 0n })];
    const agg = aggregateFacts("seller", facts, T0, T0 + HOUR);
    expect(agg.get(keyString({ scope: "seller", storeId: STORE, metric: "orders", hourUtcMs: T0 }))).toBeUndefined();
    expect(agg.get(keyString({ scope: "seller", storeId: STORE, metric: "units", hourUtcMs: T0 }))?.total).toBe(1n);
  });

  it("platform scope only holds the metrics derivable from facts", () => {
    const agg = aggregateFacts("platform", [f("purchase", T0, { sellerOrderId: "o1", qty: 4, grossMinor: 9n, commissionMinor: 0n }), f("view", T0)], T0, T0 + HOUR);
    expect([...agg.values()].map((x) => x.key.metric).sort()).toEqual(["gmv_purchased_minor", "units_purchased"]);
  });

  it("property: applying fact deltas incrementally (any order) equals the aggregation, orders included", () => {
    const fact = fc.record({
      kind: fc.constantFrom("store_view", "view", "impression", "save", "bag", "checkout", "purchase", "return"),
      storeId: fc.constantFrom(STORE, OTHER),
      occurredAtMs: fc.integer({ min: T0, max: T0 + 6 * HOUR - 1 }),
      qty: fc.integer({ min: 1, max: 5 }),
      grossMinor: fc.bigInt({ min: 1n, max: 1_000_000n }),
      commissionMinor: fc.constant(0n),
      sellerOrderId: fc.constantFrom("o1", "o2", "o3"),
    });
    fc.assert(
      fc.property(fc.array(fact, { maxLength: 40 }), fc.integer(), (facts, seed) => {
        const shuffled = [...facts].sort((a, b) => ((a.occurredAtMs ^ seed) % 7) - ((b.occurredAtMs ^ seed) % 7));
        const seen: AggregatableFact[] = [];
        const state = new Map<string, bigint>();
        for (const e of shuffled) {
          const ds = [...factDeltas(e)];
          if (e.kind === "purchase") {
            const prior = seen.filter((p) => p.kind === "purchase" && p.storeId === e.storeId && p.sellerOrderId === e.sellerOrderId);
            ds.push(...orderDeltas(e.storeId, prior.length === 0 ? null : Math.min(...prior.map((p) => p.occurredAtMs)), e.occurredAtMs));
          }
          for (const d of aggregateDeltas(ds)) state.set(keyString(d.key), (state.get(keyString(d.key)) ?? 0n) + d.delta);
          seen.push(e);
        }
        for (const scope of ["seller", "platform"] as const) {
          const want = aggregateFacts(scope, facts, hourStart(T0), hourStart(T0) + 7 * HOUR);
          const got = new Map([...state].filter(([k, v]) => k.startsWith(`${scope}|`) && v !== 0n));
          expect(new Map([...got].map(([k, v]) => [k, v]))).toEqual(new Map([...want].map(([k, v]) => [k, v.total])));
        }
        for (const v of state.values()) expect(v).toBeGreaterThanOrEqual(0n);
      }),
      { numRuns: 500 },
    );
  });
});
