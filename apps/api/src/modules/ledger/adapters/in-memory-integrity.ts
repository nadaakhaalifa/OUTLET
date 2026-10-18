import type { Clock } from "../../../platform/ports";
import type { AuditEvidence, IntegrityOutcome, IntegrityRunKind, LatestAttempt, StoredRun } from "../domain/integrity-runs";
import {
  IntegrityAlreadyRecordedError,
  IntegrityAuditWriteError,
  type IntegrityAuditInput,
  type IntegrityReadScope,
  type IntegrityRunIds,
  type IntegrityRunReader,
  type IntegrityRunStore,
  type IntegritySnapshot,
  type RunCursor,
} from "../domain/ports";
import type { CompletedRunData } from "../domain/integrity-runs";

interface Row {
  readonly id: string;
  readonly attemptId: string;
  readonly kind: IntegrityRunKind;
  readonly outcome: IntegrityOutcome;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly errorCode: string | null;
  readonly data: CompletedRunData | null;
}

export interface InMemoryAuditRow {
  readonly runId: string;
  readonly reportSha256: string;
  readonly ok: boolean;
  readonly chainId: string;
}

const READ_ROLES: ReadonlySet<string> = new Set(["finance", "super_admin", "system"]);

/**
 * In-memory store and reader with the same contract as the Kysely adapters: completeRun is atomic with
 * its audit row (a failing audit leaves nothing), rows are append-only, and reads honour the role set.
 */
export class InMemoryIntegrityRuns implements IntegrityRunStore, IntegrityRunReader {
  readonly rows: Row[] = [];
  readonly audit: InMemoryAuditRow[] = [];
  readonly samples = new Map<string, { retained: boolean }>();
  /** Test hook: when set, the audit insert throws and the completed row is not written. */
  auditFailure: (() => boolean) | null = null;
  /** Test hook: when set, any write throws before touching state. */
  writeFailure: (() => boolean) | null = null;

  constructor(private readonly clock: Clock) {}

  async recordStarted(a: IntegrityRunIds): Promise<void> {
    if (this.writeFailure?.() === true) throw new Error("write failed");
    this.rows.push({ id: a.id, attemptId: a.attemptId, kind: a.kind, outcome: "started", startedAtMs: this.clock.nowMs(), finishedAtMs: null, errorCode: null, data: null });
  }

  async completeRun(a: IntegrityRunIds & { data: CompletedRunData; audit: IntegrityAuditInput }): Promise<void> {
    if (this.writeFailure?.() === true) throw new Error("write failed");
    if (this.auditFailure?.() === true) throw new IntegrityAuditWriteError();
    if (this.rows.some((r) => r.attemptId === a.attemptId && r.outcome !== "started")) throw new IntegrityAlreadyRecordedError();
    const started = this.rows.find((r) => r.attemptId === a.attemptId && r.outcome === "started");
    this.audit.push({ runId: a.audit.runId, reportSha256: a.audit.reportSha256, ok: a.audit.ok, chainId: `ledger-integrity:${new Date(a.audit.atMs).toISOString().slice(0, 7)}` });
    this.rows.push({ id: a.id, attemptId: a.attemptId, kind: a.kind, outcome: "completed", startedAtMs: started?.startedAtMs ?? this.clock.nowMs(), finishedAtMs: this.clock.nowMs(), errorCode: null, data: a.data });
    this.samples.set(a.id, { retained: true });
  }

  async recordFailure(a: IntegrityRunIds & { outcome: "error" | "timeout"; errorCode: string }): Promise<void> {
    if (this.writeFailure?.() === true) throw new Error("write failed");
    const started = this.rows.find((r) => r.attemptId === a.attemptId && r.outcome === "started");
    this.rows.push({ id: a.id, attemptId: a.attemptId, kind: a.kind, outcome: a.outcome, startedAtMs: started?.startedAtMs ?? this.clock.nowMs(), finishedAtMs: this.clock.nowMs(), errorCode: a.errorCode, data: null });
  }

  /** Test hook: simulates the retention job removing the drift sample. */
  purgeSample(runId: string): void {
    this.samples.set(runId, { retained: false });
  }

  private evidence(r: Row): AuditEvidence {
    return this.audit.some((x) => x.runId === r.id && x.reportSha256 === r.data?.reportSha256) ? "present" : "missing";
  }

  private stored(r: Row): StoredRun {
    const d = r.data;
    if (d === null) throw new Error("not a completed row");
    const retained = this.samples.get(r.id)?.retained ?? true;
    return {
      ...d,
      id: r.id,
      runKind: r.kind,
      startedAtMs: r.startedAtMs,
      finishedAtMs: r.finishedAtMs ?? r.startedAtMs,
      auditEvidence: this.evidence(r),
      // Same shape as the Postgres reader: no raw user id leaves the store.
      sample: retained ? d.sample.map((s) => ({ accountId: null, sub: s.sub, projectedMinor: s.projectedMinor, fromPostingsMinor: s.fromPostingsMinor, differenceMinor: s.differenceMinor })) : [],
      sampleAvailable: retained || d.driftCount === 0,
    };
  }

  private allow(scope: IntegrityReadScope): boolean {
    return READ_ROLES.has(scope.role);
  }

  private completed(): Row[] {
    return this.rows.filter((r) => r.outcome === "completed").sort((a, b) => b.startedAtMs - a.startedAtMs || (a.id < b.id ? 1 : -1));
  }

  async snapshot(scope: IntegrityReadScope): Promise<IntegritySnapshot> {
    if (!this.allow(scope)) return { latest: null, latestAttempt: null, firstStartedAtMs: null };
    const top = this.completed()[0];
    const byStart = [...this.rows].sort((a, b) => b.startedAtMs - a.startedAtMs);
    const first = byStart[byStart.length - 1];
    const newest = byStart[0];
    let attempt: LatestAttempt | null = null;
    if (newest !== undefined) {
      const sameAttempt = this.rows.filter((r) => r.attemptId === newest.attemptId);
      const final = sameAttempt.find((r) => r.outcome !== "started") ?? newest;
      attempt = { attemptId: final.attemptId, startedAtMs: final.startedAtMs, outcome: final.outcome, errorCode: final.errorCode };
    }
    return { latest: top === undefined ? null : this.stored(top), latestAttempt: attempt, firstStartedAtMs: first?.startedAtMs ?? null };
  }

  async listCompleted(scope: IntegrityReadScope, q: { limit: number; before: RunCursor | null }) {
    if (!this.allow(scope)) return { items: [], next: null };
    const all = this.completed().filter((r) => {
      if (q.before === null) return true;
      const t = Date.parse(q.before.ts);
      return r.startedAtMs < t || (r.startedAtMs === t && r.id < q.before.id);
    });
    const page = all.slice(0, q.limit);
    const last = page[page.length - 1];
    const next = all.length > q.limit && last !== undefined ? { ts: new Date(last.startedAtMs).toISOString(), id: last.id } : null;
    return { items: page.map((r) => this.stored(r)), next };
  }
}
