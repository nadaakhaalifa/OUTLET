# Security and privacy review log, 2026-10-16

These are **AI-assisted code reviews** (chief-reviewer and architect agents reading the repository), not a penetration test and not a certification. They found design and code defects early; they cannot replace adversarial testing against a running system. **An external penetration test is still required before launch** (master prompt T5, `docs/plan/release-checklist.md`). Nothing here runs against real money, real personal data or real providers (ADR-0029).

The findings originally lived only in an agent conversation. This file is the durable record.

## How to read the status column

- **Fixed in code**: the fix is present in the working tree (uncommitted at time of writing, see `git status`) and the evidence column points at the code or the test that pins it. Statuses were checked by reading the code on 2026-10-16, not by re-running the suites.
- **Open**: not fixed; remains by design or pending a dependency.
- **Owner decision**: blocked on an ADR or counsel decision (`docs/adr/README.md`, "Owner decisions required").
- **unverified**: no evidence for or against was found by grep; treat as still open until someone confirms.

Severity labels are those given by the reviewer. Evidence paths are relative to the repository root.

## Review 1: ledger integrity runs (migration 0089)

| Finding | Severity | Status | Evidence |
|---|---|---|---|
| Snapshot transaction was not READ ONLY | Medium | Fixed in code | `apps/api/src/modules/ledger/adapters/kysely-store.ts:329` (`set transaction read only`); test `kysely-integrity.pglite.test.ts:302` |
| Run idempotency: `attempt_id` not unique, a retry after an ambiguous commit could write a second final row and audit row | Medium | Fixed in code | `packages/db/migrations/0093_ledger_audit_hardening.sql:87` (`lir_attempt_final_uq`) |
| Drift samples held the raw `user_id` (P2) | High | Fixed in code | `0093_ledger_audit_hardening.sql:99` drops `user_id`, adds `account_id` (ledger account) |
| Erased-keys lookup role | Medium | Fixed in code (tested at the table) | `apps/api/src/modules/seller-analytics/test/rollups-migration.test.ts:201` ("analytics_erased_keys is system only"). The original review item is terse; confirm it meant this table |
| `lir_completed_chk` did not require `finished_at` | Low | Fixed in code | `0093_ledger_audit_hardening.sql:90-96` |

## Review 2: audit chain (T7, migrations 0005 and 0007)

| Finding | Severity | Status | Evidence |
|---|---|---|---|
| Tail truncation undetectable: `audit_chain_checkpoint()` never called, no signatures, no WORM export, `verify` returns ok with 0 checkpoints | High | **Open** (partly mitigated) | The function and table exist (`0005_audit_log.sql:101-116`) and `audit_log_verify` now compares against checkpoints (`0093:67-79`), and the verify endpoint reports `checkpoints_checked` (`admin-attention/adapters/admin-attention.controller.ts:124`). But nothing outside a test calls `audit_chain_checkpoint` (only `admin-attention/test/kysely-reader.pglite.test.ts:27`); no signing, no WORM job, no `anchored` flag anywhere in the code. Needs KMS and ADR-0002 |
| `audit_log` INSERT RLS let any role append to any chain | High | Fixed in code | `0093:27-29` (`WITH CHECK (app_role() = 'system')`) |
| `audit_log_verify(NULL)` callable by any app user | Medium | Fixed in code | `0093:37-42` (system only; named chain limited to dpo, security, super_admin, system) |
| PII redaction was only a comment | High | Fixed in code | `packages/privacy/src/audit-redaction.ts` (Zod gate, key tokens and value scans); used by `admin/adapters/kysely-store.ts`, `ledger/adapters/kysely-integrity.ts`, `production/platform-adapters.ts` |
| Single-chain lock contention | Low | unverified | Chains are per month (`admin:YYYY-MM`, `ledger-integrity:YYYY-MM`) with a per-chain advisory lock (`0005_audit_log.sql:64`); no evidence this was re-assessed under load |
| Meta-audit chain name drift | Low | unverified | The meta-audit port is injected (`admin-attention/admin-attention.module.ts:22`); no test found pinning the chain name across modules |

