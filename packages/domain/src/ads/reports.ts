import { divideRoundHalfEven } from "../money";

export interface AdStatsRow {
  readonly impressions: number;
  readonly clicks: number;
  /** VAT-exclusive piastres. */
  readonly spend: bigint;
  /** Attributed gross merchandise value, piastres. */
  readonly attributedRevenue: bigint;
}

export interface AdStatsView extends AdStatsRow {
  /** Clicks / impressions in basis points, null with no impressions. */
  readonly ctrBp: number | null;
  /** Average cost per valid click, piastres (half-even), null with no clicks. */
  readonly cpc: bigint | null;
  /** Revenue / spend in basis points (10_000 = 1.00x), null with no spend. */
  readonly roasBp: bigint | null;
}

/** Read model arithmetic: integer only, one rounding mode (half-even via the money module). */
export function viewStats(r: AdStatsRow): AdStatsView {
  return {
    ...r,
    ctrBp: r.impressions === 0 ? null : Number(divideRoundHalfEven(BigInt(r.clicks) * 10_000n, BigInt(r.impressions))),
    cpc: r.clicks === 0 ? null : divideRoundHalfEven(r.spend, BigInt(r.clicks)),
    roasBp: r.spend === 0n ? null : divideRoundHalfEven(r.attributedRevenue * 10_000n, r.spend),
  };
}

export function sumStats(rows: readonly AdStatsRow[]): AdStatsRow {
  return rows.reduce<AdStatsRow>(
    (a, r) => ({
      impressions: a.impressions + r.impressions,
      clicks: a.clicks + r.clicks,
      spend: a.spend + r.spend,
      attributedRevenue: a.attributedRevenue + r.attributedRevenue,
    }),
    { impressions: 0, clicks: 0, spend: 0n, attributedRevenue: 0n },
  );
}
