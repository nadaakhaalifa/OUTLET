# Privacy Center: export, deletion, consents, DSAR queue, breach register

Spec refs: master prompt section 2 (account deletion, data export, Privacy Center), B1 (PDPL), A2 items 5, 6, 7, 9.
Code: `apps/api/src/modules/privacy`, `packages/domain/src/privacy`, migration `0025_privacy_requests.sql`.
Status: Phase 1 engineering on synthetic data. Legal values are VERIFY BEFORE LAUNCH (see Open items).

## Flow

1. Shopper opens Me, Privacy Center.
2. **Consents**: nine toggles, all off until the user acts. `PATCH /v1/me/privacy/consents` appends records; a withdrawal is one request with `granted:false` (no extra confirmation step).
3. **Export**: `POST /v1/me/privacy/export` creates an async job. A worker collects the user's P2/P3 data through the exporter registry, writes a ZIP (`README.ar.txt`, `README.en.txt`, `manifest.json`, `data/<table>.json`) to the object store and marks it ready. `GET /v1/me/privacy/export/{exportId}` returns status and, once ready, a freshly signed URL valid 24 hours.
4. **Deletion**: `POST /v1/me/privacy/delete`. Blockers are checked first; if clear, a 14 day cooling period starts. `DELETE /v1/me/privacy/delete` cancels while cooling. After cooling a worker re-checks blockers, applies the erasure plan and completes.
5. **DPO console**: `GET /v1/admin/privacy/requests` (DSAR queue) and the breach register under `/v1/admin/privacy/breaches`.

## Rules

- Nine consent purposes only, from `@outlet/privacy` `CONSENT_PURPOSES` (ADR-0018). A tenth is a 400. Records are append-only (database trigger). A grant must carry the current text version; a withdrawal is always accepted.
- One open export and one open deletion per user. A repeat POST returns the open request (200 instead of 202). Enforced by partial unique indexes as well as in code.
- Export target: ready within 72 h of the request (`ready_target_at`). Signed URL TTL 24 h, artifact retention 7 days (inventory `dsar_export_artifact`), then the sweeper deletes the object and the request becomes `expired`.
- Export retries: up to 3 collection attempts; the third failure is terminal `failed` and emits `privacy.export_failed` (terminal=true).
- Deletion blockers: open orders, open returns, open disputes. The 409 says which and how many, in Arabic and English. Store credit above zero needs `acknowledge_credit_forfeiture:true`, else 409 `forfeiture_acknowledgement_required`.
- Cooling is exactly 14 days (config `coolingDays`). Cancel is allowed only while `now < cooling_ends_at`, or while `on_hold`.
- If a blocker appears during cooling (an order is placed), the worker parks the request `on_hold` and emits `privacy.deletion_on_hold`; it resumes automatically when clear, or the user cancels.
- Erasure plan is a pure function of the resolved inventory (`planErasure`): per field `delete` to erase, `pseudonymize` to pseudonymise, `retain_legal` to retain by law, `not_personal` ignored. Table action is the strongest of its fields (retain_by_law, then pseudonymise, then erase). The worker refuses to run on an empty inventory (fail closed).
- Pseudonym: `del_` plus a keyed HMAC of the user id; the key lives outside the retained dataset (`pseudonymKey`).
- Breach clocks, from an injected clock only: triage 4 h from detection, PDPC notice 72 h from detection, subject notice 3 days from the PDPC notice (or from the PDPC deadline while it is outstanding). VERIFY the reading of "then within 3 days".
- DSAR SLA default 30 days from request (VERIFY statutory deadline). A request is overdue when past that, or when an export misses its 72 h target.

## State machines (`packages/domain/src/privacy`)

Export: `requested -start-> collecting -complete-> ready -expire-> expired`; `collecting -retry-> requested` (attempts left), `collecting -abandon-> failed` (exhausted).

Deletion: `cooling -cancel-> cancelled` (cooling running), `cooling -hold-> on_hold`, `cooling|on_hold -begin_erasure-> erasing` (cooling ended), `on_hold -cancel-> cancelled`, `erasing -complete-> completed`.

Breach: `detected -triage-> triaged -notify_pdpc-> pdpc_notified -notify_subjects-> subjects_notified -close-> closed`; `triaged -close-> closed` only when the DPO decided `no_notification_required`; `notify_pdpc` only when decided `notify`.

All three have table tests plus property tests (random event sequences never leave the state space, never leave a terminal state, never skip the DPO decision).

## Edge cases

- Export id of another user, or unknown: 404, identical body (policy rule `dsar_export` owner scope).
- Two workers race on one export: compare-and-set on `version`; exactly one proceeds.
- Crash after `begin_erasure`: request stays `erasing`; `runDue` resumes it and re-runs the executor, which must be idempotent.
- Artifact past 7 days but sweeper not yet run: no URL is issued.
- Object deleted but state update lost a race: next sweep deletes again (idempotent) and expires.
- Export content never includes other users' rows (exporters are keyed by user id; registry rejects undeclared tables).
- Money in exports is serialised as strings (bigint safe).

## Data

`dsar_requests(id, user_id, kind, status, locale, requested_at, due_at, ready_target_at, cooling_ends_at, forfeited_credit_amount, blockers, attempts, failure_code, completed_at, cancelled_at, export_object_ref, artifact_expires_at, version, updated_at)`. PII: user_id P2, forfeited_credit_amount P2, rest P1. RLS: owner or `dpo`/`system` read, owner or `system` write.

`breach_register(id, detected_at, severity, summary, affected_count, status, triaged_at, dpo_decision, pdpc_notified_at, subjects_notified_at, closed_at, version, created_at, updated_at)`. P1, summary must not contain personal data. RLS: `dpo`/`system` only.

