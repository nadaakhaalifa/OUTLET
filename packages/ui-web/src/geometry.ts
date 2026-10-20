/** Pure SVG geometry for the hand-written charts. Plain numbers (display only): money is formatted by the caller. */

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Min and max by loop (spread of a very large array overflows the call stack). Empty input gives [Infinity, -Infinity]. */
function extent(values: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

export interface Point { readonly x: number; readonly y: number }

/**
 * Sparkline points on a consistent, caller-supplied scale. `domain` lets stacked sparklines share one scale
 * (Tufte: per-line min/max scaling misleads comparisons); default is the series' own range.
 * `mirror` draws the oldest value at the inline-end side (right-to-left time), a decision left to the Arabic UX reviewer.
 */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  opts: { domain?: readonly [number, number]; mirror?: boolean; pad?: number } = {},
): Point[] {
  const pad = opts.pad ?? 2;
  // Non-finite samples (NaN, Infinity) are dropped: they must never reach an SVG attribute.
  const vals = values.filter(Number.isFinite);
  if (vals.length === 0) return [];
  const [dataLo, dataHi] = extent(vals);
  const domainOk = opts.domain !== undefined && Number.isFinite(opts.domain[0]) && Number.isFinite(opts.domain[1]);
  const lo = domainOk ? (opts.domain as readonly [number, number])[0] : dataLo;
  const hi = domainOk ? (opts.domain as readonly [number, number])[1] : dataHi;
  const span = hi - lo;
  const n = vals.length;
  return vals.map((v, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const x = pad + (opts.mirror === true ? 1 - t : t) * (width - 2 * pad);
    const y = span === 0 || !Number.isFinite(span) ? height / 2 : pad + (1 - (v - lo) / span) * (height - 2 * pad);
    return { x: r2(x), y: r2(y) };
  });
}

export function pathOf(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
}

export interface BulletGeometry {
  readonly bands: readonly { x: number; width: number; level: 1 | 2 | 3 }[];
  readonly measure: { x: number; width: number };
  readonly targetX: number | null;
}

/** Bullet chart: qualitative bands (ascending upper bounds), a measure bar and an optional target tick. */
export function bulletGeometry(
  o: { value: number; target?: number | undefined; bands: readonly number[]; max?: number | undefined },
  width: number,
): BulletGeometry {
  const fin = (n: number): number => (Number.isFinite(n) ? n : 0);
  // Bands are upper bounds: sort ascending so widths can never be negative, and keep the first three levels.
  const upper3 = o.bands.filter(Number.isFinite).sort((a, b) => a - b).slice(0, 3);
  const auto = Math.max(fin(o.value), fin(o.target ?? 0), ...upper3, 1);
  const max = o.max !== undefined && Number.isFinite(o.max) && o.max > 0 ? o.max : auto;
  const sx = (v: number): number => r2((Math.min(Math.max(fin(v), 0), max) / max) * width);
  let prev = 0;
  const bands = upper3.map((upper, i) => {
    const x = sx(prev);
    const w = r2(Math.max(sx(upper) - x, 0));
    prev = upper;
    return { x, width: w, level: (i + 1) as 1 | 2 | 3 };
  });
  return { bands, measure: { x: 0, width: sx(o.value) }, targetX: o.target === undefined ? null : sx(o.target) };
}

export interface WaterfallStep { readonly label: string; readonly value: number; readonly kind: "total" | "delta" }
export interface WaterfallBar {
  readonly label: string;
  readonly kind: "total" | "up" | "down";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Running level after this step. */
  readonly end: number;
  /** The step's own value: the signed change for a delta bar, the total for a total bar. */
  readonly value: number;
}

/**
 * Waterfall: a `total` step resets the running level to its value, a `delta` step floats from the previous level.
 * Bars come back in data order with the baseline y for the axis; each bar carries its step `value` and the running `end`. `mirror` reverses inline order.
 */
