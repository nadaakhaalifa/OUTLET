"use client";
import { useId, useState, type ReactNode } from "react";
import { DataTable, type DataTableProps } from "./DataTable";

export interface ChartFrameProps<Row> {
  readonly title: string;
  /** One-sentence text summary in the active language (trend, max, min, change). Required: it is the text alternative. */
  readonly summary: string;
  readonly chart: ReactNode;
  readonly table: Pick<DataTableProps<Row>, "caption" | "columns" | "rows" | "rowKey">;
  /** Fixed toggle label (e.g. "View as table"). The pressed state is conveyed by aria-pressed, so the name never changes. */
  readonly viewAsTableLabel: string;
  /** Source / basis / freshness line. */
  readonly note?: string;
  /** Marks synthetic data. Shown as visible text; never ship a demo frame to production. */
  readonly demoLabel?: string;
}

/**
 * Figure wrapper: figcaption (title + summary) is the accessible name and description of the chart; a toggle swaps
 * the chart for the same data as a semantic table. The chart stays mounted (hidden) so heavy libraries do not re-init.
 */
export function ChartFrame<Row>(p: ChartFrameProps<Row>) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <figure className={p.demoLabel === undefined ? "uw-figure" : "uw-figure uw-demo uw-card"} aria-labelledby={`${id}-t`} aria-describedby={`${id}-s`}>
      <figcaption>
        <p className="uw-figure-title" id={`${id}-t`}>{p.title}</p>
        <p className="uw-figure-summary" id={`${id}-s`}>{p.summary}</p>
        {p.demoLabel === undefined ? null : <p className="uw-figure-note"><strong>{p.demoLabel}</strong></p>}
      </figcaption>
      <div className="uw-figure-toolbar">
        <button type="button" className="uw-btn" aria-pressed={asTable} aria-controls={`${id}-v`} onClick={() => setAsTable((v) => !v)}>
          {p.viewAsTableLabel}
        </button>
      </div>
      <div id={`${id}-v`}>
        <div hidden={asTable}>{p.chart}</div>
        {asTable ? <DataTable {...p.table} /> : null}
      </div>
      {p.note === undefined ? null : <p className="uw-figure-note">{p.note}</p>}
    </figure>
  );
}
