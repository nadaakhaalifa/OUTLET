# Seller payouts and statements (spec T4, 22, B2, B4)

Status: Phase 1, synthetic data only, fakes only, nothing deployed · Module: `apps/api/src/modules/payouts` · Pure rules: `packages/domain/src/payouts` · Migration: `0035_payouts_reconciliation.sql` · Builds on ADR-0021 points 1, 4, 5, 7, ADR-0003, ADR-0018, ADR-0019 · Privacy: `docs/privacy/data_inventory.yaml` (`payouts`, `payout_lines`, `payout_attempts`, `payout_status_history`)

## Hard limits
* **Seller funds never sit in a Z-OUTLET balance** (ADR-0021 point 1). This module never moves money itself. It decides WHAT to pay and WHEN, posts the ledger entry, and asks `PayoutPort` (PSP or bank) to pay. Only `FakePayoutPort` exists. Whether the PSP can pay sellers out (sub-merchant) or a bank file is used stays VR-22 / VR-F1-03.
* **No live network calls.** Name inquiry, payout submission and status polling are ports with fakes.
* **No IBAN in this module's tables.** Bank details are owned by seller KYC (`seller_kyc_records.iban`, P3 field-encrypted). A payout row stores an opaque `account_token` and the last four digits only.
* **Ledger-first** (ADR-0021 point 5): the `seller_payout` entry is posted before the provider call; a provider rejection posts a reversal. The ledger module is reached only through `PayoutLedgerPort`.

## Flow
1. **Schedule (weekly, Africa/Cairo).** `SchedulePayouts` runs for the latest cycle: Sunday 10:00 Cairo (configurable weekday and hour). The cycle key is the Cairo civil date of the run, the cutoff is the run instant. For each store with payables it reads closed seller orders and outstanding clawbacks from `PayoutSourcePort`, runs the pure `planPayout`, and creates ONE payout per (store, cycle) in `SCHEDULED` with its lines. A second run of the same cycle creates nothing.
2. **Hold checks (same pass).** No bank details, IBAN name mismatch or unavailable name inquiry, risk hold from `PayoutRiskPort`, or a payout larger than the ledger `seller_payable` balance moves the payout `SCHEDULED -> ON_HOLD` with a reason code.
3. **Approve.** Finance approves (`POST /v1/admin/finance/payouts/{id}/approve`). At or above the payout threshold (`requiresDualApproval`, default 50,000 EGP, admin-editable) the payout needs an `APPROVED`, unexpired admin approval record that `approvalCovers` for exactly (`payout`, `payout`, payout id, amount); requester and approver are different people (checked in `approvalCovers` and by a DB CHECK in 0029). Below the threshold no record is needed. Open disputes block approval.
4. **Send.** `SendPayout` (job or finance retry): kill switch, then IBAN name match again, then ledger post, then `APPROVED -> SENT` persisted, then `PayoutPort.send` idempotent by payout id. `accepted` stays `SENT`; `settled` goes `SETTLED`; `rejected` goes `FAILED` and posts the reversal; `unavailable` stays `SENT` for the next `AdvanceSentPayouts` pass, which is safe because the provider key is the payout id.
5. **Failure.** `FAILED` payouts can be rescheduled (`RESCHEDULE`) or cancelled. Cancel releases the lines so the next cycle picks them up again.

## State machine
The shared Payout machine is reused unchanged: `SCHEDULED -> ON_HOLD | APPROVED | CANCELLED`, `ON_HOLD -> APPROVED | CANCELLED`, `APPROVED -> ON_HOLD | SENT | CANCELLED`, `SENT -> SETTLED | FAILED`, `FAILED -> SCHEDULED | CANCELLED`. Guards: `APPROVE` needs `approvalRequirementMet && noOpenDispute`, `SEND` needs `ibanNameMatched`. Every transition is a version-checked update with an append-only history row and its outbox events in the same transaction.