export function waterfallGeometry(
  steps: readonly WaterfallStep[],
  width: number,
  height: number,
  opts: { mirror?: boolean; gap?: number } = {},
): { bars: WaterfallBar[]; baselineY: number } {
  const gap = opts.gap ?? 8;
  let level = 0;
  const raw = steps.map((s) => {
    const start = s.kind === "total" ? 0 : level;
    const end = s.kind === "total" ? s.value : level + s.value;
    level = end;
    return { s, start, end };
  });
  const lows = raw.flatMap((b) => [b.start, b.end]);
  const [loRaw, hiRaw] = extent(lows);
  const lo = Math.min(0, loRaw);
  const hi = Math.max(0, hiRaw);
  const span = hi - lo || 1;
  const y = (v: number): number => r2((1 - (v - lo) / span) * height);
  const n = raw.length;
  const bw = n === 0 ? 0 : (width - gap * (n - 1)) / n;
  const bars = raw.map((b, i) => {
    const slot = opts.mirror === true ? n - 1 - i : i;
    const top = Math.min(y(b.start), y(b.end));
    const bottom = Math.max(y(b.start), y(b.end));
    return {
      label: b.s.label,
      kind: b.s.kind === "total" ? ("total" as const) : b.s.value >= 0 ? ("up" as const) : ("down" as const),
      x: r2(slot * (bw + gap)),
      y: top,
      width: r2(bw),
      height: Math.max(r2(bottom - top), 1),
      end: b.end,
      value: b.s.value,
    };
  });
  return { bars, baselineY: y(0) };
}

/* ---------- Phase B primitives: horizontal bar, stacked bar, aging bars, interval plot ---------- */

/**
 * Non-finite or negative inputs become 0 for GEOMETRY ONLY (zero-length bar, never a negative width). Labels must print the
 * caller's original value (`input`), so a negative is shown as given and never misstated as 0.
 */
const clean = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** `display`: caller-formatted text (for bigint/string piastres above 2^53); `value` then only drives geometry as a Number ratio. */
export interface BarHRow { readonly label: string; readonly value: number | null; readonly display?: string }
export interface BarHBar {
  readonly label: string;
  /** Null input = not loaded: no bar is drawn, `missing` is true (never a zero-length bar). */
  readonly missing: boolean;
  readonly value: number;
  /** The caller's original value, unclamped (for labels). */
  readonly input: number | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Where the value text sits, and which side it extends to. */
  readonly textX: number;
  readonly labelY: number;
}

/**
 * Ranking bars from a zero baseline (never truncated). One shared scale across rows. Each row is a label line above
 * a bar. `width` is the plot width; the caller reserves a gutter for value text. `mirror` grows bars from inline-end.
 */
export function barHGeometry(
  rows: readonly BarHRow[],
  width: number,
  opts: { mirror?: boolean; barHeight?: number; labelHeight?: number; gap?: number } = {},
): { bars: BarHBar[]; height: number } {
  const bh = opts.barHeight ?? 12;
  const lh = opts.labelHeight ?? 14;
  const gap = opts.gap ?? 8;
  const mirror = opts.mirror === true;
  const max = Math.max(0, ...rows.map((r) => (r.value === null ? 0 : clean(r.value))));
  const pitch = lh + bh + gap;
  const bars = rows.map((r, i) => {
    const v = r.value === null ? 0 : clean(r.value);
    const w = max === 0 ? 0 : r2((v / max) * width);
    const y = i * pitch + lh;
    return {
      label: r.label,
      missing: r.value === null || !Number.isFinite(r.value),
      value: v,
      input: r.value,
      x: mirror ? r2(width - w) : 0,
      y,
      width: w,
      height: bh,
      textX: mirror ? r2(width - w - 4) : r2(w + 4),
      labelY: y - 4,
    };
  });
  return { bars, height: rows.length === 0 ? 0 : rows.length * pitch - gap };
}

export interface StackSegment { readonly label: string; readonly value: number; readonly display?: string }
export interface StackedSegmentGeometry { readonly label: string; readonly value: number; readonly input: number; readonly x: number; readonly width: number; readonly share: number }

/**
 * One total split into segments. Boundaries are rounded once and widths are differences of boundaries, so the widths
 * telescope to exactly the full width (the segments always add up to the whole). Zero total gives zero widths.
 */
export function stackedGeometry(segments: readonly StackSegment[], width: number, opts: { mirror?: boolean } = {}): { segments: StackedSegmentGeometry[]; total: number } {
  const vals = segments.map((s) => clean(s.value));
  const total = vals.reduce((a, b) => a + b, 0);
  const mirror = opts.mirror === true;
  let cum = 0;
  const out = segments.map((s, i) => {
    const v = vals[i] ?? 0;
    const a = total === 0 ? 0 : (cum / total) * width;
    cum += v;
    const b = total === 0 ? 0 : (cum / total) * width;
    const x0 = r2(a);
    const x1 = i === segments.length - 1 && total > 0 ? r2(width) : r2(b);
    return { label: s.label, value: v, input: s.value, x: mirror ? r2(width - x1) : x0, width: r2(x1 - x0), share: total === 0 ? 0 : v / total };
  });
  return { segments: out, total };
}

