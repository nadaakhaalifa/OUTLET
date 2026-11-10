import { barHeights } from "../../lib/charts/models";

const BAR = 8;
const GAP = 2;
/** Slot count: a short series keeps the bar size of a full one and sits at the start edge. */
const SLOTS = 14;
const HEIGHT = 40;

/**
 * A stat tile's trend as small columns, newest in the accent. Server-rendered SVG, no script. Time
 * runs in reading direction (oldest at the start: right in Arabic). The same figures are in a
 * visually hidden list for screen readers. Renders only what it is given.
 */
export function Sparkline({ values, rtl, label, valueText }: { values: readonly number[]; rtl: boolean; label: string; valueText: (index: number, value: number) => string }) {
  if (values.length === 0) return null;
  const heights = barHeights(values);
  const width = Math.max(SLOTS, values.length) * (BAR + GAP) - GAP;
  const slots = Math.max(SLOTS, values.length);
  const x = (i: number) => (rtl ? slots - 1 - i : i) * (BAR + GAP);
  return (
    <figure className="spark">
      <svg viewBox={`0 0 ${String(width)} 40`} preserveAspectRatio="none" role="presentation" focusable="false" className="sparkSvg">
        <line className="sparkBase" x1={0} x2={width} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
        {values.map((v, i) => {
          const h = Math.round((heights[i] ?? 0) * (HEIGHT - 2) * 100) / 100;
          return h > 0 ? <rect key={i} className={i === values.length - 1 ? "sparkNow" : "sparkBar"} x={x(i)} y={HEIGHT - h} width={BAR} height={h} rx={1.5}><title>{valueText(i, v)}</title></rect> : null;
        })}
      </svg>
      <figcaption>
        <span className="srOnly">{label}</span>
        <ol className="srOnly">{values.map((v, i) => <li key={i}>{valueText(i, v)}</li>)}</ol>
      </figcaption>
    </figure>
  );
}
