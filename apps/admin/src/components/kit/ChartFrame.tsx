import type { ReactNode } from "react";
import type { TableData } from "../../lib/charts/models";

/** Card around a chart: title, note, the plot at a fixed height (same when empty, so nothing jumps) and an optional footer. */
export function ChartFrame({ title, note, size = "md", children, footer }: { title: ReactNode; note?: ReactNode; size?: "sm" | "md" | "lg"; children: ReactNode; footer?: ReactNode }) {
  return (
    <figure className="chartFrame">
      <div className="chartFrameHead">
        <h3 className="chartFrameTitle">{title}</h3>
        {note ? <p className="hint">{note}</p> : null}
      </div>
      <div className="chartPlot" data-size={size}>{children}</div>
      {footer}
    </figure>
  );
}

/** Accessible table carrying every value of a chart. */
export function DataTable({ table, caption }: { table: TableData; caption: string }) {
  return (
    <div className="tableWrap">
      <table className="table chartTable">
        <caption className="srOnly">{caption}</caption>
        <thead><tr>{table.head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>{row.map((cell, c) => (c === 0 ? <th key={c} scope="row">{cell}</th> : <td key={c}><bdi>{cell}</bdi></td>))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
