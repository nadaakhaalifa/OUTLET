# Spec: ledger posting service (T4, ADR-0021 F-1)

Status: Draft for money review. Refs: master prompt B2, B3, T4, 7, 15.2, 15.6, 22; ADR-0003, ADR-0018, ADR-0019, ADR-0021.
Code: `packages/domain/src/ledger-posting/` (pure), `apps/api/src/modules/ledger/` (service, adapters, admin read API), `packages/db/migrations/0031_ledger_posting.sql`.

## Flow
1. A use case (checkout saga step, refund saga, payout, courier or BNPL reconciliation) builds a `PostingCommand` and calls `PostingService.postCommand(tx, command)` with the transaction handle of its own unit of work. The posting, the caller's state change and the caller's outbox events commit or roll back together.
2. `PostingTemplates` (pure) turn the command into a balanced `JournalEntry` using the existing chart-of-accounts builders. The template derives the idempotency key (`<template>:<ref id>[:<seq>]`), so two callers cannot post the same business event under different keys.
3. `PostingService.post` replays or appends: same key and same payload returns the existing entry id, same key and a different payload throws `PostingConflictError`. New entries are written with the DB deferred balance trigger as the last line of defence and are linked into the hash chain.
4. Corrections use `PostingService.reversal(tx, entryId)`: exact mirror postings, key `reversal:<entryId>`, so repeating it is a replay.
5. `IntegrityJob` (pure core, Kysely and in-memory sources) reports trial balance, hash chain verification and store-credit projection drift.
6. Finance reads: `GET /admin/ledger/balances`, `GET /admin/ledger/entries/:id`.

## Templates (all pure, bigint piastres)
| Template | Entry kind (builder) | Key | Accounts |
|---|---|---|---|
| `order_paid` | order_recognised | `order_paid:<orderGroupId>` | Dr psp/bnpl clearing, store_credit sub-balances; Cr seller_payable per store, platform_commission, platform_vat_output (14% of commission), shipping_revenue; Dr promo_expense_platform (platform voucher), promo_receivable_seller (seller voucher) |
| `order_cod_confirmed` | order_recognised | `order_cod_confirmed:<orderGroupId>` | same, external tender is cod_clearing (courier receivable) |
| `cod_collected` | clearing_settled | `cod_collected:<remittanceId>` | Dr bank_settlement, courier_fee_expense; Cr cod_clearing |
| `bnpl_settled` | clearing_settled | `bnpl_settled:<settlementId>` | Dr bank_settlement, provider_fee_expense; Cr bnpl_clearing |
| `psp_settled` | clearing_settled | `psp_settled:<settlementId>` | Dr bank_settlement, provider_fee_expense; Cr psp_clearing |
| `refund` | refund_issued | `refund:<refundId>:<storeId>` | mirror of the refunded portion, destinations restore the original sub-balances |
| `seller_payout` | seller_payout | `seller_payout:<payoutId>` | Dr seller_payable, Cr bank_settlement |
| `seller_promo_netted` | seller_promo_netted | `seller_promo_netted:<ref>` | Dr seller_payable, Cr promo_receivable_seller |
| `store_credit_issue` | store_credit_granted | `store_credit_issue:<grantId>` | Dr promo_expense_platform, Cr store_credit sub |
| `store_credit_expire` | store_credit_expired | `store_credit_expire:<expiryId>` | reverse of issue |
| `gift_card_sold` / `gift_card_redeemed` | gift_card_* | `gift_card_sold:<cardId>`, `gift_card_redeemed:<cardId>:<redemptionId>` | kill switch `gift_card_sales`, off by default (ADR-0003) |
| `plus_charged`, `plus_revenue_recognised` | plus_* | `plus_charged:<invoiceId>`, `plus_revenue_recognised:<invoiceId>:<period>` | passthrough of the chart builders |

Store credit spending is not a standalone entry: it is a tender of `order_paid` (spend order from `planStoreCreditSpend`, soonest-expiring first, refund credit last), so the credit and the order cannot diverge.

