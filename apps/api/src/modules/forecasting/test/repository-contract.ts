import { beforeEach, describe, expect, it } from "vitest";
import type { ForecastRecord, ForecastStore, RunSummary } from "../domain/ports";
import { AS_OF, NOW_MS, SKU_L, SKU_M, STORE_A, STORE_B, U, seriesRows } from "./fixtures";

export interface StoreContext {
  readonly store: ForecastStore;
}

export const run = (storeId: string, asOfDay: string, status: "completed" | "failed" = "completed"): RunSummary => ({
  storeId,
  asOfDay,
  status,
  seriesTotal: status === "completed" ? 2 : 0,
  okCount: status === "completed" ? 1 : 0,
  insufficientCount: status === "completed" ? 1 : 0,
  suppressedCount: 0,
  servedModels: status === "completed" ? { ets_seasonal: 1 } : {},
  meanWapeBps: status === "completed" ? 1500 : null,
  meanBaselineWapeBps: status === "completed" ? 1800 : null,
  meanPinballMilli: status === "completed" ? 900 : null,
  meanCoverageBps: status === "completed" ? 8000 : null,
  meanBiasBps: status === "completed" ? -120 : null,
  errorCode: status === "failed" ? "forecast_run_failed" : null,
  startedAtMs: NOW_MS,
  finishedAtMs: NOW_MS + 1000,
});

let seq = 9000;
export const okRecord = (storeId: string, key: string, h: 7 | 14 | 28, asOfDay = AS_OF): ForecastRecord => ({
  id: U(++seq),
  storeId,
  scope: "sku",
  scopeKey: key,
  horizonDays: h,
  asOfDay,
  model: "ets_seasonal",
  modelVersion: "baseline-v1",
  status: "ok",
  p10: 10,
  p50: 14,
  p90: 20,
  reasonCodes: ["weekly_seasonality", "model_beat_baseline"],
  comparableUnits: 120,
  observedDays: 84,
  backtestOrigins: 8,
  wapeBps: 1500,
  baselineWapeBps: 1800,
  pinballMilli: 900,
  coverageBps: 8000,
  biasBps: -120,
  generatedAtMs: NOW_MS,
});
export const emptyRecord = (storeId: string, key: string, h: 7 | 14 | 28, asOfDay = AS_OF): ForecastRecord => ({
  ...okRecord(storeId, key, h, asOfDay),
  model: null,
  status: "insufficient_history",
  p10: null,
  p50: null,
  p90: null,
  reasonCodes: ["units_below_minimum"],
  backtestOrigins: 0,
  wapeBps: null,
  baselineWapeBps: null,
  pinballMilli: null,
  coverageBps: null,
  biasBps: null,
});

