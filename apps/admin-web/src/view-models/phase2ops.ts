import type { AdsConfigWire, PriceMatchingConfigWire } from "../api/schemas";

/** Spec 9.2: a 2,000-pair labelled Egyptian set must exist before tau leaves shadow mode. */
export const LABELLED_PAIRS_TARGET = 2000;
export interface MatchingView {
  readonly tauPercent: string;
  readonly shadowOnly: boolean;
  readonly labelledPairs: number;
  readonly targetPairs: number;
  readonly remainingPairs: number;
  readonly kappa: string;
  readonly version: number;
  readonly setReady: boolean;
}
const frac = (n: number, div: number, digits: number): string => `${Math.floor(n / div)}.${String(n % div).padStart(digits, "0")}`;
export function matchingView(c: PriceMatchingConfigWire): MatchingView {
  return {
    tauPercent: frac(c.tau_bp, 100, 2),
    shadowOnly: c.shadow_only,
    labelledPairs: c.labelled_pairs,
    targetPairs: LABELLED_PAIRS_TARGET,
    remainingPairs: Math.max(0, LABELLED_PAIRS_TARGET - c.labelled_pairs),
    kappa: frac(c.kappa_milli, 1000, 3),
    version: c.version,
    // Shown as a hint only: the API decides when tau may leave shadow mode.
    setReady: c.labelled_pairs >= LABELLED_PAIRS_TARGET,
  };
}

export interface AdsView {
  readonly slots: number;
  readonly pricing: string;
  readonly botBlockPercent: string;
  readonly vatPercent: string;
  readonly floorMinor: bigint;
  readonly limits: readonly { readonly key: string; readonly value: number; readonly unit: "ms" | "count" }[];
}
export function adsView(c: AdsConfigWire): AdsView {
  return {
    slots: c.slots,
    pricing: c.pricing,
    botBlockPercent: frac(c.bot_score_block_bps, 100, 2),
    vatPercent: frac(c.vat_bps, 100, 2),
    floorMinor: BigInt(c.floor_price.amount),
    limits: [
      { key: "minDwell", value: c.min_dwell_ms, unit: "ms" },
      { key: "dedupe", value: c.click_dedupe_window_ms, unit: "ms" },
      { key: "clickTokenTtl", value: c.click_token_ttl_ms, unit: "ms" },
      { key: "clicksPerSessionMinute", value: c.max_clicks_per_session_per_minute, unit: "count" },
      { key: "clicksPerCampaignSessionDay", value: c.max_clicks_per_campaign_session_day, unit: "count" },
      { key: "frequencyCap", value: c.frequency_cap_per_session_day, unit: "count" },
    ],
  };
}