`consent_records` is the existing 0006 table (unchanged). All columns are tagged in `docs/privacy/data_inventory.yaml`.

## API

| Method and path | Auth | Idempotent | Rate limit |
|---|---|---|---|
| `POST /v1/me/privacy/export` | self | key optional, plus one open request per user | 5 / hour / user |
| `GET /v1/me/privacy/export/{exportId}` | `dsar_export` read, owner | no | 60 / min |
| `POST /v1/me/privacy/delete` | self | key optional, plus one open request per user | 5 / hour |
| `GET /v1/me/privacy/delete` | self | no | 60 / min |
| `DELETE /v1/me/privacy/delete` | self | naturally (second call 404) | 10 / hour |
| `GET, PATCH /v1/me/privacy/consents` | self | key optional | 120 and 60 / min |
| `GET /v1/admin/privacy/requests` | admin audience, role `dpo`, passkey | no | 60 / min |
| `GET, POST /v1/admin/privacy/breaches` | same | no | 60 and 20 / min |
| `POST /v1/admin/privacy/breaches/{id}/triage, /pdpc-notified, /subjects-notified, /close` | same | no | 20 / min |

Wire names follow `docs/api/openapi.yaml` (`PrivacyExport`, `PrivacyDeletion`, `PrivacyRequestAdmin`). Additions that the OpenAPI file needs: export `locale` and `ready_target_at`; deletion statuses `on_hold` and `erasing`, blocker `count` and `message`, `GET /v1/me/privacy/delete`; the breach routes; admin list `next_cursor` is always null and a `summary` object is added. `POST /v1/admin/privacy/requests/{requestId}/decision` is NOT implemented (no decision semantics are defined yet).

## Events (outbox, same transaction as the state change)

`consent.changed`, `privacy.export_requested`, `privacy.export_ready`, `privacy.export_failed`, `privacy.deletion_requested`, `privacy.deletion_cancelled`, `privacy.deletion_on_hold`, `privacy.deletion_completed`, `privacy.breach_recorded`, `privacy.breach_<status>`. Payloads carry ids and codes only. Consumers (notifications, auth session revocation, ledger forfeiture) are other modules.

## Failure handling

- Exporter throws: attempt counted, request returns to `requested`, event emitted; third failure terminal.
- Object store down on `put`: same path as exporter failure.
- Erasure executor throws: request stays `erasing`, exception surfaces to the scheduler for retry with backoff.
- Outbox event cannot be written: the state change rolls back (tested on PGlite).

## Security and abuse

- BOLA: export reads go through the policy guard with an owner-scoped resolver. Deletion routes take no object id and use the token subject.
- BFLA: DPO routes require admin audience (buyer tokens are 401), an admin `dpo` grant that is live, and a passkey session; otherwise 403. Every allow and deny is written to the audit sink (`privacy.dpo_console`).
- DPO list shows a pseudonymous `subject_ref`, never the raw user id.
- Export ZIP is built from allow-listed tables only; unknown tables from an exporter are rejected.
- Signed URLs are never stored and never logged; responses are `Cache-Control: private, no-store`.
- API3: strict Zod bodies (unknown fields rejected). API4: per-user rate limits above.

## Metrics

Export ready p95 under 72 h (guardrail: overdue count), deletion completion rate, requests overdue (alert at 1), breach clocks overdue (page), consent withdrawals per day, export failures per day.

## Acceptance

- A shopper with an open order gets 409 `deletion_blocked` naming `open_orders` and the count.
- A deletion requested at T cannot be erased before T plus 14 days and can be cancelled until then.
- Another user's export id returns 404; a shopper token on a DPO route is rejected; an ops admin gets 403.
- Every inventory table tagged for export has an exporter or a reasoned exemption (test `exporter-coverage.test.ts`; it fails when the inventory grows).
- Breach with detection at T: PDPC deadline T+72 h, `overdue` one millisecond later.

## Decisions (ADR candidates)

1. Single `dsar_requests` table for both kinds, matching the existing inventory entry, instead of two tables.
2. One open request per kind per user, including a `ready` export: avoids repeated heavy exports and gives idempotent POST. Cost: a user waits for the 7 day artifact expiry to request a fresh snapshot. Alternative (allow a new export once ready) is a one-line index change.
3. Stored ZIP, no compression: exports are JSON and text, a ZIP dependency is not worth it; no ZIP64, so over 4 GiB is refused, never truncated.
4. DPO routes check the role in the controller because the policy rule set has no DSAR-queue resource. A rule `dsar_queue` (read, create, update) for `dpo` is the proper fix.
5. Exporters are declared in a manifest owned here, implemented by each module behind `ExporterPort`. Ownership is by inventory primary purpose and is a starting assignment.

## Open items

- VERIFY: statutory DSAR deadline, breach subject-notice clock reading, exemption of fraud signals, logs and pseudonymous analytics from access requests (listed in `exporter-manifest.ts`).
- Deletion blockers expose counts, not per-object reference ids (OpenAPI `blockers[].reference_id`); needs a richer `BlockersPort` from orders, returns and disputes.
- Real adapters not built: object store (S3 compatible), exporters per module, erasure executor, blockers port. All are fakes behind ports.
- Persistence wiring: Kysely adapters exist and pass the shared contract on PGlite, but `PrivacyModule.forRoot(config, options)` is only given in-memory defaults by `AppModule` (see integration needs).
- Consent method mapping to the 0006 `method` column is lossy for `web_banner` and `support_agent_on_request` (both stored as `api`).
- Workers (`ProcessExport.runDue`, `ExpireExports.run`, `ProcessDeletions.runDue`) have no scheduler yet.
