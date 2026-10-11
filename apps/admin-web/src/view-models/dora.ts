import type { DoraReport } from "../api/schemas";
import { doraReport } from "../api/schemas";

export interface MetricView {
  readonly id: "deploymentFrequency" | "leadTime" | "changeFailureRate" | "timeToRecover" | "reworkRate";
  /** null = not measurable (rendered "not measured"), never zero. */
  readonly value: string | null;
  readonly unit: "perWeek" | "hours" | "percent";
  readonly band: string | null;
  readonly basis: string;
  readonly sample: string | null;
}
export interface DoraView {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly proxy: DoraReport["source"]["deploymentProxy"];
  /** A proxy is never to look like a production deploy metric. */
  readonly isProxy: boolean;
  readonly metrics: readonly MetricView[];
  readonly series: DoraReport["series"];
  readonly notes: readonly string[];
}

const pct = (r: number | null): string | null => (r === null ? null : (Math.round(r * 1000) / 10).toString());
const num1 = (n: number): string => (Math.round(n * 10) / 10).toString();

export function parseDora(text: string): { ok: true; report: DoraReport } | { ok: false } {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false }; }
  const p = doraReport.safeParse(json);
  return p.success ? { ok: true, report: p.data } : { ok: false };
}

export function doraView(r: DoraReport): DoraView {
  const m = r.metrics;
  const proxyBasis = `proxy: ${r.source.deploymentProxy}`;
  return {
    generatedAt: r.generatedAt,
    windowDays: r.window.days,
    proxy: r.source.deploymentProxy,
    isProxy: r.source.deploymentProxy !== "github-deployment",
    metrics: [
      { id: "deploymentFrequency", value: num1(m.deploymentFrequency.perWeek), unit: "perWeek", band: m.deploymentFrequency.band, basis: proxyBasis, sample: String(m.deploymentFrequency.count) },
      { id: "leadTime", value: m.leadTimeForChanges === null ? null : num1(m.leadTimeForChanges.medianHours), unit: "hours", band: m.leadTimeForChanges?.band ?? null, basis: m.leadTimeForChanges?.basis ?? proxyBasis, sample: m.leadTimeForChanges === null ? null : String(m.leadTimeForChanges.sampleSize) },
      { id: "changeFailureRate", value: pct(m.changeFailureRate.ratio), unit: "percent", band: m.changeFailureRate.band, basis: m.changeFailureRate.basis, sample: String(m.changeFailureRate.deployments) },
      { id: "timeToRecover", value: m.timeToRecover === null ? null : num1(m.timeToRecover.medianHours), unit: "hours", band: m.timeToRecover?.band ?? null, basis: m.timeToRecover?.basis ?? proxyBasis, sample: m.timeToRecover === null ? null : String(m.timeToRecover.sampleSize) },
      { id: "reworkRate", value: pct(m.reworkRate.ratio), unit: "percent", band: null, basis: m.reworkRate.basis, sample: String(m.reworkRate.changeCommits) },
    ],
    series: r.series,
    notes: r.notes,
  };
}

/** Not measured yet (spec T10): shown as placeholders, never as numbers. */
export const NOT_MEASURED_PLACEHOLDERS = ["cost_per_order", "cost_per_1k_sessions", "gco2e_per_order"] as const;
