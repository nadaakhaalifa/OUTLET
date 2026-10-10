# Runbook: reconciliation break

Trigger: `SLOZeroBreachReconciliationUnmatchedAfter5m` (ticket) or `...After24h` (page), or the nightly job reports a mismatch. SLO: unmatched PSP lines older than 3 days must be zero (spec T8). Ledger rules: docs/specs/money-and-ledger.md. Ledger is the system of record (spec T4).

## Principles

- Never edit or delete ledger entries. Corrections are new balanced entries (reversal plus repost) with a reason and the approver.
- Money is integer minor units. Do not "round to match".
- Two people for any manual adjustment above the owner-set threshold (VERIFY: threshold undecided).

## Triage

1. Open the reconciliation dashboard; identify the PSP, date range, count and amount of unmatched lines, and the age buckets.
2. Classify each line:
   - **Missing in ledger:** PSP shows a settlement we never recorded (lost or failed webhook, handler bug).
   - **Missing at PSP:** ledger shows capture the PSP does not (webhook sent before capture, duplicate, test event).
   - **Amount mismatch:** fees, partial capture, currency or rounding.
   - **Timing:** settlement date straddles cut-off; not a break if matched within the cut-off tolerance.
   - **Duplicate:** idempotency failure; the highest-severity class, because it can mean a double charge.
3. Check recent releases, webhook delivery logs and the outbox for the same window.

## Actions by class

| Class | Action |
|---|---|
| Missing in ledger | Re-fetch the PSP transaction through the PSP API (read-only), replay through the normal idempotent handler, never post by hand if replay works |
| Missing at PSP | Hold the order state, ask the PSP, do not ship if unpaid; refund path if a customer was charged elsewhere |
| Amount mismatch | Identify fee or partial capture; post a fee or adjustment entry with the PSP document reference |
| Timing | Wait until the next settlement file; document |
| Duplicate | Sev1. Stop the affected method (psp-outage.md hide step), refund duplicates through the PSP, fix idempotency, add a regression test |

## Close-out

- Unmatched count back to zero for lines older than 3 days; note remaining younger lines with an owner.
- Record the break, class, cause, amount and correcting entries in the reconciliation log.
- If cause was code: post-mortem within 5 business days and a test that reproduces it.
- Settlement files and statements are retained per the raw-webhook and financial retention rules (B1; VERIFY the exact period).

## Escalation

Finance-ops owns triage. Escalate to Sev2 when the unmatched amount is material relative to a day's volume (threshold: owner decision) or any duplicate charge is found. Seller payables depend on the ledger: pause seller payouts for affected sellers until the break is closed.
