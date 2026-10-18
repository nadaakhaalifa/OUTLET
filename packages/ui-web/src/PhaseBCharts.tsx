import { useId, type ReactNode } from "react";
import {
  agingGeometry, barHGeometry, intervalGeometry, stackedGeometry,
  type AgingBucket, type BarHRow, type IntervalRow, type StackSegment,
} from "./geometry";

/**
 * Phase B chart primitives (spec dashboard-tier1-views.md D3): BarH, StackedBar, AgingBars, IntervalPlot.
 * Data props only; every string arrives as a prop (the caller localises). No style attribute: colour comes from
 * CSS classes, geometry from SVG attributes. Series differ by pattern as well as colour; labels are direct.
 * Render each inside ChartFrame so it has a summary and a table view.
 */

/** Negative inputs: geometry is zero-length, but the label prints the caller's original value (never shown as 0). `display` strings carry exact bigint text. */
/** `ready` draws the chart. `stale` draws it greyed with `stateText`. The rest draw only `stateText`, never numbers (R-NODATA). */
export type ChartState = "ready" | "stale" | "empty" | "no_data_yet" | "not_configured";

type StateProps =
  | { readonly state?: "ready"; readonly stateText?: string }
  | { readonly state: "stale"; readonly stateText?: string }
  | { readonly state: "empty" | "no_data_yet" | "not_configured"; readonly stateText: string };

type Common = StateProps & {
  /** Accessible name. */
  readonly label: string;
  /** Longer accessible description (for example the one-sentence summary). */
  readonly description?: string;
  /** Text for a null (not loaded) datum. */
  readonly notLoadedText?: string;
  /** Right-to-left layout: bars grow from the inline-end side. */
  readonly mirror?: boolean;
};

/** Number of distinct series styles; the series style cycles after this (the rulebook caps categories at five). */
export const SERIES_STYLES = 5;

function Defs({ id }: { id: string }) {
  const pat = (name: string, children: ReactNode) => (
    <pattern id={`${id}-${name}`} width={6} height={6} patternUnits="userSpaceOnUse">
      <rect width={6} height={6} className="uw-ch-pat-bg" />
      {children}
    </pattern>
  );
  return (
    <defs>
      {pat("p1", <line x1={0} y1={6} x2={6} y2={0} className="uw-ch-pat-fg" />)}
      {pat("p2", <circle cx={3} cy={3} r={1.2} className="uw-ch-pat-dot" />)}
      {pat("p3", <path d="M0 0L6 6M6 0L0 6" className="uw-ch-pat-fg" />)}
      {pat("p4", <line x1={3} y1={0} x2={3} y2={6} className="uw-ch-pat-fg" />)}
    </defs>
  );
}

/** Fill for series i: solid for 0, patterns for the rest (so colour is never the only signal). */
const seriesProps = (id: string, i: number): { className?: string; fill?: string } => {
  const k = ((i % SERIES_STYLES) + SERIES_STYLES) % SERIES_STYLES;
  return k === 0 ? { className: "uw-ch-s0" } : { className: "uw-ch-s", fill: `url(#${id}-p${k})` };
};

const safeId = (raw: string): string => `uwc${raw.replace(/[^a-zA-Z0-9]/g, "")}`;

function Gate({ common, children }: { common: Common; children: (stale: boolean) => ReactNode }) {
  const state = common.state ?? "ready";
  if (state !== "ready" && state !== "stale") {
    return <p className={`uw-state uw-chart-state-${state}`} role="status">{common.stateText !== undefined && common.stateText !== "" ? common.stateText : common.label}</p>;
  }
  return (
    <div className={state === "stale" ? "uw-chart-wrap uw-ch-stale" : "uw-chart-wrap"}>
      {children(state === "stale")}
      {state === "stale" && common.stateText !== undefined ? <p className="uw-figure-note">{common.stateText}</p> : null}
    </div>
  );
}

function Svg({ common, width, height, children }: { common: Common; width: number; height: number; children: ReactNode }) {
  const id = safeId(useId());
  return (
    <svg
      className="uw-chart" role="img" tabIndex={0} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      aria-labelledby={`${id}-t`} {...(common.description === undefined ? {} : { "aria-describedby": `${id}-d` })}
    >
      <title id={`${id}-t`}>{common.label}</title>
      {common.description === undefined ? null : <desc id={`${id}-d`}>{common.description}</desc>}
      {children}
    </svg>
  );
}

