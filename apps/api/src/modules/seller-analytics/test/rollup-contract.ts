import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { aggregateFacts, keyString, type AggregatableFact, type RollupKey, type RollupScope } from "../domain/bridge";
import type { AnalyticsStore, SourceEvent } from "../domain/ports";
import type { ShopperFactsEraser } from "../domain/erasure-ports";
import type { RollupMaintenance } from "../domain/rollup-ports";
import { ReconcileRollups } from "../application/reconcile";
import { DAY, NOW, P1, P2, SKU_L, SKU_M, STORE_A, STORE_B, T0, U, ev, purchase } from "./repository-contract";

const HOUR = 3_600_000;
const H0 = Math.floor((T0 - DAY) / HOUR) * HOUR;

export interface RollupSubject {
  readonly store: AnalyticsStore & RollupMaintenance;
  /** Removes every fact, inbox row and rollup row. */
  reset(): Promise<void>;
  /** value + held_value of one rollup row (0 when there is no row). */
  value(scope: RollupScope, storeId: string | null, metric: string, hourMs: number): Promise<bigint>;
  hasRow(scope: RollupScope, storeId: string | null, metric: string, hourMs: number): Promise<boolean>;
  /** Writes a row directly (corruption for the repair tests). */
  setRow(scope: RollupScope, storeId: string | null, metric: string, hourMs: number, value: bigint, held?: bigint): Promise<void>;
  deleteRows(): Promise<void>;
  deleteRowsOf(scope: RollupScope, storeId: string | null, metric: string, hourMs: number): Promise<void>;
  /** Reconciliation rows written so far, oldest first. */
  recorded(): Promise<readonly { scope: string; outcome: string; mismatches: number; corrected: number; skippedConcurrent: number }[]>;
  readonly eraser: ShopperFactsEraser;
  /** Shopper keys currently stored in facts, sorted (test only; no read path returns them). */
  shopperKeys(): Promise<readonly string[]>;
  /** The facts as aggregatable rows (the oracle input). */
  facts(): Promise<readonly AggregatableFact[]>;
}

let idSeq = 0;
export const ctx = (): { now: () => number; ids: { uuidV7: () => string } } => ({ now: () => NOW, ids: { uuidV7: () => U(900_000 + ++idSeq) } });

/** What the rollups must equal, computed independently from the stored facts. */
export async function expectRollupsEqualFacts(s: RollupSubject, scope: RollupScope, fromMs = H0 - 48 * HOUR, toMs = H0 + 72 * HOUR): Promise<void> {
  const want = aggregateFacts(scope, await s.facts(), fromMs, toMs);
  for (const { key, total } of want.values()) expect(await s.value(key.scope, key.storeId, key.metric, key.hourUtcMs), keyString(key)).toBe(total);
  const snap = await s.store.snapshot(scope, { fromMs, toMs });
  for (const [k, r] of snap.rows) expect(r.state.value + r.state.held, `row ${k}`).toBe(want.get(k)?.total ?? 0n);
}

const mk = (s: RollupSubject): ReconcileRollups => {
  const c = ctx();
  return new ReconcileRollups({ rollups: s.store, clock: { nowMs: c.now }, ids: c.ids });
};

