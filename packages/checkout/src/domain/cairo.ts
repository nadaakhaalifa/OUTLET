// Copied from packages/returns/src/domain/eligibility.ts (importing it would couple the modules).
const CAIRO = "Africa/Cairo";
const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO, year: "numeric", month: "2-digit", day: "2-digit" });
const CLOCK_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Local calendar date in Africa/Cairo as YYYY-MM-DD (handles Egypt's DST). */
export const cairoDate = (d: Date): string => {
  const parts = new Map(DAY_FMT.formatToParts(d).map((p) => [p.type, p.value] as const));
  return `${parts.get("year") ?? ""}-${parts.get("month") ?? ""}-${parts.get("day") ?? ""}`;
};

const startOfCairoDay = (date: string): Date => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  for (const off of [2, 3]) {
    const cand = new Date(utcMidnight - off * 3_600_000);
    if (cairoDate(cand) === date && CLOCK_FMT.format(cand) === "00:00") return cand;
  }
  return new Date(utcMidnight - 2 * 3_600_000);
};

/** Last millisecond of the Cairo calendar day `days` after the delivery day (delivery day is day 0). */
export const windowEnd = (deliveredAt: Date, days: number): Date => {
  const [y, m, d] = cairoDate(deliveredAt).split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + days + 1)).toISOString().slice(0, 10);
  return new Date(startOfCairoDay(next).getTime() - 1);
};