## Rules
| # | Rule |
|---|---|
| R1 | A seller order is payable when its status is `CLOSED` (return window elapsed, spec 22) AND `closed_at + 3 days <= cutoff` AND it has no open dispute. The 3 days is the T4 "return window plus 3 days" buffer, a constant `PAYOUT_HOLD_AFTER_CLOSE_MS`. |
| R2 | A seller order is in at most one ACTIVE payout (partial unique index). A clawback may be applied in parts: its outstanding amount is its amount minus the sum of its active lines. Cancelling a payout releases its lines. |
| R3 | **Netting.** Clawbacks (refund after payout, seller-funded promo netting, chargebacks) are consumed oldest first from the eligible total, partial application allowed, never below zero. `payout = eligible - netted`, `carry_forward = clawbacks - netted`. The ledger already reduced `seller_payable` when the refund or promo was posted, so netting changes the payout amount only, never creates a posting. |
| R4 | A payout below the minimum (default 10,000 piastres = 100 EGP, admin-editable) or equal to zero is not created: items and clawbacks carry to the next cycle. |
| R5 | The amount sent never exceeds the ledger `seller_payable` natural balance, checked at schedule time, when a hold for `exceeds_ledger_balance` or `risk_review` is lifted by approve (a FRESH check must pass, else `hold_not_cleared` / 409), and again in `send` before anything is posted (held again otherwise). HONEST LIMIT: the balance is the natural ledger balance, which includes orders not yet CLOSED. It is a floor against overpaying, not proof that every unit is past its return window; CLOSED + 3 days is enforced by eligibility at schedule time only (F-7). |
| R5b | A `send` that loses the version check (cancel, hold or another actor won) reverses the entry it just posted, unless the winner is another send of the same attempt that owns it through `ledger_ref`. A cancelled payout never keeps a live payout entry (ADV-W4-5). |
| R6 | IBAN: structural check (country EG, 29 chars, mod 97) in the seller KYC module. Here the holder name from the bank inquiry is compared with the seller legal name after normalization (Arabic diacritics, alef and ya forms, punctuation, company suffixes, token order). No match = no payout. |
| R7 | Kill switch `payouts_enabled` (feature flag, `PayoutFlagsPort`): when off, `SEND` is refused (`kill_switch`) and nothing is posted or sent. Scheduling and approval stay allowed so the queue is visible. |
| R8 | Refund after payout: the refund's posting makes `seller_payable` smaller or negative. The clawback appears in `PayoutSourcePort.clawbacks` and is netted by R3 in the next payout. A negative balance stays visible on the statement. |
| R9 | Statement lines (orders, refunds, promo netting, payout sends and reversals, other ledger adjustments; refund-after-payout clawbacks are NOT separate lines, the refund line already carries them) use the same formulas as the ledger builders (`commissionOf`, `commissionVatOf`, half-even once): net = merchandise - commission - VAT on commission. Closing balance = opening + sum of line nets (property tested). |

## Algorithms compared
* **Netting order.** (a) Newest clawback first: shields older seller debt, unfair to the platform. (b) Oldest first with partial application: chosen, deterministic, keeps the oldest debt from aging. Ties break on id.
* **Name matching.** (a) Fuzzy (Jaro-Winkler, 0.9): fewer manual reviews but a near-miss can pay the wrong party. (b) Normalized token-set equality: chosen, a false negative costs a manual review, a false positive costs money.
* **Cycle clock.** (a) Fixed 7 x 24 h from an epoch: drifts across Egypt's DST. (b) Civil Cairo weekday and hour converted per run: chosen, same method as `addBusinessDays` in admin.

## Edge cases
Payout rerun after crash (idempotent by (store, cycle), ledger key per attempt, provider key = payout id) · clock at the exact cutoff (inclusive) · closed order with `closed_at` null (never eligible) · all clawbacks exceed eligible (carry, no payout) · approval expired between approve and send (approval is consumed at approve; amount fixed) · amount changes (it cannot: lines are frozen at creation) · two finance users approve at once (version conflict, one wins) · store suspended (risk port hold) · provider returns `settled` immediately · provider unavailable (stays `SENT`) · kill switch flipped mid-run (checked per payout) · negative net orders (ineligible, `non_positive`).

