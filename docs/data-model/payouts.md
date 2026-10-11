# Module: payouts

Phase 1 (weekly seller payouts, dual approval, IBAN name match) and Phase 3 (creator payouts at scale) · Spec refs: §T4, §22 (payout interplay), §19 (finance), §B2, §15.4, §B6, §23 (dual approval) · Owner aggregates: `Payout`, `PayoutInstrument`, `PayoutAccrual`, `PayoutCycle`

## Flow
When a seller order line becomes `CLOSED` (return window plus 3 days, no dispute), a `payout_accruals` row moves from `PENDING` to `ELIGIBLE`. A weekly `payout_cycles` run groups eligible accruals per store (or creator), nets any negative seller balance (refunds after payout, chargebacks, penalties), creates a `payouts` row `SCHEDULED`, applies risk holds, requires dual approval above a threshold, sends through the PSP or bank API with an idempotent request, and posts the ledger entry. The bank or PSP result moves it to `SETTLED` or `FAILED`.

## Rules
- State machine: `SCHEDULED -> ON_HOLD (risk) -> APPROVED -> SENT -> SETTLED | FAILED` (§T4). Valid transitions are table driven (§A2.6). `ON_HOLD -> APPROVED` needs a hold release with a reason.
- Eligibility: line `CLOSED` (return window plus 3 days) and no open dispute, return or price enforcement hold. Payout money comes from `seller_payable:{store}` only.
- A refund after payout leaves `seller_payable` negative. The next payout nets it. If a seller never earns again the negative balance is a receivable handled by Finance (decision needed, I-32).
- IBAN is P3, field-encrypted, with a blind index `iban_hash`. The account holder name must match the KYC legal name (name-match check) before the instrument is `VERIFIED`. An IBAN change puts the next payout on `ON_HOLD` for a cooling period (proposed 7 days).
- Dual approval above a threshold (config) through admin `approval_requests`. The approver cannot be the requester.
- Seller Agreement hold: payouts can be held on severe or repeat price-integrity enforcement (§9.5), recorded as `payout_holds` with a reference to the enforcement action.
- Creator payouts need KYC and age 21 (§B6, §15.4). Creator VAT above EGP 500k and payout tax are VERIFY BEFORE LAUNCH.
- A payout request to the bank or PSP carries `provider_idempotency_key = payout_id`. A retry never creates a second transfer.
- Payout currency is EGP. Fees are explicit `payout_fee_amount`, never hidden in the net.
- The weekly cycle day and thresholds are admin config (`config_parameters`), versioned and audited.

## Edge cases
- Payout `SENT` but no confirmation within the provider window: reconcile by provider reference before any resend.
- Name match fails: instrument `NEEDS_REVIEW`, payout stays `ON_HOLD`, seller notified.
- Seller suspended: payouts `ON_HOLD` per agreement, human review of suspension within 5 business days (§9.5).
- IBAN reused across stores: flagged for fraud (`iban_hash` index across stores).
- Partial failure in a bulk file: per-payout status, never per-file.
- Negative net: no payout created, balance carried forward, seller sees the statement.
- COD-heavy sellers: accrual still waits for `CLOSED`, COD cash arrives through remittance but is not seller money until then.

## ER diagram

