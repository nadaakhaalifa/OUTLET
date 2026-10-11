import { InvalidPayoutInputError } from "./errors";

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Cairo",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

export interface CairoLocal {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly msOfDay: number;
  /** 0 = Sunday ... 6 = Saturday. */
  readonly weekday: number;
}

export function cairoLocal(ms: number): CairoLocal {
  const p: Record<string, number> = {};
  for (const part of PARTS.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const y = p["year"] ?? 0;
  const m = p["month"] ?? 0;
  const d = p["day"] ?? 0;
  const msOfDay = (((p["hour"] ?? 0) * 60 + (p["minute"] ?? 0)) * 60 + (p["second"] ?? 0)) * 1000;
  return { y, m, d, msOfDay, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** Local Cairo wall time to UTC ms. Gap times resolve to the standard offset, ambiguous times to the earlier instant. */
export function cairoToUtc(y: number, m: number, d: number, msOfDay: number): number {
  const naive = Date.UTC(y, m - 1, d) + msOfDay;
  const valid = [2, 3]
    .map((h) => naive - h * MS_PER_HOUR)
    .filter((c) => {
      const l = cairoLocal(c);
      return l.y === y && l.m === m && l.d === d && l.msOfDay === msOfDay;
    })
    .sort((a, b) => a - b);
  return valid[0] ?? naive - 2 * MS_PER_HOUR;
}

/** Civil date `YYYY-MM-DD` in Africa/Cairo. */
export function cairoDateKey(ms: number): string {
  const l = cairoLocal(ms);
  return `${String(l.y).padStart(4, "0")}-${String(l.m).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
}

/** Steps a civil date by whole days (UTC arithmetic on the date part has no DST). */
export function addCivilDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function requireInt(label: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new InvalidPayoutInputError(`${label} must be an integer between ${min} and ${max}`);
  }
}
