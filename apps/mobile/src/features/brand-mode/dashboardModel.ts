/** Pure presentation model for the brand "Today" dashboard (no React). Keeps ordering, tones and KPI nulls testable. */
import type { DashboardView, Metric } from "./model";

/** Countdown turns urgent (coral tint) under this many ms; the accept SLA itself is 24 h. */
export const URGENT_MS = 3 * 3_600_000;

export type CountdownTone = "calm" | "urgent" | "closed";
export function countdownTone(remainingMs: number): CountdownTone {
  if (remainingMs <= 0) return "closed";
  return remainingMs < URGENT_MS ? "urgent" : "calm";
}

export type KpiKey = "sales" | "orders" | "awaiting";
export type KpiTile =
  | { readonly key: "sales"; readonly metric: Metric<bigint> }
  | { readonly key: "orders"; readonly metric: Metric<number> }
  | { readonly key: "awaiting"; readonly metric: Metric<number> };

/** Three equal tiles. Awaiting is a real count from the order list (a true zero is a value); sales/orders keep null = unavailable. */
export function kpiTiles(view: Pick<DashboardView, "sales" | "orders" | "awaiting">): readonly KpiTile[] {
  return [
    { key: "sales", metric: view.sales },
    { key: "orders", metric: view.orders },
    { key: "awaiting", metric: { kind: "value", value: view.awaiting.length } },
  ];
}

export type SectionKey = "actions" | "caughtUp" | "lowStock" | "money" | "health";
/** Needs-your-action leads when orders are waiting; otherwise a calm "caught up" row. Low stock only when there is some. */
export function sectionOrder(view: Pick<DashboardView, "awaiting" | "lowStock">): readonly SectionKey[] {
  const out: SectionKey[] = [view.awaiting.length > 0 ? "actions" : "caughtUp"];
  if (view.lowStock.length > 0) out.push("lowStock");
  out.push("money", "health");
  return out;
}

export type CountdownLabel =
  | { readonly kind: "closed" }
  | { readonly kind: "minutes"; readonly minutes: number }
  | { readonly kind: "hoursMinutes"; readonly hours: number; readonly minutes: number };
export function countdownLabel(sla: { remainingMs: number; hours: number; minutes: number }): CountdownLabel {
  if (sla.remainingMs <= 0) return { kind: "closed" };
  if (sla.hours === 0) return { kind: "minutes", minutes: sla.minutes };
  return { kind: "hoursMinutes", hours: sla.hours, minutes: sla.minutes };
}

/** Bar heights (0..1) for the 7-day sales trend. null when there is nothing honest to draw (fewer than 2 days or all zero). */
export function trendBars(trend: readonly bigint[] | undefined): readonly number[] | null {
  if (trend === undefined || trend.length < 2) return null;
  const max = trend.reduce((m, v) => (v > m ? v : m), 0n);
  if (max <= 0n) return null;
  return trend.map((v) => Number((v * 1000n) / max) / 1000);
}

/** Percent of whole piastres the verified discount represents (integer floor, same rule as the price engine); null unless the claim is verified. */
export function verifiedOffPct(claim: string, price: bigint | null, reference: bigint | null | undefined): number | null {
  if (claim !== "verified_discount" || price === null || reference === null || reference === undefined || reference <= price) return null;
  const pct = Number(((reference - price) * 100n) / reference);
  return pct >= 5 ? pct : null;
}
