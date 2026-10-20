/** Injected time source. Domain code never reads the system clock. */
export interface Clock {
  now(): Date;
}

/**
 * Injected one-way hash. Must be deterministic, keyed/salted by the caller and
 * return a lowercase hex string. Production wiring (HMAC-SHA-256 with a secret
 * from the secret manager) lives outside this package.
 */
export type Hasher = (input: string) => string;

export const HEX_HASH = /^[0-9a-f]{16,128}$/;

export function toIso(d: Date): string {
  const t = d.getTime();
  if (Number.isNaN(t)) throw new RangeError('Invalid Date');
  return d.toISOString();
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/** Calendar month addition in UTC, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const d = new Date(Date.parse(iso));
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}
