/** Market-local calendar day (YYYY-MM-DD) of an instant. Intl uses the IANA tz database, so Egypt's DST switch days are handled. */
export const localDay = (at: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: string): boolean => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Calendar arithmetic on a YYYY-MM-DD string (no time zone involved, so no DST surprises). */
export const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
