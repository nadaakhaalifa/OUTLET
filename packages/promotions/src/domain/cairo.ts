import { PromotionError } from "./errors.js";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Offset of Africa/Cairo from UTC at an instant, in ms (+2h winter, +3h while Egypt observes DST). */
const offsetMs = (instantMs: number): number => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(instantMs)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)])) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instantMs / 1000) * 1000;
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Cairo wall-clock midnight of a YYYY-MM-DD date as an instant. */
export const cairoMidnight = (date: string): Date => {
  const m = DATE.exec(date);
  if (m === null) throw new PromotionError("INVALID_PROMOTION", `bad date ${date}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(guess).toISOString().slice(0, 10) !== date) throw new PromotionError("INVALID_PROMOTION", `bad date ${date}`);
  return new Date(guess - offsetMs(guess - offsetMs(guess)));
};

/** Admin-entered Cairo dates: from 00:00 of `from` (inclusive) to 00:00 of the day after `toInclusive` (exclusive). */
export const cairoDateWindow = (from: string, toInclusive: string): { startsAt: Date; endsAt: Date } => {
  const startsAt = cairoMidnight(from);
  cairoMidnight(toInclusive);
  const m = DATE.exec(toInclusive);
  const next = new Date(Date.UTC(Number(m?.[1]), Number(m?.[2]) - 1, Number(m?.[3]) + 1)).toISOString().slice(0, 10);
  const endsAt = cairoMidnight(next);
  if (endsAt <= startsAt) throw new PromotionError("INVALID_PROMOTION", "window ends before it starts");
  return { startsAt, endsAt };
};
