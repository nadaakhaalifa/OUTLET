/** Africa/Cairo calendar helpers (DST aware through Intl, no tz database copy). */

const FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Cairo",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface CairoParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

export function cairoParts(ms: number): CairoParts {
  const m = new Map<string, string>();
  for (const p of FORMAT.formatToParts(new Date(ms))) m.set(p.type, p.value);
  const num = (k: string): number => Number(m.get(k) ?? "0");
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
    weekday: WEEKDAYS[m.get("weekday") ?? "Sun"] ?? 0,
  };
}

/** Cairo local wall time to a UTC instant. Skipped local times (DST gap) resolve forward. */
export function cairoLocalToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = cairoParts(guess);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    const delta = wanted - shown;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

export interface CairoSchedule {
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday. Absent: every day. */
  readonly weekday?: number;
}

/** First instant strictly after `afterMs` that matches the Cairo wall-clock schedule. */
export function nextCairoOccurrence(afterMs: number, s: CairoSchedule): number {
  const base = cairoParts(afterMs);
  for (let add = 0; add <= 8; add++) {
    const day = new Date(Date.UTC(base.year, base.month - 1, base.day + add));
    const at = cairoLocalToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), s.hour, s.minute);
    if (at <= afterMs) continue;
    if (s.weekday !== undefined && cairoParts(at).weekday !== s.weekday) continue;
    return at;
  }
  throw new RangeError("no Cairo occurrence within 8 days");
}
