import {
  HORIZONS,
  MODEL_VERSION,
  forecastSeries,
  geographyCellReleasable,
  prepareSeries,
  reconcileTopDown,
  shopperSupportLowerBound,
  type DemandInterval,
  type ForecastOk,
  type ForecastOutcome,
  type HorizonDays,
} from "../domain/bridge";
import type { ForecastRecord, ForecastScope, RunSummary, SeriesRow } from "../domain/ports";


interface Cell {
  readonly scope: ForecastScope;
  readonly key: string;
  /** Category the cell belongs to (parent for reconciliation). */
  readonly category: string;
  readonly rows: SeriesRow[];
}

type CellResult =
  | { readonly kind: "outcome"; readonly cell: Cell; readonly outcome: ForecastOutcome }
  | { readonly kind: "suppressed"; readonly cell: Cell; readonly support: number };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Group stored day rows into forecast cells. Deterministic: rows are sorted first. */
function cellsOf(rows: readonly SeriesRow[]): Cell[] {
  const sorted = [...rows].sort(
    (a, b) => cmp(a.skuId, b.skuId) || cmp(a.governorate, b.governorate) || cmp(a.day, b.day),
  );
  const cells = new Map<string, Cell>();
  const add = (scope: ForecastScope, key: string, category: string, row: SeriesRow): void => {
    const id = `${scope}\u0000${key}`;
    const cell = cells.get(id) ?? { scope, key, category, rows: [] };
    cell.rows.push(row);
    cells.set(id, cell);
  };
  for (const r of sorted) {
    add("sku", r.skuId, r.categoryCode, r);
    add("category", r.categoryCode, r.categoryCode, r);
    add("category_size", `${r.categoryCode}|${r.sizeLabel}`, r.categoryCode, r);
    add("category_governorate", `${r.categoryCode}|${r.governorate}`, r.categoryCode, r);
  }
  return [...cells.values()].sort((a, b) => cmp(a.scope, b.scope) || cmp(a.key, b.key));
}

function evaluate(cell: Cell, asOfDay: string): CellResult {
  if (cell.scope === "category_governorate") {
    const support = shopperSupportLowerBound(cell.rows.map((r) => r.shoppers));
    if (!geographyCellReleasable(support)) return { kind: "suppressed", cell, support };
  }
  const prepared = prepareSeries(
    cell.rows.map((r) => ({ day: r.day, unitsNet: r.unitsNet, censored: r.censored, flagged: r.flagged })),
    asOfDay,
  );
  return { kind: "outcome", cell, outcome: forecastSeries(prepared) };
}

export interface BuiltForecasts {
  readonly records: readonly ForecastRecord[];
  readonly summary: Omit<RunSummary, "storeId" | "asOfDay" | "status" | "errorCode" | "startedAtMs" | "finishedAtMs">;
}

/**
 * All forecasts for one store as of one Cairo day. Pure apart from `newId`.
 *
 * Reconciliation (spec acceptance "size forecasts sum to the SKU forecast"): where the category
 * forecast and every one of its children (SKUs, sizes, governorates) are `ok`, the children's
 * medians are apportioned from the category median so they sum exactly; otherwise the children are
 * left as forecast and tagged `not_reconciled_partial_children`.
 */
