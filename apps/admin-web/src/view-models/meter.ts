/** Elapsed fraction -> 5% bucket (0..20). The CSP forbids inline style attributes, so widths are CSS classes `mw-N`. */
export function meterBucket(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(20, Math.max(0, Math.round(fraction * 20)));
}
export const meterClass = (fraction: number): string => `mw-${meterBucket(fraction)}`;
/** CSS for all buckets (generated so it cannot drift from meterBucket). */
export const METER_CSS = Array.from({ length: 21 }, (_, i) => `.meter>span.mw-${i}{inline-size:${i * 5}%}`).join("");
