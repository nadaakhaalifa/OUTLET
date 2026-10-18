import { cairoDayBounds, cairoHourBucket, cairoParts, cairoWeekStart } from "@outlet/domain";

/** Africa/Cairo buckets (ADR-0047 default; display decision Proposed). Pure: no I/O, uses Intl through @outlet/domain. */
export const GRAINS = ["hour", "day", "week", "month"] as const;
export type Grain = (typeof GRAINS)[number];

/** Maximum points per series (spec section 4): hour 7 days (169), day 366, week 104, month 36. */
export const GRAIN_MAX_POINTS: Readonly<Record<Grain, number>> = { hour: 169, day: 366, week: 104, month: 36 };

const HOUR_MS = 3_600_000;
const pad = (n: number): string => String(n).padStart(2, "0");

export interface Bucket {
  /** Bucket start, UTC instant. */
  readonly startMs: number;
  /** Exclusive end. */
  readonly endMs: number;
  /** Local label: 2026-10-29 | 2026-10-29T23 | 2026-W44 | 2026-10. */
  readonly label: string;
  /** UTC offset at bucket start. */
  readonly offsetMin: 120 | 180;
  /** Hour grain only: 1 = the repeated local hour. */
  readonly fold?: 0 | 1;
  /** Real hours in the bucket. */
  readonly hours: number;
  /** Local calendar date at the start of the bucket. */
  readonly localDate: string;
}

const offsetAt = (ms: number): 120 | 180 => cairoHourBucket(ms).utcOffsetMin;

function make(startMs: number, endMs: number, label: string, localDate: string, fold?: 0 | 1): Bucket {
  return {
    startMs,
    endMs,
    label,
    offsetMin: offsetAt(startMs),
    ...(fold === undefined ? {} : { fold }),
    hours: Math.round((endMs - startMs) / HOUR_MS),
    localDate,
  };
}

function dayOfYear(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}

/** The bucket of `grain` that contains the instant `ms`. Weeks start on Saturday (ADR-0047 Proposed default). */
export function bucketContaining(grain: Grain, ms: number): Bucket {
  switch (grain) {
    case "hour": {
      const hb = cairoHourBucket(ms);
      const prev = cairoHourBucket(hb.hourUtcMs - HOUR_MS);
      const fold: 0 | 1 = prev.cairoDate === hb.cairoDate && prev.cairoHour === hb.cairoHour ? 1 : 0;
      return make(hb.hourUtcMs, hb.hourUtcMs + HOUR_MS, `${hb.cairoDate}T${pad(hb.cairoHour)}`, hb.cairoDate, fold);
    }
    case "day": {
      const p = cairoParts(ms);
      const b = cairoDayBounds(p.year, p.month, p.day);
      const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
      return make(b.startMs, b.endMs, date, date);
    }
    case "week": {
      const w = cairoWeekStart(ms);
      const start = cairoDayBounds(w.year, w.month, w.day).startMs;
      const n = new Date(Date.UTC(w.year, w.month - 1, w.day + 7));
      const end = cairoDayBounds(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()).startMs;
      const no = Math.floor((dayOfYear(w.year, w.month, w.day) - 1) / 7) + 1;
      return make(start, end, `${w.year}-W${pad(no)}`, `${w.year}-${pad(w.month)}-${pad(w.day)}`);
    }
    case "month": {
      const p = cairoParts(ms);
      const start = cairoDayBounds(p.year, p.month, 1).startMs;
      const n = new Date(Date.UTC(p.year, p.month, 1));
      const end = cairoDayBounds(n.getUTCFullYear(), n.getUTCMonth() + 1, 1).startMs;
      return make(start, end, `${p.year}-${pad(p.month)}`, `${p.year}-${pad(p.month)}-01`);
    }
  }
}

export const nextBucket = (grain: Grain, b: Bucket): Bucket => bucketContaining(grain, b.endMs);
export const previousBucket = (grain: Grain, b: Bucket): Bucket => bucketContaining(grain, b.startMs - 1);

export class InvalidWindowError extends Error {
  constructor(readonly code: "invalid_window" | "window_too_large") {
    super(code);
    this.name = "InvalidWindowError";
  }
}

/**
 * Snaps `[fromMs, toMs)` outward to whole buckets, then clamps the end to the end of the bucket containing `nowMs`.
 * Throws `invalid_window` for from >= to (or a window wholly in the future) and `window_too_large` above the point cap.
 */
export function snapWindow(grain: Grain, fromMs: number, toMs: number, nowMs: number): readonly Bucket[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new InvalidWindowError("invalid_window");
  const current = bucketContaining(grain, nowMs);
  const out: Bucket[] = [];
  let b = bucketContaining(grain, fromMs);
  if (b.startMs > current.startMs) throw new InvalidWindowError("invalid_window");
  while (b.startMs < toMs && b.startMs <= current.startMs) {
    out.push(b);
    if (out.length > GRAIN_MAX_POINTS[grain]) throw new InvalidWindowError("window_too_large");
    b = nextBucket(grain, b);
  }
  return out;
}

export interface PreviousSlot {
  /** The bucket in the previous window, or null when the slot has no counterpart (DST). */
  readonly bucket: Bucket | null;
}

/**
 * The previous window has the same number of buckets immediately before `current[0]`, aligned BY BUCKET INDEX
 * (a 23-hour day aligns with a 24-hour day). For the hour grain it is aligned by (day index, local hour, fold):
 * the previous local days are the same number of local days before the first one, and a slot with no counterpart
 * (the skipped spring hour, or fold 1 against a normal day) is null.
 */
export function previousSlots(grain: Grain, current: readonly Bucket[]): readonly PreviousSlot[] {
  if (current.length === 0) return [];
  if (grain !== "hour") {
    const rev: Bucket[] = [];
    let b = current[0] as Bucket;
    for (let i = 0; i < current.length; i++) {
      b = previousBucket(grain, b);
      rev.push(b);
    }
    return rev.reverse().map((bucket) => ({ bucket }));
  }
  const dates: string[] = [];
  for (const b of current) if (dates[dates.length - 1] !== b.localDate) dates.push(b.localDate);
  const n = dates.length;
  const hoursOf = new Map<string, Map<string, Bucket>>();
  const dayHours = (date: string): Map<string, Bucket> => {
    const cached = hoursOf.get(date);
    if (cached !== undefined) return cached;
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const bounds = cairoDayBounds(y, m, d);
    const m2 = new Map<string, Bucket>();
    for (let t = bounds.startMs; t < bounds.endMs; t += HOUR_MS) {
      const hb = bucketContaining("hour", t);
      m2.set(`${hb.label}|${hb.fold ?? 0}`, hb);
    }
    hoursOf.set(date, m2);
    return m2;
  };
  const shift = (date: string): string => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const s = new Date(Date.UTC(y, m - 1, d - n));
    return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
  };
  return current.map((c) => {
    const prevDate = shift(c.localDate);
    const hh = c.label.slice(11, 13);
    const bucket = dayHours(prevDate).get(`${prevDate}T${hh}|${c.fold ?? 0}`) ?? null;
    return { bucket };
  });
}
