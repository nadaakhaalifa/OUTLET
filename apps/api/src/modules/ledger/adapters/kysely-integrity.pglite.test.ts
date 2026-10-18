import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo, lintMigration } from "@outlet/db";
import { sql, type Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { computeIntegrityState, gaugeValues } from "../domain/integrity-runs";
import { IntegrityAlreadyRecordedError, IntegrityAuditWriteError } from "../domain/ports";
import { cachedGaugeReader } from "../application/integrity-gauge";
import { FakeClock, driftRow, failedReport, okReport, recorderFor, uid } from "../test/integrity-fixtures";
import { KyselyIntegrityRunReader, KyselyIntegrityRunStore } from "./kysely-integrity";
import { KyselyIntegritySnapshots } from "./kysely-store";

const SQL_0089 = readFileSync(fileURLToPath(new URL("../../../../../../packages/db/migrations/0089_ledger_integrity_runs.sql", import.meta.url)), "utf8");
const SQL_0093 = readFileSync(fileURLToPath(new URL("../../../../../../packages/db/migrations/0093_ledger_audit_hardening.sql", import.meta.url)), "utf8");
const FINANCE = { actorId: uid(1), role: "finance" } as const;
const SYSTEM = { actorId: null, role: "system" } as const;
const open: Kysely<Record<string, never>>[] = [];

const fresh = async () => {
  const raw = await createTestDatabaseUpTo(87);
  await raw.exec(SQL_0089);
  await raw.exec(SQL_0093);
  const db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return { raw, db, store: new KyselyIntegrityRunStore(db), reader: new KyselyIntegrityRunReader(db) };
};
const count = async (raw: Awaited<ReturnType<typeof fresh>>["raw"], table: string): Promise<number> =>
  Number((await raw.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]?.n);

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describe("0089_ledger_integrity_runs", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL_0089)).toEqual([]);
  });

  it("has RLS on both tables and grants app_user no UPDATE or TRUNCATE (no DELETE on runs)", async () => {
    const { raw } = await fresh();
    const rls = await raw.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('ledger_integrity_runs','ledger_integrity_drift_samples') order by 1`,
    );
    expect(rls.rows.map((r) => r.relrowsecurity)).toEqual([true, true]);
    const g = await raw.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_name in ('ledger_integrity_runs','ledger_integrity_drift_samples') and grantee = 'app_user' order by 1, 2`,
    );
    expect(g.rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([
      "ledger_integrity_drift_samples:DELETE",
      "ledger_integrity_drift_samples:INSERT",
      "ledger_integrity_drift_samples:SELECT",
      "ledger_integrity_runs:INSERT",
      "ledger_integrity_runs:SELECT",
    ]);
  });
});

