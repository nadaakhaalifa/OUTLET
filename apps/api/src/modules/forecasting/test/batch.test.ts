import { describe, expect, it } from "vitest";
import { InMemoryForecastStore, StaticForecastFlags } from "../adapters/in-memory";
import { buildStoreForecasts } from "../application/build";
import { IngestDemandSeries, RunForecastBatch, SellerForecastQueries, STALE_AFTER_MS } from "../application/forecasting";
import type { ForecastRecord, ForecastStore } from "../domain/ports";
import { AS_OF, NOW_MS, SKU_L, SKU_M, STORE_A, STORE_B, U, seriesRows } from "./fixtures";

let n = 0;
const nid = (): string => U(++n + 70_000);
const clock = { nowMs: () => NOW_MS };
const ids = { uuidV7: nid, hex: () => "ab" };

async function seeded() {
  const store = new InMemoryForecastStore();
  const flags = new StaticForecastFlags(true);
  await store.upsertSeries(
    [
      ...seriesRows({ sku: SKU_M, size: "M", base: 5, seed: 11 }),
      ...seriesRows({ sku: SKU_L, size: "L", base: 3, seed: 12 }),
      ...seriesRows({ store: STORE_B, sku: U(40), base: 4, seed: 13 }),
    ],
    NOW_MS,
  );
  return { store, flags, batch: new RunForecastBatch(store, flags, clock, ids), queries: new SellerForecastQueries(store, flags, clock) };
}

describe("buildStoreForecasts", () => {
  const rows = [
    ...seriesRows({ sku: SKU_M, size: "M", base: 5, seed: 11 }),
    ...seriesRows({ sku: SKU_L, size: "L", base: 3, seed: 12 }),
  ];
  const built = buildStoreForecasts(STORE_A, rows, AS_OF, NOW_MS, nid);
  const pick = (scope: string, key: string, h: number): ForecastRecord => {
    const r = built.records.find((x) => x.scope === scope && x.scopeKey === key && x.horizonDays === h);
    if (r === undefined) throw new Error(`missing ${scope} ${key} ${h}`);
    return r;
  };

  it("emits 7/14/28 for each of sku, category, category_size and category_governorate cells", () => {
    expect(built.records).toHaveLength(3 * (2 + 1 + 2 + 1)); // a suppressed cell is still emitted, without numbers
  });

  it("every ok record has an ordered integer interval; every non-ok record has no number", () => {
    for (const r of built.records) {
      if (r.status === "ok") {
        expect(Number.isInteger(r.p10) && Number.isInteger(r.p50) && Number.isInteger(r.p90)).toBe(true);
        expect((r.p10 ?? 0) <= (r.p50 ?? 0) && (r.p50 ?? 0) <= (r.p90 ?? 0)).toBe(true);
      } else {
        expect([r.p10, r.p50, r.p90, r.model]).toEqual([null, null, null, null]);
      }
    }
  });

  it("size and SKU medians sum exactly to the category median (hierarchical reconciliation)", () => {
    for (const h of [7, 14, 28]) {
      const cat = pick("category", "dresses", h);
      const sizes = built.records.filter((r) => r.scope === "category_size" && r.horizonDays === h);
      const skus = built.records.filter((r) => r.scope === "sku" && r.horizonDays === h);
      expect(sizes.reduce((s, r) => s + (r.p50 ?? 0), 0)).toBe(cat.p50);
      expect(skus.reduce((s, r) => s + (r.p50 ?? 0), 0)).toBe(cat.p50);
      expect(sizes[0]?.reasonCodes).toContain("reconciled_to_parent");
    }
  });

  it("a governorate cell below 50 distinct shoppers on every day is suppressed with no numbers", () => {
    const g = pick("category_governorate", "dresses|Cairo", 7);
    expect(g).toMatchObject({ status: "suppressed", p10: null, p50: null, p90: null, reasonCodes: ["k_anonymity_below_minimum"] });
  });

  it("a governorate cell with >= 50 distinct shoppers on some day is released", () => {
    const big = seriesRows({ sku: SKU_M, base: 90, seed: 5, shoppersPerDay: 1000, governorate: "Giza" });
    const b = buildStoreForecasts(STORE_A, big, AS_OF, NOW_MS, nid);
    const g = b.records.find((r) => r.scope === "category_governorate" && r.horizonDays === 7);
    expect(g?.status).toBe("ok");
  });

  it("fewer than 20 comparable units: insufficient_history, no numbers", () => {
    const tiny = seriesRows({ sku: U(77), base: 0.05, seed: 3 });
    const b = buildStoreForecasts(STORE_A, tiny, AS_OF, NOW_MS, nid);
    expect(b.records.every((r) => r.status !== "ok" && r.p50 === null)).toBe(true);
    expect(b.records.some((r) => r.status === "insufficient_history")).toBe(true);
  });

  it("stock-out days are flagged censored in the reasons and not treated as zero", () => {
    const rows2 = seriesRows({ sku: SKU_M, base: 6, seed: 9, censorEvery: 20 });
    const b = buildStoreForecasts(STORE_A, rows2, AS_OF, NOW_MS, nid);
    const r = b.records.find((x) => x.scope === "sku" && x.horizonDays === 28);
    expect(r?.reasonCodes).toContain("stockout_days_excluded");
  });

  it("is deterministic and the run summary counts series", () => {
    const again = buildStoreForecasts(STORE_A, rows, AS_OF, NOW_MS, () => "fixed");
    const first = buildStoreForecasts(STORE_A, rows, AS_OF, NOW_MS, () => "fixed");
    expect(again).toEqual(first);
    expect(built.summary.seriesTotal).toBe(built.summary.okCount + built.summary.insufficientCount + built.summary.suppressedCount);
  });
});

