import { cairoParts } from "./cairo";

const HOUR_MS = 3_600_000;

/** One real UTC hour with its Africa/Cairo labels (ADR-0047). Egypt's offsets are whole hours, so local and UTC hours coincide. */
export interface CairoHourBucket {
  /** Start of the UTC hour, epoch ms. */
  readonly hourUtcMs: number;
  /** Local calendar date at the start of the hour, `YYYY-MM-DD`. */
  readonly cairoDate: string;
  /** Local hour 0-23 (the repeated autumn hour appears twice, with different offsets). */
  readonly cairoHour: number;
  /** UTC offset at the start of the hour: 120 (winter) or 180 (summer). */
  readonly utcOffsetMin: 120 | 180;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The hour bucket containing `ms`. Rollup rows store these derived fields at write time; Postgres never converts time zones. */
export function cairoHourBucket(ms: number): CairoHourBucket {
  const hourUtcMs = Math.floor(ms / HOUR_MS) * HOUR_MS;
  const p = cairoParts(hourUtcMs);
  const offset = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - hourUtcMs) / 60_000);
  if (offset !== 120 && offset !== 180) throw new Error(`unexpected Africa/Cairo offset ${offset} minutes`);
  return { hourUtcMs, cairoDate: `${p.year}-${pad(p.month)}-${pad(p.day)}`, cairoHour: p.hour, utcOffsetMin: offset };
}