## Review 3: admin identity design (ADR-0045, ADR-0048, ADR-0049)

| Finding | Severity | Status | Evidence |
|---|---|---|---|
| Column margins public, so complementary suppression was computed against the wrong family | High | Owner decision | Fix designed as ADR-0052 (**Proposed**, needs DPO: VR-DASH-02, VR-DASH-05). Pure core built: `seller-analytics/domain/external-margins.ts`, `domain/kanon-table.ts`; not exposed by a service while the release flag stays blocked |
| Memo monotone only for hidden cells; released cells can change on erasure or late facts | High | Owner decision | ADR-0052 decision 3 (pinned release ledger). Ledger states `pinned`/`memo` exist in `kanon-table.ts:83-97`; distinct-visitor pinning touches VR-DASH-06 |
| Admin-web nav failed open on not_admin and 5xx | High | Fixed in code | `apps/admin-web/src/view-models/nav.ts:47` (fail closed); test `view-models/vm.test.ts:257` |
| Elevation vs standing inconsistency for money capabilities | Medium | unverified | `admin/domain/access.ts` computes standing and elevation separately; no test found that pins the money-capability case |
| DST 29 Oct fold | Medium | Fixed in code | `platform-metrics/test/series.test.ts:11-33` (25-hour day, fold 0/1 offsets 180/120) |
| Per-store concurrency cap | Low | unverified | Rollups serialise per key via advisory lock (`seller-analytics/adapters/kysely-rollups.ts:53`); no per-store cap found |

## Review 4: admin and /me code

| Finding | Severity | Status | Evidence |
|---|---|---|---|
| devTrust and ingress refusals keyed on `env === 'production'` | High | Fixed in code | `admin/admin.module.ts:82,95,100-103`: keyed on `adapters !== "in-memory-dev"` (real adapters) rather than NODE_ENV |
| No minimum edge key length | Medium | Fixed in code | `admin/adapters/edge-posture.ts:30` (`MIN_EDGE_KEY_BYTES = 32`), enforced `admin.module.ts:96-98` |
| Assurance vs `amr` source mismatch | Medium | Fixed in code | `admin/adapters/admin-me.controller.ts:121-125` (`assurance_mismatch` 403) |
| Replay TTL equals 2x skew | Low | Fixed in code | `edge-posture.ts:31-32` (skew 60 s, TTL 180 s) |
| 503 `elevations_unavailable` before the standing-role check | Medium | Fixed in code | `admin-me.controller.ts:89-98` (elevation store only read when a standing grant exists); test `admin/admin-me.http.test.ts:149` |
| No timeout on binding port; comma in `x-admin-install` | Low | Fixed in code | `admin-me.controller.ts:52-56,135-143` (`withTimeout`, comma rejected) |
| Request-id binding relies on the edge overwriting the request id | Medium | Open | The HMAC covers `request_id` (`edge-posture.ts:41`) and the API compares it to `req.ctx.requestId`, but that the edge overwrites an inbound request id is an infra assumption with no test in this repo |

## Review 5: envelope cipher (sizing, P3)

| Finding | Severity | Status | Evidence |
|---|---|---|---|
| AAD omitted the owner | High | Fixed in code | `sizing/application/codec.ts:41` (AAD built from userId, profileId, field); test `sizing/envelope-cipher.test.ts:149` |
| Header bounds checks | Medium | Fixed in code | `sizing/adapters/envelope-cipher.ts:58-70`; tests `envelope-cipher.test.ts:76,88` |
| No format version byte | Low | Fixed in code | `envelope-cipher.ts:19-21,44-45` (magic `0xe1`, format `0x01`); test `:71` |
| `LocalTestKms` in a production module | Medium | Fixed in code | Now `sizing/test/local-test-kms.ts`; no import from non-test code |
| Unwrapped DEK source not zeroed | Medium | Fixed in code | `envelope-cipher.ts:89-90` (`dek.fill(0)`, `unwrapped.fill(0)`) |
| Missing tests | Medium | Fixed in code | `sizing/envelope-cipher.test.ts` (tamper, rotation, truncation, unknown key, GCM failure, property test) |

