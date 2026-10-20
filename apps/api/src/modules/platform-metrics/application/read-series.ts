import { createHash } from "node:crypto";
import { GRAIN_MAX_POINTS, previousSlots, snapWindow, type Bucket, type Grain } from "../domain/buckets";
import {
  buildSeriesWire,
  componentsOf,
  computePoints,
  type HourlyRow,
  type MetricDef,
  type SeriesWire,
} from "../domain/series";

export type Compare = "previous_period" | "none";

export interface SeriesRequest {
  readonly def: MetricDef;
  readonly grain: Grain;
  readonly fromMs: number;
  readonly toMs: number;
  readonly compare: Compare;
  readonly nowMs: number;
}

/** What a series needs from a rollup table; `scope` bits (platform vs one store) stay in the adapter. */
export interface HourlySource {
  freshness(): Promise<{ readonly asOfMs: number | null; readonly epoch: number }>;
  read(metric: string, fromMs: number, toMs: number): Promise<readonly HourlyRow[]>;
}

export interface PlannedSeries {
  readonly buckets: readonly Bucket[];
  readonly slots: readonly (Bucket | null)[] | null;
}

/** Snaps the window and plans the previous period. Throws InvalidWindowError. */
export function planSeries(r: SeriesRequest): PlannedSeries {
  const buckets = snapWindow(r.grain, r.fromMs, r.toMs, r.nowMs);
  const slots = r.compare === "none" ? null : previousSlots(r.grain, buckets).map((s) => s.bucket);
  return { buckets, slots };
}

/** Strong ETag: SHA-256 of (metric id, version, snapped window, grain, compare, scope, as_of, reconciliation epoch). */
export function seriesEtag(i: {
  readonly metricId: string;
  readonly buckets: readonly Bucket[];
  readonly grain: Grain;
  readonly compare: Compare;
  readonly scope: string;
  readonly asOfMs: number | null;
  readonly epoch: number;
}): string {
  const first = i.buckets[0] as Bucket;
  const last = i.buckets[i.buckets.length - 1] as Bucket;
  const h = createHash("sha256")
    .update(
      JSON.stringify([i.metricId, 1, first.startMs, last.endMs, i.grain, i.compare, i.scope, i.asOfMs, i.epoch]),
    )
    .digest("hex");
  return `"${h}"`;
}

/** Reads the hourly rows of every component and assembles the wire document. */
export async function readSeries(
  src: HourlySource,
  r: SeriesRequest,
  plan: PlannedSeries,
  asOfMs: number | null,
): Promise<SeriesWire> {
  const comps = componentsOf(r.def.calc);
  const real = (plan.slots ?? []).filter((b): b is Bucket => b !== null);
  const firstMs = Math.min((plan.buckets[0] as Bucket).startMs, ...real.map((b) => b.startMs));
  const lastMs = Math.max((plan.buckets[plan.buckets.length - 1] as Bucket).endMs, ...real.map((b) => b.endMs));
  const rows = new Map<string, readonly HourlyRow[]>();
  for (const m of comps) rows.set(m, await src.read(m, firstMs, lastMs));
  const rowsOf = (m: string): readonly HourlyRow[] => rows.get(m) ?? [];
  const current = computePoints(r.def, plan.buckets, rowsOf, r.nowMs);
  const previous =
    plan.slots === null ? null : { slots: plan.slots, points: computePoints(r.def, plan.slots, rowsOf, r.nowMs) };
  return buildSeriesWire({
    def: r.def,
    grain: r.grain,
    buckets: plan.buckets,
    requested: { fromMs: r.fromMs, toMs: r.toMs },
    current,
    previous,
    asOfMs,
  });
}

export { GRAIN_MAX_POINTS };