### Algorithm choices (2 options each)
- **Voucher allocation across seller orders.** (a) proportional to merchandise with largest remainder (`allocate`), (b) equal split. Chosen (a): matches how the discount was earned and is exact (parts sum to the total). Co-funded vouchers split each allocated part by `sellerShareBps` with one rounding.
- **Refund voucher share per line.** (a) re-allocate the remaining voucher over remaining lines at each refund, (b) fix each line's share at order time and release it proportionally to refunded goods using cumulative differencing. Chosen (b): any sequence of partial refunds telescopes to exactly the order's voucher, with one rounding point per call.
- **Refund destinations.** (a) store credit first, (b) pro rata over the original tenders weighted by remaining refundable amount. Chosen (b): neutral to the shopper, "original method" by default (15.6), and each part provably stays within the tender's remaining capacity. A shopper choice of store credit re-routes external PSP portions to refund_credit; BNPL portions always go back to the provider (ADR-0021 point 3); COD that was already collected is routed to refund_credit because a cash refund path does not exist yet (VERIFY).
- **Hash chain.** (a) one global chain serialised by `pg_advisory_xact_lock`, (b) chain per account shard. Chosen (a): a total order is what an auditor can verify with one pass. Trade-off: ledger appends serialise (one entry per order group, short critical section, lock taken after the caller's reads and only for new keys). Sharding is a later ADR if the mega-event load test shows contention.

## Rules
- Every amount is integer piastres, currency EGP. Rounding happens only inside `money.ts` (`divideRoundHalfEven`, `allocate`).
- Entries are immutable; there is no update or delete path (DB triggers reject them as well).
- Idempotency payload fingerprint covers kind, ref and the multiset of (account, amount, currency). It excludes the generated id and the timestamp, so a retry of the same business event is a replay.
- A reversal of a reversal is refused (`InvalidReversalError`); an entry is reversed at most once (DB unique on `reverses_entry_id`).
- Gift card sale and redemption entries require the `gift_card_sales` flag; with the flag off the service throws `GiftCardSalesDisabledError` before touching the database.
- `refund_reserve` stays unposted (reserved account).

## Edge cases
Zero or negative amounts rejected by builders (`InvalidChartInputError`); tender sum different from payable (`TenderMismatchError`); store credit cannot buy gift cards or Plus; refund larger than the remaining capacity of the original tenders (`RefundExceedsOriginalError`); concurrent posts with the same key (unique violation is caught, the winner is re-read and compared); posting replay after commit; mixed currency entries (builders only produce EGP).

## Data
No new business tables. New: `ledger_entry_chain(seq identity, entry_id unique FK, prev_hash, entry_hash unique, created_at)`, append-only, RLS (select finance, super_admin, system; insert system, finance). PII class P1 (no personal data; ids only). Retention `orders_tax_records`. Existing: `ledger_accounts`, `journal_entries`, `postings` (0003, 0007, 0011).

## API (admin audience, passkey session, standing `finance` grant; standing super_admin opens nothing without break-glass, same rule as the admin module)
- `GET /v1/admin/ledger/balances?owner_type=&owner_id=&type=&limit=` returns balances derived from postings, never a cached value. Not idempotent (read). Rate limit 60/min/user.
- `GET /v1/admin/ledger/entries/:id` returns the entry with postings and chain link. 404 for an unknown id. 120/min/user.
- No HTTP write endpoint: posting is internal, called by saga steps. Wrong audience 401/403, shopper or seller token 403, missing passkey 403.

## Events (outbox, same transaction)
`ledger.entry_posted` (aggregate `journal_entry`, payload: kind, ref type and id, idempotency key, posting count, chain seq), `ledger.entry_reversed` (adds `reverses_entry_id`). Payloads carry no amounts per person and no personal data.

## Failure handling
Unbalanced entry: typed error before SQL, DB trigger at COMMIT as backstop. Key conflict: `PostingConflictError` maps to 409 for callers that surface it, saga step goes to manual review (never retried with a changed payload). Integrity failures are a report, not an exception: the job returns `ok: false` with the offending currency, entry id or user and the caller alerts Finance.

## Security and abuse
Deny by default; reads only for admin audience with an unexpired `finance` grant and a passkey session (a missing role is 403, a missing passkey 403 `passkey_required`, an unknown entry 404); every allow and deny goes to the AuditSink. Posting runs as the `system` DB role inside the caller's transaction and has no HTTP surface. API mapping: API1/API5 (BOLA/BFLA, negative tests per route), API4 (limit max 200), API6 not applicable. Threat notes: forged ledger writes need the system role (RLS), chain tampering is detectable by `verifyChain`, replay is harmless by idempotency.

## Metrics
Entries posted per kind, replay rate, conflict count (target 0), trial balance (SLO 0 always), chain verification (SLO ok), store-credit drift count (target 0), posting latency p95 (< 50 ms inside the checkout transaction).

## Acceptance
- Cart with stores A, B, C and a split tender: one entry balancing to 0 with three seller payables, a commission and VAT at 14%.
- Same command twice: same entry id, one row. Same key and a different payload: `PostingConflictError`.
- Partial refunds in any order sum to the original commission, VAT and voucher exactly.
- `reversal` then balance of every account is 0 for that entry; repeating it returns the same reversal.
- Failing outbox emit or state change after posting rolls the posting back (same transaction).
- A mutated entry hash or a removed link makes `verifyChain` fail at the exact sequence number.

## VERIFY BEFORE LAUNCH rows added (see docs/compliance/verify-register.md)
VR-F1-01 COD recognition point and receivable timing, VR-F1-02 cash refund of collected COD, VR-F1-03 PSP split or sub-merchant allocation and fees at settlement (Paymob unverified), VR-F1-04 gift-card VAT point and breakage, VR-F1-05 who bears provider and courier fees, VR-F1-06 platform-funded voucher expense versus revenue reduction.

## Mutation testing
`packages/domain/stryker.ledger-posting.mjs` (break 80, ADR-0019) covers `src/ledger-posting/**`. The run could not complete in the authoring sandbox (`spawn pgrep EAGAIN` in Stryker's process cleanup), so no score is claimed. Run it from `packages/domain` on Node 24 before the milestone review.