describe("recorder on the real schema (PGlite)", () => {
  it("round-trips a completed run with its sample and audit evidence, read as finance", async () => {
    const { raw, store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    const drift = [driftRow(1, 10n), driftRow(2, -30n)];
    const { recorder } = recorderFor(store, clock, { run: async () => failedReport() });
    // use a report whose drift has two rows
    const report = { ...failedReport(), storeCredit: { drift, negative: [] } };
    const { recorder: r2 } = recorderFor(store, clock, { run: async () => report });
    void recorder;
    await r2.run("nightly");
    const snap = await reader.snapshot(FINANCE);
    expect(snap.latest).toMatchObject({
      ok: false,
      trialOk: false,
      chainOk: false,
      chainLength: 0n,
      chainHeadHash: null,
      driftCount: 2,
      auditEvidence: "present",
      sampleAvailable: true,
      runKind: "nightly",
    });
    expect(snap.latest?.trialOffenders).toEqual([{ currency: "EGP", totalMinor: -5n }]);
    expect(snap.latest?.chainFailure).toEqual({ seq: 7n, entryId: uid(77), reason: "entry_hash_mismatch" });
    expect(snap.latest?.sample.map((s) => s.differenceMinor)).toEqual([-30n, 10n]);
    expect(snap.latestAttempt).toMatchObject({ outcome: "completed", errorCode: null });
    const audit = await raw.query<{ chain_id: string; action: string; diff_redacted: { run_id: string; report_sha256: string; ok: boolean } }>(
      `select chain_id, action, diff_redacted from audit_log`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.action).toBe("ledger.integrity.run");
    expect(audit.rows[0]?.chain_id).toMatch(/^ledger-integrity:\d{4}-\d{2}$/);
    expect(audit.rows[0]?.diff_redacted).toEqual({ run_id: snap.latest?.id, ok: false, report_sha256: snap.latest?.reportSha256 });
    // started_at of the completed row is the started row's database time
    const t = await raw.query<{ same: boolean }>(
      `select (select started_at from ledger_integrity_runs where outcome='completed') = (select started_at from ledger_integrity_runs where outcome='started') as same`,
    );
    expect(t.rows[0]?.same).toBe(true);
  });

  it("H4: a failing audit insert rolls back the run row and the sample rows; the previous result stays", async () => {
    const { raw, store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    await recorderFor(store, clock, { run: async () => okReport() }).recorder.run("nightly");
    const before = await reader.snapshot(SYSTEM);
    await raw.exec(`
      create function a_fail() returns trigger language plpgsql as $$ begin raise exception 'audit down'; end $$;
      create trigger a_fail_trg before insert on audit_log for each row execute function a_fail();`);
    const bad = { run: async () => ({ ...failedReport(), storeCredit: { drift: [driftRow(1, 10n)], negative: [] } }) };
    const { recorder, counters } = recorderFor(store, clock, bad);
    await expect(recorder.run("nightly")).rejects.toThrow("could not be recorded");
    expect(await count(raw, "ledger_integrity_drift_samples")).toBe(0);
    expect(await count(raw, "audit_log")).toBe(1);
    const completed = await raw.query<{ n: string }>(`select count(*)::text as n from ledger_integrity_runs where outcome = 'completed'`);
    expect(completed.rows[0]?.n).toBe("1");
    expect(counters.auditFailed).toBe(1);
    const after = await reader.snapshot(SYSTEM);
    expect(after.latest?.id).toBe(before.latest?.id);
    expect(after.latestAttempt).toMatchObject({ outcome: "error", errorCode: "audit_failed" });
    // direct store call surfaces the typed error
    await expect(
      store.completeRun({ id: uid(900), attemptId: uid(901), kind: "manual", data: { ...okMapped() }, audit: { atMs: Date.now(), runId: uid(900), ok: true, reportSha256: "b".repeat(64) } }),
    ).rejects.toBeInstanceOf(IntegrityAuditWriteError);
    // started + completed (first run), started + error (second run); the direct call above rolled back
    expect(await count(raw, "ledger_integrity_runs")).toBe(4);
  });

  it("evidence missing: an audit row deleted by a superuser makes ok report 0 and state failed; a changed hash does too", async () => {
    const { raw, store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    await recorderFor(store, clock, { run: async () => okReport() }).recorder.run("nightly");
    expect((await reader.snapshot(FINANCE)).latest?.auditEvidence).toBe("present");
    await raw.exec(`alter table audit_log disable trigger audit_log_immutable_trg; delete from audit_log; alter table audit_log enable trigger audit_log_immutable_trg;`);
    const snap = await reader.snapshot(FINANCE);
    expect(snap.latest?.auditEvidence).toBe("missing");
    expect(computeIntegrityState({ latest: snap.latest, latestAttempt: snap.latestAttempt, nowMs: Date.now(), mode: "batch" }).state).toBe("failed");
    expect((await cachedGaugeReader(reader, clock, 0)()).ok).toBe(0);
  });

  it("evidence missing when the stored report hash no longer matches the audit row", async () => {
    const { raw, store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    await recorderFor(store, clock, { run: async () => okReport() }).recorder.run("nightly");
    await raw.exec(`alter table ledger_integrity_runs disable trigger lir_immutable_trg; update ledger_integrity_runs set report_sha256 = repeat('c', 64) where outcome = 'completed'; alter table ledger_integrity_runs enable trigger lir_immutable_trg;`);
    expect((await reader.snapshot(FINANCE)).latest?.auditEvidence).toBe("missing");
  });

  it("failed then error keeps the failed run as latest and reports the error attempt", async () => {
    const { store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    await recorderFor(store, clock, { run: async () => failedReport() }).recorder.run("nightly");
    await expect(recorderFor(store, clock, { run: async () => Promise.reject(new Error("x")) }).recorder.run("nightly")).rejects.toThrow();
    const snap = await reader.snapshot(FINANCE);
    expect(snap.latest?.ok).toBe(false);
    expect(snap.latestAttempt).toMatchObject({ outcome: "error", errorCode: "job_error" });
    expect(computeIntegrityState({ latest: snap.latest, latestAttempt: snap.latestAttempt, nowMs: Date.now(), mode: "batch" }).state).toBe("failed");
  });

  it("empty table: never_run, no gauge values; error-only table: error_only and age from the first row", async () => {
    const { store, reader } = await fresh();
    const empty = await reader.snapshot(FINANCE);
    expect(empty).toEqual({ latest: null, latestAttempt: null, firstStartedAtMs: null });
    expect(gaugeValues(null, empty.firstStartedAtMs, Date.now())).toEqual({ ok: null, ageSeconds: null });
    const clock = new FakeClock(Date.now());
    await expect(recorderFor(store, clock, { run: async () => Promise.reject(new Error("x")) }).recorder.run("nightly")).rejects.toThrow();
    const snap = await reader.snapshot(FINANCE);
    expect(snap.latest).toBeNull();
    expect(snap.firstStartedAtMs).not.toBeNull();
    expect(computeIntegrityState({ latest: null, latestAttempt: snap.latestAttempt, nowMs: Date.now(), mode: "batch" }).state).toBe("error_only");
  });

  it("a started row without an outcome is the latest attempt with outcome started", async () => {
    const { store, reader } = await fresh();
    await store.recordStarted({ id: uid(1), attemptId: uid(2), kind: "nightly" });
    expect((await reader.snapshot(FINANCE)).latestAttempt).toMatchObject({ attemptId: uid(2), outcome: "started" });
  });

  it("sample_available is false once the sample passed retention while drift_count > 0", async () => {
    const { raw, store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    const withDrift = { ...failedReport(), storeCredit: { drift: [driftRow(1, 10n)], negative: [] } };
    await recorderFor(store, clock, { run: async () => withDrift }).recorder.run("nightly");
    await raw.exec(`delete from ledger_integrity_drift_samples`);
    const snap = await reader.snapshot(FINANCE);
    expect(snap.latest).toMatchObject({ driftCount: 1, sample: [], sampleAvailable: false, auditEvidence: "present" });
  });

  it("keyset paging returns each completed run once, newest first", async () => {
    const { store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    for (let i = 0; i < 5; i += 1) await recorderFor(store, clock, { run: async () => okReport() }).recorder.run("intraday");
    const ids: string[] = [];
    let before = null as { ts: string; id: string } | null;
    for (let n = 0; n < 6; n += 1) {
      const p = await reader.listCompleted(FINANCE, { limit: 2, before });
      ids.push(...p.items.map((i) => i.id));
      if (p.next === null) break;
      before = p.next;
    }
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    await expect(reader.listCompleted(FINANCE, { limit: 2, before: { ts: "yesterday", id: "x" } })).rejects.toThrow("invalid cursor");
  });
});

describe("immutability and RLS", () => {
  it("runs reject UPDATE, DELETE and TRUNCATE; samples reject UPDATE", async () => {
    const { raw, store } = await fresh();
    const clock = new FakeClock(Date.now());
    const withDrift = { ...failedReport(), storeCredit: { drift: [driftRow(1, 10n)], negative: [] } };
    await recorderFor(store, clock, { run: async () => withDrift }).recorder.run("nightly");
    await expect(raw.exec(`update ledger_integrity_runs set ok = true`)).rejects.toThrow(/append-only/);
    await expect(raw.exec(`delete from ledger_integrity_runs`)).rejects.toThrow(/append-only/);
    // the foreign key from the sample table refuses first; the statement trigger covers the FK-free case
    await expect(raw.exec(`truncate ledger_integrity_runs`)).rejects.toThrow();
    await expect(raw.exec(`truncate ledger_integrity_runs cascade`)).rejects.toThrow(/append-only/);
    await expect(raw.exec(`update ledger_integrity_drift_samples set difference_minor = 0`)).rejects.toThrow(/append-only/);
  });

  it("an ops (or security) session reads zero rows; finance reads them; super_admin reads them", async () => {
    const { store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    await recorderFor(store, clock, { run: async () => okReport() }).recorder.run("nightly");
    for (const role of ["ops", "security", "marketing", "dpo", "customer"]) {
      const s = await reader.snapshot({ actorId: uid(5), role: role as never });
      expect(s.latest, role).toBeNull();
      expect(s.firstStartedAtMs, role).toBeNull();
      expect((await reader.listCompleted({ actorId: uid(5), role: role as never }, { limit: 5, before: null })).items, role).toEqual([]);
    }
    expect((await reader.snapshot(FINANCE)).latest).not.toBeNull();
    expect((await reader.snapshot({ actorId: uid(1), role: "super_admin" })).latest).not.toBeNull();
  });

  it("a non-system session cannot insert runs or samples", async () => {
    const { raw } = await fresh();
    for (const role of ["finance", "ops", "customer"]) {
      await expect(
        raw.exec(`begin; set local role app_user; select set_config('app.role', '${role}', true);
                  insert into ledger_integrity_runs (id, run_kind, outcome, attempt_id) values ('${uid(10)}', 'nightly', 'started', '${uid(11)}');`),
      ).rejects.toThrow(/row-level security/);
      await raw.exec("rollback").catch(() => undefined);
    }
  });

  it("only system may delete samples; a finance delete removes nothing", async () => {
    const { raw, store, db } = await fresh();
    const clock = new FakeClock(Date.now());
    const withDrift = { ...failedReport(), storeCredit: { drift: [driftRow(1, 10n)], negative: [] } };
    await recorderFor(store, clock, { run: async () => withDrift }).recorder.run("nightly");
    await db.transaction().execute(async (trx) => {
      await sql`set local role app_user`.execute(trx);
      await sql`select set_config('app.role', 'finance', true)`.execute(trx);
      await sql`delete from ledger_integrity_drift_samples`.execute(trx);
    });
    expect(await count(raw, "ledger_integrity_drift_samples")).toBe(1);
    await db.transaction().execute(async (trx) => {
      await sql`set local role app_user`.execute(trx);
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      await sql`delete from ledger_integrity_drift_samples`.execute(trx);
    });
    expect(await count(raw, "ledger_integrity_drift_samples")).toBe(0);
  });

  it("the evidence function answers nothing for roles outside the ledger readers", async () => {
    const { raw, store } = await fresh();
    const clock = new FakeClock(Date.now());
    await recorderFor(store, clock, { run: async () => okReport() }).recorder.run("nightly");
    const id = (await raw.query<{ id: string }>(`select id from ledger_integrity_runs where outcome = 'completed'`)).rows[0]?.id ?? "";
    await raw.exec(`begin; set local role app_user; select set_config('app.role', 'ops', true);`);
    const ops = await raw.query(`select * from ledger_integrity_audit_evidence(array['${id}']::uuid[])`);
    await raw.exec("rollback");
    expect(ops.rows).toEqual([]);
    await raw.exec(`begin; set local role app_user; select set_config('app.role', 'finance', true);`);
    const fin = await raw.query(`select * from ledger_integrity_audit_evidence(array['${id}']::uuid[])`);
    await raw.exec("rollback");
    expect(fin.rows).toHaveLength(1);
  });
});

function okMapped() {
  return {
    ok: true,
    trialOk: true,
    trialOffenders: [],
    chainOk: true,
    chainLength: 1n,
    chainHeadHash: "a".repeat(64),
    chainFailure: null,
    driftCount: 0,
    negativeCount: 0,
    sampleTruncated: false,
    sample: [],
    reportSha256: "b".repeat(64),
  };
}

describe("0093 ledger integrity hardening (PGlite)", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL_0093)).toEqual([]);
  });

  it("the integrity snapshot transaction is READ ONLY: an INSERT inside withSnapshot fails", async () => {
    const { db } = await fresh();
    const snaps = new KyselyIntegritySnapshots(db);
    await expect(
      snaps.withSnapshot(async (source) => {
        const trx = (source as unknown as { trx: Kysely<Record<string, never>> }).trx;
        // system role would pass RLS and grants; only the transaction access mode stops this write.
        await sql`insert into ledger_integrity_runs (id, run_kind, outcome, attempt_id) values (${uid(500)}::uuid, 'manual', 'started', ${uid(501)}::uuid)`.execute(trx);
      }),
    ).rejects.toThrow(/read-only transaction/i);
    // and a plain read still works
    await expect(snaps.withSnapshot((source) => source.trialBalance())).resolves.toBeDefined();
  });

  it("allows at most one final row per attempt; a second completeRun is reported as already recorded and adds no audit row", async () => {
    const { raw, store } = await fresh();
    const clock = new FakeClock(Date.now());
    const data = okMapped();
    const audit = (runId: string) => ({ atMs: Date.now(), runId, ok: true, reportSha256: data.reportSha256 });
    await store.recordStarted({ id: uid(600), attemptId: uid(601), kind: "nightly" });
    await store.completeRun({ id: uid(602), attemptId: uid(601), kind: "nightly", data, audit: audit(uid(602)) });
    await expect(store.completeRun({ id: uid(603), attemptId: uid(601), kind: "nightly", data, audit: audit(uid(603)) })).rejects.toBeInstanceOf(
      IntegrityAlreadyRecordedError,
    );
    await expect(store.recordFailure({ id: uid(604), attemptId: uid(601), kind: "nightly", outcome: "error", errorCode: "x" })).rejects.toThrow();
    expect(await count(raw, "audit_log")).toBe(1);
    // The guard is the partial unique index itself, not application bookkeeping.
    await expect(
      raw.query(`insert into ledger_integrity_runs (id, run_kind, outcome, attempt_id, finished_at, error_code) values ('${uid(605)}','nightly','error','${uid(601)}', now(), 'x')`),
    ).rejects.toThrow(/lir_attempt_final_uq/);
    const finals = await raw.query<{ n: string }>(`select count(*)::text as n from ledger_integrity_runs where attempt_id = '${uid(601)}' and outcome <> 'started'`);
    expect(finals.rows[0]?.n).toBe("1");
    void clock;
  });

  it("the recorder treats a duplicate-final conflict as success (one completed row, one audit row, no failure row)", async () => {
    const { raw, store } = await fresh();
    const clock = new FakeClock(Date.now());
    let first = true;
    // Simulates an ambiguous commit: the first completeRun commits but the caller sees an error; the retry hits the unique index.
    const flaky = {
      recordStarted: store.recordStarted.bind(store),
      recordFailure: store.recordFailure.bind(store),
      completeRun: async (a: Parameters<typeof store.completeRun>[0]) => {
        await store.completeRun(a);
        if (first) {
          first = false;
          throw new Error("connection reset after commit");
        }
      },
    };
    const { recorder, counters } = recorderFor(flaky, clock, { run: async () => okReport() });
    await expect(recorder.run("nightly")).resolves.toMatchObject({ ok: 1 });
    const kinds = await raw.query<{ outcome: string }>(`select outcome from ledger_integrity_runs order by outcome`);
    expect(kinds.rows.map((r) => r.outcome)).toEqual(["completed", "started"]);
    expect(await count(raw, "audit_log")).toBe(1);
    expect(counters.runs).toEqual(["completed"]);
  });

  it("lir_completed_chk: every final outcome requires finished_at", async () => {
    const { raw } = await fresh();
    await expect(raw.query(`insert into ledger_integrity_runs (id, run_kind, outcome, attempt_id, error_code) values ('${uid(700)}','nightly','error','${uid(701)}','x')`)).rejects.toThrow(/lir_completed_chk/);
    await expect(raw.query(`insert into ledger_integrity_runs (id, run_kind, outcome, attempt_id, error_code) values ('${uid(702)}','nightly','timeout','${uid(703)}','x')`)).rejects.toThrow(/lir_completed_chk/);
    await expect(
      raw.query(
        `insert into ledger_integrity_runs (id, run_kind, outcome, attempt_id, ok, trial_ok, chain_ok, report_sha256) values ('${uid(704)}','nightly','completed','${uid(705)}',true,true,true,'${"a".repeat(64)}')`,
      ),
    ).rejects.toThrow(/lir_completed_chk/);
    await expect(raw.query(`insert into ledger_integrity_runs (id, run_kind, outcome, attempt_id) values ('${uid(706)}','nightly','started','${uid(707)}')`)).resolves.toBeDefined();
  });

  it("drift samples persist and return the ledger account id, never the raw user id", async () => {
    const { raw, store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    const user = uid(1);
    const acct = await raw.query<{ id: string }>(
      `insert into ledger_accounts (type, owner_type, owner_id, sub_key, currency) values ('store_credit','user','${user}','refund_credit','EGP') returning id`,
    );
    const report = { ...failedReport(), storeCredit: { drift: [driftRow(1, 10n), driftRow(2, -30n)], negative: [] } };
    await recorderFor(store, clock, { run: async () => report }).recorder.run("nightly");
    const cols = await raw.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'ledger_integrity_drift_samples'`);
    expect(cols.rows.map((c) => c.column_name)).not.toContain("user_id");
    const rows = await raw.query<{ account_id: string | null }>(`select account_id::text as account_id from ledger_integrity_drift_samples order by ord`);
    expect(rows.rows.map((r) => r.account_id)).toEqual([null, acct.rows[0]?.id]);
    const dump = JSON.stringify((await raw.query(`select * from ledger_integrity_drift_samples`)).rows);
    expect(dump).not.toContain(user);
    expect(dump).not.toContain(uid(2));
    const snap = await reader.snapshot(FINANCE);
    expect(JSON.stringify(snap.latest?.sample, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(user);
    expect(snap.latest?.sample.map((x) => x.accountId)).toEqual([null, acct.rows[0]?.id]);
  });

  it("drift account resolution only matches user-owned EGP store_credit accounts and never picks arbitrarily", async () => {
    const { raw, store, reader } = await fresh();
    const clock = new FakeClock(Date.now());
    const user = uid(1);
    await raw.query(`insert into ledger_accounts (type, owner_type, owner_id, sub_key, currency) values ('store_credit','store','${user}','refund_credit','EGP')`);
    await raw.query(`insert into ledger_accounts (type, owner_type, owner_id, sub_key, currency) values ('store_credit','user','${user}','refund_credit','USD')`);
    const wrongOnly = { ...failedReport(), storeCredit: { drift: [driftRow(1, 10n)], negative: [] } };
    await recorderFor(store, clock, { run: async () => wrongOnly }).recorder.run("nightly");
    let snap = await reader.snapshot(FINANCE);
    expect(snap.latest?.sample.map((x) => x.accountId)).toEqual([null]);
    // Once the correct account exists the same user resolves to it (the unique identity constraint makes more than one match impossible; the CASE guards it anyway).
    const good = await raw.query<{ id: string }>(
      `insert into ledger_accounts (type, owner_type, owner_id, sub_key, currency) values ('store_credit','user','${user}','refund_credit','EGP') returning id`,
    );
    await recorderFor(store, clock, { run: async () => wrongOnly }).recorder.run("nightly");
    snap = await reader.snapshot(FINANCE);
    expect(snap.latest?.sample.map((x) => x.accountId)).toEqual([good.rows[0]?.id]);
  });
});
