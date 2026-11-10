# @outlet/ledger

Double-entry ledger (spec: `docs/specs/ledger-chart-of-accounts.md`; schema: migration `0008_ledger.sql`).

## Invariants enforced by the database
- Every entry balances to zero per currency at COMMIT and has at least two postings (deferred constraint triggers).
- Entries are closed after commit: `journal_entries.txid` (xid8) must equal `pg_current_xact_id()` for any posting insert, so balanced postings cannot be added to an old entry later.
- Postings and journal entries are immutable (UPDATE, DELETE, TRUNCATE rejected). All guard triggers are `ENABLE ALWAYS`, so `session_replication_role = replica` does not disable them.
- `store_credit` sub-balances are enumerated (`refund_credit`, `gift_card`, `cashback_coins`, `referral_credit`, `goodwill`) in TypeScript and in a CHECK. `market_id` is two capital letters.
- `journal_entries.note` holds the reversal reason (outside the content hash).

## Deviation from DM-15 (A2): per-market serialisation
Writers take `pg_advisory_xact_lock(hashtextextended('ledger:' || market, 0))`, held until commit or rollback, so the per-market hash chain has a single head. Throughput ceiling: ONE ledger-writing transaction per market at a time (the checkout webhook path posts serially per market). Fine at Phase 1 volume; before mega-events either keep ledger transactions tiny (post last, no external calls inside) or move to sharded chains.

## Roles
`outlet_app` has explicit SELECT and INSERT on `ledger_accounts`, `journal_entries`, `postings` (no UPDATE/DELETE/TRUNCATE; `assertRuntimeRole` enforces it). Each post also appends an outbox event, which RLS pins to the context market: a post under another market's context fails.
