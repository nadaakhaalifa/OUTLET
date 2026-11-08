const CAIRO = "Africa/Cairo";
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO, year: "numeric", month: "2-digit", day: "2-digit" });

/** Local calendar date in Africa/Cairo as YYYY-MM-DD (handles Egypt's DST). */
export const cairoDate = (d: Date): string => {
  if (Number.isNaN(d.getTime())) throw new RangeError("invalid date");
  return fmt.format(d);
};

const addDays = (iso: string, days: number): string => {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

export interface PayoutCycle {
  /** Monday, inclusive, Cairo local date. */
  readonly start: string;
  /** Sunday, inclusive. */
  readonly end: string;
}

/**
 * Weekly cycle (master prompt T4): the Monday-to-Sunday week that ended before the current Cairo week.
 * Every run during the same Cairo week yields the same cycle, which is what makes buildCycle idempotent.
 */
export const weeklyCycle = (now: Date): PayoutCycle => {
  const today = cairoDate(now);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const sinceMonday = (dow + 6) % 7;
  const thisMonday = addDays(today, -sinceMonday);
  return { start: addDays(thisMonday, -7), end: addDays(thisMonday, -1) };
};
