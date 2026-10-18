import { useId } from "react";
import { bulletGeometry, pathOf, sparklinePoints, waterfallGeometry, type WaterfallStep } from "./geometry";

/**
 * Hand-written SVG charts. Colour comes from CSS classes (generated from tokens), geometry from SVG attributes:
 * no style attribute anywhere, so they run under the admin CSP. Every chart has role="img" and a text name.
 */

export function Sparkline({ values, label, width = 120, height = 32, domain, mirror }: {
  values: readonly number[]; label: string; width?: number; height?: number; domain?: readonly [number, number]; mirror?: boolean;
}) {
  const pts = sparklinePoints(values, width, height, { ...(domain === undefined ? {} : { domain }), ...(mirror === undefined ? {} : { mirror }) });
  const last = pts[pts.length - 1];
  return (
    <svg className="uw-chart" role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {pts.length > 1 ? <path className="uw-ch-line" d={pathOf(pts)} /> : null}
      {last === undefined ? null : <circle className="uw-ch-dot" cx={last.x} cy={last.y} r={3} />}
    </svg>
  );
}

export function BulletChart({ value, target, bands, max, label, valueText, targetText, width = 240 }: {
  value: number; target?: number; bands: readonly number[]; max?: number; label: string; valueText: string; targetText?: string; width?: number;
}) {
  const g = bulletGeometry({ value, target, bands, max }, width);
  const h = 16;
  return (
    <svg className="uw-chart" role="img" aria-label={`${label}: ${valueText}${targetText === undefined ? "" : ` / ${targetText}`}`} width={width} height={h + 16} viewBox={`0 0 ${width} ${h + 16}`}>
      {g.bands.map((b) => <rect key={b.level} className={`uw-ch-band-${b.level}`} x={b.x} y={0} width={b.width} height={h} />)}
      <rect className="uw-ch-measure" x={g.measure.x} y={h / 4} width={g.measure.width} height={h / 2} />
      {g.targetX === null ? null : <line className="uw-ch-target" x1={g.targetX} x2={g.targetX} y1={1} y2={h - 1} />}
      <text className="uw-ch-text" x={0} y={h + 12} textAnchor="start">{valueText}</text>
    </svg>
  );
}

/** Text for a bar: signed for deltas (the sign is explicit whatever the formatter does), plain for totals. */
export function stepText(kind: "total" | "up" | "down", value: number, format: (n: number) => string): string {
  if (kind === "total" || value === 0) return format(value);
  return value > 0 ? `+${format(value)}` : `-${format(Math.abs(value))}`;
}

/**
 * Waterfall. Increases are solid, decreases hatched, totals dark. Every bar prints its own step value as text, never
 * fill alone: delta bars with an explicit sign ("+30", "-20"), total bars with their total. The running level is not printed.
 */
export function Waterfall({ steps, label, format, width = 480, height = 160, mirror }: {
  steps: readonly WaterfallStep[]; label: string; format: (n: number) => string; width?: number; height?: number; mirror?: boolean;
}) {
  const pad = 18;
  const { bars, baselineY } = waterfallGeometry(steps, width, height, mirror === undefined ? {} : { mirror });
  const hatch = useId();
  return (
    <svg className="uw-chart" role="img" aria-label={label} width={width} height={height + pad * 2 + 14} viewBox={`0 0 ${width} ${height + pad * 2 + 14}`}>
      <defs>
        <pattern id={hatch} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={6} height={6} className="uw-ch-down" />
          <line x1={0} y1={0} x2={0} y2={6} className="uw-ch-hatch-line" />
        </pattern>
      </defs>
      <g transform={`translate(0 ${pad})`}>
        <line className="uw-ch-axis" x1={0} x2={width} y1={baselineY} y2={baselineY} />
        {bars.map((b, i) => {
          const text = stepText(b.kind, b.value, format);
          return (
          <g key={`${i}-${b.label}`}>
            <title>{`${b.label}: ${text}`}</title>
            <rect className={b.kind === "up" ? "uw-ch-up" : b.kind === "total" ? "uw-ch-total" : undefined} {...(b.kind === "down" ? { fill: `url(#${hatch})` } : {})} x={b.x} y={b.y} width={b.width} height={b.height} />
            <text className="uw-ch-text" x={b.x + b.width / 2} y={b.y - 4} textAnchor="middle">{text}</text>
            <text className="uw-ch-text uw-ch-muted" x={b.x + b.width / 2} y={height + 14} textAnchor="middle">{b.label}</text>
          </g>
          );
        })}
      </g>
    </svg>
  );
}