export interface AgingBucket { readonly label: string; readonly count: number | null; readonly display?: string }
export interface AgingColumn {
  readonly label: string;
  readonly missing: boolean;
  readonly count: number;
  readonly input: number | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** True for buckets beyond the reference boundary (they carry a pattern, not just a colour). */
  readonly beyond: boolean;
}

/**
 * Aging histogram: buckets are ordered youngest to oldest in reading direction, so with `mirror` (Arabic) the youngest
 * bucket sits at the right. `referenceBoundary` (0..n) puts a marker line between bucket k-1 and k: for a zero-tolerance
 * rule use the boundary before the first forbidden bucket. Zero counts keep a hairline baseline, never a fake bar.
 */
export function agingGeometry(
  buckets: readonly AgingBucket[],
  width: number,
  height: number,
  opts: { mirror?: boolean; gap?: number; referenceBoundary?: number } = {},
): { columns: AgingColumn[]; referenceX: number | null; baselineY: number } {
  const n = buckets.length;
  const gap = opts.gap ?? 8;
  const mirror = opts.mirror === true;
  const max = Math.max(0, ...buckets.map((b) => (b.count === null ? 0 : clean(b.count))));
  const bw = n === 0 ? 0 : (width - gap * (n - 1)) / n;
  const ref = opts.referenceBoundary;
  const columns = buckets.map((b, i) => {
    const c = b.count === null ? 0 : clean(b.count);
    const h = max === 0 ? 0 : r2((c / max) * height);
    const slot = mirror ? n - 1 - i : i;
    return { label: b.label, missing: b.count === null || !Number.isFinite(b.count), count: c, input: b.count, x: r2(slot * (bw + gap)), y: r2(height - h), width: r2(bw), height: h, beyond: ref !== undefined && i >= ref };
  });
  let referenceX: number | null = null;
  if (ref !== undefined && n > 0 && Number.isFinite(ref)) {
    const k = Math.min(Math.max(Math.round(ref), 0), n);
    const edge = k * (bw + gap) - (k === 0 || k === n ? 0 : gap / 2);
    referenceX = r2(mirror ? width - edge : edge);
  }
  return { columns, referenceX, baselineY: height };
}

export interface IntervalRow { readonly label: string; readonly interval: { readonly p10: number; readonly p50: number; readonly p90: number } | null }
export interface IntervalMark {
  readonly label: string;
  /** Null interval or p10 <= p50 <= p90 violated: nothing is drawn. */
  readonly unavailable: boolean;
  readonly x10: number;
  readonly x50: number;
  readonly x90: number;
  readonly y: number;
}

/**
 * Interval plot on one shared zero-based scale: a p10-p90 bar with a p50 tick per row. The scale is shared so rows are
 * comparable. An interval that is not ordered is rejected rather than silently sorted.
 */
export function intervalGeometry(
  rows: readonly IntervalRow[],
  width: number,
  opts: { mirror?: boolean; rowHeight?: number; domainMax?: number } = {},
): { marks: IntervalMark[]; height: number; max: number } {
  const rh = opts.rowHeight ?? 36;
  const mirror = opts.mirror === true;
  const ok = (iv: IntervalRow["interval"]): iv is NonNullable<IntervalRow["interval"]> =>
    iv !== null && [iv.p10, iv.p50, iv.p90].every((v) => Number.isFinite(v) && v >= 0) && iv.p10 <= iv.p50 && iv.p50 <= iv.p90;
  const max = opts.domainMax ?? Math.max(0, ...rows.map((r) => (ok(r.interval) ? r.interval.p90 : 0)));
  const sx = (v: number): number => {
    const x = max === 0 ? 0 : (Math.min(Math.max(v, 0), max) / max) * width;
    return r2(mirror ? width - x : x);
  };
  const marks = rows.map((r, i) => {
    const iv = r.interval;
    const good = ok(iv);
    return { label: r.label, unavailable: !good, x10: good ? sx(iv.p10) : 0, x50: good ? sx(iv.p50) : 0, x90: good ? sx(iv.p90) : 0, y: i * rh };
  });
  return { marks, height: rows.length * rh, max };
}
