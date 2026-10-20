# Runbook: ledger imbalance or integrity-job failure

Owner: Finance engineering. Roles: incident commander, finance lead (read), DBA/on-call (Postgres). Sev1 always (spec: ledger imbalance is a Sev1 example in incident-response.md).

## What the check does
`IntegrityJob` (`apps/api/src/modules/ledger/application/integrity-job.ts`, exposed as `INTEGRITY_JOB` in `ledger.module.ts`) returns `{ ok, trialBalance, chain, storeCredit }` from one consistent snapshot: trial balance per currency equals 0, hash chain verified from genesis in pages, store-credit projection versus postings. It never throws on a finding; it returns `ok: false`.

NOT available (2026-10-11): a scheduler or alert that runs it nightly or intraday, and an admin route to run it. Run it from an engineer-run script until wired (launch blocker, VERIFY owner decision). Domain proof: `packages/domain/src/ledger.test.ts`; DB proof: `ledger/adapters/kysely-store.pglite.test.ts` (unbalanced entry refused by the database, chain append-only and fork-refusing).

## Response
1. Declare Sev1. Freeze: turn off money-moving capabilities: kill switches for payment methods and `kill.referral_payouts`, `kill.gift_card_sales` (kill-switches.md); hold all payouts (`POST /v1/admin/finance/payouts/{id}/hold`, roles finance/ops, dual approval rules apply).
2. Classify the finding:
   - Trial balance non-zero: should be impossible (deferred constraint trigger, migration `0003_ledger.sql`/`0031_ledger_posting.sql`). Suspect trigger disabled, a restore, or a migration run without it. Compare with `tooling/db/run-on-postgres16.sh` results on a scratch restore.
   - Chain break: identify first bad `seq`; never rewrite. Preserve a snapshot (pg_dump of ledger tables) before anything else.
   - Store-credit drift or negative balance: list the rows from the report; check `composition/credit-balances.ts` projection and recent refunds.
3. Correct only by reversing or adjusting entries via the posting service (`ledger/application/posting-service.ts`), each with an idempotency key, a finance reason, and dual approval. Never UPDATE/DELETE postings (revoked grants).
4. Re-run the job; require `ok: true` before lifting the freeze.
5. Notify DPO only if personal data is involved (breach.md). Finance owner decides external notifications (PSP, sellers).

## Evidence for the post-mortem
Report JSON, snapshot time, first bad entry, correcting entry ids, timeline, root cause, regression test added to `ledger/adapters/*.pglite.test.ts`.
