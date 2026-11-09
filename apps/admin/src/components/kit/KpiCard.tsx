import Link from "next/link";
import type { ReactNode } from "react";
import type { DeltaValue } from "../../lib/charts/format";
import { Delta } from "./Delta";
import { Sparkline } from "./Sparkline";

/** Headline number with change against the previous period, an optional sparkline and a link to the detail. The value is formatted by the caller. */
export function KpiCard({ label, value, delta, deltaText, deltaLabels, noneLabel, compareNote, spark, sparkLabel, sparkText, href, rtl, note }: {
  label: string;
  value: ReactNode;
  delta?: DeltaValue;
  deltaText?: string | null;
  deltaLabels?: { up: string; down: string; flat: string };
  noneLabel?: string;
  compareNote?: string;
  spark?: readonly number[];
  sparkLabel?: string;
  sparkText?: (index: number, value: number) => string;
  href?: string;
  rtl: boolean;
  note?: ReactNode;
}) {
  const body = (
    <>
      <span className="kpiLabel">{label}</span>
      <span className="kpiValue"><bdi>{value}</bdi></span>
      <span className="kpiMeta">
        {delta ? <Delta delta={delta} text={deltaText ?? null} noneLabel={noneLabel ?? "-"} labels={deltaLabels ?? { up: "", down: "", flat: "" }} /> : null}
        {compareNote && delta ? <span>{compareNote}</span> : null}
        {note ? <span>{note}</span> : null}
      </span>
      {spark && spark.length > 0 ? <span className="kpiSpark"><Sparkline values={spark} rtl={rtl} label={sparkLabel ?? label} valueText={sparkText ?? ((_, v) => String(v))} /></span> : null}
    </>
  );
  return href ? <Link href={href} className="kpi" data-kpi>{body}</Link> : <div className="kpi" data-kpi>{body}</div>;
}