export function buildStoreForecasts(
  storeId: string,
  rows: readonly SeriesRow[],
  asOfDay: string,
  nowMs: number,
  newId: () => string,
): BuiltForecasts {
  const results = cellsOf(rows).map((c) => evaluate(c, asOfDay));
  const okOf = (r: CellResult): ForecastOk | null =>
    r.kind === "outcome" && r.outcome.status === "ok" ? r.outcome : null;

  // Per-horizon interval overrides and reason codes from reconciliation, keyed by cell.
  const override = new Map<string, Map<HorizonDays, DemandInterval>>();
  const extraReason = new Map<string, string>();
  const keyOf = (c: Cell): string => `${c.scope}\u0000${c.key}`;
  const parents = new Map<string, CellResult>();
  for (const r of results) if (r.cell.scope === "category") parents.set(r.cell.category, r);
  const childScopes: readonly ForecastScope[] = ["sku", "category_size", "category_governorate"];
  for (const [category, parent] of parents) {
    const parentOk = okOf(parent);
    if (parentOk === null) continue;
    for (const scope of childScopes) {
      const group = results.filter((r) => r.cell.scope === scope && r.cell.category === category);
      if (group.length === 0) continue;
      const oks = group.map(okOf);
      if (oks.some((o) => o === null)) {
        for (const r of group) if (okOf(r) !== null) extraReason.set(keyOf(r.cell), "not_reconciled_partial_children");
        continue;
      }
      for (const h of HORIZONS) {
        const parentInterval = parentOk.horizons.find((x) => x.horizonDays === h);
        if (parentInterval === undefined) continue;
        const children = group.map((r) => {
          const iv = okOf(r)?.horizons.find((x) => x.horizonDays === h);
          return { key: keyOf(r.cell), interval: iv ?? { p10: 0, p50: 0, p90: 0 } };
        });
        for (const c of reconcileTopDown(parentInterval, children)) {
          const m = override.get(c.key) ?? new Map<HorizonDays, DemandInterval>();
          m.set(h, c.interval);
          override.set(c.key, m);
        }
      }
      for (const r of group) extraReason.set(keyOf(r.cell), "reconciled_to_parent");
    }
  }

  const records: ForecastRecord[] = [];
  let ok = 0;
  let insufficient = 0;
  let suppressed = 0;
  const served: Record<string, number> = {};
  const wape: number[] = [];
  const baseWape: number[] = [];
  const pin: number[] = [];
  const cov: number[] = [];
  const bias: number[] = [];
  for (const r of results) {
    const common = { storeId, scope: r.cell.scope, scopeKey: r.cell.key, asOfDay, generatedAtMs: nowMs };
    if (r.kind === "suppressed") {
      suppressed += 1;
      for (const h of HORIZONS) {
        records.push({
          ...common,
          id: newId(),
          horizonDays: h,
          model: null,
          modelVersion: MODEL_VERSION,
          status: "suppressed",
          p10: null,
          p50: null,
          p90: null,
          reasonCodes: ["k_anonymity_below_minimum"],
          comparableUnits: 0,
          observedDays: 0,
          backtestOrigins: 0,
          wapeBps: null,
          baselineWapeBps: null,
          pinballMilli: null,
          coverageBps: null,
          biasBps: null,
        });
      }
      continue;
    }
    const o = r.outcome;
    if (o.status === "insufficient_history") {
      insufficient += 1;
      for (const h of HORIZONS) {
        records.push({
          ...common,
          id: newId(),
          horizonDays: h,
          model: null,
          modelVersion: MODEL_VERSION,
          status: "insufficient_history",
          p10: null,
          p50: null,
          p90: null,
          reasonCodes: [o.reason],
          comparableUnits: o.comparableUnits,
          observedDays: o.observedDays,
          backtestOrigins: 0,
          wapeBps: null,
          baselineWapeBps: null,
          pinballMilli: null,
          coverageBps: null,
          biasBps: null,
        });
      }
      continue;
    }
    ok += 1;
    served[o.model] = (served[o.model] ?? 0) + 1;
    if (o.backtest.wapeBps !== null) wape.push(o.backtest.wapeBps);
    if (o.baseline.wapeBps !== null) baseWape.push(o.baseline.wapeBps);
    pin.push(o.backtest.pinballMilli);
    cov.push(o.backtest.coverageBps);
    if (o.backtest.biasBps !== null) bias.push(o.backtest.biasBps);
    const reasons: string[] = [...o.reasonCodes];
    const extra = extraReason.get(keyOf(r.cell));
    if (extra !== undefined) reasons.push(extra);
    for (const hz of o.horizons) {
      const iv = override.get(keyOf(r.cell))?.get(hz.horizonDays) ?? hz;
      records.push({
        ...common,
        id: newId(),
        horizonDays: hz.horizonDays,
        model: o.model,
        modelVersion: o.modelVersion,
        status: "ok",
        p10: iv.p10,
        p50: iv.p50,
        p90: iv.p90,
        reasonCodes: reasons,
        comparableUnits: o.comparableUnits,
        observedDays: o.observedDays,
        backtestOrigins: o.backtest.origins,
        wapeBps: o.backtest.wapeBps,
        baselineWapeBps: o.baseline.wapeBps,
        pinballMilli: o.backtest.pinballMilli,
        coverageBps: o.backtest.coverageBps,
        biasBps: o.backtest.biasBps,
      });
    }
  }
  const mean = (xs: readonly number[]): number | null =>
    xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    records,
    summary: {
      seriesTotal: results.length,
      okCount: ok,
      insufficientCount: insufficient,
      suppressedCount: suppressed,
      servedModels: served,
      meanWapeBps: mean(wape),
      meanBaselineWapeBps: mean(baseWape),
      meanPinballMilli: mean(pin),
      meanCoverageBps: mean(cov),
      meanBiasBps: mean(bias),
    },
  };
}