/** Horizontal bars for a ranking. Zero baseline, shared scale, value printed at each bar end; null rows are marked not loaded. */
export function BarH(p: Common & {
  rows: readonly BarHRow[]; format: (n: number) => string; width?: number; gutter?: number;
}) {
  const width = p.width ?? 360;
  const gutter = p.gutter ?? 72;
  const mirror = p.mirror === true;
  const { bars, height } = barHGeometry(p.rows, width - gutter, mirror ? { mirror } : {});
  const shift = mirror ? gutter : 0;
  return (
    <Gate common={p}>{() => (
      <Svg common={p} width={width} height={Math.max(height, 1)}>
        <g transform={`translate(${shift} 0)`}>
          {bars.map((b, bi) => (
            <g key={`${bi}-${b.label}`}>
              <text className="uw-ch-text" x={mirror ? width - gutter : 0} y={b.labelY} textAnchor={mirror ? "end" : "start"}>{b.label}</text>
              {b.missing ? (
                <>
                  <rect className="uw-ch-missing" x={0} y={b.y} width={width - gutter} height={b.height} />
                  <text className="uw-ch-text uw-ch-muted" x={mirror ? width - gutter - 4 : 4} y={b.y + b.height - 2} textAnchor={mirror ? "end" : "start"}>{p.notLoadedText ?? ""}</text>
                </>
              ) : (
                <>
                  <rect className="uw-ch-s0" x={b.x} y={b.y} width={b.width} height={b.height} />
                  <text className="uw-ch-text" x={b.textX} y={b.y + b.height - 2} textAnchor={mirror ? "end" : "start"}>{p.rows[bi]?.display ?? p.format(b.input ?? b.value)}</text>
                </>
              )}
            </g>
          ))}
          <line className="uw-ch-axis" x1={mirror ? width - gutter : 0} x2={mirror ? width - gutter : 0} y1={0} y2={height} />
        </g>
      </Svg>
    )}</Gate>
  );
}

/** One total split into segments, each with a swatch (pattern) and a direct "label value share" line. Segment widths add up to the whole. */
export function StackedBar(p: Common & {
  segments: readonly StackSegment[]; format: (n: number) => string; formatShare?: (fraction: number) => string; width?: number;
}) {
  const width = p.width ?? 360;
  const barH = 18;
  const rowH = 18;
  const mirror = p.mirror === true;
  const { segments } = stackedGeometry(p.segments, width, mirror ? { mirror } : {});
  const height = barH + 8 + segments.length * rowH;
  const id = safeId(useId());
  return (
    <Gate common={p}>{() => (
      <Svg common={p} width={width} height={height}>
        <Defs id={id} />
        {segments.map((s, i) => (
          <rect key={`${i}-${s.label}`} {...seriesProps(id, i)} x={s.x} y={0} width={s.width} height={barH} />
        ))}
        <rect className="uw-ch-frame" x={0} y={0} width={width} height={barH} />
        {segments.map((s, i) => {
          const y = barH + 8 + i * rowH;
          const sx = mirror ? width - 12 : 0;
          const tx = mirror ? width - 18 : 18;
          const share = p.formatShare === undefined ? "" : ` (${p.formatShare(s.share)})`;
          return (
            <g key={`${i}-l`}>
              <rect {...seriesProps(id, i)} x={sx} y={y + 2} width={12} height={12} />
              <rect className="uw-ch-frame" x={sx} y={y + 2} width={12} height={12} />
              <text className="uw-ch-text" x={tx} y={y + 12} textAnchor={mirror ? "end" : "start"}>{`${s.label}: ${p.segments[i]?.display ?? p.format(s.input)}${share}`}</text>
            </g>
          );
        })}
      </Svg>
    )}</Gate>
  );
}

/**
 * Aging histogram. Buckets go youngest to oldest in reading direction. `referenceBoundary` draws a marker line
 * (SLA or zero-tolerance) before bucket k and gives the buckets beyond it a pattern; `referenceLabel` names it.
 */
