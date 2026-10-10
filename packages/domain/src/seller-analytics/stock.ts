import { divideRoundHalfEven } from "../money";

const bps = (num: number, den: number): number | null =>
  den === 0 ? null : Number(divideRoundHalfEven(BigInt(num) * 10_000n, BigInt(den)));

/** sold / (sold + on hand) in bps; null when the SKU was never stocked. */
export function sellThroughBps(soldUnits: number, onHand: number): number | null {
  if (soldUnits < 0 || onHand < 0) throw new RangeError("units must not be negative");
  return bps(soldUnits, soldUnits + onHand);
}

export interface SizeRow {
  readonly size: string;
  readonly soldUnits: number;
  readonly onHandUnits: number;
}

export interface SizeCurveRow {
  readonly size: string;
  readonly soldUnits: number;
  readonly onHandUnits: number;
  readonly soldShareBps: number;
  readonly stockedShareBps: number;
  /** soldShare - stockedShare. Positive: the size sells faster than it was stocked (restock candidate). */
  readonly gapBps: number;
}

export interface SizeCurve {
  readonly rows: readonly SizeCurveRow[];
  readonly totalSold: number;
  readonly totalStocked: number;
}

/** Stocked = sold + on hand. Row order follows `order` (unknown sizes last, alphabetical). */
export function sizeCurve(rows: readonly SizeRow[], order: readonly string[] = []): SizeCurve {
  const totalSold = rows.reduce((n, r) => n + r.soldUnits, 0);
  const totalStocked = rows.reduce((n, r) => n + r.soldUnits + r.onHandUnits, 0);
  const rank = (s: string): number => {
    const i = order.indexOf(s);
    return i === -1 ? order.length : i;
  };
  const sorted = [...rows].sort((a, b) => rank(a.size) - rank(b.size) || (a.size < b.size ? -1 : a.size > b.size ? 1 : 0));
  return {
    rows: sorted.map((r) => {
      const sold = bps(r.soldUnits, totalSold) ?? 0;
      const stocked = bps(r.soldUnits + r.onHandUnits, totalStocked) ?? 0;
      return { ...r, soldShareBps: sold, stockedShareBps: stocked, gapBps: sold - stocked };
    }),
    totalSold,
    totalStocked,
  };
}

export const AGING_THRESHOLDS_DAYS = { watch: 30, aging: 60, critical: 90 } as const;
export type AgingSeverity = "watch" | "aging" | "critical";

export interface AgingSku {
  readonly skuId: string;
  readonly productId: string;
  readonly onHand: number;
  readonly listedAtMs: number;
  readonly soldUnits: number;
}

export interface AgingAlert {
  readonly skuId: string;
  readonly productId: string;
  readonly severity: AgingSeverity;
  readonly ageDays: number;
  readonly onHand: number;
  readonly sellThroughBps: number | null;
}

const DAY_MS = 86_400_000;

/** Only SKUs that still hold stock and are at least 30 days old. Oldest first. */
export function agingAlerts(skus: readonly AgingSku[], nowMs: number): AgingAlert[] {
  const out: AgingAlert[] = [];
  for (const s of skus) {
    if (s.onHand <= 0) continue;
    const ageDays = Math.floor((nowMs - s.listedAtMs) / DAY_MS);
    const severity: AgingSeverity | null =
      ageDays >= AGING_THRESHOLDS_DAYS.critical
        ? "critical"
        : ageDays >= AGING_THRESHOLDS_DAYS.aging
          ? "aging"
          : ageDays >= AGING_THRESHOLDS_DAYS.watch
            ? "watch"
            : null;
    if (severity === null) continue;
    out.push({
      skuId: s.skuId,
      productId: s.productId,
      severity,
      ageDays,
      onHand: s.onHand,
      sellThroughBps: sellThroughBps(s.soldUnits, s.onHand),
    });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays || (a.skuId < b.skuId ? -1 : 1));
}

export interface ReturnReasonCount {
  readonly reason: string;
  readonly units: number;
}

export function returnRateBps(returnedUnits: number, soldUnits: number): number | null {
  return bps(returnedUnits, soldUnits);
}
