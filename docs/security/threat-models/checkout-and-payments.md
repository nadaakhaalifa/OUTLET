# Threat model: checkout and payments

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §7, §B8, §20.7, §T3, §T5 · Modules: `cart`, `checkout`, `payments`, `orders`, PSP adapters

No checkout or payment code exists. The only related code in the repo is the money arithmetic in `packages/domain/src/money.ts`, which the checkout totals will depend on.

## Scope and assets
Payment intents, webhook endpoint, order-group state, saved-card tokens (`psp_token`, brand, last4, expiry, fingerprint), COD risk decisions, client-supplied totals (never trusted). Card data never touches Outlet NK (SAQ A path, §B8).

## Trust boundaries and actors
Mobile app / web to API · API to PSP (hosted page, native SDK, webhooks) · API to courier (COD). Adversaries: price tamperers, card testers, webhook forgers, replay attackers, double-spend racers, COD abusers, malicious script injectors on any payment-adjacent web page.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| PAY-S1 | S | Forged PSP webhook marks an order paid | `POST /v1/webhooks/{provider}`: IP allow-list, HMAC over the raw body, timestamp within plus or minus 5 min, dedup on `payment_events_raw.event_id UNIQUE`; the amount and currency in the event are compared with the intent | PAY-T01 bad signature, stale timestamp, wrong amount and unknown intent each leave the order unpaid and the ledger untouched | planned |
| PAY-S2 | S | Another user finalizes or reads someone's OrderGroup (BOLA) | Ownership check in policy guard plus RLS; not found or not owned is 404 | PAY-T02 negative authorization test on every order-group route | planned |
| PAY-T1 | T | Client tampers with prices, quantities, vouchers or totals | `ValidateCart` recomputes prices, stock, promotions and age gates server-side; client total is ignored; DTO allow-lists block mass assignment (API3) | PAY-T03 request with inflated discount fields is rejected or ignored and the total equals the server calculation | planned |
| PAY-T2 | T | Replay of a checkout or double tap creates two charges | Idempotency key (UUIDv7) stored with `(key, route, actor, request_hash, response)` for 24 h; same key with a different hash is 422; PSP intent created with `Idempotency-Key = order_group_id` | PAY-T04 duplicate POSTs yield one OrderGroup and one PSP intent; PAY-T05 same key, different body is 422 | planned |
| PAY-T3 | T | Money rounding or allocation drift between order lines and the charge | Integer piastres only, one rounding point, largest-remainder allocation | `packages/domain/src/money.test.ts` ("always sums exactly to the total", "keeps every part within one unit of its exact proportional share") and PAY-T06 per-line allocation sums to the charge | partial (arithmetic implemented in `packages/domain/src/money.ts`; checkout use planned) |
| PAY-T4 | T/E | Payment succeeded after reservation expired causes oversell | Auto-claim if stock is available, else automatic refund plus apology voucher; alert above 0.1% | PAY-T07 chaos test: expire reservation, deliver webhook, assert claim-or-refund and never negative stock | planned |
| PAY-R1 | R | Dispute of what was charged or what price was shown | `payment_events_raw` stores the raw body and signature result 7 years; order lines store `vrp_snapshot` and evidence IDs; audit log for admin actions | PAY-T08 every paid order has a raw event row and a ledger entry referencing it | planned |
| PAY-I1 | I | Card data or tokens reach logs, analytics or crash reports | PSP hosted page or native SDK only; nothing card-shaped stored; PAN-pattern scanner in log pipeline and in CI over fixtures; saved cards are tokens only | PAY-T09 log and DB scan over the test run finds no 13-19 digit Luhn-valid strings | planned |
| PAY-I2 | I | Payment screen captured by screenshot or app switcher | `FLAG_SECURE` on Android payment screens, blur on iOS app-switch | MOB-T05 (see mobile-app model) | planned |
| PAY-I3 | I | Client-side script compromise on a web page that embeds or redirects to payment (SAQ A eligibility) | Strict CSP with nonces, SRI on all scripts, script inventory with justification, CSP `report-to`, 5-minute DOM hash monitor; PSP written confirmation (Option 2) kept as the alternative | PAY-T10 CI header test: CSP and SRI present on payment-adjacent pages; synthetic monitor alert fires on a changed DOM hash in staging | planned |
| PAY-D1 | D | Webhook storm or PSP outage blocks order confirmation | Webhook handler only persists and enqueues, processing is async with DLQ and replay tool; PSP calls 10 s timeout, 3 idempotent retries, circuit breaker; failover PSP or kill switch hides the method | PAY-T11 chaos: PSP down leads to failover or hidden method; API killed mid-saga yields no double charge and no oversell (spec §7 acceptance) | planned |
| PAY-D2 | D | Card testing (many small authorizations) | Per-user, device and IP limits on checkout; BIN-spread detector; 3-DS mandatory on cards; attestation on `POST /v1/checkout` | PAY-T12 simulated card-testing pattern triggers block and alert | planned |
| PAY-E1 | E | A seller or shopper reaches refund or payout controls | Refund and payout routes need admin scopes and dual approval above threshold; policy deny-by-default | PAY-T13 shopper and seller tokens get 403 on refund approval | planned |
| PAY-E2 | E | COD abuse: repeated refusals, fake addresses, bot orders | Risk gate with the control table in §20.7 (new-user cap, confirmation, refusal policy); decision logged with features hash for appeal | PAY-T14 first-order COD above 1,500 EGP is refused; second refusal within 90 days forces prepaid only | planned |
| PAY-E3 | E | Voucher or promotion stacking exploit | Deterministic promotions engine with property test over the stacking matrix | PAY-T15 fast-check: total never below the floor, no stack outside the allowed matrix | planned |

## Decisions and open items
- PSP split, tokenization and recurring support are provider claims not yet confirmed. VERIFY BEFORE LAUNCH (register rows 4, 5) before webhook formats and replay windows are fixed.
- PCI path: SAQ A with the FAQ 1588 techniques versus PSP confirmation. Both on file before launch; VERIFY BEFORE LAUNCH with the acquiring PSP and QSA.
- Webhook IP allow-lists depend on PSP-published ranges; none are assumed here.

## Residual risk
PSP-side compromise and hosted-page compromise are outside Outlet NK control; mitigated by reconciliation (see ledger-and-payouts) and by failover.
