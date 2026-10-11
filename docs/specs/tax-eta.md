# Spec: tax engine and ETA e-invoice / e-receipt queue, Phase 1

Status: DRAFT for review · Spec refs: master prompt §B4 (Tax, ETA e-invoice and e-receipt, VAT 14%), §B5 (Arabic documents), §A2.4 (money), A2.5 (idempotency), A2.6 (state machines), A2.7 (outbox), §T4 (reconciliation), A3 · Code: `packages/domain/src/tax/**`, `apps/api/src/modules/tax-eta/**`, migration `0027_tax_eta.sql`.

Scope: VAT computation, document models, the ETA submission queue and its reconciliation, all against a fake ETA. HARD LIMITS: this module posts nothing to the ledger and makes no live ETA call. The production `EtaPort` adapter, the ETA signing step and the ledger VAT postings (`platform_vat_output`, T4) are separate, owner-reviewed work.

## Flow
1. **Quote.** Checkout (other module) calls `QuoteOrderTax` with VAT-inclusive unit prices, quantities, tax categories and the order-level discount. Result: per line `net`, `vat`, `gross` and order totals, in piastres.
2. **Issue.** An internal caller (settlement run, order paid, subscription charge) calls `IssueDocument` with a `sourceRef`. The document is built by the pure domain, stored, and a `QUEUED` submission is created in one transaction. The same `(kind, sourceRef, version)` never creates a second document.
3. **Send.** `ProcessSubmissionQueue` (scheduled worker) takes due `QUEUED`/`RETRY` rows, writes `SUBMITTED` (attempts + 1) before calling ETA, calls `EtaPort.submit`, then moves to `ACCEPTED` (signed document stored), `REJECTED`, `RETRY` (backoff) or `DEAD_LETTER`.
4. **Poll.** `PollSubmissionStatuses` resolves rows left `SUBMITTED` (ETA answered "pending", or the worker crashed after the write). `not_found` at ETA sends the row back through `RETRY`.
5. **Reconcile.** `RunDailyReconciliation(date)` produces the submitted / accepted / rejected report for a Cairo calendar day and lists every discrepancy.
6. **Admin.** Finance and ops read categories, documents, the reconciliation report and the exemption audit; finance edits exemptions and requeues dead letters.
7. **Seller.** A seller reads its own e-invoices and their ETA status.

## Rules
- **Rate.** 14% (1,400 bps) default per tax category, seeded: `standard`, `marketplace_fee`, `shipping`, `subscription`, `gift_card`. Admins edit only the **exemption** of a category (an effective window with Arabic and English reason and a legal basis), never the base rate. An exemption in force makes the effective rate 0; outside its window the category is 14% again.
- **VAT-inclusive prices.** Shopper prices include VAT. Per line: `net = round_half_even(gross * 10000 / (10000 + rate))`, `vat = gross - net`. That single rounding point is the only one in the engine, so `net + vat == gross` exactly per line and the order totals are plain sums of the lines.
- **Seller invoices are net-quoted.** Commission and fees are net amounts; `vat = round_half_even(net * rate)` and `gross = net + vat`.
- **Order-level discount allocation.** The discount (VAT-inclusive) is spread across lines by line gross with the largest-remainder method (`allocate`, ties to the lower index). Shares sum to the discount exactly (no piastre lost) and no share exceeds its line. A discount above the merchandise total is refused. VAT is then computed on each post-discount line gross. Which base applies when the platform funds the discount is a VERIFY item (VR-B4-04); the default is the amount the shopper paid.
- **Document kinds.**
  - `seller_einvoice`: B2B, Z-OUTLET to a seller; lines `commission`, `fee`, `ads`, `fbh_service`. Seller needs a tax registration number.
  - `shopper_ereceipt`: B2C, Z-OUTLET's own supplies only; lines `delivery_fee`, `plus_subscription`, `gift_card_sale`.
  - `seller_goods_ereceipt`: the seller is the supplier and issuer. Z-OUTLET builds it only as an optional service under an **active delegated-signing grant** for that exact seller (`SigningDelegationPort`); otherwise `delegation_required` and the seller issues its own receipt (default path).
