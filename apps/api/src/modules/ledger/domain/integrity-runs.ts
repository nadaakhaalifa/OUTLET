/** Types and pure rules for the persisted ledger integrity result (ADR-0046). No I/O here. */

export type IntegrityRunKind = "nightly" | "intraday" | "manual";
export type IntegrityOutcome = "started" | "completed" | "error" | "timeout";
export type AuditEvidence = "present" | "missing";
export type IntegrityState = "ok" | "failed" | "stale" | "never_run" | "error_only";
export type IntegrityCadence = "nightly_0230_cairo" | "every_30_min";
export type IntegrityMode = "batch" | "event";

export const SAMPLE_CAP = 50;
export const OFFENDER_CAP = 8;
export const STALE_AFTER_MS: Readonly<Record<IntegrityMode, number>> = {
  batch: 26 * 3_600_000,
  event: 90 * 60_000,
};

/**
 * Write-side drift sample. `userId` exists only in memory, to let the store resolve the ledger account;
 * it is never persisted, hashed, returned or logged. `subjectRef` (sha256 of a domain-separated user id)
 * binds the sample to the report hash without carrying the id.
 */
export interface DriftSampleInput {
  readonly userId: string;
  readonly subjectRef: string;
  readonly sub: string;
  readonly projectedMinor: bigint;
  readonly fromPostingsMinor: bigint;
  readonly differenceMinor: bigint;
}

/** Persisted and returned drift sample: the pseudonymous ledger account id, never the raw user id (0093). */
export interface DriftSampleRow {
  /** ledger_accounts.id; null when the projection row has no ledger account. */
  readonly accountId: string | null;
  readonly sub: string;
  readonly projectedMinor: bigint;
  readonly fromPostingsMinor: bigint;
  readonly differenceMinor: bigint;
}

/** The report mapped to the row shape. No recomputation: every field comes from the job report. */
export interface CompletedRunData {
  readonly ok: boolean;
  readonly trialOk: boolean;
  readonly trialOffenders: readonly { readonly currency: string; readonly totalMinor: bigint }[];
  readonly chainOk: boolean;
  /** 0 when the chain failed: the job stops at the first failure and does not report a verified length. */
  readonly chainLength: bigint;
  readonly chainHeadHash: string | null;
  readonly chainFailure: { readonly seq: bigint; readonly entryId: string; readonly reason: string } | null;
  readonly driftCount: number;
  readonly negativeCount: number;
  readonly sampleTruncated: boolean;
  readonly sample: readonly DriftSampleInput[];
  readonly reportSha256: string;
}

export interface StoredRun extends Omit<CompletedRunData, "sample"> {
  readonly sample: readonly DriftSampleRow[];
  readonly id: string;
  readonly runKind: IntegrityRunKind;
  /** Database `now()` at the attempt's start row (copied to the completed row). Never a worker clock. */
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly auditEvidence: AuditEvidence;
  /** False once the drift sample passed its retention while drift_count > 0. */
  readonly sampleAvailable: boolean;
}

export interface LatestAttempt {
  readonly attemptId: string;
  readonly startedAtMs: number;
  readonly outcome: IntegrityOutcome;
  readonly errorCode: string | null;
}

export const byDifference = (a: DriftSampleInput, b: DriftSampleInput): number => {
  const x = a.differenceMinor < 0n ? -a.differenceMinor : a.differenceMinor;
  const y = b.differenceMinor < 0n ? -b.differenceMinor : b.differenceMinor;
  if (x !== y) return x > y ? -1 : 1;
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  return a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0;
};

/** Canonical JSON: fixed key order, bigint as decimal string. The hash input of `report_sha256`. */
export function canonicalReport(d: Omit<CompletedRunData, "reportSha256">): string {
  return JSON.stringify({
    chain: {
      failure: d.chainFailure === null ? null : { entry_id: d.chainFailure.entryId, reason: d.chainFailure.reason, seq: d.chainFailure.seq.toString() },
      head_hash: d.chainHeadHash,
      length: d.chainLength.toString(),
      ok: d.chainOk,
    },
    ok: d.ok,
    store_credit: {
      drift_count: d.driftCount,
      negative_count: d.negativeCount,
      sample: d.sample.map((s) => ({
        difference_minor: s.differenceMinor.toString(),
        from_postings_minor: s.fromPostingsMinor.toString(),
        projected_minor: s.projectedMinor.toString(),
        sub: s.sub,
        subject_ref: s.subjectRef,
      })),
      sample_truncated: d.sampleTruncated,
    },
    trial_balance: {
      offenders: d.trialOffenders.map((o) => ({ currency: o.currency, total_minor: o.totalMinor.toString() })),
      ok: d.trialOk,
    },
  });
}

export interface StateInput {
  readonly latest: Pick<StoredRun, "ok" | "startedAtMs" | "auditEvidence"> | null;
  readonly latestAttempt: LatestAttempt | null;
  readonly nowMs: number;
  readonly mode: IntegrityMode;
}

export interface StateResult {
  readonly state: IntegrityState;
  readonly stale: boolean;
  readonly staleAfterMs: number | null;
  readonly cadence: IntegrityCadence;
}

/**
 * `failed` (latest completed ok=false, or its audit evidence is missing) over `stale` over `ok`;
 * `never_run` with no attempt at all; `error_only` when attempts exist but none completed.
 * Stale means strictly more than the threshold since the latest completed run STARTED (26 h batch,
 * 90 min event mode). A later error attempt never hides the latest completed result.
 */
export function computeIntegrityState(i: StateInput): StateResult {
  const cadence: IntegrityCadence = i.mode === "batch" ? "nightly_0230_cairo" : "every_30_min";
  if (i.latest === null) {
    return { state: i.latestAttempt === null ? "never_run" : "error_only", stale: false, staleAfterMs: null, cadence };
  }
  const staleAfterMs = i.latest.startedAtMs + STALE_AFTER_MS[i.mode];
  const stale = i.nowMs > staleAfterMs;
  if (!i.latest.ok || i.latest.auditEvidence === "missing") return { state: "failed", stale, staleAfterMs, cadence };
  return { state: stale ? "stale" : "ok", stale, staleAfterMs, cadence };
}

export interface GaugeValues {
  /** 1 or 0; null when there is no completed row (not reported, so the absence rule fires). */
  readonly ok: 0 | 1 | null;
  readonly ageSeconds: number | null;
}

/** Gauge values from the latest completed row; with none, the age counts from the table's first row. */
export function gaugeValues(
  latest: Pick<StoredRun, "ok" | "startedAtMs" | "auditEvidence"> | null,
  firstStartedAtMs: number | null,
  nowMs: number,
): GaugeValues {
  if (latest !== null) {
    return {
      ok: latest.ok && latest.auditEvidence === "present" ? 1 : 0,
      ageSeconds: Math.max(0, (nowMs - latest.startedAtMs) / 1000),
    };
  }
  return { ok: null, ageSeconds: firstStartedAtMs === null ? null : Math.max(0, (nowMs - firstStartedAtMs) / 1000) };
}
