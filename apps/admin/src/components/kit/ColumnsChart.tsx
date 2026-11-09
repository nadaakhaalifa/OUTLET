import { columnsModel } from "../../lib/charts/columnsModel";
import { formatWith, type FormatSpec } from "../../lib/charts/format";
import { directLabelIndexes } from "../../lib/charts/models";
import { ChartFrame, DataTable } from "./ChartFrame";
import { ChartTableToggle } from "./ChartTableToggle";

const pct = (n: number): string => `${n.toFixed(2)}%`;

export interface ColumnPoint {
  readonly label: string;
  readonly value: number;
}

/**
 * Single-series columns in one hue from the Outlex tokens, zero baseline, labelled y axis and x axis,
 * and direct labels on the highest and the newest column (so the figure never depends on hover or
 * colour). Digits sit in `bdi`. The table view lists every value. `rtl` mirrors the time axis.
 * Renders exactly the points it is given.
 */
export function ColumnsChart({ points, rtl, title, note, summary, format, axisFormat, valueHeader, labelHeader, tableLabel, emptyText, highestLabel, latestLabel, size = "md" }: {
  points: readonly ColumnPoint[];
  rtl: boolean;
  title: string;
  note?: string;
  summary?: string;
  format: FormatSpec;
  axisFormat: FormatSpec;
  valueHeader: string;
  labelHeader: string;
  tableLabel: string;
  emptyText: string;
  highestLabel: string;
  latestLabel: string;
  size?: "sm" | "md" | "lg";
}) {
  const m = columnsModel(points.map((p) => ({ label: p.label, values: [p.value] })), { mirror: rtl, maxLabels: 5 });
  const marked = new Set(directLabelIndexes(points.map((p) => p.value)));
  const highest = directLabelIndexes(points.map((p) => p.value))[0];
  const n = Math.max(points.length, 1);
  const slot = 100 / n;
  const chart = (
    <div className="cols" role="group" aria-label={title}>
      <svg className="colsY" aria-hidden="true" focusable="false">
        {m.yTicks.map((t) => <text key={t.value} className="colsTick" x="100%" y={pct(t.yPct)} textAnchor="end" dominantBaseline="middle">{formatWith(axisFormat, t.value)}</text>)}
      </svg>
      <div className="colsArea">
        {m.empty ? (
          <p className="colsEmpty">{emptyText}</p>
        ) : (
          <svg className="colsSvg" focusable="false">
            {m.yTicks.map((t) => <line key={t.value} className="colsRule" x1="0" x2="100%" y1={pct(t.yPct)} y2={pct(t.yPct)} />)}
            {m.columns.map((c, pos) => {
              const direct = marked.has(c.index) && c.total > 0;
              const kind = c.index === points.length - 1 ? latestLabel : c.index === highest ? highestLabel : "";
              return (
                <g key={c.index} data-newest={c.index === points.length - 1 ? "true" : undefined}>
                  <title>{`${c.label}: ${formatWith(format, c.total)}${kind ? ` (${kind})` : ""}`}</title>
                  <rect className="colsBar" x={pct(pos * slot + slot * 0.15)} width={pct(slot * 0.7)} y={pct(100 - c.totalPct)} height={pct(c.totalPct)} rx="2" />
                  {direct ? <text className="colsCap" x={pct(pos * slot + slot / 2)} y={pct(100 - c.totalPct)} dy="-4" textAnchor="middle">{formatWith(format, c.total)}</text> : null}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <div className="colsX" aria-hidden="true">{m.xLabels.map((l) => <span key={l.index}><bdi>{l.label}</bdi></span>)}</div>
    </div>
  );
  const table = <DataTable caption={title} table={{ head: [labelHeader, valueHeader], rows: points.map((p) => [p.label, formatWith(format, p.value)]) }} />;
  return (
    <ChartFrame title={title} note={note} summary={summary} size={size}>
      {m.empty && points.length === 0 ? <p className="colsEmpty">{emptyText}</p> : <ChartTableToggle chart={chart} table={table} label={tableLabel} />}
    </ChartFrame>
  );
}
