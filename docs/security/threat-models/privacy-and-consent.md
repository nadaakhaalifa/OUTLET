# Threat model: privacy, consent, DSAR and data lifecycle

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE with LINDDUN prompts · Spec refs: §B1, §2, §T5, §T6, ADR-0002 (Proposed, not accepted) · Modules: `privacy`, consent, retention, DSAR, analytics ingest

Per ADR-0002 and ADR-0006, no real personal data may be processed anywhere until residency and licensing are decided (open questions 1, 2, 8). `packages/privacy/src/index.ts` is an empty export. Present in the repo: `docs/privacy/data_inventory.yaml` with `tooling/privacy/inventory-schema.mjs`, `consent_records` and `consent_text_versions` tables in `packages/db/migrations/0006_identity_consent.sql` (append-only intent, RLS in `0007_rls_and_grants.sql`), and the analytics PII guard in `packages/analytics/src/pii.ts`. None is exercised by a test in this repository yet.

## Scope and assets
`consent_records`, `age_attestations`, `data_inventory.yaml` (RoPA source), export ZIPs, deletion jobs, pseudonymous analytics IDs, breach register, transfer register.

## Threats and controls
| ID | STRIDE / LINDDUN | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| PRIV-S1 | S | Someone requests export or deletion for another person's account | Export and delete require a fresh authenticated session with step-up; export link signed, 24 h, single-use, bound to the user | PRIV-T01 stale session or foreign user cannot start or download an export | planned |
| PRIV-T1 | T | Consent state edited or back-filled to justify processing | `consent_records` append-only with version, method, timestamp, IP hash; withdrawal creates a new row; SDK init reads the latest row | PRIV-T02 UPDATE and DELETE on consent rows denied; withdrawal reflected in SDK gate | planned |
| PRIV-T2 | T | A new column ships without a PII class, breaking RoPA completeness | `data_inventory.yaml` schema check in CI fails on untagged columns | PRIV-T03 CI fixture with an untagged column fails the check | planned |
| PRIV-R1 | R | Cannot prove consent or deletion happened | Consent and deletion events in the audit log; deletion produces a completion certificate record | PRIV-T04 deletion job writes `privacy.deletion_completed` with counts per store | planned |
| PRIV-I1 | I | P2/P3 reaches analytics, Sentry, push provider or an LLM without consent | SDKs initialise only after matching consent; PII scrubber and field allow-list at the gateway and at the logger; mobile does not initialise PostHog or Sentry in the foundation milestone (ADR-0006 decision 5) | PRIV-T05 with consent off, no network call to analytics hosts; PRIV-T06 payload allow-list rejects unknown fields | planned |
| PRIV-I2 | I | Export ZIP or backups contain other people's data | Export built from fields tagged for that `user_id` only; third-party data (for example other users in referrals) pseudonymized | PRIV-T07 export for user A contains no identifiers of user B | planned |
| PRIV-I3 | I | Seller retains buyer PII after the access window | Seller access to buyer PII lost 30 days after delivery or return closure; phone masked through relay number where the courier supports it | PRIV-T08 seller read of buyer address after window is 404 | planned |
| PRIV-I4 | I | Residual personal data after deletion (search index, warehouse, caches, backups) | Deletion fans out through outbox to every store holding the user; retention purge jobs with metrics; backups age out per retention policy (documented, not instant) | PRIV-T09 deletion fan-out test over each registered data store | planned |
| PRIV-D1 | D | DSAR flood used to overwhelm the team | Per-user rate limit and one active export; async queue with cap | PRIV-T10 second concurrent export request returns the existing job | planned |
| PRIV-E1 | E | DPO console or privacy admin role used for casual browsing | Every PII view carries a reason code and is logged; JIT elevation; dual approval for data exports | PRIV-T11 PII view without reason code is refused | planned |
| PRIV-N1 | LINDDUN: linkability | Pseudonymous analytics ID linked back to identity | Analytics ID rotated yearly, salt kept in KMS and not in the warehouse, no join keys to user tables in the warehouse | PRIV-T12 warehouse schema check has no raw user ID columns | planned |
| PRIV-N2 | LINDDUN: non-compliance | Cross-border transfer without licence | Region as configuration, data classification drives placement, `cross_border_ml` consent plus licence flag required in the gateway; staging and dev synthetic only | PRIV-T13 gateway refuses P2/P3 when licence flag off | planned |

## VERIFY BEFORE LAUNCH
PDPC licence category and fees, DPO qualification, DSAR statutory deadline (30 days is a placeholder), retention periods for tax records, breach notification clock mechanics, and the transfer licence lead time. None are asserted here as legal fact.

## Residual risk
Retention in immutable stores (audit log, ledger, raw webhooks) conflicts with erasure; the design pseudonymizes rather than deletes. Counsel must confirm that approach.
