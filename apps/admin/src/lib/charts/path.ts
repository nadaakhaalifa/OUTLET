/** Pure SVG path builders: straight lines, monotone cubic curves and closed areas. */

export interface Pt {
  x: number;
  y: number;
}

const r = (n: number): string => String(Math.round(n * 100) / 100);

export function linePath(points: readonly Pt[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${r(p.x)} ${r(p.y)}`).join("");
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson, the d3 `curveMonotoneX` idea): the curve
 * never overshoots, so a revenue line never dips below a real low or above a real high. `x`
 * must be strictly monotone (ascending or descending, which covers right-to-left charts).
 */
export function monotonePath(points: readonly Pt[]): string {
  const n = points.length;
  const first = points[0];
  if (first === undefined) return "";
  if (n === 1) return `M${r(first.x)} ${r(first.y)}`;
  if (n === 2) return linePath(points);
  const px = points.map((p) => p.x);
  const py = points.map((p) => p.y);
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const w = (px[i + 1] ?? 0) - (px[i] ?? 0);
    dx.push(w);
    slope.push(w === 0 ? 0 : ((py[i + 1] ?? 0) - (py[i] ?? 0)) / w);
  }
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = slope[0] ?? 0;
  m[n - 1] = slope[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1] ?? 0;
    const s1 = slope[i] ?? 0;
    m[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const sl = slope[i] ?? 0;
    if (sl === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] ?? 0) / sl;
    const b = (m[i + 1] ?? 0) / sl;
    const h = Math.hypot(a, b);
    if (h > 3) {
      const t = 3 / h;
      m[i] = t * a * sl;
      m[i + 1] = t * b * sl;
    }
  }
  let d = `M${r(first.x)} ${r(first.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (dx[i] ?? 0) / 3;
    const x0 = px[i] ?? 0;
    const y0 = py[i] ?? 0;
    const x1 = px[i + 1] ?? 0;
    const y1 = py[i + 1] ?? 0;
    d += `C${r(x0 + h)} ${r(y0 + h * (m[i] ?? 0))} ${r(x1 - h)} ${r(y1 - h * (m[i + 1] ?? 0))} ${r(x1)} ${r(y1)}`;
  }
  return d;
}

/** Closes a curve down to `baseline` (the y of zero) for an area fill. */
export function areaPath(curve: string, points: readonly Pt[], baseline: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || curve === "") return "";
  return `${curve}L${r(last.x)} ${r(baseline)}L${r(first.x)} ${r(baseline)}Z`;
}

/** Stroke-dasharray values for a ring/segment of `pct` percent (0–100) of a pathLength=100 circle. */
export function ringDash(pct: number): string {
  const v = Math.min(100, Math.max(0, pct));
  return `${r(v)} ${r(100 - v)}`;
}
