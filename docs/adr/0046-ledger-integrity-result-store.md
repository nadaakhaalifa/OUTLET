# ADR-0046: Persist the ledger integrity result in an append-only table

- Status: **Accepted (engineering default; reversible)**, except the retention of user ids in the drift sample, which is **Proposed** (owner, Finance, counsel, DPO; VR-DASH-08). The role that may read it is in ADR-0049 (Proposed). Amended 2026-10-16 after the chief-reviewer security and privacy review (H4, H5, L3, and the RLS finding F1).
- Date: 2026-10-16
- Deciders: Architect, Tech Lead; Finance (consumer); DPO and counsel (sample retention)
- Spec refs: `docs/specs/dashboard-foundations.md` track 3 and section 8 (launch blockers); master prompt T4 (integrity job), T8 (SLOs), A2.9 (audit); `apps/api/src/modules/ledger/application/integrity-job.ts`

## Context and problem statement
`IntegrityJob.run()` checks the trial balance, the journal hash chain and store-credit drift, nightly and every 30 minutes in event mode. The result is returned to the scheduler and lost: no table, no alert port, no HTTP route. The worker registry text "writes only alerts and the signed snapshot" is not backed by code. Finance cannot see whether the ledger is sound, and a restart forgets a failure.

## Decision
1. Add `ledger_integrity_runs` (migration 0089): one immutable row per attempt start and one per outcome (`completed`, `error`, `timeout`), typed columns for each check and the SHA-256 of the canonical report. The capped drift sample (50 rows, with user ids) goes to a child table `ledger_integrity_drift_samples` so it can follow its own retention while run rows stay immutable.
2. A `RecordIntegrityRun` wrapper owns persistence and metrics; `IntegrityJob` stays pure.
3. **The completed row, its sample rows and its `audit_log` row (`ledger.integrity.run`, chain `ledger-integrity:YYYY-MM`, target = run id, carrying the report hash) are written in one transaction.** If the audit insert fails, nothing is committed and the staleness alert fires. The read route also returns `audit_evidence: present | missing` per run by joining on the target; `missing` is treated as `failed`.
4. **Gauges are exported from the table**, by the API process on every metric collection (latest completed row), not by the job, so a dead worker cannot freeze them. Prometheus rules page on `ok == 0`, on staleness and on **`absent_over_time(outlet_ledger_integrity_ok[30m])`**, each with a promtool test that CI runs. Alert payloads carry the run id and state only, never chain or drift details.
5. RLS uses concrete roles (`finance`, `super_admin`, `system`), mirroring `ledger_entry_chain`; `'admin'` is not a valid `app.role`.

## Options compared
- New table (chosen) vs reuse `audit_log` vs in-memory state or gauge only. A typed table gives an indexed read model and history at trivial volume; `audit_log` is an actor-action log with a P2 class and a jsonb blob that is awkward to query; in-memory state is lost on restart and differs per instance. The audit row keeps the tamper evidence of option B without its query cost.
- Audit evidence: same transaction (chosen) vs best-effort audit plus a join-time check. Same transaction makes "a completed run without evidence" impossible for the application; the join-time `audit_evidence` field is kept as a tamper signal, not as the primary guarantee.
- Gauges: emitted by the job (draft) vs read from the table by the always-running API (chosen). Job-emitted gauges vanish or freeze with the worker; table-backed gauges age honestly and an absence rule covers the export path itself.

## Consequences
- `GET /v1/admin/ledger/integrity` can report failed, stale, never-run, error-only and missing-evidence states honestly.
- **Limits of tamper evidence:** `forbid_mutation` triggers and the hash chain are tamper-evident only against roles that cannot disable triggers or rewrite the chain; a database superuser can do both. The **signed snapshot** (KMS signature over the journal chain head and the audit checkpoints, stored off the database) is still not built and is a **launch blocker**. Signing waits for KMS (ADR-0002, ADR-0032).
- Alert delivery (Alertmanager or an on-call vendor) does not exist in the repo; until it does, the rules are tested but page no one (launch blocker).
- Retention: run rows (no user ids) 7 years as financial evidence (VR-01). Drift samples hold user ids tied to a balance anomaly (P2); **safe default 25 months**, purged by the retention job; keeping them 7 years is the owner's and counsel's decision (VR-DASH-08). After purge a run shows `sample_available: false`; the report hash stays in the audit row.

## Owner decision required
Owner, Finance, counsel and DPO: retention of drift-sample user ids (VR-DASH-08). Safe default: 25 months.
