/**
 * Day arithmetic on Cairo calendar days (`YYYY-MM-DD` strings). The caller supplies the Cairo day;
 * this module only converts it to an integer day index (days since 1970-01-01) so series maths never
 * touches a timezone. Pure.
 */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DAY_MS = 86_400_000;

export function isoDayToIndex(day: string): number {
  const m = ISO_DAY.exec(day);
  if (m === null) throw new RangeError(`invalid day: ${day}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new RangeError(`invalid day: ${day}`);
  }
  return ms / DAY_MS;
}

export function indexToIsoDay(index: number): string {
  if (!Number.isInteger(index)) throw new RangeError("day index must be an integer");
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}
