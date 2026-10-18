import { InMemoryAnalyticsStore } from "../adapters/in-memory";
import type { AggregatableFact, RollupScope } from "../domain/bridge";
import { keyString } from "../domain/bridge";
import { describeRollupContract, type RollupSubject } from "./rollup-contract";

const make = async (): Promise<RollupSubject> => {
  const store = new InMemoryAnalyticsStore();
  const r = store.rollups;
  const key = (scope: RollupScope, storeId: string | null, metric: string, hourMs: number) => ({ scope, storeId, metric, hourUtcMs: hourMs });
  return {
    store,
    eraser: store,
    async reset() {
      store.reset();
    },
    async value(scope, storeId, metric, hourMs) {
      return store.rollups.value(scope, storeId, metric, hourMs);
    },
    async hasRow(scope, storeId, metric, hourMs) {
      return store.rollups.rows.has(keyString(key(scope, storeId, metric, Math.floor(hourMs / 3_600_000) * 3_600_000)));
    },
    async setRow(scope, storeId, metric, hourMs, value, held = 0n) {
      const k = key(scope, storeId, metric, Math.floor(hourMs / 3_600_000) * 3_600_000);
      const cur = r.rows.get(keyString(k));
      r.rows.set(keyString(k), { key: k, value, held, version: (cur?.version ?? -1n) + 1n });
    },
    async deleteRows() {
      r.rows.clear();
    },
    async deleteRowsOf(scope, storeId, metric, hourMs) {
      r.rows.delete(keyString(key(scope, storeId, metric, Math.floor(hourMs / 3_600_000) * 3_600_000)));
    },
    async recorded() {
      return r.reconciliations.map((x) => ({ scope: x.scope, outcome: x.outcome, mismatches: x.mismatches, corrected: x.corrected, skippedConcurrent: x.skippedConcurrent }));
    },
    async shopperKeys() {
      return [...store.storedShopperKeys()].sort();
    },
    async facts(): Promise<readonly AggregatableFact[]> {
      return (await facts(store)) as readonly AggregatableFact[];
    },
  };
};

const facts = async (store: InMemoryAnalyticsStore): Promise<readonly AggregatableFact[]> => store.rollups.factSnapshot();

describeRollupContract("in-memory", make, { runs: 300 });
