"use client";
import { Bar, BarChart, CartesianGrid, Line, LineChart as RLineChart, ResponsiveContainer, Scatter, ScatterChart, XAxis, YAxis } from "recharts";
import { DAYS, ORDERS, REFUNDS, bigSeries, summarize } from "./data";
import { C, PerfMark, dayRows, dayTable, frame } from "./shared";

const PERF_N = 5000;
const perfData = bigSeries(PERF_N).map((v, i) => ({ x: i, y: v }));

export default function RechartsSection({ perf }: { perf: boolean }) {
  return (
    <>
      <h2 id="lib-recharts">C. Recharts 3 (for comparison)</h2>
      {frame("C1 Orders per day (Recharts line, fixed size)", summarize("Orders", DAYS, ORDERS), (
        <RLineChart width={520} height={260} data={dayRows} accessibilityLayer>
          <CartesianGrid stroke={C.hairline} />
          <XAxis dataKey="day" stroke={C.textSecondary} />
          <YAxis stroke={C.textSecondary} />
          <Line type="monotone" dataKey="orders" stroke={C.brand} strokeWidth={2} isAnimationActive={false} />
        </RLineChart>
      ), dayTable)}
      {frame("C2 Refunds per day (Recharts bar, ResponsiveContainer)", summarize("Refunds", DAYS, REFUNDS), (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={dayRows} accessibilityLayer>
            <CartesianGrid stroke={C.hairline} />
            <XAxis dataKey="day" stroke={C.textSecondary} />
            <YAxis stroke={C.textSecondary} />
            <Bar dataKey="refunds" fill={C.brand} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      ), dayTable)}
      {perf ? <PerfMark name="recharts-perf">{frame(`C3 ${PERF_N} scatter marks (Recharts perf)`, `${PERF_N} synthetic points.`, (
        <ScatterChart width={520} height={260}>
          <XAxis type="number" dataKey="x" />
          <YAxis type="number" dataKey="y" />
          <Scatter data={perfData} fill={C.brand} isAnimationActive={false} />
        </ScatterChart>
      ), { caption: "Not tabulated", columns: [{ key: "n", header: "Points", numeric: true, cell: (r: { n: number }) => String(r.n) }], rows: [{ n: PERF_N }], rowKey: () => "n" })}</PerfMark> : null}
    </>
  );
}