```mermaid
erDiagram
    payout_instruments {
        uuid id PK
        text owner_type "STORE, CREATOR"
        uuid owner_id
        bytea iban_enc "P3"
        bytea iban_hash "blind index"
        bytea account_holder_name_enc "P3"
        text bank_code
        text name_match_status "PENDING, MATCHED, MISMATCH, NEEDS_REVIEW"
        text status "PENDING, VERIFIED, SUSPENDED, RETIRED"
        timestamptz verified_at
        timestamptz created_at
    }
    payout_cycles {
        uuid id PK
        date cycle_date
        text status "OPEN, CALCULATED, APPROVED, SENT, CLOSED"
        timestamptz cutoff_at
        int payout_count
        bigint total_amount
        char currency
        uuid created_by
    }
    payout_accruals {
        uuid order_line_id PK
        uuid store_id FK "tenancy"
        uuid seller_order_id FK
        bigint gross_amount "line payable to seller"
        bigint commission_amount
        bigint commission_vat_amount
        bigint fees_amount
        bigint net_amount
        char currency
        text status "PENDING, ELIGIBLE, HELD, PAID, CLAWED_BACK"
        timestamptz eligible_at
        uuid payout_id FK "nullable"
        uuid ledger_entry_id FK "closing entry"
    }
    payouts {
        uuid id PK
        uuid cycle_id FK
        text owner_type "STORE, CREATOR"
        uuid owner_id
        uuid instrument_id FK
        text status
        bigint gross_amount
        bigint adjustments_amount "negative balance netting"
        bigint fee_amount
        bigint net_amount
        char currency
        text provider_code
        text provider_ref UK
        uuid approval_request_id FK "L admin, nullable"
        uuid ledger_entry_id FK "L ledger"
        text failure_code
        timestamptz scheduled_for
        timestamptz sent_at
        timestamptz settled_at
    }
    payout_items {
        uuid payout_id PK
        uuid order_line_id PK
        bigint net_amount
    }
    payout_adjustments {
        uuid id PK
        uuid payout_id FK "nullable until netted"
        uuid store_id FK
        text kind "REFUND_AFTER_PAYOUT, CHARGEBACK, PENALTY, COD_REFUSAL_FEE, MANUAL"
        bigint amount "signed"
        char currency
        text ref_type
        text ref_id
        uuid ledger_entry_id FK
        timestamptz created_at
    }
    payout_holds {
        uuid id PK
        text owner_type
        uuid owner_id
        text reason_code "RISK, ENFORCEMENT, IBAN_CHANGE, KYC_REVIEW, DISPUTE"
        uuid source_ref_id "enforcement action or case"
        text status "ACTIVE, RELEASED"
        uuid placed_by
        uuid released_by
        timestamptz placed_at
        timestamptz released_at
    }
    payout_statements {
        uuid id PK
        uuid payout_id FK
        uuid store_id FK
        text locale "ar, en"
        text object_key
        timestamptz generated_at
    }
    payout_instruments ||--o{ payouts : paid_to
    payout_cycles ||--o{ payouts : groups
    payouts ||--|{ payout_items : composed_of
    payout_accruals ||--o| payout_items : paid_via
    payouts ||--o{ payout_adjustments : nets
    payouts ||--o| payout_statements : documented_by
```

## Entities

| Entity | Ph | PK | FK (E enforced, L logical) | Indexes and uniqueness | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|---|---|---|
| `payout_instruments` | P1 | `id` | `owner_id` L (stores or creator_accounts) | index `(owner_type, owner_id)`; index `(iban_hash)` (cross-owner reuse detection); unique `(owner_type, owner_id, iban_hash)` | P3 (IBAN, holder name) | `store_id` when `owner_type = STORE` (finance role only) | none | RET-KYC: contract plus 5 years (spec §B1), VERIFY |
| `payout_cycles` | P1 | `id` | `created_by` L | unique `(cycle_date)` | P1 | none | none | RET-TAX |
| `payout_accruals` | P1 | `order_line_id` | `store_id` E, `seller_order_id` L, `order_line_id` L, `payout_id` E, `ledger_entry_id` L | partial index `(store_id, eligible_at) WHERE status = 'ELIGIBLE'`; index `(payout_id)` | P1 | `store_id` | none | RET-TAX |
| `payouts` | P1 | `id` | `cycle_id` E, `instrument_id` E, `approval_request_id` L, `ledger_entry_id` L | unique `(provider_code, provider_ref)`; index `(owner_type, owner_id, scheduled_for DESC)`; index `(status, scheduled_for)` | P2 (links to an identified store or creator) | `store_id` via owner | none | RET-TAX |
| `payout_items` | P1 | `(payout_id, order_line_id)` | `payout_id` E, `order_line_id` L | unique `(order_line_id)` (a line is paid once) | P1 | via payout | none | RET-TAX |
| `payout_adjustments` | P1 | `id` | `payout_id` E, `store_id` E, `ledger_entry_id` L | index `(store_id, payout_id)`; index `(ref_type, ref_id)` | P1 | `store_id` | none | RET-TAX |
| `payout_holds` | P1 | `id` | `owner_id` L, `source_ref_id` L | partial index `(owner_type, owner_id) WHERE status = 'ACTIVE'` | P1 | `store_id` via owner | none | RET-TAX |
| `payout_statements` | P1 | `id` | `payout_id` E, `store_id` E | unique `(payout_id, locale)` | P1 | `store_id` | none | RET-TAX |

