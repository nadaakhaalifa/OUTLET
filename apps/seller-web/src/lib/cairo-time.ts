const TZ = "Africa/Cairo";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const part = (parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number =>
  Number(parts.find((p) => p.type === type)?.value ?? "0");

/** Cairo offset from UTC in minutes at an instant (Egypt observes DST, so this is not a constant). */
export function cairoOffsetMinutes(utcMs: number): number {
  const p = fmt.formatToParts(new Date(utcMs));
  const asUtc = Date.UTC(part(p, "year"), part(p, "month") - 1, part(p, "day"), part(p, "hour"), part(p, "minute"), part(p, "second"));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** "2026-11-20T18:30" typed as Cairo wall-clock time to a UTC ISO string. Null when malformed. */
export function cairoLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (m === null) return null;
  const [y, mo, dy, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const wall = Date.UTC(y, mo - 1, dy, h, mi);
  const back = new Date(wall);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== dy || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return null;
  const guess = wall - cairoOffsetMinutes(wall) * 60_000;
  const utc = wall - cairoOffsetMinutes(guess) * 60_000;
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