## Review 6: milestone review (0093, redaction, creators A-1/A-3/A-9, orders close, kanon core)

| Finding | Severity | Status | Evidence |
|---|---|---|---|
| H1: redaction value gate bypasses (numbers, local phone, tokens) | High | Fixed in code | `packages/privacy/src/audit-redaction.ts:36-52` (`token` key token, `EG_LOCAL_PHONE`, `numberLooksPersonal`) |
| H2: creators attribution void not itself audited | High | Fixed in code | `creators/adapters/access.ts:62-65` (one audit row, 503 if the sink fails); test `creators/test/creators.http.test.ts:402-411` |
| H3: kanon "whole column" assumed the full row domain | High | Fixed in code | `seller-analytics/domain/kanon-table.ts:70-78` (`RowDomainViolation`); test `kanon-table.test.ts:230-251` |
| Medium: admin-attention test role | Medium | Fixed in code | `admin-attention/test/kysely-reader.pglite.test.ts:51` sets `app.role = system` |
| Medium: drift resolver filters | Medium | unverified | No resolver code found in `admin-attention`; the item may refer to the ledger drift reader (`ledger/adapters/kysely-integrity.ts`) |
| Medium: `balance_negative` re-emit | Medium | unverified | Event exists (`creators/application/commissions.ts`); no test found asserting no re-emit |
| Medium: deferred accrual DLQ alert | Medium | Fixed in code (partly) | Metric block `platform/telemetry/metrics.ts:48-50`, DLQ handling `production/relay.ts:217`, runbook `docs/runbooks/creators-accrual-dlq.md`. Alert rule itself not confirmed |
| Medium: `lineReturns` must be mandatory | Medium | Fixed in code | `production/bindings.ts:133-147` throws `MissingLineReturnsError` when creators is composed without it |
| Medium: partial-month windows silently expanded | Medium | Fixed in code | `seller-analytics/domain/gated-window.ts:43` returns `window_not_on_grid`; test `kanon-table.test.ts:299` |

## Items that remain open by design

| Item | Why open | Status | Evidence / where tracked |
|---|---|---|---|
| Audit checkpoint and WORM job, `anchored` flag | Needs KMS signing and the residency decision (ADR-0002) | Open | See Review 2 row 1; no caller of `audit_chain_checkpoint` in app code |
| ADR-0052 (external margins, pinned releases) | Proposed, pending DPO acceptance (VR-DASH-02, VR-DASH-05, VR-DASH-06) | Owner decision | `docs/adr/0052-gated-breakdowns-external-margins-and-pinned-releases.md` |
| Exporter-manifest exemption for `ledger_integrity_drift_samples` | Reason string rests on "pseudonymous account id"; counsel must confirm the DSAR exemption | Owner decision | `privacy/application/exporter-manifest.ts:52` |
| Production Redis replay adapter TTL | No production replay store exists yet (only `UnconfiguredEdgeReplayStore` and `InMemoryEdgeReplayStore`). The port takes `ttlSeconds` from the caller (`EDGE_POSTURE_REPLAY_TTL_S = 180`), so a future adapter must not hard-code 120 s. Grep found no 120 s literal | Open | `admin/adapters/edge-posture.ts:6-12,32,87` |
| Seller return window | Needs legal check against CPL 181/2018 | Owner decision | `docs/compliance/verify-register.md` (VERIFY rows) |
| Payouts depend on returns data in production | Returns repository must be composed in production before payouts can read it | Open | `production/ports.ts:136`, `production/bindings.ts` |
| Per-store shopper-series flags | Blocked behind ADR-0052 and the blocked release flag | Open | `production/bindings.ts:53` (dark behind `release.admin.*` flags, default blocked) |

## Next steps

1. Commission the external penetration test (T5) and give testers this log as scope input.
2. Confirm or close each **unverified** row with a test or a code change.
3. Decide ADR-0052 and the residency ADR so the audit anchoring job can be built.
