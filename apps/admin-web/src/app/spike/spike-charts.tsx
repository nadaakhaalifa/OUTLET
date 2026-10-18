"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Dialog } from "@outlet/ui-web";

// One chunk per library (dynamic import) so the bundle cost of each is measurable and nothing loads unless rendered.
const EChartsSection = dynamic(() => import("./echarts-section"));
const SvgSection = dynamic(() => import("./svg-section"));
const RechartsSection = dynamic(() => import("./recharts-section"));
// Same section, client-only render: React then sets style through the CSSOM (allowed by CSP) instead of in server HTML (blocked).
const RechartsCsr = dynamic(() => import("./recharts-section"), { ssr: false });

export type Only = "all" | "echarts" | "svg" | "recharts" | "recharts-csr" | "none";

/** `only` renders one library per page load so CSP violations and bundle size can be attributed per library. */
export function SpikeCharts({ perf, only }: { perf: boolean; only: Only }) {
  const [open, setOpen] = useState(false);
  const show = (lib: Exclude<Only, "all" | "none" | "recharts-csr">): boolean => only === "all" || only === lib;
  return (
    <>
      <p><button type="button" className="uw-btn" onClick={() => setOpen(true)}>Open dialog</button></p>
      <Dialog open={open} onClose={() => setOpen(false)} title="Spike dialog" closeLabel="Close"><p>Focus is trapped here; Escape closes.</p><button type="button" className="uw-btn">Inner action</button></Dialog>
      {show("echarts") ? <EChartsSection perf={perf} /> : null}
      {show("svg") ? <SvgSection /> : null}
      {show("recharts") ? <RechartsSection perf={perf} /> : null}
      {only === "recharts-csr" ? <RechartsCsr perf={perf} /> : null}
    </>
  );
}
