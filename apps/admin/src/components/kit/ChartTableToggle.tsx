"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * "Show as table" switch for one chart: both views are rendered by the caller, this only swaps which is
 * visible. A real button with a constant name and aria-pressed, 44px target.
 */
export function ChartTableToggle({ chart, table, label }: { chart: ReactNode; table: ReactNode; label: string }) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <>
      <div id={id} className="chartView" data-view={asTable ? "table" : "chart"}>{asTable ? table : chart}</div>
      <button type="button" className="btn btnSecondary chartToggle" aria-pressed={asTable} aria-controls={id} onClick={() => { setAsTable((v) => !v); }} data-testid="chart-table-toggle">{label}</button>
    </>
  );
}
