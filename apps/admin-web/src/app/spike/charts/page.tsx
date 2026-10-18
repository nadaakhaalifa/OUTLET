import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { radius, spacing } from "@outlet/ui-tokens";
import { spikeEnabled } from "../gate";
import { SpikeCharts, type Only } from "../spike-charts";

export const metadata = { title: "Chart spike (internal)", robots: { index: false, follow: false } };

const ONLY: readonly Only[] = ["all", "echarts", "svg", "recharts", "recharts-csr", "none"];
const parseOnly = (v: string | string[] | undefined): Only => ONLY.find((o) => o === v) ?? "all";

// Internal, English-only engineering page; not linked from navigation, not translated (documented in docs/research/chart-spike-results.md).
export default async function ChartSpikePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!spikeEnabled(process.env)) notFound();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const q = await searchParams;
  const css = `.sp-box{inline-size:100%;block-size:260px}.sp-note{padding:${spacing.md}px;border:1px dashed var(--border);border-radius:${radius.md}px;background:var(--surface)}`;
  return (
    <main>
      <style nonce={nonce}>{css}</style>
      <h1>Chart spike (internal)</h1>
      <p className="sp-note">Internal engineering page. Synthetic demo data only. Not linked from navigation and not served in production unless ADMIN_CHART_SPIKE=1.</p>
      <SpikeCharts perf={q["perf"] === "1"} only={parseOnly(q["only"])} />
    </main>
  );
}
