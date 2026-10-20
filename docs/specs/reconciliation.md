# Reconciliation (spec T4, 7, 21, B4, 15.2)

Status: Phase 1, synthetic data only, fixture file format, nothing deployed · Module: `apps/api/src/modules/reconciliation` · Pure rules: `packages/domain/src/reconciliation` · Migration: `0035_payouts_reconciliation.sql` · Builds on ADR-0021 point 8 · Privacy: `docs/privacy/data_inventory.yaml` (`settlement_files`, `settlement_file_lines`, `recon_runs`, `recon_tickets`)

## Hard limits
* **Provider file formats are not known.** Paymob, courier and BNPL settlement files are NOT contracted. A single fixture format (CSV, integer piastres, trailing TOTAL row) sits behind `SettlementFilePort`. Real parsers are new adapters, the matchers do not change. Every field assumption is VERIFY (VR-RC-01).
* **No live network calls.** Files arrive by `IngestSettlementFile` (SFTP or manual upload is the adapter's concern).
* **Read-only on money.** Reconciliation never posts. Findings become tickets and alerts. Corrections are human decisions followed by reversing entries elsewhere.

## Flow
1. **Ingest.** A file is hashed (SHA-256). A known hash returns `duplicate`. The pure parser checks per-line arithmetic (`gross - fee = net`), line numbers, currency and the TOTAL row. A file with errors is stored as `rejected` with its error codes and never matched.
2. **Run.** `RunReconciliation` (mode `nightly` or `intraday`) builds findings from six suites and upserts tickets:
   * PSP settlement lines vs `psp_clearing` movements (match on provider reference, gross signed) plus posted `psp_settled` gross and fee vs the file.
   * Courier COD remittance lines vs `cod_clearing` movements.
   * BNPL settlement lines vs `bnpl_clearing` movements.
   * ETA submissions vs ETA reported status.
   * Store-credit projection vs postings (reuses `storeCreditDrift`).
   * Trial balance (all currencies net to zero, reuses `checkTrialBalance`).
3. **Tickets and alerts.** Every finding upserts a ticket by a stable dedupe key. A new ticket raises an alert (outbox event + `ReconAlertPort`). A ticket whose item is older than 3 days (aging basis: the item's own timestamp) becomes `escalated` to Finance, once. A ticket whose finding disappears is `resolved` automatically.
4. **Schedule.** `ScheduleReconciliation.tick(now)` decides whether the nightly run (02:00 Cairo, once per Cairo date) or the intraday run (every 2 h, only while `intraday` mode is enabled for mega events) is due. It is a use case; nothing calls it yet (the integrator wires a job).
5. **Read model.** Finance reads runs, tickets (by status, source, severity), the aging summary and the file list.

## Matching algorithm (compared)
* **(a) Greedy by amount and date window**, tolerant of missing references: fewer unmatched lines, but one line can steal another's match and the result depends on arrival order.
* **(b) Exact reference, then exact amount within a reference group (multiset intersection)**: chosen. Deterministic and order-independent because both sides are sorted into a canonical order first; a reference match with a different amount is an `amount_mismatch` for a human, never silently accepted. Extra lines for a reference that already matched are `duplicate_external` / `duplicate_internal` (a possible double posting).
Each line id is consumed at most once. Totals conserve: external total = matched + mismatched + unmatched + duplicate external, same for internal (property tested).

## Rules
| # | Rule |
|---|---|
| C1 | Money is exact bigint piastres. There is no tolerance. |
| C2 | Finding kinds: `unmatched_external`, `unmatched_internal`, `amount_mismatch`, `duplicate_external`, `duplicate_internal`, `file_rejected` (parse errors: line arithmetic, total mismatch and the rest, as codes), `settlement_not_posted`, `settlement_posting_mismatch`, `eta_*`, `store_credit_drift`, `store_credit_negative`, `trial_balance`. |
| C3 | Severity: `trial_balance` critical; mismatches, duplicates, drift, posting mismatches high; other medium. |
| C4 | Escalate when `now - item_at > 3 days` (T4: aging above 3 days goes to Finance). Critical findings escalate immediately. |
| C5 | A file is matched against internal movements in its date range widened by one day on each side. |
| C6 | Intraday runs match only files received in the last 24 h and always run trial balance and store credit. |

## Edge cases
Same file uploaded twice · line present in two files (second is `duplicate_external` against the first match) · refund and capture with the same provider reference (both signed amounts match independently) · empty file · currency other than EGP (rejected) · TOTAL row missing or wrong · negative fee · unknown ETA id · ledger posted but file late (internal unmatched, ages, escalates) · run while a file is being ingested (file visible only when `parsed`) · clock skew at the 3-day boundary (strictly greater).

## Data
`settlement_files(id, kind psp|cod|bnpl, provider, settlement_id, checksum UNIQUE, status parsed|rejected, line_count, gross_total, fee_total, net_total, error_codes, received_at)` · `settlement_file_lines(file_id, line_no, kind capture|refund|chargeback|remittance|adjustment, provider_ref, gross, fee, net, occurred_at)` PK (file_id, line_no) · `recon_runs(id, mode, started_at, finished_at, window_from, window_to, finding_count, ticket_opened, ticket_escalated, ticket_resolved, ok)` · `recon_tickets(id, dedupe_key UNIQUE, source, kind, severity, ref, amount_delta, item_at, status open|escalated|resolved, first_seen_at, last_seen_at, escalated_at, resolved_at, last_run_id)`. No personal data (provider references are P1). Retention `raw_webhooks_financial` for files and lines (7 years, VERIFY), tickets `orders_tax_records`. RLS: `finance`, `ops` (read), `super_admin`, `system`; sellers, shoppers and other staff see nothing.

## API
| Route | Auth | Limit |
|---|---|---|
| `GET /v1/admin/finance/reconciliation/summary` | admin_api, `payout` read (finance, ops), passkey | 60/min |
| `GET /v1/admin/finance/reconciliation/tickets?status&source&severity&cursor&limit` | same | 120/min |
| `GET /v1/admin/finance/reconciliation/tickets/{id}` | same, missing = 404 | 120/min |
| `GET /v1/admin/finance/reconciliation/runs` | same | 60/min |
| `GET /v1/admin/finance/reconciliation/files` | same | 60/min |

All read-only, so no idempotency key. Shoppers and sellers get 401 (wrong audience) or 403.

## Events
`reconciliation.run_completed`, `reconciliation.ticket_opened`, `reconciliation.ticket_escalated`, `reconciliation.ticket_resolved`. Payload: ids, source, kind, severity, amount delta.

## Failure handling
A suite that throws is recorded as `suite_failed` finding (critical) and the other suites still run. Parser failure never throws out of ingest: it returns `invalid` with codes. Alert port failure does not roll back tickets (alerts are re-sent from the open ticket list on the next run).

## Security and abuse
Finance data is staff only (RLS + central policy). Uploaded content is untrusted text: size cap 5 MB, strict parser, no formula evaluation, CSV injection is irrelevant because nothing is re-exported unescaped. Ingest is idempotent by checksum so replay cannot double-open tickets.

## Metrics
Unmatched PSP lines older than 3 days (SLO: 0, T8), open tickets by severity, time to resolve, file parse rejection rate, trial balance ok.

## Acceptance
* Given a PSP file and ledger movements that agree, then no findings and all tickets resolve.
* Given a captured amount that differs by 1 piastre, then one `amount_mismatch` high ticket.
* Given an internal line with no file line for 4 days, then it is `escalated` once.
* Given the same file twice, then one file row and no new tickets.
* Given shuffled input order, then identical findings.
* Given an unbalanced ledger, then a critical `trial_balance` ticket, escalated immediately.

## VERIFY BEFORE LAUNCH (appended to the register)
VR-RC-01 (settlement file formats, units, timezones, per provider), VR-RC-02 (reference key that links a provider line to a ledger movement), VR-RC-03 (COD remittance cycle and cut-off, links VR-11), VR-RC-04 (aging policy and escalation recipients).

## Conservation across files (ADV-W4-4)

The matcher is per settlement file. A provider that re-reports the same reference under a new settlement id would match the same internal clearing line twice. `reconcileAcrossFiles` runs per provider over every parsed file in the window: the same (provider reference, line kind, signed gross) appearing in two files of one provider is a `duplicate_external` finding on each later copy (the file with the lowest settlement id owns the line). A refund or chargeback of a captured reference has another kind and sign, so it never trips this.
