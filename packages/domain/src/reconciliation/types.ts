export const RECON_SOURCES = [
  "psp_settlement",
  "cod_remittance",
  "bnpl_settlement",
  "eta_submission",
  "store_credit",
  "trial_balance",
  "run",
] as const;
export type ReconSource = (typeof RECON_SOURCES)[number];

export const FINDING_KINDS = [
  "unmatched_external",
  "unmatched_internal",
  "amount_mismatch",
  "duplicate_external",
  "duplicate_internal",
  "file_rejected",
  "settlement_not_posted",
  "settlement_posting_mismatch",
  "eta_rejected",
  "eta_missing_at_authority",
  "eta_unknown_at_authority",
  "eta_status_mismatch",
  "eta_stale_submitted",
  "store_credit_drift",
  "store_credit_negative",
  "trial_balance",
  "suite_failed",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const SEVERITIES = ["critical", "high", "medium"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One side of a match: an external (provider) line or an internal (ledger) movement. */
export interface ReconLine {
  /** Unique within its side and stable across runs (file id + line number, or ledger entry + posting). */
  readonly id: string;
  /** The reference both sides share (provider reference, AWB, settlement item id). */
  readonly key: string;
  /** Signed piastres. */
  readonly amount: bigint;
  readonly atMs: number;
}

export interface Finding {
  readonly source: ReconSource;
  readonly kind: FindingKind;
  readonly severity: Severity;
  /** Short stable reference: a provider key, a currency, a file id. Never personal data. */
  readonly ref: string;
  readonly lineIds: readonly string[];
  /** external - internal (or projected - posted). Positive means the outside world says more. */
  readonly delta: bigint;
  /** When the underlying item happened. Aging runs from here. */
  readonly atMs: number;
  /** Unique per underlying problem across runs; tickets upsert on it. */
  readonly dedupeKey: string;
  /** Machine-readable code details, no free text from files. */
  readonly detail: string;
}
