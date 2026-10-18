/** Cairo calendar helpers. The server clock decides; the app clock is never trusted (spec edge cases). */
import { EG_MARKET } from "../market/eg";
const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: EG_MARKET.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` of the Cairo calendar day containing `ms`. */
export function cairoDayKey(ms: number): string {
  return FMT.format(new Date(ms));
}

/** `YYYY-MM` of the Cairo calendar month containing `ms`. */
export function cairoMonthKey(ms: number): string {
  return cairoDayKey(ms).slice(0, 7);
}

export function previousMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function nextMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

const MINUTE = 60_000;

/** First instant (minute precision) at which the Cairo day key differs from the day of `ms`. */
export function nextCairoDayStartMs(ms: number): number {
  const key = cairoDayKey(ms);
  let hi = ms + 25 * 3_600_000;
  let lo = ms;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (cairoDayKey(mid) === key) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** First instant (minute precision) of the Cairo month after the one containing `ms`. */
export function nextCairoMonthStartMs(ms: number): number {
  const key = cairoMonthKey(ms);
  let lo = ms;
  let hi = ms + 32 * 24 * 3_600_000;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (cairoMonthKey(mid) === key) lo = mid;
    else hi = mid;
  }
  return hi;
}