- **Arabic mandatory.** Issuer and recipient `legalNameAr` and every line `descriptionAr` must contain Arabic script (domain error, API 422/`invalid`, and a CHECK constraint on the stored names). English is optional.
- **Idempotent internal ids.** `internalId = {INV|RCP|GRC}-{sourceRef}-v{version}`. Re-issuing a source returns the existing document. A rejected document is corrected as `version + 1` with a new internal id. The fake ETA, like the real portal must be, is idempotent on the internal id.
- **Submission state machine** (`submissionMachine`): `QUEUED -> SUBMITTED -> ACCEPTED | REJECTED | RETRY`; `RETRY -> SUBMITTED`; budget exhausted: `SUBMITTED -> DEAD_LETTER` (DLQ); `DEAD_LETTER -> QUEUED` only by admin `REQUEUE`. `ACCEPTED` and `REJECTED` are final. Guards: `FAIL` while `attempts < max`, `EXHAUST` once `attempts >= max` (default 6).
- **Backoff.** Equal-jitter exponential: `exp = min(1 h, 30 s * 2^(attempt-1))`, delay uniform in `[exp/2, exp]`. Random input is injected for exact tests.
- **Crash safety.** `SUBMITTED` is persisted (compare-and-set on `version`) before the ETA call. A second worker loses the CAS and sends nothing. The poller recovers stranded rows.
- **Reconciliation report.** Counts and gross totals per state, submitted (not `QUEUED`), accepted, rejected, acceptance rate (bps), and discrepancies: `rejected`, `dead_letter`, `stale_submitted` (> 6 h), `accepted_without_signed_document`, `accepted_without_eta_uuid`, `missing_at_eta`, `unknown_at_eta`, `status_mismatch`. `reconciled` is true only with no discrepancy and nothing `QUEUED`/`SUBMITTED`/`RETRY`. A Cairo day is `[00:00, 24:00)` in `Africa/Cairo` (UTC+2 or +3). If ETA cannot be queried only internal checks run.
- **Exemption changes.** Require a reason (>= 3 chars), Arabic reason, legal basis, a valid window and the caller's `expected_version` (409 on a stale version). Every change appends an immutable audit row with before/after and bumps the category version in the same transaction. Whether exemption changes need dual approval is VR-B4-06; until a `tax_config` policy resource exists the route requires the finance or super_admin role and a passkey session.

## Edge cases
- Zero-priced lines and zero discount are valid; an all-zero order with a discount is refused (discount exceeds total).
- Negative amounts are rejected in documents (credit notes are future work, listed as a gap). `splitVatInclusive` is symmetric for negatives so a credit note will mirror the charge.
- Unknown category, duplicate line id, qty outside 1..100000: typed `InvalidTaxInputError`.
- A rate outside 0..10,000 bps is refused.
- ETA down: `transient_error` or a thrown error becomes `RETRY`; nothing is lost. Permanent rejection is `REJECTED` with up to 20 reasons (300 chars each).
- Duplicate or concurrent issue of the same source: one row (unique constraints), one `tax_document.issued` event.
- Deleted shopper: `user_id` is pseudonymized on erasure; the document is retained for the tax period.

## Data (see migration `0027_tax_eta.sql`, entries in `docs/privacy/data_inventory.yaml`)
| Table | Key columns | PII |
|---|---|---|
| `tax_categories` | `code`, `rate_bps`, `exemption jsonb`, `version` | P0 |
| `tax_exemption_audit` | `category_code`, `actor_id`, `action`, `reason`, `before/after`, `version_after` (append-only) | P2 (actor) |
| `tax_documents` | `internal_id` UNIQUE, `(kind, source_ref, version)` UNIQUE, `store_id`, `user_id`, `net/vat/gross` BIGINT with `net+vat=gross`, `document jsonb`; append-only | P2 |
| `eta_submissions` | `document_id` PK, `state`, `attempts`, `next_attempt_at`, `eta_uuid`, `signed_document_ref`, `version` | P1 |
| `eta_signed_documents` | `ref` PK, `sha256`, `body`; append-only | P2 |
| `signing_delegations` | `store_id` PK, `active`, `signing_ref` (a reference, never the secret) | P1 |

RLS: finance, ops and super_admin read all documents; a store reads rows with its `store_id`; a shopper reads rows with its `user_id`; writes are `system` (the module adapter), except exemption edits (finance, super_admin, system) and store-owned delegation rows. Documents, audit rows and signed documents are append-only (`forbid_mutation`).

## API
| Method and path | Audience and gate | Idempotent | Rate limit |
|---|---|---|---|
| `GET /v1/admin/tax/categories` | admin, role finance/ops/super_admin, passkey | n/a | 60/min user |
| `PUT /v1/admin/tax/categories/{code}/exemption` | admin, finance/super_admin, passkey | yes (required) | 20/min |
| `POST /v1/admin/tax/categories/{code}/exemption/clear` | same | yes (required) | 20/min |
| `GET /v1/admin/tax/exemption-audit?code=` | admin read roles | n/a | 60/min |
| `GET /v1/admin/tax/documents?state=&kind=&cursor=&limit=` | admin read roles | n/a | 60/min |
| `GET /v1/admin/tax/documents/{documentId}` | admin read roles | n/a | 120/min |
| `GET /v1/admin/tax/reconciliation?date=YYYY-MM-DD` | admin read roles | n/a | 30/min |
| `POST /v1/admin/tax/submissions/{documentId}/requeue` | admin, finance/super_admin | yes (required) | 20/min |
| `GET /v1/seller/invoices` | seller, `store_payout:read` (owner, manager, finance), `seller:read` | n/a | 120/min |
| `GET /v1/seller/invoices/{documentId}` | same, store-scoped | n/a | 120/min |

