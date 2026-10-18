import { assertAuditDiff } from "@outlet/privacy";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { applySession, resolveTxOptions } from "../../../platform/db";
import type { AuditEvidence, CompletedRunData, DriftSampleRow, IntegrityOutcome, LatestAttempt, StoredRun } from "../domain/integrity-runs";
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
import type { LedgerDb } from "./kysely-store";

const ROLE = /^[a-z_][a-z0-9_]*$/;
const iso = (ms: number): string => new Date(ms).toISOString();
const isFinalRowConflict = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const x = e as { code?: unknown; constraint?: unknown; message?: unknown };
  return x.code === "23505" && (x.constraint === "lir_attempt_final_uq" || (typeof x.message === "string" && x.message.includes("lir_attempt_final_uq")));
};
const yyyymm = (ms: number): string => iso(ms).slice(0, 7);

type Trx = Transaction<Record<string, never>>;

/**
 * Writes run rows as `system` (RLS insert policy). `completeRun` is ONE transaction: completed row,
 * drift sample rows and the hash-chained `ledger.integrity.run` audit row (H4). The completed row copies
 * `started_at` from the attempt's started row so freshness always uses the database clock.
 */
export class KyselyIntegrityRunStore implements IntegrityRunStore {
  constructor(
    private readonly db: LedgerDb,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  private async tx<R>(process: string, fn: (trx: Trx) => Promise<R>): Promise<R> {
    if (this.applicationRole !== null && !ROLE.test(this.applicationRole)) throw new RangeError("invalid role name");
    return this.db.transaction().execute(async (trx) => {
      await applySession(trx, resolveTxOptions({ session: { userId: null, role: "system" }, process, profile: "default" }), this.applicationRole);
      return fn(trx);
    });
  }

  async recordStarted(a: IntegrityRunIds): Promise<void> {
    await this.tx("ledger.integrity.record", async (trx) => {
      await sql`
        insert into ledger_integrity_runs (id, run_kind, outcome, attempt_id)
        values (${a.id}::uuid, ${a.kind}, 'started', ${a.attemptId}::uuid)`.execute(trx);
    });
  }

  async completeRun(a: IntegrityRunIds & { data: CompletedRunData; audit: IntegrityAuditInput }): Promise<void> {
    try {
      await this.completeRunTx(a);
    } catch (e) {
      // lir_attempt_final_uq: the transaction (completed row, samples, audit row) rolled back as one, so nothing doubled.
      if (isFinalRowConflict(e)) throw new IntegrityAlreadyRecordedError();
      throw e;
    }
  }

  private async completeRunTx(a: IntegrityRunIds & { data: CompletedRunData; audit: IntegrityAuditInput }): Promise<void> {
    const d = a.data;
    await this.tx("ledger.integrity.record", async (trx) => {
      await sql`
        insert into ledger_integrity_runs
          (id, run_kind, outcome, attempt_id, started_at, finished_at, ok, trial_ok, trial_offenders, chain_ok,
           chain_length, chain_head_hash, chain_failure, drift_count, negative_count, sample_truncated, report_sha256)
        select ${a.id}::uuid, ${a.kind}, 'completed', ${a.attemptId}::uuid,
               coalesce((select s.started_at from ledger_integrity_runs s where s.attempt_id = ${a.attemptId}::uuid and s.outcome = 'started' limit 1), now()),
               now(), ${d.ok}, ${d.trialOk},
               ${JSON.stringify(d.trialOffenders.map((o) => ({ currency: o.currency, total_minor: o.totalMinor.toString() })))}::jsonb,
               ${d.chainOk}, ${d.chainLength.toString()}::bigint, ${d.chainHeadHash},
               ${d.chainFailure === null ? null : JSON.stringify({ seq: d.chainFailure.seq.toString(), entry_id: d.chainFailure.entryId, reason: d.chainFailure.reason })}::jsonb,
               ${d.driftCount}, ${d.negativeCount}, ${d.sampleTruncated}, ${d.reportSha256}`.execute(trx);
      let ord = 0;
      for (const s of d.sample) {
        ord += 1;
        await sql`
          insert into ledger_integrity_drift_samples (run_id, ord, account_id, sub, projected_minor, from_postings_minor, difference_minor)
          values (${a.id}::uuid, ${ord},
                  (select case when count(*) = 1 then (array_agg(la.id))[1] end
                     from ledger_accounts la
                    where la.type = 'store_credit' and la.owner_type = 'user' and la.currency = ${STORE_CREDIT_CURRENCY}
                      and la.owner_id::text = ${s.userId} and la.sub_key = ${s.sub}),
                  ${s.sub}, ${s.projectedMinor.toString()}::bigint,
                  ${s.fromPostingsMinor.toString()}::bigint, ${s.differenceMinor.toString()}::bigint)`.execute(trx);
      }
      try {
        await sql`
          insert into audit_log (occurred_at, chain_id, actor_type, actor_id, action, target_type, target_id, diff_redacted)
          values (${iso(a.audit.atMs)}::timestamptz, ${`ledger-integrity:${yyyymm(a.audit.atMs)}`}, 'system', null,
                  'ledger.integrity.run', 'ledger_integrity_run', ${a.audit.runId}::uuid,
                  ${JSON.stringify(assertAuditDiff({ run_id: a.audit.runId, ok: a.audit.ok, report_sha256: a.audit.reportSha256 }))}::jsonb)`.execute(trx);
      } catch {
        // Thrown out of the transaction callback: Kysely rolls the whole transaction back.
        throw new IntegrityAuditWriteError();
      }
    });
  }

  async recordFailure(a: IntegrityRunIds & { outcome: "error" | "timeout"; errorCode: string }): Promise<void> {
    await this.tx("ledger.integrity.record", async (trx) => {
      await sql`
        insert into ledger_integrity_runs (id, run_kind, outcome, attempt_id, started_at, finished_at, error_code)
        values (${a.id}::uuid, ${a.kind}, ${a.outcome},  ${a.attemptId}::uuid,
                coalesce((select s.started_at from ledger_integrity_runs s where s.attempt_id = ${a.attemptId}::uuid and s.outcome = 'started' limit 1), now()),
                now(), ${a.errorCode.slice(0, 64)})`.execute(trx);
    });
  }
}

/** Store credit is EGP-only (spec section 6/15.2). Anything but exactly one matching account resolves to NULL (fail closed, never an arbitrary pick). */
const STORE_CREDIT_CURRENCY = "EGP";

const Big = z.string().regex(/^-?\d+$/).transform((s) => BigInt(s));
const Json = z.unknown().transform((v) => (typeof v === "string" ? (JSON.parse(v) as unknown) : v));
const OffenderList = z.array(z.object({ currency: z.string(), total_minor: Big }));
const Failure = z.object({ seq: Big, entry_id: z.string(), reason: z.string() });

const RunRow = z.object({
  id: z.string(),
  run_kind: z.enum(["nightly", "intraday", "manual"]),
  started_ms: Big,
  finished_ms: Big,
  ts_iso: z.string(),
  ok: z.boolean(),
  trial_ok: z.boolean(),
  trial_offenders: Json,
  chain_ok: z.boolean(),
  chain_length: Big,
  chain_head_hash: z.string().nullable(),
  chain_failure: Json,
  drift_count: z.number().int(),
  negative_count: z.number().int(),
  sample_truncated: z.boolean(),
  report_sha256: z.string(),
});
const SampleRow = z.object({ run_id: z.string(), account_id: z.string().nullable(), sub: z.string(), p: Big, f: Big, d: Big });
const AttemptRow = z.object({ attempt_id: z.string(), started_ms: Big, outcome: z.enum(["started", "completed", "error", "timeout"]), error_code: z.string().nullable() });

const RUN_COLS = sql.raw(`
  r.id::text as id, r.run_kind,
  floor(extract(epoch from r.started_at) * 1000)::text as started_ms,
  floor(extract(epoch from coalesce(r.finished_at, r.started_at)) * 1000)::text as finished_ms,
  to_char(r.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts_iso,
  r.ok, r.trial_ok, r.trial_offenders, r.chain_ok, r.chain_length::text as chain_length, r.chain_head_hash,
  r.chain_failure, r.drift_count, r.negative_count, r.sample_truncated, r.report_sha256`);

const ISO_MICRO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads under the caller's role (finance on the HTTP path, system for the gauges): RLS is the second line of defence. */
export class KyselyIntegrityRunReader implements IntegrityRunReader {
  constructor(
    private readonly db: LedgerDb,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  private async read<R>(scope: IntegrityReadScope, fn: (trx: Trx) => Promise<R>): Promise<R> {
    if (this.applicationRole !== null && !ROLE.test(this.applicationRole)) throw new RangeError("invalid role name");
    return this.db.transaction().execute(async (trx) => {
      await applySession(
        trx,
        resolveTxOptions({ session: { userId: scope.actorId, role: scope.role }, process: "ledger.integrity.read", profile: "read" }),
        this.applicationRole,
      );
      return fn(trx);
    });
  }

  private async hydrate(trx: Trx, rows: readonly z.output<typeof RunRow>[]): Promise<StoredRun[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const idList = sql.join(ids.map((i) => sql`${i}::uuid`));
    const ev = await sql<{ run_id: string }>`select run_id::text as run_id from ledger_integrity_audit_evidence(array[${idList}]::uuid[])`.execute(trx);
    const present = new Set(ev.rows.map((r) => r.run_id));
    const sm = await sql<unknown>`
      select run_id::text as run_id, account_id::text as account_id, sub, projected_minor::text as p, from_postings_minor::text as f, difference_minor::text as d
      from ledger_integrity_drift_samples where run_id in (${idList}) order by run_id, ord`.execute(trx);
    const byRun = new Map<string, DriftSampleRow[]>();
    for (const raw of sm.rows) {
      const s = SampleRow.parse(raw);
      const list = byRun.get(s.run_id) ?? [];
      list.push({ accountId: s.account_id, sub: s.sub, projectedMinor: s.p, fromPostingsMinor: s.f, differenceMinor: s.d });
      byRun.set(s.run_id, list);
    }
    return rows.map((r): StoredRun => {
      const offenders = OffenderList.parse(r.trial_offenders ?? []);
      const failure = r.chain_failure === null || r.chain_failure === undefined ? null : Failure.parse(r.chain_failure);
      const sample = byRun.get(r.id) ?? [];
      const evidence: AuditEvidence = present.has(r.id) ? "present" : "missing";
      return {
        id: r.id,
        runKind: r.run_kind,
        startedAtMs: Number(r.started_ms),
        finishedAtMs: Number(r.finished_ms),
        auditEvidence: evidence,
        ok: r.ok,
        trialOk: r.trial_ok,
        trialOffenders: offenders.map((o) => ({ currency: o.currency, totalMinor: o.total_minor })),
        chainOk: r.chain_ok,
        chainLength: r.chain_length,
        chainHeadHash: r.chain_head_hash,
        chainFailure: failure === null ? null : { seq: failure.seq, entryId: failure.entry_id, reason: failure.reason },
        driftCount: r.drift_count,
        negativeCount: r.negative_count,
        sampleTruncated: r.sample_truncated,
        sample,
        sampleAvailable: sample.length > 0 || r.drift_count === 0,
        reportSha256: r.report_sha256,
      };
    });
  }

  async snapshot(scope: IntegrityReadScope): Promise<IntegritySnapshot> {
    return this.read(scope, async (trx) => {
      const latestRows = await sql<unknown>`
        select ${RUN_COLS} from ledger_integrity_runs r where r.outcome = 'completed'
        order by r.started_at desc, r.id desc limit 1`.execute(trx);
      const latest = (await this.hydrate(trx, latestRows.rows.map((x) => RunRow.parse(x))))[0] ?? null;
      const attemptRows = await sql<unknown>`
        with newest as (select attempt_id from ledger_integrity_runs order by started_at desc, id desc limit 1)
        select r.attempt_id::text as attempt_id, floor(extract(epoch from r.started_at) * 1000)::text as started_ms, r.outcome, r.error_code
        from ledger_integrity_runs r join newest n on n.attempt_id = r.attempt_id
        order by (r.outcome = 'started'), r.id desc limit 1`.execute(trx);
      const a = attemptRows.rows[0] === undefined ? null : AttemptRow.parse(attemptRows.rows[0]);
      const first = await sql<{ ms: string | null }>`
        select floor(extract(epoch from min(started_at)) * 1000)::text as ms from ledger_integrity_runs`.execute(trx);
      const firstMs = first.rows[0]?.ms ?? null;
      const latestAttempt: LatestAttempt | null =
        a === null ? null : { attemptId: a.attempt_id, startedAtMs: Number(a.started_ms), outcome: a.outcome as IntegrityOutcome, errorCode: a.error_code };
      return { latest, latestAttempt, firstStartedAtMs: firstMs === null ? null : Number(firstMs) };
    });
  }

  async listCompleted(scope: IntegrityReadScope, q: { limit: number; before: RunCursor | null }) {
    if (q.before !== null && (!ISO_MICRO.test(q.before.ts) || !UUID.test(q.before.id))) throw new RangeError("invalid cursor");
    return this.read(scope, async (trx) => {
      const keyset = q.before === null ? sql`true` : sql`(r.started_at, r.id) < (${q.before.ts}::timestamptz, ${q.before.id}::uuid)`;
      const res = await sql<unknown>`
        select ${RUN_COLS} from ledger_integrity_runs r where r.outcome = 'completed' and ${keyset}
        order by r.started_at desc, r.id desc limit ${q.limit + 1}`.execute(trx);
      const parsed = res.rows.map((x) => RunRow.parse(x));
      const page = parsed.slice(0, q.limit);
      const last = page[page.length - 1];
      const items = await this.hydrate(trx, page);
      return { items, next: parsed.length > q.limit && last !== undefined ? { ts: last.ts_iso, id: last.id } : null };
    });
  }
}

