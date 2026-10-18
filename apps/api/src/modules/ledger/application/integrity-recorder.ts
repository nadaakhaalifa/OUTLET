import type { Clock, IdGenerator } from "../../../platform/ports";
import type { Sha256Hex } from "../domain/bridge";
import {
  SAMPLE_CAP,
  byDifference,
  canonicalReport,
  OFFENDER_CAP,
  type CompletedRunData,
  type DriftSampleInput,
  type IntegrityOutcome,
  type IntegrityRunKind,
} from "../domain/integrity-runs";
import { IntegrityAlreadyRecordedError, IntegrityAuditWriteError, type IntegrityRunStore } from "../domain/ports";
import type { IntegrityJobReport } from "./integrity-job";

/** Report to row mapper (ADR-0046). No recomputation: every field comes from the job report. */
export function mapReport(report: IntegrityJobReport, sha256: Sha256Hex): CompletedRunData {
  const sorted = report.storeCredit.drift
    .map((d): DriftSampleInput => ({ userId: d.userId, subjectRef: sha256(`ledger-drift-sample|${d.userId}`), sub: d.sub, projectedMinor: d.projected, fromPostingsMinor: d.fromPostings, differenceMinor: d.difference }))
    .sort(byDifference);
  const base: Omit<CompletedRunData, "reportSha256"> = {
    ok: report.ok,
    trialOk: report.trialBalance.ok,
    trialOffenders: report.trialBalance.offenders.slice(0, OFFENDER_CAP).map((o) => ({ currency: o.currency, totalMinor: o.total })),
    chainOk: report.chain.ok,
    chainLength: report.chain.ok ? BigInt(report.chain.length) : 0n,
    chainHeadHash: report.chain.ok ? report.chain.headHash : null,
    chainFailure: report.chain.ok ? null : { seq: report.chain.seq, entryId: report.chain.entryId, reason: report.chain.reason },
    driftCount: report.storeCredit.drift.length,
    negativeCount: report.storeCredit.negative.length,
    sampleTruncated: sorted.length > SAMPLE_CAP,
    sample: sorted.slice(0, SAMPLE_CAP),
  };
  return { ...base, reportSha256: sha256(canonicalReport(base)) };
}

export interface RecorderMetrics {
  /** Counter `outlet.ledger.integrity.runs{outcome}`. */
  run(outcome: IntegrityOutcome): void;
  /** Counter `outlet.ledger.integrity.audit_failed`. */
  auditFailed(): void;
}

export interface RecorderDeps {
  readonly job: { run(): Promise<IntegrityJobReport> };
  readonly store: IntegrityRunStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sha256: Sha256Hex;
  readonly metrics: RecorderMetrics;
  /** Receives the attempt id only: never amounts, hashes or user ids. */
  readonly log: (event: "ledger_integrity_record_failed" | "ledger_integrity_job_failed", fields: { readonly attemptId: string }) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Run timeout per kind (nightly 30 min, intraday 15 min, as the worker registry). */
  readonly timeoutMs?: Readonly<Record<IntegrityRunKind, number>>;
  /** Final transaction attempts (default 3). */
  readonly maxAttempts?: number;
}

export interface RecordedRun {
  readonly ok: 0 | 1;
  readonly drift_count: number;
  readonly negative_count: number;
}

const DEFAULT_TIMEOUT: Readonly<Record<IntegrityRunKind, number>> = { nightly: 30 * 60_000, intraday: 15 * 60_000, manual: 30 * 60_000 };
const BACKOFF_BASE_MS = 200;

class JobTimeout extends Error {
  constructor() {
    super("integrity job timeout");
  }
}

/**
 * Owns persistence of the integrity result. `IntegrityJob` stays pure and unchanged.
 *  1. A `started` row (failure here: the job does not run, fail closed).
 *  2. The job. An exception or a timeout is recorded as an attempt (`error` / `timeout`) and rethrown.
 *  3. ONE transaction writes the completed row, its sample rows and its audit row (H4). If the audit
 *     insert fails nothing is committed: no completed row, so the table-backed gauges age and the
 *     staleness and absence alerts fire.
 */
export class RecordIntegrityRun {
  constructor(private readonly d: RecorderDeps) {}

  async run(kind: IntegrityRunKind = "nightly"): Promise<RecordedRun> {
    const attemptId = this.d.ids.uuidV7();
    await this.d.store.recordStarted({ id: this.d.ids.uuidV7(), attemptId, kind });

    let report: IntegrityJobReport;
    try {
      report = await this.withTimeout(this.d.job.run(), (this.d.timeoutMs ?? DEFAULT_TIMEOUT)[kind]);
    } catch (e) {
      const outcome = e instanceof JobTimeout ? "timeout" : "error";
      this.d.log("ledger_integrity_job_failed", { attemptId });
      await this.failure(attemptId, kind, outcome, outcome === "timeout" ? "job_timeout" : "job_error");
      throw e instanceof JobTimeout ? new Error("ledger integrity job timed out") : e;
    }

    const data = mapReport(report, this.d.sha256);
    const attempts = this.d.maxAttempts ?? 3;
    let last: unknown;
    for (let n = 0; n < attempts; n += 1) {
      if (n > 0) await this.backoff(n);
      const id = this.d.ids.uuidV7();
      try {
        await this.d.store.completeRun({
          id,
          attemptId,
          kind,
          data,
          audit: { atMs: this.d.clock.nowMs(), runId: id, ok: data.ok, reportSha256: data.reportSha256 },
        });
        this.d.metrics.run("completed");
        return { ok: data.ok ? 1 : 0, drift_count: data.driftCount, negative_count: data.negativeCount };
      } catch (e) {
        if (e instanceof IntegrityAlreadyRecordedError) {
          // An earlier attempt committed (ambiguous failure on the way back): that row and its audit row are the record.
          this.d.metrics.run("completed");
          return { ok: data.ok ? 1 : 0, drift_count: data.driftCount, negative_count: data.negativeCount };
        }
        last = e;
      }
    }
    this.d.log("ledger_integrity_record_failed", { attemptId });
    if (last instanceof IntegrityAuditWriteError) this.d.metrics.auditFailed();
    await this.failure(attemptId, kind, "error", last instanceof IntegrityAuditWriteError ? "audit_failed" : "record_failed");
    throw new Error("ledger integrity result could not be recorded");
  }

  private async failure(attemptId: string, kind: IntegrityRunKind, outcome: "error" | "timeout", errorCode: string): Promise<void> {
    this.d.metrics.run(outcome);
    try {
      await this.d.store.recordFailure({ id: this.d.ids.uuidV7(), attemptId, kind, outcome, errorCode });
    } catch {
      // The attempt row is best effort: the staleness and absence alerts do not depend on it.
      this.d.log("ledger_integrity_record_failed", { attemptId });
    }
  }

  private async backoff(n: number): Promise<void> {
    const jitter = 0.5 + (this.d.random ?? Math.random)() * 0.5;
    await (this.d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(BACKOFF_BASE_MS * 2 ** (n - 1) * jitter);
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new JobTimeout()), ms);
    });
    return Promise.race([p, t]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
}
