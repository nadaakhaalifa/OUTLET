/**
 * Pure scale and tick helpers for the hand-rolled SVG charts. No DOM, no React: unit-tested in
 * test/charts. The tick rule is the d3-array "nice ticks" algorithm (ISC licence), re-written.
 */

/** A step of 1, 2 or 5 times a power of ten that gives about `count` intervals over the span. */
export function tickStep(start: number, stop: number, count: number): number {
  const raw = (stop - start) / Math.max(count, 1);
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const power = Math.floor(Math.log10(raw));
  const error = raw / 10 ** power;
  const factor =
    error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1;
  return factor * 10 ** power;
}

/**
 * Nice axis for [min, max]: the rounded domain and the tick values (about `count` of them).
 * A flat or empty series gets a small domain starting at 0, never a zero-height axis.
 */
export function niceTicks(
  min: number,
  max: number,
  count = 4,
): { domain: [number, number]; ticks: number[] } {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { domain: [0, 1], ticks: [0, 1] };
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else {
      hi = lo > 0 ? lo * 1.2 : 0;
      lo = lo > 0 ? 0 : lo * 1.2;
    }
  }
  const step = tickStep(lo, hi, count);
  const first = Math.floor(lo / step) * step;
  const last = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const n = Math.round((last - first) / step);
  for (let i = 0; i <= n; i++) ticks.push(Number((first + i * step).toPrecision(12)));
  return { domain: [ticks[0] ?? 0, ticks[ticks.length - 1] ?? 1], ticks };
}

/** Maps the domain onto the range linearly; a zero-width domain maps to the range start. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (v) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0));
}

/** Evenly spaced bands: `start` and `size` of band `i` inside `range`, with `padding` (0–1). */
export function bandScale(
  count: number,
  range: readonly [number, number],
  padding = 0.2,
): { size: number; start: (i: number) => number; centre: (i: number) => number } {
  const [r0, r1] = range;
  const n = Math.max(count, 1);
  const step = (r1 - r0) / n;
  const size = step * (1 - padding);
  const start = (i: number) => r0 + i * step + (step - size) / 2;
  return { size, start, centre: (i) => start(i) + size / 2 };
}
