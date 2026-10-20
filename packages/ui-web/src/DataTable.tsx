import type { ReactNode } from "react";
import { Skeleton } from "./Skeleton";

export type SortDir = "asc" | "desc";

export interface Column<Row> {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** Right-align (inline-end) with tabular figures. Use for every numeric and money column. */
  readonly numeric?: boolean;
  readonly sortable?: boolean;
  /** Visible sort-button label, e.g. "Sort by Revenue" (translated by the caller). */
  readonly sortLabel?: string;
}

export type TableState = "ready" | "loading" | "error" | "empty";

export interface DataTableProps<Row> {
  readonly caption: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly state?: TableState;
  /** Say why it is empty and what to do next. */
  readonly emptyMessage?: string;
  readonly errorMessage?: string;
  /** Optional retry control for the error state. */
  readonly errorAction?: ReactNode;
  readonly loadingLabel?: string;
  readonly sort?: { readonly key: string; readonly dir: SortDir };
  /** Controlled sorting: the parent re-orders `rows`. Without it, headers are plain text. Client components only. */
  readonly onSort?: (key: string) => void;
  /** Header cell scope for the first column (human-readable row header). Default true. */
  readonly firstColumnIsHeader?: boolean;
}

/** Rank for the total order: numbers (incl. ±Infinity) first, then NaN, then strings. NaN and strings sort last in both directions. */
function rank(v: number | string): 0 | 1 | 2 {
  return typeof v === "string" ? 2 : Number.isNaN(v) ? 1 : 0;
}

/**
 * Stable sort helper for controlled tables; `value` extracts a number or string. Does not mutate.
 * The comparator is a total order: numbers by value, NaN after numbers, strings last (mixed columns never throw or
 * reorder unpredictably); NaN and strings stay last for both directions. Strings use an explicit collation `locale`
 * (default "en", never the runtime default, so server and client agree); pass the UI language for Arabic.
 */
export function sortRows<Row>(rows: readonly Row[], value: (row: Row) => number | string, dir: SortDir, locale = "en"): Row[] {
  const sign = dir === "asc" ? 1 : -1;
  const collator = new Intl.Collator(locale);
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      const ra = rank(a.v);
      const rb = rank(b.v);
      if (ra !== rb) return ra - rb;
      let c = 0;
      if (ra === 0) c = (a.v as number) < (b.v as number) ? -1 : (a.v as number) > (b.v as number) ? 1 : 0;
      else if (ra === 2) c = collator.compare(a.v as string, b.v as string);
      return c === 0 ? a.i - b.i : c * sign;
    })
    .map((x) => x.row);
}

/** Unique React keys from `rowKey`: a repeated key gets an occurrence suffix instead of colliding (two rows are never merged or dropped). */
function uniqueKeys<Row>(rows: readonly Row[], rowKey: (row: Row) => string): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const k = rowKey(r);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n === 0 ? k : `${k}\u0000dup${n}`;
  });
}

/** Accessible name of a sort button: always contains the visible header text (WCAG 2.5.3 Label in Name). */
export function sortButtonName(header: string, sortLabel: string | undefined): string | undefined {
  if (sortLabel === undefined) return undefined;
  return sortLabel.includes(header) ? sortLabel : `${header}, ${sortLabel}`;
}

const ARROW: Readonly<Record<SortDir, string>> = { asc: "▲", desc: "▼" };

/**
 * Semantic table: caption, scoped headers, aria-sort (only on columns that are sortable AND wired with `onSort`),
 * numeric columns on the inline-end side, explicit non-ready states. Duplicate `rowKey` values are de-duplicated
 * for React; keep them unique anyway. Needs no "use client": it has no hooks; `onSort` is a function prop, so
 * the parent that passes it must itself be a client component.
 */
export function DataTable<Row>(p: DataTableProps<Row>) {
  const state = p.state ?? "ready";
  const firstIsHeader = p.firstColumnIsHeader ?? true;
  const cols = p.columns.length;
  const keys = state === "ready" ? uniqueKeys(p.rows, p.rowKey) : [];
  return (
    <div className="uw-tablewrap" aria-busy={state === "loading" ? true : undefined}>
      <table className="uw-table">
        <caption>{p.caption}</caption>
        <thead>
          <tr>
            {p.columns.map((c) => {
              const active = p.sort?.key === c.key ? p.sort.dir : undefined;
              const interactive = c.sortable === true && p.onSort !== undefined;
              const ariaSort = interactive ? (active === undefined ? "none" : active === "asc" ? "ascending" : "descending") : undefined;
              return (
                <th key={c.key} scope="col" className={c.numeric === true ? "uw-num" : undefined} aria-sort={ariaSort}>
                  {interactive ? (
                    <button type="button" className="uw-sort" onClick={() => p.onSort?.(c.key)} aria-label={sortButtonName(c.header, c.sortLabel)}>
                      <span>{c.header}</span>
                      <span aria-hidden="true">{active === undefined ? "⇅" : ARROW[active]}</span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {state === "ready"
            ? p.rows.map((row, ri) => (
                <tr key={keys[ri]}>
                  {p.columns.map((c, i) =>
                    i === 0 && firstIsHeader ? (
                      <th key={c.key} scope="row" className={c.numeric === true ? "uw-num" : undefined}>{c.cell(row)}</th>
                    ) : (
                      <td key={c.key} className={c.numeric === true ? "uw-num" : undefined}>{c.cell(row)}</td>
                    ),
                  )}
                </tr>
              ))
            : null}
          {state === "loading"
            ? [0, 1, 2].map((i) => (
                <tr key={i}>
                  <td colSpan={cols}><Skeleton width={i === 1 ? 75 : 100} {...(i === 0 && p.loadingLabel !== undefined ? { label: p.loadingLabel } : {})} /></td>
                </tr>
              ))
            : null}
          {state === "empty" ? (
            <tr><td colSpan={cols}><p className="uw-state">{p.emptyMessage}</p></td></tr>
          ) : null}
          {state === "error" ? (
            <tr><td colSpan={cols}><p role="alert" className="uw-state uw-state-error">{p.errorMessage}</p>{p.errorAction}</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
