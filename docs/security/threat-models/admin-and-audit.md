# Threat model: admin console and audit log

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §23, §A2.9, §T5, §B1 · Target ASVS level: L3 · Modules: `admin`, RBAC, audit log, feature flags and kill switches, support desk

No admin code exists. `packages/policy/src/index.ts` and `packages/feature-flags/src/index.ts` are empty exports. The append-only, hash-chained `audit_log` and its verification function are written in `packages/db/migrations/0005_audit_log.sql` (not yet executed by any test); its own header notes it is tamper-evident, not tamper-proof, and that tail truncation is only detectable against a checkpoint.

## Scope and assets
Admin identities and roles, privileged actions (payout and refund approvals, plan price changes, role grants, data exports, PII views), `audit_log` (append-only, hash-chained, WORM shipping), feature flags and kill switches, support desk with customer data, DPO console.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| ADM-S1 | S | Admin account takeover | Passkey mandatory, SSO plus device posture, IP allow-list for Finance and Super-admin, short sessions, no shared accounts, break-glass accounts sealed and alerted | ADM-T01 admin route without passkey-level `amr` is 401; ADM-T02 Finance route from a non-allow-listed IP is 403 | planned |
| ADM-T1 | T | Audit log altered or deleted | Append-only table, UPDATE and DELETE revoked, hash chain with periodic head publication, shipping to WORM storage; separate credentials for log shipping | ADM-T03 tamper with a row in a test DB and assert chain verification fails | partial (`audit_log`, triggers and `audit_log_verify()` written in `packages/db/migrations/0005_audit_log.sql`; WORM shipping and head publication planned; untested) |
| ADM-T2 | T | Feature flag or kill switch tampered to enable gift-card sales, COD or drops | Flag changes need role plus dual approval for money flags, logged, with version and rollback; kill switches default off for gift-card sales (open question 3) | ADM-T04 enabling a money kill switch with a single approver fails | planned |
| ADM-R1 | R | Admin denies an action | Every sensitive action records actor, action, target, redacted diff, IP, device, request ID and reason code; PII view logged with reason | ADM-T05 each privileged route writes exactly one audit row with required fields | planned |
| ADM-I1 | I | Mass PII exposure through support tools, exports or search | Just-in-time elevation, per-view reason code, field masking by default, export needs dual approval, rate limits on lookups, anomaly alert on view volume | ADM-T06 bulk lookups beyond a cap trigger an alert; unmasked view needs elevation | planned |
| ADM-I2 | I | Prompt or reply suggestions leak other customers' data in the support desk | AI-suggested replies get only the current ticket context via the gateway scrubber; human sends | ADM-T07 support suggestion request contains no data from other tickets | planned |
| ADM-D1 | D | An admin action floods downstream (bulk refund, mass notification) | Bulk operations require dual approval above thresholds and are queued with caps | ADM-T08 bulk refund above threshold waits for second approval | planned |
| ADM-E1 | E | Role grant abuse, privilege creep, self-approval | Dual approval for role grants; approver must differ from requester; roles reviewed quarterly; JIT elevation expires; policy deny-by-default | ADM-T09 requester approving own request is refused; ADM-T10 shopper token on admin route is 403 | planned |
| ADM-E2 | E | Shopper or seller reaches admin API (BFLA) | Separate route namespace and audience for admin tokens; guard and RLS both enforce | ADM-T11 generated test over all `/v1/admin/*` routes with shopper and seller tokens expects 403 | planned |
| ADM-E3 | E | Insider changes plan prices without notice (consumer-law and trust risk) | Plan price changes versioned, dual approved, members notified at least 30 days ahead | ADM-T12 price change without notification schedule is refused | planned |

## Open items
- Break-glass procedure and sealed credential custody need an owner (founder or CTO) and a runbook.
- Whether the audit hash chain is anchored externally (for example periodic head publication) is an ADR candidate.

## Residual risk
A Super-admin acting with a second colluding approver defeats dual control; detective controls (audit review, anomaly alerts) and role minimization remain necessary.
