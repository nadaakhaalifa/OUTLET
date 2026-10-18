"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { colors } from "@outlet/ui-tokens";
import { ChartFrame, type Column } from "@outlet/ui-web";
import { DAYS, DEMO_LABEL, ORDERS, REFUNDS } from "./data";

/** Chart libraries cannot read CSS variables in presentation attributes, so resolved token values are passed (light scheme). */
export const C = colors.light;

export interface DayRow { day: string; orders: number; refunds: number }
export const dayRows: DayRow[] = DAYS.map((d, i) => ({ day: d, orders: ORDERS[i] ?? 0, refunds: REFUNDS[i] ?? 0 }));
const dayCols: Column<DayRow>[] = [
  { key: "day", header: "Day", cell: (r) => r.day },
  { key: "orders", header: "Orders", numeric: true, cell: (r) => String(r.orders) },
  { key: "refunds", header: "Refunds", numeric: true, cell: (r) => String(r.refunds) },
];
export const dayTable = { caption: "Orders and refunds per day (demo)", columns: dayCols, rows: dayRows, rowKey: (r: DayRow) => r.day };

export interface TableSpec<Row> { caption: string; columns: readonly Column<Row>[]; rows: readonly Row[]; rowKey: (r: Row) => string }

/** Every spike chart is wrapped in ChartFrame: text summary, table toggle, visible demo label. */
export function frame<Row>(title: string, summary: string, chart: ReactNode, table: TableSpec<Row>) {
  return <ChartFrame title={title} summary={summary} chart={chart} table={table} viewAsTableLabel="View as table" demoLabel={DEMO_LABEL} />;
}

/** Records mount time (render to effects) and SVG node count of its subtree: the 5k-mark check. */
export function PerfMark({ children, name }: { children: ReactNode; name: string }) {
  const t0 = useRef(performance.now());
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // Two animation frames after the effect so libraries that draw in a follow-up state update are included (approximate).
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.dataset["renderMs"] = String(Math.round(performance.now() - t0.current));
      el.dataset["svgNodes"] = String(el.querySelectorAll("svg *").length);
    }));
  }, []);
  return <div ref={ref} data-perf={name}>{children}</div>;
}
