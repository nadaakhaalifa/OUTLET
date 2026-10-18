/** Africa/Cairo calendar helpers (DST aware through Intl, no tz database copy). */

const FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Cairo",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface CairoParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

export function cairoParts(ms: number): CairoParts {
  const m = new Map<string, string>();
  for (const p of FORMAT.formatToParts(new Date(ms))) m.set(p.type, p.value);
  const num = (k: string): number => Number(m.get(k) ?? "0");
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
    weekday: WEEKDAYS[m.get("weekday") ?? "Sun"] ?? 0,
  };
}

/** Egypt winter offset (UTC+2); the offset in force before a spring-forward gap. */
const EGYPT_STANDARD_OFFSET_MS = 2 * 3_600_000;

/** Cairo local wall time to a UTC instant. Skipped local times (DST gap) resolve forward. */
export function cairoLocalToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = cairoParts(guess);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    const delta = wanted - shown;
    if (delta === 0) break;
    guess += delta;
  }
  const shown = cairoParts(guess);
  const matches = shown.year === year && shown.month === month && shown.day === day && shown.hour === hour && shown.minute === minute;
  if (matches) return guess;
  // The wall time does not exist (DST gap). Resolve forward: interpret it with the offset in force
  // before the gap (the smaller one), which lands on the first real instant at or after the gap.
  return Date.UTC(year, month - 1, day, hour, minute) - EGYPT_STANDARD_OFFSET_MS;
}

export interface CairoSchedule {
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday. Absent: every day. */
  readonly weekday?: number;
}

/** First instant strictly after `afterMs` that matches the Cairo wall-clock schedule. */
export function nextCairoOccurrence(afterMs: number, s: CairoSchedule): number {
  const base = cairoParts(afterMs);
  for (let add = 0; add <= 8; add++) {
    const day = new Date(Date.UTC(base.year, base.month - 1, base.day + add));
    const at = cairoLocalToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), s.hour, s.minute);
    if (at <= afterMs) continue;
    if (s.weekday !== undefined && cairoParts(at).weekday !== s.weekday) continue;
    return at;
  }
  throw new RangeError("no Cairo occurrence within 8 days");
}

export interface CairoDayBounds {
  /** First instant with the local date (a skipped local midnight resolves forward). */
  readonly startMs: number;
  /** First instant of the next local date (exclusive). */
  readonly endMs: number;
  /** Real hours in the local day: 23 (spring forward), 24, or 25 (fall back). */
  readonly hours: number;
}

/** Bounds of one Cairo calendar day. `month` is 1-12. Hour counts are derived from real instants, never assumed. */
export function cairoDayBounds(year: number, month: number, day: number): CairoDayBounds {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const startMs = cairoLocalToUtc(year, month, day, 0, 0);
  const endMs = cairoLocalToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
  return { startMs, endMs, hours: Math.round((endMs - startMs) / 3_600_000) };
}

/** 0 = Sunday ... 6 = Saturday. Egypt's weeks start on Saturday (ADR-0047, Proposed default). */
export const CAIRO_WEEK_START_WEEKDAY = 6;

/** Cairo calendar date (year, month 1-12, day) of the Saturday that starts the local week containing `ms`. */
export function cairoWeekStart(ms: number): { readonly year: number; readonly month: number; readonly day: number } {
  const p = cairoParts(ms);
  const back = (p.weekday - CAIRO_WEEK_START_WEEKDAY + 7) % 7;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
