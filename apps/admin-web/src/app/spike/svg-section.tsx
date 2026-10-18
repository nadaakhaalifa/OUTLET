"use client";
import { BulletChart, Sparkline, Waterfall } from "@outlet/ui-web";
import { SPARK, WATERFALL, summarize } from "./data";
import { frame } from "./shared";

const wfRows = WATERFALL.map((s) => ({ ...s }));

export default function SvgSection() {
  return (
    <>
      <h2 id="lib-svg">B. Hand-written SVG (packages/ui-web)</h2>
      {frame("B1 Sparkline", summarize("Weekly value", SPARK.map((_, i) => `W${i + 1}`), SPARK), <Sparkline values={SPARK} label="Sparkline of ten values (demo)" />, {
        caption: "Sparkline values (demo)",
        columns: [{ key: "i", header: "Week", cell: (r: { i: number; v: number }) => `W${r.i + 1}` }, { key: "v", header: "Value", numeric: true, cell: (r) => String(r.v) }],
        rows: SPARK.map((v, i) => ({ i, v })), rowKey: (r) => String(r.i),
      })}
      {frame("B2 Bullet chart: dispatch SLA", "Value 82 against a target of 90, in the middle band.", <BulletChart value={82} target={90} bands={[60, 85, 100]} label="Dispatched on time" valueText="82%" targetText="target 90%" />, {
        caption: "Bullet data (demo)",
        columns: [{ key: "k", header: "Measure", cell: (r: { k: string; v: string }) => r.k }, { key: "v", header: "Value", numeric: true, cell: (r) => r.v }],
        rows: [{ k: "On-time dispatch", v: "82%" }, { k: "Target", v: "90%" }], rowKey: (r) => r.k,
      })}
      {frame("B3 Waterfall: gross to payout", "Gross 1000 less commission 150 and refunds 90, plus 30 adjustments, leaves a payout of 790.", <Waterfall steps={WATERFALL} label="Waterfall from gross to payout (demo)" format={String} />, {
        caption: "Waterfall steps (demo)",
        columns: [{ key: "label", header: "Step", cell: (r: (typeof wfRows)[number]) => r.label }, { key: "value", header: "Amount", numeric: true, cell: (r) => (r.value > 0 && r.kind === "delta" ? `+${r.value}` : String(r.value)) }],
        rows: wfRows, rowKey: (r) => r.label,
      })}
    </>
  );
}
