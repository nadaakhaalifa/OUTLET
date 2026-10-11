export type MegaEventId = "white_friday" | "singles_day" | "ramadan" | "eid_al_fitr" | "eid_al_adha" | "mothers_day";
export const FREEZE_HOURS = 48;
const HOUR = 3_600_000, DAY = 86_400_000;

export interface MegaEvent {
  readonly id: MegaEventId;
  readonly year: number;
  readonly startMs: number; // 00:00 Africa/Cairo expressed as UTC ms
  readonly endMs: number;
  /** Hijri-based dates come from the astronomical Umm al-Qura calendar: confirm after moon sighting. */
  readonly estimated: boolean;
}

/** Cairo is UTC+2 or UTC+3 (DST since 2023). Resolve the offset for a calendar date using ICU, not a constant. */
function cairoMidnightMs(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hour: "numeric", hourCycle: "h23", timeZoneName: "longOffset" });
  const off = /GMT([+-])(\d{2}):(\d{2})/.exec(fmt.format(new Date(guess + 12 * HOUR)));
  const mins = off === null ? 120 : (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3]));
  return guess - mins * 60_000;
}

function lastFridayOfNovember(y: number): number {
  for (let d = 30; d >= 1; d--) if (new Date(Date.UTC(y, 10, d)).getUTCDay() === 5) return d;
  return 30;
}

const hijri = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { timeZone: "UTC", day: "numeric", month: "numeric", year: "numeric" });
function hijriParts(utcDayMs: number): { y: number; m: number; d: number } {
  const p = hijri.formatToParts(new Date(utcDayMs));
  const get = (t: string): number => Number(p.find((x) => x.type === t)?.value ?? "0");
  return { y: get("relatedYear") || get("year"), m: get("month"), d: get("day") };
}
/** Finds the Gregorian day (UTC midnight ms) of a Hijri month/day inside a Gregorian year; null when absent. */
function findHijri(gYear: number, hMonth: number, hDay: number): number | null {
  for (let t = Date.UTC(gYear, 0, 1); t < Date.UTC(gYear + 1, 0, 1); t += DAY) {
    const h = hijriParts(t);
    if (h.m === hMonth && h.d === hDay) return t;
  }
  return null;
}
const ymd = (ms: number): [number, number, number] => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };

export function megaEventsForYear(year: number): readonly MegaEvent[] {
  const out: MegaEvent[] = [];
  const fixed = (id: MegaEventId, y: number, m: number, d: number, days: number): void => {
    out.push({ id, year, startMs: cairoMidnightMs(y, m, d), endMs: cairoMidnightMs(y, m, d) + days * DAY, estimated: false });
  };
  fixed("white_friday", year, 11, lastFridayOfNovember(year), 3);
  fixed("singles_day", year, 11, 11, 1);
  fixed("mothers_day", year, 3, 21, 1);
  const hij = (id: MegaEventId, hm: number, hd: number, days: number): void => {
    const t = findHijri(year, hm, hd);
    if (t === null) return;
    const [y, m, d] = ymd(t);
    out.push({ id, year, startMs: cairoMidnightMs(y, m, d), endMs: cairoMidnightMs(y, m, d) + days * DAY, estimated: true });
  };
  hij("ramadan", 9, 1, 30);
  hij("eid_al_fitr", 10, 1, 3);
  hij("eid_al_adha", 12, 10, 4);
  return out.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

export type FreezeState = "none" | "upcoming_freeze" | "freeze_active" | "event_running";
export interface CalendarRow { readonly event: MegaEvent; readonly freezeFromMs: number; readonly state: FreezeState }

/** Release freeze starts 48h before the event (T8) and lasts until it ends. Uses the server clock. */
export function calendarRows(serverNowMs: number, years: readonly number[]): readonly CalendarRow[] {
  const rows = years.flatMap((y) => megaEventsForYear(y)).map((event): CalendarRow => {
    const freezeFromMs = event.startMs - FREEZE_HOURS * HOUR;
    const state: FreezeState =
      serverNowMs >= event.endMs ? "none"
        : serverNowMs >= event.startMs ? "event_running"
          : serverNowMs >= freezeFromMs ? "freeze_active"
            : "upcoming_freeze";
    return { event, freezeFromMs, state };
  });
  return rows.filter((r) => r.event.endMs > serverNowMs).sort((a, b) => a.event.startMs - b.event.startMs);
}

export const freezeWarning = (rows: readonly CalendarRow[]): CalendarRow | null =>
  rows.find((r) => r.state === "freeze_active" || r.state === "event_running") ?? null;
