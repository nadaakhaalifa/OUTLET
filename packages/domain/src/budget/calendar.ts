import type { Cycle } from "./types";

/** Egypt reinstated DST in 2023, so the offset changes; Intl carries the rules (no hard-coded offset). */
const CAIRO = "Africa/Cairo";

const FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: CAIRO,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

export interface LocalDate {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number; // 1..31
}

function partsOf(ms: number): { date: LocalDate; hour: number; minute: number } {
  const get: Record<string, number> = {};
  for (const p of FORMAT.formatToParts(new Date(ms))) {
    if (p.type !== "literal") get[p.type] = Number(p.value);
  }
  return {
    date: { year: get["year"] ?? 1970, month: get["month"] ?? 1, day: get["day"] ?? 1 },
    hour: get["hour"] ?? 0,
    minute: get["minute"] ?? 0,
  };
}

export function cairoLocalDate(ms: number): LocalDate {
  return partsOf(ms).date;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const sameDate = (a: LocalDate, b: LocalDate): boolean => a.year === b.year && a.month === b.month && a.day === b.day;

/**
 * First instant whose Cairo local date is `d`. Normally local 00:00; on a spring-forward day
 * where 00:00 does not exist it is the transition instant. Scans in 15 minute steps from a point
 * safely before the day starts (offsets are +2h or +3h), so DST never shifts a cycle by a day.
 */
export function cairoDayStart(d: LocalDate): number {
  const utcMidnight = Date.UTC(d.year, d.month - 1, d.day);
  const STEP = 15 * 60 * 1000;
  for (let t = utcMidnight - 4 * 60 * 60 * 1000; t <= utcMidnight + 4 * 60 * 60 * 1000; t += STEP) {
    if (sameDate(cairoLocalDate(t), d)) return t;
  }
  return utcMidnight - 3 * 60 * 60 * 1000;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
export const isoDate = (d: LocalDate): string => `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;

/** The payday date inside a month: day 31 in a 30-day month (or 29/30 in February) is the last day. */
export function paydayIn(year: number, month: number, payday: number): LocalDate {
  return { year, month, day: Math.min(payday, daysInMonth(year, month)) };
}

const shiftMonth = (year: number, month: number, by: number): { year: number; month: number } => {
  const idx = year * 12 + (month - 1) + by;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
};

/**
 * The budget cycle containing `nowMs`: [this payday, next payday). Boundaries are Cairo local
 * midnights. Payday 31 -> the last day of shorter months, so a cycle "ends" on the 30th.
 */
export function cycleFor(payday: number, nowMs: number): Cycle {
  if (!Number.isInteger(payday) || payday < 1 || payday > 31) throw new RangeError("payday must be an integer 1..31");
  const today = cairoLocalDate(nowMs);
  const thisMonthPayday = paydayIn(today.year, today.month, payday);
  const startMonth = today.day >= thisMonthPayday.day ? { year: today.year, month: today.month } : shiftMonth(today.year, today.month, -1);
  const nextMonth = shiftMonth(startMonth.year, startMonth.month, 1);
  const start = paydayIn(startMonth.year, startMonth.month, payday);
  const end = paydayIn(nextMonth.year, nextMonth.month, payday);
  return { startMs: cairoDayStart(start), endMs: cairoDayStart(end), startDate: isoDate(start), endDate: isoDate(end) };
}

/** The cycle that begins exactly at `cycle.endMs`. */
export function nextCycle(payday: number, cycle: Cycle): Cycle {
  return cycleFor(payday, cycle.endMs);
}

export function previousCycle(payday: number, cycle: Cycle): Cycle {
  return cycleFor(payday, cycle.startMs - 1);
}
