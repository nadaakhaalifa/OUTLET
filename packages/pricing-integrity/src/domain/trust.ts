/**
 * Price Trust Score 0-100 (master 9.4). Start at 100, subtract capped penalties, add a capped bonus; integer result.
 * Weights (documented defaults, admin-editable later): fake reference -15 each (cap 45); inflation -10 each (cap 30); breach still open
 * -20; resolved parity breaches in 90 d -5 each (cap 15); anomaly signal -8 each (cap 24); no verified channel -10; stale evidence -10;
 * upheld appeals +5 each (cap +10).
 */
export interface TrustSignals {
  readonly fakeReferences90d: number;
  readonly inflations90d: number;
  readonly openParityBreach: boolean;
  readonly resolvedParityBreaches90d: number;
  readonly anomalySignals: number;
  readonly hasVerifiedChannel: boolean;
  readonly staleEvidence: boolean;
  readonly upheldAppeals90d: number;
}
const cap = (n: number, per: number, max: number): number => Math.min(Math.max(0, Math.trunc(n)) * per, max);

export const priceTrustScore = (s: TrustSignals): number => {
  let v = 100;
  v -= cap(s.fakeReferences90d, 15, 45) + cap(s.inflations90d, 10, 30) + cap(s.resolvedParityBreaches90d, 5, 15) + cap(s.anomalySignals, 8, 24);
  if (s.openParityBreach) v -= 20;
  if (!s.hasVerifiedChannel) v -= 10;
  if (s.staleEvidence) v -= 10;
  v += cap(s.upheldAppeals90d, 5, 10);
  return Math.max(0, Math.min(100, v));
};

/** Check cadence by risk tier (spec section 4). */
export const riskTierOf = (score: number): "trusted" | "normal" | "watched" => (score >= 80 ? "trusted" : score < 50 ? "watched" : "normal");
export const CHECK_INTERVAL_MS = { trusted: 6 * 3_600_000, normal: 3 * 3_600_000, watched: 3_600_000 } as const;
