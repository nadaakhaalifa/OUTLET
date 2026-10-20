# Spec: Money and ledger domain core

Phase 0 · Spec refs: §A2.4, §A2.5, §A2.6, §T4 · Status: Draft for review

## Flow
Pure functions only. No I/O, no clock, no randomness. Persistence, idempotency storage, the deferred database trigger and outbox are adapters built later (§A2.3).

## Rules
1. **Money** is `{ amount: bigint, currency }`, amount in minor units (piastres for EGP). Floats are never used. Currency is always carried. Arithmetic across currencies throws.
2. **Rounding** happens at one documented point, `divideRoundHalfEven`, using banker's rounding (§A2.4). Percentages are expressed in basis points and multiplied through that point.
3. **Allocation** splits a total by weights so that parts sum exactly to the total.
4. **Journal entry**: at least 2 postings, no zero-amount posting, postings sum to zero **per currency**. Sign convention: positive is debit, negative is credit.
5. **Entries are immutable.** A correction is a reversing entry that negates every posting and references the original.
6. **Idempotency key** is mandatory on every entry. Uniqueness is enforced by the persistence adapter.
7. **Balances** are derived from postings, never stored as the truth (§15.2).

## Options compared
**Rounding.** Half-up is simpler but biases totals upward over many lines. Half-even is unbiased and is already mandated by §A2.4. Chosen: half-even.

**Allocation.** Giving the whole remainder to the last part is simple but systematically penalises one party (for example one seller). Largest remainder is fair and deterministic, with ties broken by index. Chosen: largest remainder.

## Edge cases
- Negative totals allocate on the absolute value and negate, so refunds mirror charges exactly.
- Zero-weight parts never receive a remainder unit.
- Empty weights, negative weights, or all-zero weights throw.
- Mixed-currency entries are allowed only if each currency balances on its own.

## Data (mapped later by the persistence adapter)
`ledger_accounts`, `journal_entries(idempotency_key UNIQUE)`, `postings(amount BIGINT signed)` per §T4. PII class: P1 (internal).

## Failure handling
Invalid input throws a typed `DomainError` subclass. Nothing is partially applied because entries are built whole and validated before use.

## Security & abuse
No external input reaches this layer unvalidated. Zod at the API boundary converts strings to bigint before calling in.

## Acceptance
- Allocation always sums to the total (property test).
- Any entry that does not balance per currency is rejected (property test).
- Reversing an entry yields zero net per account.
- The §T4 "order paid" worked example balances to zero, with 14% VAT on commission computed exactly.

## Open items
- Mutation testing at 80% (Stryker, §A2.10) is required for this module and is not yet wired in CI.
- Account chart is only partially modelled here (naming helpers). The full chart of accounts is a separate P5 deliverable.
