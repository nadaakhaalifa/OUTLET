import { divideRoundHalfEven } from "../money";

export const FUNNEL_STAGES = ["impression", "view", "save", "bag", "checkout", "purchase"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export type FunnelCounts = Readonly<Record<FunnelStage, number>>;

export interface FunnelStep {
  readonly stage: FunnelStage;
  readonly count: number;
  /** Conversion from the previous stage in basis points (10_000 = 100%); null when the previous stage is 0. */
  readonly fromPreviousBps: number | null;
  /** True when this stage exceeds the previous one (a stage can be skipped: buy-now skips save). Shown, not hidden. */
  readonly exceedsPrevious: boolean;
}

export interface Funnel {
  readonly steps: readonly FunnelStep[];
  /** purchase / impression in basis points; null when there are no impressions. */
  readonly overallBps: number | null;
}

const bps = (num: number, den: number): number | null =>
  den === 0 ? null : Number(divideRoundHalfEven(BigInt(num) * 10_000n, BigInt(den)));

export function computeFunnel(counts: FunnelCounts): Funnel {
  const steps: FunnelStep[] = [];
  let previous: number | null = null;
  for (const stage of FUNNEL_STAGES) {
    const count = counts[stage];
    if (!Number.isInteger(count) || count < 0) throw new RangeError(`funnel count for ${stage} must be a non-negative integer`);
    steps.push({
      stage,
      count,
      fromPreviousBps: previous === null ? null : bps(count, previous),
      exceedsPrevious: previous !== null && count > previous,
    });
    previous = count;
  }
  return { steps, overallBps: bps(counts.purchase, counts.impression) };
}

export const emptyFunnelCounts = (): { -readonly [K in FunnelStage]: number } => ({
  impression: 0,
  view: 0,
  save: 0,
  bag: 0,
  checkout: 0,
  purchase: 0,
});