Internal use cases (not HTTP): `QuoteOrderTax`, `IssueDocument`, `ProcessSubmissionQueue`, `PollSubmissionStatuses`, `RunDailyReconciliation`.

## Events
Outbox (no PII, internal ids only): `tax_document.issued`, `eta.submission_accepted`, `eta.submission_rejected`, `eta.submission_dead_lettered`. The publisher is a port; the in-process publisher is a fake. Transactional outbox emission inside the Kysely transaction is a gap (below).

## Failure handling
ETA call timeout/5xx/throw: retry with equal-jitter backoff, max 6 attempts, then DLQ (`DEAD_LETTER`, metric and alert on count > 0); admin replays through `requeue`. Status poll gap: rows `SUBMITTED` older than the poll age. Crash between persist and call: recovered by polling (`not_found` re-sends). Signed-document store failure: the settle step throws; the row stays `SUBMITTED` and the poller retries the status call, ETA being idempotent.

## Security and abuse
- AuthZ: sellers see only e-invoices addressed to their own store; another store's invoice, a shopper receipt and an unknown id are all 404 (BOLA, API1). Seller roles without `store_payout:read` (catalog, warehouse, support) are 403. Shopper, seller and wrong-audience tokens never reach `/admin/tax` (401). Admin without the role or without a passkey session: 403, audited.
- Mass assignment: strict Zod bodies; exemption payload is an allow-list; seller wire hides `last_error` and internal ids.
- Fail closed: the module refuses to boot outside test mode without a real `EtaPort`, signed store, event publisher and delegation port.
- Threat notes: (T) forged exemption to cut VAT: admin role + passkey + audit + version CAS; (R) denied change: append-only audit; (I) shopper identity in documents: receipts carry only the internal user id; (D) ETA outage floods retries: capped backoff and batch limit; (E) seller reading another tenant: store-scoped resolver plus RLS.

## Metrics
Documents issued per day, acceptance rate (bps), first-pass rejection rate, time from issue to `ACCEPTED` p95, DLQ depth (alert > 0), `stale_submitted` count, reconciliation `reconciled` ratio. SLO: 99% of documents `ACCEPTED` within 24 h of issue.

## Acceptance
- A 11,400 piastre VAT-inclusive line yields net 10,000, vat 1,400, gross 11,400.
- For random baskets and discounts, line sums equal order totals, the discount is fully allocated and every line balances (property test).
- An English-only description or party name is refused (domain, API and DB).
- The same source issued twice creates one document; two parallel workers send once.
- A transient failure moves to `RETRY` with a delay in `[exp/2, exp]`; the sixth failure goes to `DEAD_LETTER`; `requeue` returns it to `QUEUED`.
- The daily report flags rejected, dead-lettered, stale, unsigned-accepted and ETA mismatches.
- Seller B cannot read seller A's invoice (404); a catalog-role user gets 403; shoppers and admins get 401 on seller routes.

## VERIFY BEFORE LAUNCH (B4)
Tracked in `docs/compliance/verify-register.md` as VR-B4-01 to VR-B4-08:
1. VR-B4-01: Z-OUTLET's own B2C e-receipt wave or obligation date.
2. VR-B4-02: delegated signing rules for seller goods e-receipts (token or HSM, delegation evidence).
3. VR-B4-03: marketplace withholding or reporting duty for sellers.
4. VR-B4-04: VAT base for platform-funded discounts; VAT on coins, vouchers and gift cards (issue vs redemption).
5. VR-B4-05: exact ETA document schema, signing, error taxonomy, endpoints.
6. VR-B4-06: exemption list and legal basis; dual approval for exemption changes.
7. VR-B4-07: retention period and residency of signed documents.
8. VR-B4-08: ETA rounding and tolerance rules.

## Gaps and integration needs
See the hand-off summary: app module registration, `export * as tax` in the domain index, policy resource types `tax_config` and `tax_document`, ETA production adapter, outbox-in-transaction, OpenAPI, ledger postings (out of scope), credit notes.