## Data notes
- The spec gives no Data block for payouts. Entities are derived from §T4 (state machine, eligibility, dual approval, IBAN name match) and §19 (statements).
- The ledger is the source of truth for seller balance. `payout_accruals` is a work queue and an audit trail: its rows must reconcile with `seller_payable:{store}` postings. A nightly check compares `sum(ELIGIBLE and HELD and PENDING net_amount)` with the account balance (I-33: the spec does not define the seller balance timeline pending, eligible, held).
- Commission and VAT on commission per line come from the order line snapshot (`commission_rate_snapshot_bps`). VAT 14% on commission is posted to `platform_vat_output` by the single rounding point (ledger I-09).
- `payout_instruments.owner_type = CREATOR` serves creator payouts (referrals). KYC for creators is in `creator_kyc_records` (referrals).
- The data inventory names `payout_instruments(id, owner_user_id, iban, iban_hash, account_holder_name)`. This model uses `owner_type` and `owner_id` because the owner can be a store (a legal entity) or a creator (a user). Alignment is a follow-up for the inventory (I-34).
- IBAN is envelope-encrypted with a blind index, never logged and never returned to the client beyond the last 4 characters.

## API
| Endpoint | Scope | Idempotent | Rate limit |
|---|---|---|---|
| `GET /v1/seller/finance/balance`, `/payouts`, `/statements` | seller finance role | n/a | 60/min |
| `POST /v1/seller/finance/instruments` | seller manager or finance, recent auth | yes | 5/min |
| `GET /v1/admin/payouts`, `POST /v1/admin/payouts/{id}/hold`, `/release`, `/approve` | finance, dual approval above threshold | yes | 30/min |
| `POST /v1/admin/payout-cycles/{id}/run` | finance | yes | 5/min |

## Events
Outbox: `payout.scheduled`, `payout.held`, `payout.approved`, `payout.sent`, `payout.settled`, `payout.failed`. Analytics: none for seller money.

## Failure handling
Saga with explicit compensation: if the provider send fails before acceptance, the ledger entry is reversed and the accruals return to `ELIGIBLE`. If status is unknown after timeout, no resend until reconciliation by provider reference. Retries with backoff, max N, then `FAILED` with Finance ticket. Provider callbacks are deduplicated and processed through the inbox.

## Security and abuse
- ASVS Level 3 scope. Dual approval, IP allow-list for Finance, passkey required.
- IBAN change is the main takeover vector: it requires recent auth, notifies all store managers, and holds the next payout.
- BOLA: a seller sees only their own balances and payouts (404 otherwise).
- The approver and requester differ, enforced by a database check on `approval_requests`.
- Payout file or API credentials live in the secrets manager.

## Metrics
Payout success rate, time from `CLOSED` to cash, held payouts count and age, name-match failure rate, negative seller balances, payout reconciliation mismatches.

## Acceptance
- A line is never in two payouts (unique `payout_items.order_line_id`).
- A refund after payout produces a negative adjustment netted in the next cycle.
- A payout above the threshold cannot move to `APPROVED` without a second approver.
- A failed provider send restores accrual eligibility and reverses the ledger entry.
