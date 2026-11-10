import Link from "next/link";
import type { ReactNode } from "react";
import { barWidths } from "../../lib/charts/models";

export interface BarListItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: number;
  readonly valueText: string;
  readonly sub?: ReactNode;
  readonly href?: string;
}

/** Horizontal bars from a zero baseline, sorted by the caller, with the value written out in text. */
export function BarList({ items, emptyText }: { items: readonly BarListItem[]; emptyText: string }) {
  if (items.length === 0) return <p className="empty">{emptyText}</p>;
  const widths = barWidths(items.map((i) => i.value));
  return (
    <ul className="bars">
      {items.map((it, i) => (
        <li key={it.id} className="barRow">
          <div className="barHead">
            {it.href ? <Link href={it.href} className="barLabel">{it.label}</Link> : <span className="barLabel">{it.label}</span>}
            <span className="barValue"><bdi>{it.valueText}</bdi></span>
          </div>
          <svg className="barSvg" aria-hidden="true" focusable="false"><rect className="barTrack" width="100%" height="100%" rx="4" /><rect className="barFill" width={`${(widths[i] ?? 0).toFixed(2)}%`} height="100%" rx="4" /></svg>
          {it.sub ? <span className="hint">{it.sub}</span> : null}
        </li>
      ))}
    </ul>
  );
}
