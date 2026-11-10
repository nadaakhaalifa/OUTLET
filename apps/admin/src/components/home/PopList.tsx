import Link from "next/link";
import type { ReactNode } from "react";

export interface PopRow {
  readonly id: string;
  readonly cells: readonly ReactNode[];
  readonly href?: string;
}

/** Read-only table for a pop page. The caller slices to MAX_POP_ROWS; the view only renders what it is given. */
export function PopList({ caption, head, rows, viewLabel }: { caption: string; head: readonly string[]; rows: readonly PopRow[]; viewLabel: string }) {
  return (
    <div className="tableWrap card">
      <table className="table" data-testid="pop-list">
        <caption className="srOnly">{caption}</caption>
        <thead><tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}{rows.some((r) => r.href !== undefined) ? <th scope="col"><span className="srOnly">{viewLabel}</span></th> : null}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {r.cells.map((c, i) => <td key={i}><bdi>{c}</bdi></td>)}
              {rows.some((x) => x.href !== undefined) ? <td>{r.href !== undefined ? <Link href={r.href} className="btn btnGhost">{viewLabel}</Link> : null}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
