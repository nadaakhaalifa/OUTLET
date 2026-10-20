import { DOB_MIN_YEAR, daysInMonth, draftFromPicker, validateDobDraft } from "./dob";

/**
 * Pure calendar math for the date-of-birth picker. No React, no Intl: names are produced by the
 * screen. Weekdays use JS numbering (0 = Sunday .. 6 = Saturday). Egypt's week starts on Saturday.
 */

export interface CalDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const WEEK_START_EGYPT = 6;
export const DEFAULT_YEARS_BACK = 25;

/** Weekday (0 = Sunday) of a civil date, Gregorian, no timezone involved. */
export function weekdayOf(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(2000, month - 1, day));
  d.setUTCFullYear(year);
  return d.getUTCDay();
}

/** Weekday numbers in column order for a week that starts on `weekStart`. */
export function weekdayOrder(weekStart: number = WEEK_START_EGYPT): number[] {
  return Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
}

/** Weeks of 7 cells; `null` pads the days outside the month. Always 4 to 6 rows. */
export function monthMatrix(year: number, month: number, weekStart: number = WEEK_START_EGYPT): (number | null)[][] {
  const lead = (weekdayOf(year, month, 1) - weekStart + 7) % 7;
  const total = daysInMonth(year, month);
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12 + 12) % 12 + 1 };
}

/** True when the day lies after `max` (future days are disabled) or before January of the minimum year. */
export function isDayDisabled(year: number, month: number, day: number, max: CalDay): boolean {
  if (year < DOB_MIN_YEAR) return true;
  if (year !== max.year) return year > max.year;
  if (month !== max.month) return month > max.month;
  return day > max.day;
}

export function canGoNext(year: number, month: number, max: CalDay): boolean {
  const n = addMonths(year, month, 1);
  return n.year < max.year || (n.year === max.year && n.month <= max.month);
}

export function canGoPrev(year: number, month: number): boolean {
  return year > DOB_MIN_YEAR || month > 1;
}

/** Keep a visible month inside [Jan DOB_MIN_YEAR, month of max]. */
export function clampView(year: number, month: number, max: CalDay): { year: number; month: number } {
  if (year < DOB_MIN_YEAR) return { year: DOB_MIN_YEAR, month: 1 };
  if (year > max.year || (year === max.year && month > max.month)) return { year: max.year, month: max.month };
  return { year, month };
}

/** Month the calendar opens on: the selected date, else about 25 years back so nobody scrolls a century. */
export function initialView(selected: CalDay | null, today: CalDay, yearsBack: number = DEFAULT_YEARS_BACK): { year: number; month: number } {
  if (selected !== null) return { year: selected.year, month: selected.month };
  return clampView(today.year - yearsBack, today.month, today);
}

/** Selection from a typed draft: only a complete, real, non-future date counts. */
export function selectionFromDraft(draft: string, today: CalDay): CalDay | null {
  const s = validateDobDraft(draft, today);
  return s.state === "valid" ? s.dob : null;
}

/** Draft (ASCII DDMMYYYY) for a chosen day, or null when the day is disabled. */
export function draftFromSelection(sel: CalDay, today: CalDay): string | null {
  if (isDayDisabled(sel.year, sel.month, sel.day, today)) return null;
  return draftFromPicker(sel.year, sel.month, sel.day);
}

export function isSameDay(a: CalDay | null, b: CalDay): boolean {
  return a !== null && a.year === b.year && a.month === b.month && a.day === b.day;
}

export function toIso(d: CalDay): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export function fromIso(iso: string): CalDay | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

/** Digits in the language's numerals: Arabic-Indic for "ar", ASCII otherwise. */
export function localeDigits(value: number | string, language: string): string {
  const s = String(value);
  return language.startsWith("ar") ? s.replace(/\d/g, (c) => ARABIC_INDIC.charAt(Number(c))) : s;
}

/** Years newest first, 1900..max year. */
export function yearList(maxYear: number): number[] {
  const out: number[] = [];
  for (let y = maxYear; y >= DOB_MIN_YEAR; y -= 1) out.push(y);
  return out;
}

export function yearIndex(year: number, maxYear: number): number {
  return Math.max(0, maxYear - year);
}