/** Behaviour every rollup implementation must have. Run against in-memory and Kysely/PGlite. */
export function describeRollupContract(name: string, make: () => Promise<RollupSubject>, opts: { runs: number } = { runs: 100 }): void {
  describe(`Analytics rollups contract: ${name}`, () => {
    let s: RollupSubject;
    beforeEach(async () => {
      s = await make();
    });

    const sample = (): SourceEvent[] => [
      ev({ kind: "store_view", source: "feed" }, { at: H0 + 5 * 60_000 }),
      ev({ kind: "view", productId: P1 }, { at: H0 + 6 * 60_000 }),
      ev({ kind: "view", productId: P1 }, { at: H0 + HOUR + 1 }),
      ev({ kind: "impression", productId: P1 }, { at: H0 + 7 * 60_000 }),
      ev({ kind: "save", productId: P1 }, { at: H0 + 8 * 60_000 }),
      ev({ kind: "bag", productId: P1 }, { at: H0 + 9 * 60_000 }),
      ev({ kind: "checkout", productId: P1 }, { at: H0 + 10 * 60_000 }),
      purchase(1, SKU_M, P1, 2, 20_000n, { at: H0 + 11 * 60_000 }),
      purchase(1, SKU_L, P1, 1, 10_001n, { at: H0 + 2 * HOUR }),
      purchase(2, SKU_M, P2, 1, 5_000n, { at: H0 + 2 * HOUR + 5, store: STORE_B }),
      ev({ kind: "return", productId: P1, skuId: SKU_M, qty: 1, reason: "too_small" }, { at: H0 + 3 * HOUR }),
      ev({ kind: "search_click", term: "linen" }, { at: H0 + 3 * HOUR }),
    ];

    it("consumers add the additive deltas of every fact in the hour of the event", async () => {
      await s.store.ingest("c", sample(), NOW);
      expect(await s.value("seller", STORE_A, "store_views", H0)).toBe(1n);
      expect(await s.value("seller", STORE_A, "product_views", H0)).toBe(1n);
      expect(await s.value("seller", STORE_A, "product_views", H0 + HOUR)).toBe(1n);
      expect(await s.value("seller", STORE_A, "gmv_minor", H0)).toBe(20_000n);
      expect(await s.value("seller", STORE_A, "gmv_minor", H0 + 2 * HOUR)).toBe(10_001n);
      expect(await s.value("seller", STORE_A, "commission_minor", H0)).toBe(2_000n);
      expect(await s.value("seller", STORE_A, "units", H0)).toBe(2n);
      expect(await s.value("seller", STORE_A, "purchases", H0)).toBe(1n);
      expect(await s.value("seller", STORE_A, "returned_units", H0 + 3 * HOUR)).toBe(1n);
      expect(await s.value("seller", STORE_B, "gmv_minor", H0 + 2 * HOUR)).toBe(5_000n);
      expect(await s.value("platform", null, "gmv_purchased_minor", H0 + 2 * HOUR)).toBe(15_001n);
      expect(await s.value("platform", null, "units_purchased", H0 + 2 * HOUR)).toBe(2n);
    });

    it("an order is counted once, in the hour of its earliest line, whatever the delivery order", async () => {
      // Order 1 has lines in hour 0 and hour 2: delivered later line first.
      await s.store.ingest("c", [purchase(1, SKU_L, P1, 1, 10_001n, { at: H0 + 2 * HOUR })], NOW);
      expect(await s.value("seller", STORE_A, "orders", H0 + 2 * HOUR)).toBe(1n);
      await s.store.ingest("c", [purchase(1, SKU_M, P1, 2, 20_000n, { at: H0 + 11 * 60_000 })], NOW);
      expect(await s.value("seller", STORE_A, "orders", H0 + 2 * HOUR)).toBe(0n);
      expect(await s.value("seller", STORE_A, "orders", H0)).toBe(1n);
      await expectRollupsEqualFacts(s, "seller");
    });

    it("a message delivered twice is counted once", async () => {
      const e = sample();
      await s.store.ingest("c", e, NOW);
      expect(await s.store.ingest("c", [...e].reverse(), NOW)).toEqual({ applied: 0, duplicates: e.length });
      await expectRollupsEqualFacts(s, "seller");
      await expectRollupsEqualFacts(s, "platform");
      expect(await s.value("seller", STORE_A, "units", H0)).toBe(2n);
    });

    it("the reconciler reports ok on consistent data", async () => {
      await s.store.ingest("c", sample(), NOW);
      const r = await mk(s).hourly();
      expect(r.mismatches).toBe(0);
      expect(r.corrected).toBe(0);
      expect(r.runs).toBe(2);
    });

    it("the reconciler restores a corrupted value, removes a phantom row's value and creates a missing key", async () => {
      await s.store.ingest("c", sample(), NOW);
      await s.setRow("seller", STORE_A, "gmv_minor", H0, 1n);
      await s.setRow("seller", STORE_A, "bags", H0 + 4 * HOUR, 7n); // no facts at all
      await s.setRow("platform", null, "units_purchased", H0 + 2 * HOUR, 99n);
      await s.deleteRowsOf("seller", STORE_A, "units", H0);
      const r = await mk(s).hourly();
      expect(r.mismatches).toBe(4);
      expect(r.corrected).toBe(4);
      expect(await s.value("seller", STORE_A, "gmv_minor", H0)).toBe(20_000n);
      expect(await s.value("seller", STORE_A, "bags", H0 + 4 * HOUR)).toBe(0n);
      expect(await s.value("platform", null, "units_purchased", H0 + 2 * HOUR)).toBe(2n);
      expect(await s.value("seller", STORE_A, "units", H0)).toBe(2n);
      expect((await mk(s).hourly()).mismatches).toBe(0);
      await expectRollupsEqualFacts(s, "seller");
    });

    it("the reconciler keeps the held part of a row (anomaly guard) and compares against value + held", async () => {
      await s.store.ingest("c", [ev({ kind: "view", productId: P1 }, { at: H0 }), ev({ kind: "view", productId: P1 }, { at: H0 + 1 })], NOW);
      await s.setRow("seller", STORE_A, "product_views", H0, 0n, 2n);
      expect((await mk(s).hourly()).mismatches).toBe(0);
      await s.setRow("seller", STORE_A, "product_views", H0, 0n, 5n);
      const r = await mk(s).hourly();
      expect(r.corrected).toBe(1);
      expect(await s.value("seller", STORE_A, "product_views", H0)).toBe(2n);
    });

    it("a row touched by a consumer after the snapshot is skipped, never overwritten (version compare-and-set)", async () => {
      await s.store.ingest("c", [ev({ kind: "view", productId: P1 }, { at: H0 })], NOW);
      await s.setRow("seller", STORE_A, "product_views", H0, 5n); // drift: facts say 1
      const store = s.store;
      const racing: RollupMaintenance = {
        snapshot: (sc, w) => store.snapshot(sc, w),
        casRepair: async (key, expected, v) => {
          // A consumer commits an increment between the reconciler's snapshot and its repair.
          if (key.metric === "product_views") await store.ingest("c", [ev({ kind: "view", productId: P1 }, { at: H0 + 2 })], NOW);
          return store.casRepair(key, expected, v);
        },
        repairNewKey: (k) => store.repairNewKey(k),
        record: (r) => store.record(r),
        firstFactMs: () => store.firstFactMs(),
        maintainPartitions: (a, b, c) => store.maintainPartitions(a, b, c),
        defaultPartitionRows: () => store.defaultPartitionRows(),
      };
      const c = ctx();
      const run = await new ReconcileRollups({ rollups: racing, clock: { nowMs: c.now }, ids: c.ids }).hourly();
      expect(run.skippedConcurrent).toBe(1);
      expect(run.corrected).toBe(0);
      // The consumer's increment survived on top of the drifted value; the next run repairs it.
      expect(await s.value("seller", STORE_A, "product_views", H0)).toBe(6n);
      expect((await mk(s).hourly()).corrected).toBe(1);
      expect(await s.value("seller", STORE_A, "product_views", H0)).toBe(2n);
    });

    it("backfill creates rollups for existing facts and a second run finds nothing", async () => {
      await s.store.ingest("c", sample(), NOW);
      await s.deleteRows();
      const first = await mk(s).backfill();
      expect(first.mismatches).toBeGreaterThan(0);
      expect(first.corrected).toBe(first.mismatches);
      await expectRollupsEqualFacts(s, "seller");
      await expectRollupsEqualFacts(s, "platform");
      expect((await mk(s).backfill()).mismatches).toBe(0);
    });

    it("every reconciliation run is recorded with its counts", async () => {
      await s.store.ingest("c", sample(), NOW);
      await s.setRow("seller", STORE_A, "gmv_minor", H0, 1n);
      await mk(s).hourly();
      const recorded = await s.recorded();
      expect(recorded.map((r) => [r.scope, r.outcome])).toEqual([["seller", "corrected"], ["platform", "ok"]]);
      expect(recorded[0]).toMatchObject({ mismatches: 1, corrected: 1, skippedConcurrent: 0 });
    });

    it("property: every message delivered twice, in random order, gives rollups equal to the facts and an ok reconciliation", async () => {
      const metricEvent = fc.oneof(
        fc.record({ k: fc.constantFrom("store_view", "view", "impression", "save", "bag", "checkout"), h: fc.integer({ min: 0, max: 5 }), store: fc.constantFrom(STORE_A, STORE_B), m: fc.integer({ min: 0, max: 59 }) }).map((x) =>
          ev(x.k === "store_view" ? { kind: "store_view", source: "feed" } : { kind: x.k as "view", productId: P1 }, { at: H0 + x.h * HOUR + x.m * 60_000, store: x.store }),
        ),
        fc.record({ o: fc.integer({ min: 1, max: 4 }), h: fc.integer({ min: 0, max: 5 }), q: fc.integer({ min: 1, max: 4 }), g: fc.integer({ min: 100, max: 99_999 }), store: fc.constantFrom(STORE_A, STORE_B) }).map((x) =>
          purchase(x.o, x.q % 2 === 0 ? SKU_M : SKU_L, P1, x.q, BigInt(x.g), { at: H0 + x.h * HOUR + x.o, store: x.store }),
        ),
        fc.record({ h: fc.integer({ min: 0, max: 5 }), q: fc.integer({ min: 1, max: 3 }) }).map((x) => ev({ kind: "return", productId: P1, skuId: SKU_M, qty: x.q, reason: "too_small" }, { at: H0 + x.h * HOUR })),
      );
      await fc.assert(
        fc.asyncProperty(fc.array(metricEvent, { minLength: 1, maxLength: 25 }), fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 60, maxLength: 60 }), async (events, noise) => {
          await s.reset();
          const doubled = [...events, ...events].map((e, i) => ({ e, r: noise[i % noise.length] ?? 0 })).sort((a, b) => a.r - b.r).map((x) => x.e);
          for (let i = 0; i < doubled.length; i += 7) await s.store.ingest("c", doubled.slice(i, i + 7), NOW);
          await expectRollupsEqualFacts(s, "seller");
          await expectRollupsEqualFacts(s, "platform");
          const r = await mk(s).hourly();
          expect(r.mismatches).toBe(0);
          // Rollup sums equal totals: the sum over hours of units equals the sum of purchase qty.
          const facts = await s.facts();
          const units = facts.filter((f) => f.kind === "purchase").reduce((n, f) => n + BigInt(f.qty ?? 0), 0n);
          let sumUnits = 0n;
          for (let h = -48; h < 72; h += 1) for (const st of [STORE_A, STORE_B]) sumUnits += await s.value("seller", st, "units", H0 + h * HOUR);
          expect(sumUnits).toBe(units);
        }),
        { numRuns: opts.runs },
      );
    });

    it("an erased shopper key is stored as NULL when an old payload arrives later (H3 step 3)", async () => {
      const key = "px_erased_key_0000000001";
      await s.eraser.recordErasedKeys([key], NOW);
      await s.store.ingest("c", [{ ...ev({ kind: "view", productId: P1 }, { at: H0 }), shopperKey: key }, ev({ kind: "view", productId: P1 }, { at: H0 + 1, shopper: 7 })], NOW);
      expect(await s.shopperKeys()).toEqual(["shopper-key-000007"]);
    });
  });
}

export type { RollupKey };
