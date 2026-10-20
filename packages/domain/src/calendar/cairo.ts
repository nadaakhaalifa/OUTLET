/**
 * Africa/Cairo wall-clock arithmetic through the tz database (Intl). Egypt observes DST again since
 * 2023, so offsets are never hard coded: the same instant resolves to +02:00 or +03:00 by date.
 */
const FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Cairo",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const MIN = 60_000;
const DAY = 86_400_000;
const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

export interface CairoParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly minuteOfDay: number;
  /** YYYY-MM-DD. */
  readonly dateKey: string;
}

export function cairoParts(utcMs: number): CairoParts {
  const m = new Map<string, string>();
  for (const p of FORMAT.formatToParts(new Date(utcMs))) m.set(p.type, p.value);
  const num = (k: string): number => Number(m.get(k) ?? "0");
  const hour = num("hour") % 24;
  const year = num("year");
  const month = num("month");
  const day = num("day");
  const minute = num("minute");
  return { year, month, day, hour, minute, minuteOfDay: hour * 60 + minute, dateKey: `${pad(year, 4)}-${pad(month)}-${pad(day)}` };
}

/** Offset of Cairo from UTC at `utcMs`, in minutes (120 or 180). */
export function cairoOffsetMinutes(utcMs: number): number {
  const p = cairoParts(utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(utcMs / MIN) * MIN) / MIN);
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isDateKey(s: string): boolean {
  const m = DATE_KEY.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Pure calendar arithmetic on a date key (no DST involved). */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const m = DATE_KEY.exec(dateKey);
  if (m === null) throw new RangeError("invalid date key");
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * DAY);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * UTC instant of a Cairo local date and minute of day. An ambiguous time (clocks go back) resolves
 * to the earlier instant; a skipped time (clocks go forward) resolves forward.
 */
export function cairoLocalToUtc(dateKey: string, minuteOfDay: number): number {
  const m = DATE_KEY.exec(dateKey);
  if (m === null) throw new RangeError("invalid date key");
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, minuteOfDay);
  for (const off of [180, 120]) {
    const t = naive - off * MIN;
    if (cairoOffsetMinutes(t) === off) return t;
  }
  return naive - 120 * MIN;
}
