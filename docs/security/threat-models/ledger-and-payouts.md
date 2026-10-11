# Threat model: ledger, payouts and reconciliation

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §T4, §A2.4-A2.9, §15.6, §23 · Target ASVS level: L3 · Modules: `ledger`, `payouts`, `reconciliation`, `refunds`

## Scope and assets
`ledger_accounts`, `journal_entries`, `postings`, seller payable balances, payout instructions (IBAN, P3), PSP settlement files, daily signed snapshots, the audit hash chain. The ledger is the system of record for who is owed what, so integrity outranks availability here.

## What exists in the repo today
- `packages/domain/src/ledger.ts`: `createJournalEntry` rejects entries with fewer than two postings, zero-amount postings, an empty idempotency key, or any currency that does not net to zero; `reverseEntry` negates every posting; `balanceOf` and `trialBalance` derive from postings.
- `packages/domain/src/money.ts`: bigint-only amounts, single rounding point, largest-remainder allocation.
- Tests: `packages/domain/src/ledger.test.ts` and `money.test.ts`, including fast-check properties.
- `packages/db/migrations/0003_ledger.sql`: SQL for the deferred balance trigger (per entry per currency, at least 2 postings), append-only triggers on `postings` and `journal_entries` (UPDATE, DELETE, TRUNCATE rejected), `idempotency_key UNIQUE`, composite FK pinning posting currency to account currency, same-transaction guard for postings. `0007_rls_and_grants.sql` grants `app_user` only SELECT and INSERT on the ledger tables and enables RLS. `0005_audit_log.sql` holds the hash-chained `audit_log`.
- Caveat: these migrations are written but no test in the repo executes them against PostgreSQL yet, so they count as `partial`, not `implemented`.
Everything else (hash chain over journal entries, signed snapshots, payouts, reconciliation, bounded money boundary) is `planned`.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| LED-S1 | S | A service or user posts entries on behalf of another account or actor | Only the ledger module's application service writes entries; postings reference accounts by ID from the chart (typed helpers); caller identity recorded on the entry | LED-T01 dependency-cruiser rule: no module imports ledger persistence except through its public API; LED-T02 posting to an account not in the chart is refused | planned |
| LED-T1 | T | An unbalanced entry reaches the database | Domain validation before persistence plus a deferred constraint trigger summing postings per entry per currency | Domain half: `packages/domain/src/ledger.test.ts` ("rejects an unbalanced entry", "accepts any random set of postings that sums to zero"). DB half: LED-T03 insert an unbalanced set directly via SQL and expect commit failure | partial (domain implemented in `packages/domain/src/ledger.ts`; DB trigger written in `packages/db/migrations/0003_ledger.sql`, not yet executed by any test) |
| LED-T2 | T | Posted entries are edited or deleted | `postings` and `journal_entries` have UPDATE and DELETE revoked from the application role; corrections are reversing entries; the app role cannot disable triggers | Domain half: `ledger.test.ts` ("is fully undone by its reversal, per account and in total"). DB half: LED-T04 UPDATE and DELETE as app role are denied | partial (reversal implemented in `packages/domain/src/ledger.ts`; immutability triggers and grants written in `0003_ledger.sql` and `0007_rls_and_grants.sql`, not yet executed by any test) |
| LED-T3 | T | Silent history rewrite by a privileged DBA or insider | Hash chain over journal entries verified by the integrity job; daily signed snapshot written to WORM storage; chain head also published to a separate account | LED-T05 corrupt one historical row in a test DB and assert the integrity job fails and alerts. Note: the hash chain that exists (`0005_audit_log.sql`) covers `audit_log`, not `journal_entries` | planned |
| LED-T4 | T | Integer overflow or float coercion of amounts at the boundary | Zod parses amounts to bigint at the API boundary with explicit min and max; DB column BIGINT; no JSON number for money | LED-T06 property test: amounts outside int64 range rejected at boundary. Gap: `money()` itself does not bound the range (see below) | planned |
| LED-T5 | T/D | Duplicate posting from a retried saga step or duplicated webhook | `journal_entries.idempotency_key UNIQUE`; domain refuses an empty key; consumers record `message_id` in `inbox_processed` in the same transaction | Domain half: `ledger.test.ts` ("rejects fewer than two postings, zero amounts and a missing key"). LED-T07 replay the same event 50 times and assert one entry | partial |
| LED-R1 | R | A finance operator denies approving a payout, refund or manual adjustment | Dual approval above threshold; approver identities, reason code and before/after diff in the hash-chained `audit_log`; manual journal entries are a distinct `kind` and require two admins | LED-T08 payout above threshold with one approver cannot reach `APPROVED`; LED-T09 each approval writes an audit row | planned |
| LED-I1 | I | IBAN, payout names or ledger exports leak | IBAN field-encrypted (P3) with envelope encryption; masked in UI and logs; exports are dual-approved and logged with reason | LED-T10 serializers never return full IBAN; log scan | planned |
| LED-I2 | I | Cross-seller visibility of balances or statements (BOLA) | Seller endpoints scoped by `app.current_store_id` RLS and policy guard; cross-tenant negative test per endpoint | LED-T11 seller A requesting seller B's statement is 404 | partial (RLS policies on ledger tables in `packages/db/migrations/0007_rls_and_grants.sql`; no cross-tenant test runs yet) |
| LED-D1 | D | Ledger write path stalls checkout | Ledger posting inside the claim transaction with a 2 s statement timeout, isolated pool; reconciliation and integrity jobs run on replicas or off-peak | LED-T12 load test of order-paid posting at 20x baseline within the SLO | planned |
| LED-E1 | E | Payout redirected to an attacker's bank account | IBAN change triggers step-up, cooling-off hold on the next payout, name match against KYC legal name, notification to all seller owners | LED-T13 IBAN change followed by payout within the hold window lands in `ON_HOLD` | planned |
| LED-E2 | E | Payout eligibility bypass (line not CLOSED, open dispute) | State machine with typed invalid-transition error; eligibility computed from order-line state and dispute state in one query | LED-T14 state machine property test: no path to `SENT` without `APPROVED`; payout with open dispute is held | planned |
| LED-E3 | E | Store credit or gift card liability created without backing | Only specific entry kinds may credit `store_credit:*` or `gift_card_liability`, each with a counter-posting to a funded account; trial balance and per-kind invariants checked nightly | LED-T15 fast-check over entry kinds: every credit to a liability account has a matching debit | planned |
| LED-D2 | D/T | Unmatched PSP or courier money goes unnoticed | Nightly reconciliation of PSP settlement files to `psp_clearing`, COD remittances to `cod_clearing`; unmatched lines open a ticket and alert, aging over 3 days escalates | LED-T16 seeded mismatch in a settlement fixture yields a ticket and alert | planned |

