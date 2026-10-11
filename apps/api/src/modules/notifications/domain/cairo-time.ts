/**
 * Africa/Cairo wall-clock arithmetic without a tz database (deterministic with an injected Clock).
 *
 * Egypt observes DST again since 2023: UTC+3 from the last Friday of April 00:00 local (EET) to the
 * last Thursday of October 24:00 local (EEST), otherwise UTC+2. Instants before 2023 use UTC+2 (the
 * platform has no data older than that). The rule is cross-checked against Intl in tests.
 */

const MIN = 60_000;
const DAY = 86_400_000;

/** Day of month of the last `weekday` (0 = Sunday) of a UTC month. */
function lastWeekdayOfMonth(year: number, monthIndex: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const dow = new Date(Date.UTC(year, monthIndex, lastDay)).getUTCDay();
  return lastDay - ((dow - weekday + 7) % 7);
}

/** UTC instant DST starts: last Friday of April 00:00 EET (UTC+2) = Thursday 22:00 UTC. */
export function dstStartMs(year: number): number {
  return Date.UTC(year, 3, lastWeekdayOfMonth(year, 3, 5), 0, 0) - 2 * 60 * MIN;
}

/** UTC instant DST ends: last Thursday of October 24:00 EEST (UTC+3) = 21:00 UTC. */
export function dstEndMs(year: number): number {
  return Date.UTC(year, 9, lastWeekdayOfMonth(year, 9, 4) + 1, 0, 0) - 3 * 60 * MIN;
}

export function cairoOffsetMinutes(utcMs: number): 120 | 180 {
  const year = new Date(utcMs).getUTCFullYear();
  if (year < 2023) return 120;
  return utcMs >= dstStartMs(year) && utcMs < dstEndMs(year) ? 180 : 120;
}

export interface CairoParts {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly minuteOfDay: number;
  /** YYYY-MM-DD local calendar date. */
  readonly dateKey: string;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

export function cairoParts(utcMs: number): CairoParts {
  const d = new Date(utcMs + cairoOffsetMinutes(utcMs) * MIN);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return { year, month, day, hour, minute, minuteOfDay: hour * 60 + minute, dateKey: `${pad(year, 4)}-${pad(month)}-${pad(day)}` };
}

/** Pure calendar arithmetic on a YYYY-MM-DD key (no DST involved). */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The `n` most recent Cairo date keys ending at the day of `utcMs`, newest first. */
export function trailingDateKeys(utcMs: number, n: number): string[] {
  const today = cairoParts(utcMs).dateKey;
  return Array.from({ length: n }, (_, i) => addDaysToDateKey(today, -i));
}

/** UTC instant of a Cairo local date and minute of day. In a DST gap the pre-transition offset is used. */
export function cairoLocalToUtc(dateKey: string, minuteOfDay: number): number {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const early = naive - 180 * MIN; // would be right if offset were +3
  const late = naive - 120 * MIN; // would be right if offset were +2
  const earlyOk = cairoOffsetMinutes(early) === 180;
  const lateOk = cairoOffsetMinutes(late) === 120;
  if (earlyOk) return early; // ambiguous or +3
  if (lateOk) return late;
  return late; // gap: local time does not exist, use the earlier-offset reading
}

export function isInQuietHours(utcMs: number, quiet: { readonly fromMin: number; readonly toMin: number }): boolean {
  const m = cairoParts(utcMs).minuteOfDay;
  if (quiet.fromMin === quiet.toMin) return false;
  return quiet.fromMin > quiet.toMin ? m >= quiet.fromMin || m < quiet.toMin : m >= quiet.fromMin && m < quiet.toMin;
}

/** First instant at or after `utcMs` that is outside quiet hours. */
export function nextQuietEnd(utcMs: number, quiet: { readonly fromMin: number; readonly toMin: number }): number {
  if (!isInQuietHours(utcMs, quiet)) return utcMs;
  const p = cairoParts(utcMs);
  const crossesMidnight = quiet.fromMin > quiet.toMin;
  const endDate = crossesMidnight && p.minuteOfDay >= quiet.fromMin ? addDaysToDateKey(p.dateKey, 1) : p.dateKey;
  return cairoLocalToUtc(endDate, quiet.toMin);
}

export function parseHhmm(s: string): number | null {
  const m = /^([0-2][0-9]):([0-5][0-9])$/.exec(s);
  if (m === null) return null;
  const h = Number(m[1]);
  return h > 23 ? null : h * 60 + Number(m[2]);
}

export function formatHhmm(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
