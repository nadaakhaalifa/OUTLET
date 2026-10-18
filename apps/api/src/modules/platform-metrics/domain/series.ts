import type { Bucket, Grain } from "./buckets";

/** Time-series arithmetic (dashboard foundations track 4). Pure; money is bigint piastres, no float anywhere. */
export type Unit = "piastres" | "count" | "bps" | "distinct_shoppers";
export type PointState = "ok" | "partial" | "suppressed" | "not_measured" | "no_bucket" | "held";
export type Basis = "exact_facts" | "rollup" | "rollup_reconciled" | "ledger" | "operational" | "batch";
export type SeriesNote = "consent_sampled" | "includes_late_data" | "launch_period" | "tz_rules_unverified" | "anomaly";

/** One hour row from a rollup table. `held` is the part the anomaly guard holds back (track 5); it is not in `value`. */
export interface HourlyRow {
  readonly hourUtcMs: number;
  readonly value: bigint;
  readonly held: bigint;
}

export type Calc =
  | { readonly kind: "sum"; readonly metric: string }
  | { readonly kind: "diff"; readonly a: string; readonly b: string }
  | { readonly kind: "aov"; readonly num: string; readonly den: string }
  | { readonly kind: "bps"; readonly num: string; readonly den: string };

export interface MetricDef {
  readonly id: string;
  readonly unit: Unit;
  readonly additive: boolean;
  readonly basis: Basis;
  readonly notes: readonly SeriesNote[];
  readonly calc: Calc;
}

export interface Point {
  readonly bucket: Bucket | null;
  readonly v: bigint | null;
  readonly state: PointState;
  /** Components, for non-additive totals computed exactly over the window. */
  readonly num: bigint;
  readonly den: bigint;
}

export const componentsOf = (c: Calc): readonly string[] =>
  c.kind === "sum" ? [c.metric] : c.kind === "diff" ? [c.a, c.b] : [c.num, c.den];

interface Comp {
  readonly v: bigint;
  readonly held: boolean;
  readonly partial: boolean;
}

function sumBucket(b: Bucket, rows: readonly HourlyRow[], nowMs: number): Comp {
  let v = 0n;
  let held = false;
  for (const r of rows) {
    if (r.hourUtcMs < b.startMs || r.hourUtcMs >= b.endMs) continue;
    v += r.value;
    if (r.held > 0n) held = true;
  }
  return { v, held, partial: b.endMs > nowMs };
}

/** Banker's rounding (half to even) for non-negative integers; the single documented rounding point for AOV. */
export function bankersDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n || num < 0n) throw new RangeError("bankersDiv needs num >= 0 and den > 0");
  const q = num / den;
  const twice = (num % den) * 2n;
  if (twice > den) return q + 1n;
  if (twice < den) return q;
  return q % 2n === 0n ? q : q + 1n;
}

/** Floor division for any sign (BigInt `/` truncates toward zero). */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export const bps = (num: bigint, den: bigint): bigint => floorDiv(num * 10_000n, den);

/** Points for the given buckets from per-component hourly rows. A null bucket is a `no_bucket` slot. */
export function computePoints(
  def: MetricDef,
  buckets: readonly (Bucket | null)[],
  rowsOf: (metric: string) => readonly HourlyRow[],
  nowMs: number,
): readonly Point[] {
  const comps = componentsOf(def.calc);
  return buckets.map((b): Point => {
    if (b === null) return { bucket: null, v: null, state: "no_bucket", num: 0n, den: 0n };
    const c = comps.map((m) => sumBucket(b, rowsOf(m), nowMs));
    const held = c.some((x) => x.held);
    const partial = c.some((x) => x.partial);
    const a = (c[0] as Comp).v;
    const z = (c[1] as Comp | undefined)?.v ?? 0n;
    if (held) return { bucket: b, v: null, state: "held", num: 0n, den: 0n };
    const state: PointState = partial ? "partial" : "ok";
    switch (def.calc.kind) {
      case "sum":
        return { bucket: b, v: a, state, num: a, den: 0n };
      case "diff":
        return { bucket: b, v: a - z, state, num: a - z, den: 0n };
      case "aov":
        return { bucket: b, v: z === 0n ? null : bankersDiv(a, z), state, num: a, den: z };
      case "bps":
        return { bucket: b, v: z === 0n ? null : bps(a, z), state, num: a, den: z };
    }
  });
}

/** Window total: additive = sum of released ok/partial points; ratios are computed exactly over the window components. */
export function totalOf(def: MetricDef, points: readonly Point[]): bigint | null {
  const released = points.filter((p) => p.state === "ok" || p.state === "partial");
  if (released.length === 0) return null;
  switch (def.calc.kind) {
    case "sum":
    case "diff":
      return released.reduce((s, p) => s + p.num, 0n);
    case "aov": {
      const n = released.reduce((s, p) => s + p.num, 0n);
      const d = released.reduce((s, p) => s + p.den, 0n);
      return d === 0n ? null : bankersDiv(n, d);
    }
    case "bps": {
      const n = released.reduce((s, p) => s + p.num, 0n);
      const d = released.reduce((s, p) => s + p.den, 0n);
      return d === 0n ? null : bps(n, d);
    }
  }
}

