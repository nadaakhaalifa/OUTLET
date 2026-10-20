import type { StateResult, StoredRun, LatestAttempt } from "../domain/integrity-runs";

/** Explicit allow-list (API3). bigint travels as a decimal string; timestamps as ISO-8601 UTC. */
export const integrityRunWire = (r: StoredRun) => ({
  id: r.id,
  run_kind: r.runKind,
  started_at: new Date(r.startedAtMs).toISOString(),
  finished_at: new Date(r.finishedAtMs).toISOString(),
  ok: r.ok,
  audit_evidence: r.auditEvidence,
  trial_balance: {
    ok: r.trialOk,
    offenders: r.trialOffenders.map((o) => ({ currency: o.currency, total_minor: o.totalMinor.toString() })),
  },
  chain: {
    ok: r.chainOk,
    length: r.chainLength.toString(),
    head_hash: r.chainHeadHash,
    failure: r.chainFailure === null ? null : { seq: r.chainFailure.seq.toString(), entry_id: r.chainFailure.entryId, reason: r.chainFailure.reason },
  },
  store_credit: {
    drift_count: r.driftCount,
    negative_count: r.negativeCount,
    sample: r.sample.map((s) => ({
      account_id: s.accountId,
      sub: s.sub,
      projected_minor: s.projectedMinor.toString(),
      from_postings_minor: s.fromPostingsMinor.toString(),
      difference_minor: s.differenceMinor.toString(),
    })),
    sample_truncated: r.sampleTruncated,
    sample_available: r.sampleAvailable,
  },
  report_sha256: r.reportSha256,
});

export const integrityStatusWire = (a: {
  readonly nowMs: number;
  readonly state: StateResult;
  readonly latest: StoredRun | null;
  readonly attempt: LatestAttempt | null;
}) => ({
  as_of: new Date(a.nowMs).toISOString(),
  state: a.state.state,
  stale: a.state.stale,
  stale_after: a.state.staleAfterMs === null ? null : new Date(a.state.staleAfterMs).toISOString(),
  expected_cadence: a.state.cadence,
  latest: a.latest === null ? null : integrityRunWire(a.latest),
  latest_attempt:
    a.attempt === null
      ? null
      : {
          attempt_id: a.attempt.attemptId,
          started_at: new Date(a.attempt.startedAtMs).toISOString(),
          outcome: a.attempt.outcome,
          error_code: a.attempt.errorCode,
        },
});