export function AgingBars(p: Common & {
  buckets: readonly AgingBucket[]; format: (n: number) => string; referenceBoundary?: number; referenceLabel?: string;
  width?: number; height?: number;
}) {
  const width = p.width ?? 360;
  const height = p.height ?? 120;
  const top = 26;
  const mirror = p.mirror === true;
  const { columns, referenceX, baselineY } = agingGeometry(p.buckets, width, height, {
    ...(mirror ? { mirror } : {}),
    ...(p.referenceBoundary === undefined ? {} : { referenceBoundary: p.referenceBoundary }),
  });
  const id = safeId(useId());
  return (
    <Gate common={p}>{() => (
      <Svg common={p} width={width} height={top + height + 18}>
        <Defs id={id} />
        <g transform={`translate(0 ${top})`}>
          {columns.map((c, ci) => {
            const cx = c.x + c.width / 2;
            return (
              <g key={`${ci}-${c.label}`}>
                {c.missing ? (
                  <>
                    <rect className="uw-ch-missing" x={c.x} y={0} width={c.width} height={height} />
                    <text className="uw-ch-text uw-ch-muted" x={cx} y={height / 2} textAnchor="middle">{p.notLoadedText ?? ""}</text>
                  </>
                ) : (
                  <>
                    {c.height > 0 ? <rect {...(c.beyond ? { className: "uw-ch-late", fill: `url(#${id}-p1)` } : { className: "uw-ch-s0" })} x={c.x} y={c.y} width={c.width} height={c.height} /> : null}
                    <text className="uw-ch-text" x={cx} y={c.y - 4} textAnchor="middle">{p.buckets[ci]?.display ?? p.format(c.input ?? c.count)}</text>
                  </>
                )}
                <text className="uw-ch-text uw-ch-muted" x={cx} y={height + 14} textAnchor="middle">{c.label}</text>
              </g>
            );
          })}
          <line className="uw-ch-axis" x1={0} x2={width} y1={baselineY} y2={baselineY} />
          {referenceX === null ? null : (
            <g>
              <line className="uw-ch-target" x1={referenceX} x2={referenceX} y1={-8} y2={height} />
              {p.referenceLabel === undefined ? null : (
                <text className="uw-ch-text" x={referenceX} y={-12} textAnchor={mirror ? "end" : "start"}>{p.referenceLabel}</text>
              )}
            </g>
          )}
        </g>
      </Svg>
    )}</Gate>
  );
}

/** p10-p90 range bar with a p50 tick per row on one shared zero-based scale. Rows without a valid interval say why via `unavailableText`. */
export function IntervalPlot(p: Common & {
  rows: readonly IntervalRow[]; format: (n: number) => string; unavailableText?: string; width?: number; domainMax?: number;
}) {
  const width = p.width ?? 360;
  const gutter = 120;
  const mirror = p.mirror === true;
  const plotW = width - gutter;
  const { marks, height } = intervalGeometry(p.rows, plotW, {
    ...(mirror ? { mirror } : {}), ...(p.domainMax === undefined ? {} : { domainMax: p.domainMax }),
  });
  const shift = mirror ? gutter : 0;
  return (
    <Gate common={p}>{() => (
      <Svg common={p} width={width} height={Math.max(height, 1)}>
        <g transform={`translate(${shift} 0)`}>
          {marks.map((m, i) => {
            const iv = p.rows[i]?.interval ?? null;
            const lo = Math.min(m.x10, m.x90);
            const w = Math.abs(m.x90 - m.x10);
            return (
              <g key={m.label}>
                <text className="uw-ch-text" x={mirror ? plotW : 0} y={m.y + 12} textAnchor={mirror ? "end" : "start"}>{m.label}</text>
                {m.unavailable || iv === null ? (
                  <text className="uw-ch-text uw-ch-muted" x={mirror ? plotW : 0} y={m.y + 28} textAnchor={mirror ? "end" : "start"}>{p.unavailableText ?? ""}</text>
                ) : (
                  <>
                    <rect className="uw-ch-range" x={lo} y={m.y + 18} width={Math.max(w, 1)} height={8} />
                    <line className="uw-ch-tick" x1={m.x50} x2={m.x50} y1={m.y + 14} y2={m.y + 30} />
                    <text className="uw-ch-text uw-ch-muted" x={mirror ? lo - 4 : lo + w + 4} y={m.y + 26} textAnchor={mirror ? "end" : "start"}>{`${p.format(iv.p10)} / ${p.format(iv.p50)} / ${p.format(iv.p90)}`}</text>
                  </>
                )}
              </g>
            );
          })}
        </g>
      </Svg>
    )}</Gate>
  );
}