export interface Delta {
  readonly delta: bigint | null;
  readonly deltaBps: bigint | null;
}
export function deltaOf(current: bigint | null, previous: bigint | null): Delta {
  if (current === null || previous === null) return { delta: null, deltaBps: null };
  return { delta: current - previous, deltaBps: previous === 0n ? null : floorDiv((current - previous) * 10_000n, previous) };
}

export type WireValue = string | number | null;

/** `v` is a decimal string for piastres, an integer otherwise; null stays null. */
export function wireValue(unit: Unit, v: bigint | null): WireValue {
  if (v === null) return null;
  if (unit === "piastres") return v.toString();
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError("count exceeds the safe integer range");
  return Number(v);
}

export interface SeriesWire {
  readonly id: string;
  readonly version: 1;
  readonly window: {
    readonly from: string;
    readonly to: string;
    readonly tz: "Africa/Cairo";
    readonly requested_from: string;
    readonly requested_to: string;
    readonly preset: string | null;
  };
  readonly grain: Grain;
  readonly unit: Unit;
  readonly currency: "EGP" | null;
  readonly additive: boolean;
  readonly series: readonly {
    readonly key: "current" | "previous";
    readonly from: string;
    readonly to: string;
    readonly points: readonly {
      readonly t: string;
      readonly label: string;
      readonly offset_min: 120 | 180;
      readonly fold?: 0 | 1;
      readonly hours: number;
      readonly v: WireValue;
      readonly state: PointState;
    }[];
  }[];
  readonly totals: { readonly current: WireValue; readonly previous: WireValue; readonly delta: WireValue; readonly delta_bps: number | null };
  readonly as_of: string | null;
  readonly basis: Basis;
  readonly suppressed: { readonly k: 50; readonly primary: number; readonly complementary: number; readonly memo: number; readonly whole_series: boolean };
  readonly notes: readonly SeriesNote[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function buildSeriesWire(i: {
  readonly def: MetricDef;
  readonly grain: Grain;
  readonly buckets: readonly Bucket[];
  readonly requested: { readonly fromMs: number; readonly toMs: number };
  readonly current: readonly Point[];
  /** Null when compare = none. */
  readonly previous: { readonly slots: readonly (Bucket | null)[]; readonly points: readonly Point[] } | null;
  readonly asOfMs: number | null;
}): SeriesWire {
  const { def } = i;
  const first = i.buckets[0] as Bucket;
  const last = i.buckets[i.buckets.length - 1] as Bucket;
  const pointWire = (p: Point, b: Bucket) => ({
    t: iso(b.startMs),
    label: b.label,
    offset_min: b.offsetMin,
    ...(b.fold === undefined ? {} : { fold: b.fold }),
    hours: b.hours,
    v: wireValue(def.unit, p.v),
    state: p.state,
  });
  const series: SeriesWire["series"][number][] = [
    {
      key: "current",
      from: iso(first.startMs),
      to: iso(last.endMs),
      points: i.current.map((p, k) => pointWire(p, i.buckets[k] as Bucket)),
    },
  ];
  let prevTotal: bigint | null = null;
  if (i.previous !== null) {
    const real = i.previous.slots.filter((b): b is Bucket => b !== null);
    // A no_bucket slot has no instant of its own: it reports the instant the aligned current bucket would start at,
    // shifted by the previous window length, so `t` stays sortable. Here: the start of the current slot's counterpart is unknown, use the current start.
    series.push({
      key: "previous",
      from: iso((real[0] ?? first).startMs),
      to: iso((real[real.length - 1] ?? last).endMs),
      points: i.previous.points.map((p, k) => {
        const b = p.bucket ?? (i.buckets[k] as Bucket);
        const w = pointWire(p, b);
        return p.bucket === null ? { ...w, v: null, state: "no_bucket" as const } : w;
      }),
    });
    prevTotal = totalOf(def, i.previous.points);
  }
  const cur = totalOf(def, i.current);
  const d = deltaOf(cur, prevTotal);
  return {
    id: def.id,
    version: 1,
    window: {
      from: iso(first.startMs),
      to: iso(last.endMs),
      tz: "Africa/Cairo",
      requested_from: iso(i.requested.fromMs),
      requested_to: iso(i.requested.toMs),
      preset: null,
    },
    grain: i.grain,
    unit: def.unit,
    currency: def.unit === "piastres" ? "EGP" : null,
    additive: def.additive,
    series,
    totals: {
      current: wireValue(def.unit, cur),
      previous: wireValue(def.unit, prevTotal),
      delta: wireValue(def.unit === "bps" ? "bps" : def.unit, d.delta),
      delta_bps: d.deltaBps === null ? null : Number(d.deltaBps),
    },
    as_of: i.asOfMs === null ? null : iso(i.asOfMs),
    basis: def.basis,
    suppressed: { k: 50, primary: 0, complementary: 0, memo: 0, whole_series: false },
    notes: def.notes,
  };
}
