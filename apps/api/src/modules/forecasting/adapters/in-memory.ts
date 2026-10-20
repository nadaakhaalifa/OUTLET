import type {
  ForecastFlags,
  ForecastQuery,
  ForecastRecord,
  ForecastStore,
  LatestForecasts,
  RunSummary,
  SeriesRow,
} from "../domain/ports";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class InMemoryForecastStore implements ForecastStore {
  private readonly series = new Map<string, SeriesRow>();
  private readonly runs = new Map<string, RunSummary>();
  private readonly forecasts = new Map<string, ForecastRecord>();

  async upsertSeries(rows: readonly SeriesRow[], _nowMs?: number): Promise<{ upserted: number }> {
    for (const r of rows) this.series.set(`${r.storeId}|${r.skuId}|${r.governorate}|${r.day}`, { ...r });
    return { upserted: rows.length };
  }

  async loadSeries(storeId: string, fromDay: string, asOfDay: string): Promise<readonly SeriesRow[]> {
    return [...this.series.values()]
      .filter((r) => r.storeId === storeId && r.day >= fromDay && r.day <= asOfDay)
      .sort((a, b) => cmp(a.day, b.day) || cmp(a.skuId, b.skuId) || cmp(a.governorate, b.governorate));
  }

  async storesPendingRun(asOfDay: string, limit: number): Promise<readonly string[]> {
    const stores = new Set<string>();
    for (const r of this.series.values()) {
      if (r.day <= asOfDay && this.runs.get(`${r.storeId}|${asOfDay}`)?.status !== "completed") stores.add(r.storeId);
    }
    return [...stores].sort(cmp).slice(0, limit);
  }

  async saveCompletedRun(run: RunSummary, forecasts: readonly ForecastRecord[]): Promise<{ inserted: number }> {
    const key = `${run.storeId}|${run.asOfDay}`;
    if (this.runs.get(key)?.status === "completed") return { inserted: 0 };
    let inserted = 0;
    for (const f of forecasts) {
      const k = `${f.storeId}|${f.scope}|${f.scopeKey}|${f.horizonDays}|${f.asOfDay}`;
      if (this.forecasts.has(k)) continue;
      this.forecasts.set(k, f);
      inserted += 1;
    }
    this.runs.set(key, run);
    return { inserted };
  }

  async saveFailedRun(run: RunSummary): Promise<void> {
    const key = `${run.storeId}|${run.asOfDay}`;
    if (this.runs.get(key)?.status === "completed") return;
    this.runs.set(key, run);
  }

  async latest(storeId: string, q: ForecastQuery): Promise<LatestForecasts> {
    const runs = [...this.runs.values()].filter((r) => r.storeId === storeId).sort((a, b) => cmp(b.asOfDay, a.asOfDay));
    const lastRun = runs[0] ?? null;
    const completed = runs.find((r) => r.status === "completed");
    if (completed === undefined) return { items: [], hasMore: false, lastRun };
    const rows = [...this.forecasts.values()]
      .filter(
        (f) =>
          f.storeId === storeId &&
          f.asOfDay === completed.asOfDay &&
          (q.scope === undefined || f.scope === q.scope) &&
          (q.scopeKey === undefined || f.scopeKey === q.scopeKey) &&
          (q.horizonDays === undefined || f.horizonDays === q.horizonDays),
      )
      .sort((a, b) => cmp(a.scope, b.scope) || cmp(a.scopeKey, b.scopeKey) || a.horizonDays - b.horizonDays);
    return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit, lastRun };
  }

  /** Test helper. */
  seriesCount(): number {
    return this.series.size;
  }
}

/** Toggleable flags for tests and development. */
export class StaticForecastFlags implements ForecastFlags {
  constructor(private on = true) {}
  set(on: boolean): void {
    this.on = on;
  }
  async enabled(): Promise<boolean> {
    return this.on;
  }
}

