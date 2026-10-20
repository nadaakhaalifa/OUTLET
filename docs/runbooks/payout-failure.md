# Runbook: payout failure, wrong payout or payout hold

Owner: Finance engineering. Roles: incident commander, finance lead (approver), second finance approver (dual approval), DBA/on-call. Severity: Sev2 for a failed or stuck batch; Sev1 if money was sent to the wrong party, an amount is wrong, or the ledger is unbalanced (then also ledger-integrity.md).

## Trigger / alert
- A payout stays in a non-terminal state past its cycle (spec T4 state machine: `SCHEDULED -> ON_HOLD -> APPROVED -> SENT -> SETTLED | FAILED`).
- Seller or support reports a missing or wrong payout.
- Reconciliation break touching `seller_payable` (see reconciliation-break.md) or a ledger integrity failure.
- NOT available (2026-10-11): an automatic alert on stuck payouts, and a real bank/PSP payout adapter. The `SENT`/`SETTLED` leg talks to a fake in `apps/api/src/modules/payouts/adapters/fakes.ts`; live disbursement is VERIFY BEFORE LAUNCH (VR-04 PSP payout/split, IBAN name-match provider).

## Known facts from code
- Domain rules: `packages/domain/src/payouts/` (`lifecycle.ts`, `eligibility.ts`, `approval.ts`, `iban.ts`, `cycle.ts`). Eligibility: line `CLOSED` and no open dispute (an open dispute returns 409 `open_dispute`).
- Admin endpoints (`apps/api/src/modules/payouts/adapters/payouts.controller.ts`), all require `Idempotency-Key`:
  - `GET /v1/admin/finance/payouts` and `GET /v1/admin/finance/payouts/{id}`
  - `POST /v1/admin/finance/payouts/{id}/approve` (finance role; above threshold a different approver is required, else 403 `dual_approval_required`)
  - `POST /v1/admin/finance/payouts/{id}/hold`
  - `POST /v1/admin/finance/payouts/{id}/cancel`
- Seller read side: `GET /v1/seller/payouts`, `/v1/seller/payouts/{id}`, `/v1/seller/stores/{id}/statements`.
- No admin route exists to mark `SENT`, `SETTLED`, `FAILED` or to retry a send: not implemented. Those transitions are driven by the (not yet live) adapter.

## Response
1. Declare severity. If money may have gone to the wrong IBAN or amount: Sev1, stop all approvals first (step 2).
2. Contain: `POST /v1/admin/finance/payouts/{id}/hold` on every payout in the affected batch that is not yet `SENT`. Consider turning off referral payouts via `kill.referral_payouts` (see kill-switch-operations.md) if the fault is in referral rewards.
3. Diagnose with `GET .../payouts/{id}`: status, amount, IBAN last 4 and name-match result, eligibility facts, approval record.
4. Compare to the ledger: seller payable balance versus the sum of eligible `CLOSED` lines minus returns netted (spec section 22 payout interplay). A negative seller balance is netted from the next payout, never paid.
5. Run the ledger integrity job (ledger-integrity.md). Do not approve anything while it fails.
6. Fix the cause (wrong IBAN: seller re-verifies; wrong amount: cancel and re-schedule via the next cycle; open dispute: wait for resolution). Cancel with `POST .../cancel`; never edit rows in SQL.
7. Sent-in-error money: no clawback procedure exists in code. Finance lead contacts the bank/PSP out of band. VERIFY recall process and time limits with the bank contract.

## Verification
- Payout status is terminal and matches the bank/PSP statement (manual until adapter exists).
- Trial balance is 0 and `seller_payable:{store}` equals the seller statement from `GET /v1/seller/stores/{id}/statements`.
- Audit log contains the hold/approve/cancel actions with actor and reason.

## Rollback
Release a hold by `POST .../approve` (second approver where required). Nothing else is reversible; a sent payout is corrected by a reversing ledger entry plus a negative balance, not by deleting.

## Escalation
Finance lead -> head of engineering -> owner for any wrong-party transfer. If personal data was exposed (IBAN, names) follow breach.md and its 72 h clock.

## Post-mortem checklist
- Timeline, payouts and amounts affected, sellers notified (Arabic/English notice).
- Why dual approval or IBAN name-match did not catch it.
- Add a regression test in `apps/api/src/modules/payouts/test/scenarios.ts` or the domain property tests.
- Add the missing alert (stuck payout age) if still absent.
- Update the verify register rows touched.
