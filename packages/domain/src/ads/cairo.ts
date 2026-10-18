/** Daily budgets reset on the Cairo calendar day (spec 10, "timezone day reset Cairo"). */
import { EG_MARKET } from "../market/eg";
const FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: EG_MARKET.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" of the Cairo calendar day containing the instant. */
export function cairoDayKey(ms: number): string {
  return FORMAT.format(new Date(ms));
}

/** First instant (epoch ms) of the Cairo calendar day containing `ms`. */
export function startOfCairoDayMs(ms: number): number {
  const key = cairoDayKey(ms);
  let lo = ms - 26 * 3_600_000;
  let hi = ms;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (cairoDayKey(mid) === key) hi = mid;
    else lo = mid;
  }
  return cairoDayKey(lo) === key ? lo : hi;
}
