import { EVIDENCE_STALE_MS, MS_PER_DAY, SNAPSHOT_WINDOW_DAYS } from "./types";

/** Snapshots and the evidence derived from them. Money is integer piastres (bigint), VAT-inclusive. */

export interface PriceSnapshot {
  readonly id: string;
  readonly fetchedAtMs: number;
  /** VAT-inclusive piastres, > 0. The parser adapter normalises VAT before this point. */
  readonly priceAmount: bigint;
  readonly available: boolean;
  readonly domHash: string;
}

export type SnapshotDelta = "changed" | "unchanged";

/** A fetch whose price, availability and DOM hash all equal the previous snapshot is unchanged (dedupe). */
export function snapshotDelta(prev: PriceSnapshot | null, next: Pick<PriceSnapshot, "priceAmount" | "available" | "domHash">): SnapshotDelta {
  if (prev === null) return "changed";
  return prev.priceAmount === next.priceAmount && prev.available === next.available && prev.domHash === next.domHash ? "unchanged" : "changed";
}

export const dayBucket = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** One stored row per target and SKU per UTC day: an unchanged re-fetch on the same day writes nothing. */
export function shouldStoreSnapshot(prev: PriceSnapshot | null, nextAtMs: number, delta: SnapshotDelta): boolean {
  if (prev === null) return true;
  if (dayBucket(prev.fetchedAtMs) !== dayBucket(nextAtMs)) return true;
  return delta === "changed";
}

export interface DerivedExternalEvidence {
  readonly id: string;
  readonly lowPriceAmount: bigint;
  readonly currentPriceAmount: bigint | null;
  readonly historyDays: number;
  readonly observedAtMs: number;
}

/**
 * Collapse a matched product's snapshots into the shape the VRP engine consumes. The low is over the
 * last 30 days; `current` is the latest price only when that snapshot was purchasable (an out-of-stock
 * page is not a cheaper offer). `observedAtMs` is the LATEST fetch, so a dead crawl ages the evidence
 * and the VRP degrades to a plain price after 72 h (fail closed).
 */
export function deriveExternalEvidence(snapshots: readonly PriceSnapshot[], nowMs: number, evidenceId: string): DerivedExternalEvidence | null {
  const valid = snapshots.filter((s) => s.priceAmount > 0n && s.fetchedAtMs <= nowMs).sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
  const latest = valid[valid.length - 1];
  const earliest = valid[0];
  if (latest === undefined || earliest === undefined) return null;
  const windowStart = nowMs - SNAPSHOT_WINDOW_DAYS * MS_PER_DAY;
  let low: bigint | null = null;
  for (const s of valid) {
    if (s.fetchedAtMs < windowStart) continue;
    if (low === null || s.priceAmount < low) low = s.priceAmount;
  }
  if (low === null) return null;
  const historyDays = Math.min(SNAPSHOT_WINDOW_DAYS, Math.floor((latest.fetchedAtMs - earliest.fetchedAtMs) / MS_PER_DAY));
  return {
    id: evidenceId,
    lowPriceAmount: low,
    currentPriceAmount: latest.available ? latest.priceAmount : null,
    historyDays,
    observedAtMs: latest.fetchedAtMs,
  };
}

export const isEvidenceStale = (observedAtMs: number, nowMs: number): boolean => nowMs - observedAtMs > EVIDENCE_STALE_MS;

export type EvidenceGate = "live" | "shadow" | "rejected";

/**
 * Whether a match may feed the VRP. `shadowOnly` (the default until a labelled set exists, VR-13)
 * records and scores but never reaches the claim; below tau is never evidence.
 */
export function gateEvidence(input: { readonly confBp: number; readonly tauBp: number; readonly shadowOnly: boolean }): EvidenceGate {
  if (input.confBp < input.tauBp) return "rejected";
  return input.shadowOnly ? "shadow" : "live";
}