## Gaps observed in the current domain code
These are not exploitable yet because no adapter exists, but each must be closed before persistence:
1. `money()` accepts any bigint, including values beyond signed 64-bit. A BIGINT column would reject, but the boundary must reject first with a typed error. Planned: bounded Zod schema and a domain guard.
2. `createJournalEntry` does not validate `id` or `occurredAt`, and does not check account IDs against the chart of accounts (the `chart-of-accounts` module is an empty export in `packages/domain/src/chart-of-accounts/index.ts`).
3. Entries are `readonly` at the type level but the copied postings are not frozen at runtime; immutability at rest depends on database privileges.
4. The idempotency key check only rejects an empty string; there is no format or length bound.
5. `trialBalance` is a pure check over supplied entries; the hash chain and signed snapshot do not exist.

## Decisions and open items
- Flow of funds (aggregator versus PSP split) is undecided (open question 4, register rows 3-4). Controls LED-E1 and LED-E2 assume Z-OUTLET instructs payouts; if the PSP splits at source, the payout module shrinks and reconciliation grows. VERIFY BEFORE LAUNCH.
- Payout approval threshold values are a Finance decision; none assumed.
- Third-party audit of the ledger before the first real payout (spec §T5 pen test before each major money feature).

## Residual risk
A compromised application role that can still insert valid but fraudulent entries is bounded only by authorization, dual approval and reconciliation. Detective controls (reconciliation, anomaly alerts on payable growth) are therefore mandatory, not optional.
