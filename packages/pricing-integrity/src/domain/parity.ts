import { STALE_EVIDENCE_MS } from "./external.js";

export const PARITY_GRACE_MS = 48 * 3_600_000;
export type ParityStatus = "ok" | "unmatched" | "stale" | "breach";
export type ParityAction = "none" | "demote" | "pause_sku";
export interface ParityInput {
  readonly ourPrice: bigint;
  readonly externalCurrent: bigint | null;
  readonly externalFetchedAt: Date | null;
  readonly matchConfBp: number;
  readonly tauBp: number;
  readonly now: Date;
  /** When the open parity finding was first detected (null = no open breach). */
  readonly breachSince: Date | null;
}
export interface ParityResult {
  readonly status: ParityStatus;
  readonly action: ParityAction;
  readonly fixDeadline: Date | null;
}

/** Their own site cheaper than ours: demote, 48 h to fix, then auto-pause. Unverifiable (unmatched/stale) evidence never punishes. */
export const parityCheck = (i: ParityInput): ParityResult => {
  const none = (status: ParityStatus): ParityResult => ({ status, action: "none", fixDeadline: null });
  if (i.externalCurrent === null || i.matchConfBp < i.tauBp) return none("unmatched");
  if (i.externalFetchedAt === null || i.now.getTime() - i.externalFetchedAt.getTime() > STALE_EVIDENCE_MS) return none("stale");
  if (i.externalCurrent >= i.ourPrice) return none("ok");
  const since = i.breachSince ?? i.now;
  const deadline = new Date(since.getTime() + PARITY_GRACE_MS);
  return { status: "breach", action: i.now.getTime() >= deadline.getTime() ? "pause_sku" : "demote", fixDeadline: deadline };
};