describe("RunForecastBatch", () => {
  it("is idempotent: a second run for the same day writes nothing", async () => {
    const { batch, store } = await seeded();
    const first = await batch.execute(AS_OF, 10);
    expect(first).toMatchObject({ stores: 2, completed: 2, failed: 0, disabled: 0 });
    expect(first.forecasts).toBeGreaterThan(0);
    const second = await batch.execute(AS_OF, 10);
    expect(second).toMatchObject({ stores: 0, completed: 0, forecasts: 0 });
    const a = await store.latest(STORE_A, { limit: 200 });
    expect(a.items.length).toBe(first.forecasts - (await store.latest(STORE_B, { limit: 200 })).items.length);
  });

  it("a failing store is recorded as failed, the others complete, and the old forecast turns stale", async () => {
    const { batch, store, queries } = await seeded();
    await batch.execute(AS_OF, 10);
    const failing: ForecastStore = new Proxy(store, {
      get(t, p, r) {
        if (p === "loadSeries") {
          return async (storeId: string, ...rest: [string, string]) => {
            if (storeId === STORE_A) throw new Error("warehouse timeout");
            return t.loadSeries(storeId, ...rest);
          };
        }
        const v = Reflect.get(t, p, r) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    // The next as-of day has data for both stores.
    const next = "2026-09-25";
    await store.upsertSeries(
      [
        ...seriesRows({ sku: SKU_M, base: 5, seed: 11 }).map((r) => ({ ...r, day: next })),
        ...seriesRows({ store: STORE_B, sku: U(40), base: 4, seed: 13 }).map((r) => ({ ...r, day: next })),
      ],
      NOW_MS,
    );
    const flags = new StaticForecastFlags(true);
    const res = await new RunForecastBatch(failing, flags, clock, ids).execute(next, 10);
    expect(res).toMatchObject({ stores: 2, completed: 1, failed: 1 });
    const view = await queries.list(STORE_A, {});
    expect(view.asOfDay).toBe(AS_OF); // previous forecast is still served
    expect(view.stale).toBe(true);
    expect((await queries.list(STORE_B, {})).stale).toBe(false);
    // Retry succeeds with the real store.
    expect(await batch.execute(next, 10)).toMatchObject({ completed: 1, failed: 0 });
    expect((await queries.list(STORE_A, {})).stale).toBe(false);
  });

  it("the kill switch stops the batch and the read", async () => {
    const { batch, flags, queries } = await seeded();
    flags.set(false);
    expect(await batch.execute(AS_OF, 10)).toMatchObject({ disabled: 1, completed: 0 });
    await expect(queries.list(STORE_A, {})).rejects.toThrow(/disabled/);
  });

  it("forecasts older than the tolerance are stale", async () => {
    const { batch, store, flags } = await seeded();
    await batch.execute(AS_OF, 10);
    const late = new SellerForecastQueries(store, flags, { nowMs: () => NOW_MS + STALE_AFTER_MS + 1 });
    expect((await late.list(STORE_A, {})).stale).toBe(true);
  });
});

describe("IngestDemandSeries", () => {
  it("accepts valid rows, rejects personal-data and inconsistent rows", async () => {
    const store = new InMemoryForecastStore();
    const ingest = new IngestDemandSeries(store, clock);
    const ok = seriesRows({ sku: SKU_M, base: 2, seed: 1, days: 3 });
    const res = await ingest.execute([
      ...ok,
      { ...ok[0], userId: "u-1" },
      { ...ok[0], budget: 5000 },
      { ...ok[0], unitsNet: 99, unitsGross: 1 },
      { ...ok[0], shoppers: 99, unitsGross: 1, unitsNet: 1 },
      { ...ok[0], day: "2026-13-40" },
    ]);
    expect(res).toEqual({ accepted: 3, rejected: 5 });
    expect(store.seriesCount()).toBe(3);
  });
});
