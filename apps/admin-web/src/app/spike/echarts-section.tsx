"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { FunnelChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { DAYPARTS, DAYS, FUNNEL, HEAT, ORDERS, WEEKDAYS, bigSeries, heatSummary, summarize } from "./data";
import { C, PerfMark, dayTable, frame } from "./shared";

// physical-direction: ECharts grid insets and funnel/visualMap anchors are physical option names (no logical equivalent); RTL behaviour is a spike finding.
echarts.use([LineChart, FunnelChart, HeatmapChart, ScatterChart, GridComponent, TooltipComponent, VisualMapComponent, AriaComponent, SVGRenderer]);

type EOption = Parameters<echarts.ECharts["setOption"]>[0];

function EChart({ option, name }: { option: EOption; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const chart = echarts.init(el, undefined, { renderer: "svg", width: el.clientWidth, height: 260 });
    chart.setOption(option);
    return () => chart.dispose();
  }, [option]);
  return <div ref={ref} className="sp-box" data-chart={name} />;
}

const ec = { muted: C.textSecondary, line: C.brand, grid: C.hairline };
const lineBase = {
  animation: false,
  aria: { enabled: true, decal: { show: true } },
  // physical-direction: ECharts option name
  grid: { left: 40, right: 16, top: 16, bottom: 28 },
  xAxis: { type: "category", data: [...DAYS], axisLabel: { color: ec.muted } },
  yAxis: { type: "value", axisLabel: { color: ec.muted }, splitLine: { lineStyle: { color: ec.grid } } },
  series: [{ type: "line", data: [...ORDERS], itemStyle: { color: ec.line }, lineStyle: { color: ec.line, width: 2 }, name: "Orders" }],
} as const;
const lineOption: EOption = { ...lineBase, tooltip: { trigger: "axis" } };
const lineRichText: EOption = { ...lineBase, tooltip: { trigger: "axis", renderMode: "richText" } };
const lineNoTooltip: EOption = { ...lineBase, tooltip: { show: false } };
const funnelOption: EOption = {
  animation: false,
  aria: { enabled: true },
  // physical-direction: ECharts option name
  series: [{ type: "funnel", max: 10000, minSize: "8%", left: "10%", width: "80%", label: { show: true, color: C.onAccent, formatter: "{b}: {c}" }, itemStyle: { color: C.brand, borderColor: C.background }, data: FUNNEL.map((f) => ({ name: f.stage, value: f.count })) }],
};
const heatOption: EOption = {
  animation: false,
  aria: { enabled: true },
  // physical-direction: ECharts option name
  grid: { left: 48, right: 16, top: 8, bottom: 56 },
  xAxis: { type: "category", data: [...DAYPARTS], axisLabel: { color: ec.muted } },
  yAxis: { type: "category", data: [...WEEKDAYS], axisLabel: { color: ec.muted } },
  // physical-direction: ECharts option name
  visualMap: { min: 0, max: 80, calculable: false, orient: "horizontal", left: "center", bottom: 0, inRange: { color: [C.surface, C.brand] } },
  series: [{ type: "heatmap", data: HEAT.flatMap((row, d) => row.map((v, h) => [h, d, v])), label: { show: true, color: C.textPrimary } }],
};
export const PERF_N = 5000;
const perfOption: EOption = {
  animation: false,
  // physical-direction: ECharts option name
  grid: { left: 40, right: 16, top: 16, bottom: 28 },
  xAxis: { type: "value", scale: true },
  yAxis: { type: "value", scale: true },
  series: [{ type: "scatter", symbolSize: 3, itemStyle: { color: ec.line }, data: bigSeries(PERF_N).map((v, i) => [i, v]) }],
};

const funnelRows = FUNNEL.map((f) => ({ ...f }));
type HeatRow = { w: string } & Record<string, number | string>;
const heatRows: HeatRow[] = WEEKDAYS.map((w, d) => ({ w, ...Object.fromEntries(DAYPARTS.map((p, h) => [p, HEAT[d]?.[h] ?? 0])) }));

export default function EChartsSection({ perf }: { perf: boolean }) {
  const sum = summarize("Orders", DAYS, ORDERS);
  return (
    <>
      <h2 id="lib-echarts">A. Apache ECharts (SVG renderer, tree-shaken)</h2>
      {frame("A1 Orders per day (ECharts line, default HTML tooltip)", sum, <EChart name="echarts-line" option={lineOption} />, dayTable)}
      {frame("A1b Orders per day (ECharts line, richText tooltip)", sum, <EChart name="echarts-line-richtext" option={lineRichText} />, dayTable)}
      {frame("A1c Orders per day (ECharts line, tooltip off)", sum, <EChart name="echarts-line-notooltip" option={lineNoTooltip} />, dayTable)}
      {frame("A2 Funnel (ECharts)", "Stage counts fall from 10000 impressions to 300 purchases.", <EChart name="echarts-funnel" option={funnelOption} />, {
        caption: "Funnel stages (demo)",
        columns: [{ key: "stage", header: "Stage", cell: (r: (typeof funnelRows)[number]) => r.stage }, { key: "count", header: "Count", numeric: true, cell: (r: (typeof funnelRows)[number]) => String(r.count) }],
        rows: funnelRows, rowKey: (r) => r.stage,
      })}
      {frame("A3 Heatmap orders by weekday and daypart (ECharts)", heatSummary(), <EChart name="echarts-heatmap" option={heatOption} />, {
        caption: "Orders by weekday and daypart (demo)",
        columns: [{ key: "w", header: "Weekday", cell: (r: HeatRow) => r.w }, ...DAYPARTS.map((p) => ({ key: p, header: p, numeric: true, cell: (r: HeatRow) => String(r[p] ?? 0) }))],
        rows: heatRows, rowKey: (r) => r.w,
      })}
      {perf ? <PerfMark name="echarts-perf">{frame(`A4 ${PERF_N} scatter marks (ECharts perf)`, `${PERF_N} synthetic points.`, <EChart name="echarts-perf" option={perfOption} />, { caption: "Not tabulated", columns: [{ key: "n", header: "Points", numeric: true, cell: (r: { n: number }) => String(r.n) }], rows: [{ n: PERF_N }], rowKey: () => "n" })}</PerfMark> : null}
    </>
  );
}
