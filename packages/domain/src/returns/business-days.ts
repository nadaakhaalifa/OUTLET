import { MS_PER_DAY } from "./types";

const WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short" });

/** Egypt's weekend is Friday and Saturday. Public holidays are not modelled (VERIFY). */
function isWorkingDay(ms: number): boolean {
  const d = WEEKDAY.format(new Date(ms));
  return d !== "Fri" && d !== "Sat";
}

/** Adds `days` working days (Sunday to Thursday in Africa/Cairo), keeping the time of day. */
export function addBusinessDays(startMs: number, days: number): number {
  if (!Number.isInteger(days) || days < 0) throw new RangeError("days must be a non-negative integer");
  let ms = startMs;
  let left = days;
  while (left > 0) {
    ms += MS_PER_DAY;
    if (isWorkingDay(ms)) left -= 1;
  }
  return ms;
}