## Data
`payouts(id, store_id, cycle_key, cutoff_at, status, amount, eligible_total, netted_total, carry_forward, line_count, account_token, iban_last4, hold_reason, approval_id, approved_by, ledger_entry_key, provider_ref, attempts, failure_code, version, ...)` unique (store_id, cycle_key) where status <> 'CANCELLED' · `payout_lines(payout_id, source_type seller_order|clawback, source_id, amount, active)` unique (source_id) where active and source_type = 'seller_order' · `payout_attempts(payout_id, attempt_no, outcome, code, provider_ref)` · `payout_status_history` (append-only). Classes: ids and amounts P1, `store_id` P1, `approved_by` P2, `iban_last4` P2, `account_token` P2. Retention `orders_tax_records` (5 to 7 years, VERIFY). RLS: sellers read own store rows through `app.store_ids` with roles checked by policy; staff `finance`, `ops`, `super_admin`, `system`.

## API
| Route | Auth | Idempotent | Limit |
|---|---|---|---|
| `GET /v1/seller/payouts` | seller_api, `store_payout` read (owner, manager, finance), only own stores, none = 403 | no | 120/min |
| `GET /v1/seller/payouts/{id}` | same, foreign or missing = 404 | no | 120/min |
| `GET /v1/seller/stores/{id}/statements?from&to` | same, foreign or missing store = 404 | no | 60/min |
| `GET /v1/admin/finance/payouts`, `/{id}` | admin_api, `payout` read (finance, ops), passkey | no | 120/min |
| `POST /v1/admin/finance/payouts/{id}/approve`, `/hold`, `/cancel` | admin_api, finance only, passkey | **yes, required** | 30/min |

## Events (outbox, same transaction)
`payout.scheduled`, `payout.held`, `payout.approved`, `payout.sent`, `payout.settled`, `payout.failed`, `payout.cancelled`, `payout.rescheduled`. Payloads hold ids, amounts and codes only, never IBAN or holder name.

## Failure handling
Provider timeouts leave `SENT` and are retried by id (exponential backoff is the job's concern, the call is idempotent). Ledger conflict (same key, different payload) aborts the send and raises an alert. DLQ and replay come from the outbox relay. User-visible fallback: seller sees `SCHEDULED` / `ON_HOLD` with a neutral reason code; the detail is staff only.

## Security and abuse
BOLA/BFLA (API1, API5): seller routes resolve through the store, a foreign store is 404 byte-identical to a missing one, a staff role without payout read is 403. Mass assignment: strict Zod bodies. Sensitive flow (API6): approve and cancel rate limited and idempotent. Dual approval cannot be satisfied by the requester (domain + DB). Amounts are decided by the server from the frozen lines, never by the client.

## Metrics
Payout success rate, time SCHEDULED to SETTLED p95, holds by reason, clawback carry total, payouts below minimum, kill-switch activations. Guardrail: ledger `seller_payable` drift versus payouts and statements is zero.

## Acceptance
* Given two closed orders (one inside the 3-day buffer), when the cycle runs, then only the older one is paid.
* Given a refund after payout of 30 EGP and a 100 EGP eligible total, then the next payout is 70 EGP and the statement shows the clawback.
* Given an amount at the threshold and no approval record, then approve is refused; with a record whose approver is the requester it is still refused.
* Given the kill switch off, then send changes nothing and posts nothing.
* Given the same cycle run twice, then one payout exists and the ledger has one entry.
* Given seller A reading seller B's payout, then 404, identical to a missing id.

## VERIFY BEFORE LAUNCH (appended to the register)
VR-PO-01 (PSP or bank payout rail), VR-PO-02 (bank account-holder name inquiry), VR-PO-03 (cycle, buffer, minimum and threshold), VR-PO-04 (statement as a tax document, links VR-B4-03).
