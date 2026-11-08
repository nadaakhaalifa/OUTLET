/** Market-local time helpers. Africa/Cairo observes DST, so every conversion goes through Intl, never a fixed offset. */
export const CAIRO_TZ = "Africa/Cairo";

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: CAIRO_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

export const cairoParts = (d: Date): LocalParts => {
  const get = (type: string): number => Number(fmt.formatToParts(d).find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
};

/** Local wall-clock (y-m-d h:00) in Cairo to a UTC instant. Two passes settle the DST offset. */
const cairoToUtc = (year: number, month: number, day: number, hour: number): Date => {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    const p = cairoParts(new Date(guess));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    guess -= shown - wall;
  }
  return new Date(guess);
};

export interface QuietHours {
  /** Local hour at which quiet hours start (default 23). */
  readonly startHour: number;
  /** Local hour at which they end (default 9). */
  readonly endHour: number;
}
export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 23, endHour: 9 };

export const isQuietHour = (now: Date, q: QuietHours = DEFAULT_QUIET_HOURS): boolean => {
  const h = cairoParts(now).hour;
  return q.startHour > q.endHour ? h >= q.startHour || h < q.endHour : h >= q.startHour && h < q.endHour;
};

/** First instant at or after `now` that is outside quiet hours (the next end-of-quiet local hour, or now). */
export const nextAllowedTime = (now: Date, q: QuietHours = DEFAULT_QUIET_HOURS): Date => {
  if (!isQuietHour(now, q)) return now;
  const p = cairoParts(now);
  const sameDay = p.hour < q.endHour;
  const base = Date.UTC(p.year, p.month - 1, p.day + (sameDay ? 0 : 1));
  const b = new Date(base);
  return cairoToUtc(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate(), q.endHour);
};
