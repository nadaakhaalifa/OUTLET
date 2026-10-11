import { hmacSha256, toHex, utf8 } from "./crypto";
import { MS } from "./ports";

/** An under-18 outcome blocks the device and the date of birth for 30 days (spec 1, rules). */
export const AGE_BLOCK_MS = 30 * MS.day;
export const MINIMUM_AGE_YEARS = 18;

export type CalendarDate = { readonly year: number; readonly month: number; readonly day: number };

const DOB_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Strict YYYY-MM-DD parse. Returns null for impossible dates (2001-02-30) and years before 1900. */
export function parseCalendarDate(value: string): CalendarDate | null {
  const m = DOB_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function compare(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** Whole years completed on `today`. A 29 February birthday completes its year on 1 March in common years. */
export function ageOn(dob: CalendarDate, today: CalendarDate): number {
  const leapDayInCommonYear = dob.month === 2 && dob.day === 29 && daysInMonth(today.year, 2) < 29;
  const birthday: CalendarDate = leapDayInCommonYear
    ? { year: today.year, month: 3, day: 1 }
    : { year: today.year, month: dob.month, day: dob.day };
  return today.year - dob.year - (compare(today, birthday) < 0 ? 1 : 0);
}

export function isFutureDate(date: CalendarDate, today: CalendarDate): boolean {
  return compare(date, today) > 0;
}

/**
 * Keyed identifiers for the age block. A plain hash of a date of birth has only a few tens of
 * thousands of candidates and would be reversible (docs/data-model/inconsistencies.md I-05),
 * so every identifier is an HMAC under a server secret; the DOB itself is never stored.
 * Domain separation prefixes keep the three identifier spaces from colliding.
 */
export function ageBlockKey(
  secret: Uint8Array,
  kind: "attested_device" | "device_id_hash" | "dob",
  value: string,
  salt = "",
): string {
  return toHex(hmacSha256(secret, utf8(`age-block:v1:${kind}:${value}:${salt}`)));
}
