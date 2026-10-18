# Runbook: kill-switch operations

Owner: On-call engineering (Platform). Roles: incident commander, admin with the flags-write role (`ROUTE_ROLES.flagsWrite` in `apps/api/src/modules/admin/adapters/admin.controller.ts`; VERIFY the exact role list before use), second reviewer for money switches. Severity: the switch itself is a mitigation; open or keep the incident at the severity of the underlying problem (incident-response.md).

## Trigger
Any incident where disabling a capability limits harm: PSP faults, fraud wave, runaway LLM cost, crawler abuse, ledger or payout fault, legal VERIFY item answered "no".

## What exists (from code)
- Registry: `packages/feature-flags/src/registry.ts`, `KILL_SWITCHES`. Keys: `kill.payment.card`, `kill.payment.apple_pay`, `kill.payment.mobile_wallet`, `kill.payment.instapay`, `kill.payment.fawry`, `kill.payment.cod`, `kill.payment.bnpl`, `kill.drops`, `kill.games`, `kill.stylist_llm`, `kill.ml_ranking`, `kill.crawlers`, `kill.referral_payouts`, `kill.gift_card_sales`. Phase 3 addition: `kill.odoo_channel` (Odoo seller channel polling and connection tests; allowed-when-true, default blocked; it no longer reuses `kill.crawlers`).
- Semantics: every flag is default-off, fail-closed and typed; unknown keys and non-boolean values evaluate to not enabled (`packages/feature-flags/src/flags.test.ts`). `true` means the capability is KILLED.
- Admin API: `GET /v1/admin/kill-switches`, `GET /v1/admin/flags`, `GET /v1/admin/flags/{key}`, `PUT /v1/admin/flags/{key}` with body `{ enabled, reason_code }`; idempotent, rate limited, audited (`feature_flag.update`).
- The Phase 2 specs also name switches such as `gift_card_redemption`, `plus_sales`, `hub_consolidation`, `stylist_ml`. VERIFY whether they are in the registry: only the keys above are confirmed in `registry.ts`.
- Flag provider is OpenFeature. A self-hosted production provider is not confirmed: VERIFY. In-memory provider exists for tests only.

## Steps: engage
1. Choose the narrowest key. Payment method fault: the single `kill.payment.*` key, not all. Keep COD unless COD is the problem.
2. Money-moving switches (`kill.payment.*`, `kill.referral_payouts`, `kill.gift_card_sales`): second person confirms in the incident channel before the call.
3. `PUT /v1/admin/flags/kill.payment.fawry` with `{"enabled": true, "reason_code": "<code>"}` and a fresh `Idempotency-Key`.
4. Check the response `previous_enabled` and `GET /v1/admin/kill-switches`.

## Verification
- Capability refuses: checkout hides the method with the honest unavailable message (no fake timers), or the endpoint returns the documented disabled error. Test with a synthetic shopper in staging first when time allows.
- Propagation time: not measured; VERIFY provider cache TTL and the mobile client behaviour.
- Audit entry exists with actor and reason code.
- Dashboard: traffic to that method drops to 0; error budget stops burning.

## Rollback (disengage)
1. Cause fixed and verified; for payment methods follow psp-outage.md section 5 (half-open traffic, 30 min within budget).
2. `PUT` with `{"enabled": false, ...}`. Re-check that in-flight orders reconcile (reconciliation-break.md).

## Escalation
On-call -> incident commander -> owner for switches that stop revenue for more than 1 h or any switch touching legal text. Admin cannot reach the API: edit through the provider's control plane (not implemented; VERIFY break-glass path).

## Post-mortem checklist
- Time from decision to effective block; was the narrowest switch used.
- Was the switch present and tested (spec A2.12 requires one per capability).
- Any gap: missing key, slow propagation, no alert on flag change. File follow-ups.
- Game-day entry updated (degraded-mode-matrix.md).