/** Behaviour every ForecastStore must have. Run against in-memory and Kysely/PGlite. */
export function describeForecastStoreContract(name: string, make: () => Promise<StoreContext>): void {
  describe(`ForecastStore contract: ${name}`, () => {
    let s: ForecastStore;
    beforeEach(async () => {
      s = (await make()).store;
    });

    it("series upsert replaces by key (idempotent) and load is store- and window-scoped", async () => {
      const rows = seriesRows({ sku: SKU_M, base: 3, seed: 1, days: 10 });
      await s.upsertSeries(rows, NOW_MS);
      await s.upsertSeries(rows, NOW_MS);
      await s.upsertSeries(seriesRows({ store: STORE_B, sku: SKU_L, base: 3, seed: 2, days: 5 }), NOW_MS);
      const a = await s.loadSeries(STORE_A, "2000-01-01", "2100-01-01");
      expect(a).toHaveLength(10);
      expect(a.every((r) => r.storeId === STORE_A)).toBe(true);
      const first = rows[0];
      const changed = { ...first, unitsGross: 9, unitsNet: 8 } as typeof rows[number];
      await s.upsertSeries([changed], NOW_MS);
      const again = await s.loadSeries(STORE_A, changed.day, changed.day);
      expect(again).toHaveLength(1);
      expect(again[0]?.unitsNet).toBe(8);
    });

    it("storesPendingRun lists stores without a completed run and honors the limit", async () => {
      await s.upsertSeries(seriesRows({ sku: SKU_M, base: 3, seed: 1, days: 5 }), NOW_MS);
      await s.upsertSeries(seriesRows({ store: STORE_B, sku: SKU_L, base: 3, seed: 2, days: 5 }), NOW_MS);
      expect(await s.storesPendingRun("2100-01-01", 10)).toEqual([STORE_A, STORE_B]);
      expect(await s.storesPendingRun("2100-01-01", 1)).toEqual([STORE_A]);
      await s.saveCompletedRun(run(STORE_A, "2100-01-01"), []);
      expect(await s.storesPendingRun("2100-01-01", 10)).toEqual([STORE_B]);
      expect(await s.storesPendingRun("2100-01-02", 10)).toEqual([STORE_A, STORE_B]);
    });

    it("a completed run is stored once and never rewritten", async () => {
      const recs = [okRecord(STORE_A, SKU_M, 7), okRecord(STORE_A, SKU_M, 14), okRecord(STORE_A, SKU_M, 28)];
      expect(await s.saveCompletedRun(run(STORE_A, AS_OF), recs)).toEqual({ inserted: 3 });
      expect(await s.saveCompletedRun(run(STORE_A, AS_OF), [okRecord(STORE_A, SKU_L, 7)])).toEqual({ inserted: 0 });
      const got = await s.latest(STORE_A, { limit: 50 });
      expect(got.items.map((i) => [i.scopeKey, i.horizonDays])).toEqual([[SKU_M, 7], [SKU_M, 14], [SKU_M, 28]]);
      expect(got.lastRun?.status).toBe("completed");
      expect(got.lastRun?.meanCoverageBps).toBe(8000);
    });

    it("a failed run is recorded, retried, and cannot overwrite a completed run", async () => {
      await s.saveFailedRun(run(STORE_A, AS_OF, "failed"));
      expect((await s.latest(STORE_A, { limit: 10 })).lastRun?.status).toBe("failed");
      expect(await s.storesPendingRun(AS_OF, 10)).toEqual([]); // no series yet; nothing to run
      expect(await s.saveCompletedRun(run(STORE_A, AS_OF), [okRecord(STORE_A, SKU_M, 7)])).toEqual({ inserted: 1 });
      await s.saveFailedRun(run(STORE_A, AS_OF, "failed"));
      expect((await s.latest(STORE_A, { limit: 10 })).lastRun?.status).toBe("completed");
    });

    it("latest returns only the newest completed day, filters, paginates and keeps a failed later run visible", async () => {
      await s.saveCompletedRun(run(STORE_A, "2026-09-01"), [okRecord(STORE_A, SKU_M, 7, "2026-09-01")]);
      await s.saveCompletedRun(run(STORE_A, "2026-09-02"), [
        okRecord(STORE_A, SKU_M, 7, "2026-09-02"),
        okRecord(STORE_A, SKU_L, 7, "2026-09-02"),
        emptyRecord(STORE_A, SKU_L, 14, "2026-09-02"),
      ]);
      await s.saveFailedRun(run(STORE_A, "2026-09-03", "failed"));
      const all = await s.latest(STORE_A, { limit: 10 });
      expect(all.items.map((i) => i.asOfDay)).toEqual(["2026-09-02", "2026-09-02", "2026-09-02"]);
      expect(all.lastRun).toMatchObject({ asOfDay: "2026-09-03", status: "failed" });
      const one = await s.latest(STORE_A, { limit: 1 });
      expect(one.items).toHaveLength(1);
      expect(one.hasMore).toBe(true);
      const f = await s.latest(STORE_A, { scopeKey: SKU_L, horizonDays: 14, limit: 10 });
      expect(f.items).toHaveLength(1);
      expect(f.items[0]).toMatchObject({ status: "insufficient_history", p10: null, p50: null, p90: null, model: null });
    });

    it("latest never returns another store's forecasts", async () => {
      await s.saveCompletedRun(run(STORE_B, AS_OF), [okRecord(STORE_B, SKU_L, 7)]);
      expect((await s.latest(STORE_A, { limit: 10 })).items).toEqual([]);
      expect((await s.latest(STORE_B, { limit: 10 })).items).toHaveLength(1);
    });
  });
}
