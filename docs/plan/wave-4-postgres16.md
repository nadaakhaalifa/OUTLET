# Wave 4: real PostgreSQL 16 verification

Date: 2026-10-11 · Server: PostgreSQL 16.13 (Postgres.app) · Commands: `tooling/db/run-on-postgres16.sh`, `RUNS=20 tooling/db/inventory-concurrency.sh`

## What changed
- `run-on-postgres16.sh` already globs `packages/db/migrations/*.sql` (sorted) and applies whatever exists at run time; it reports "applied N, files present M". Its trap stops the cluster it started and deletes the work dir (checked: no postgres process left after the run).
- `pg16-verify.mjs` gained three sections: referral cap race, wishlist cross-owner save, and a foreign-tenant RLS sweep (run in a throw-away `outlet_rls` copy of the DB, CHECK constraints dropped there so one synthetic row per table can be seeded with triggers and FKs skipped; the copy is dropped afterwards).
- No migration or module file was edited.

## Migrations
34 of 34 files present at run time applied cleanly on 16.13 (0001 to 0034). 0035 did not exist during the run. `pg_cron` is absent in Postgres.app (0001 continues with a NOTICE), so sweeper jobs were called directly.

## Results: 89 checks passed, 0 failed (final run); inventory script 20/20 runs passed

| # | Scenario | Actual result |
|---|---|---|
| a | Inventory, 100 units, 10,000 attempts, 100 pooled connections (pg16-verify) | 100 claimed, 9,900 insufficient, 0 errors, 0 deadlocks; 3.3 s; reserve p50 19 ms, p95 89 ms, p99 166 ms; committed = claimed, no leaked reservations |
| a | `inventory-concurrency.sh`, 20 runs x 10,000 attempts (modes A to E: warm pool, inline replenish, churn, sweeper storm, seller sync storm) | 20/20 ok, 200,000 attempts, 100 claimed every run, 0 oversold, 0 x 40P01, 0 server-side deadlock or ERROR log lines; reserve p50 9.3 ms, p95 17.9 ms, p99 32.4 ms; 23.3 s |
| b | Cart: 40 concurrent saves at version 0 | exactly 1 wins, 0 errors, 1 line, version 1. Also 80 concurrent line inserts: 50 stored, 30 rejected 23514; 20 getOrCreate: 1 cart |
| c | Referral cap 2, 6 concurrent settles (SQL transcribed from `KyselyReferralStore.settle`: inbox insert, per-referrer advisory lock, recount, guarded update) | with lock: rewarded 2, rejected(cap_reached) 4, 0 errors; redelivery of all 6 message ids: 6 duplicates, no change. Negative control without lock: rewarded 6 (race is observable) |
| d | Notification frequency cap 3, 60 concurrent reserves | with advisory lock: admitted 3, stored 3, 0 errors. Without lock: 60 (control) |
| e | Push token partial unique index, 20 users same token | 1 active row, 0 caller-visible 23505. 20 re-registrations of one (user, install): 1 row. The wave-3 23505 bug is no longer reproduced |
| f | Wishlist cross-owner save | B into A's list claiming A: 42501 (RLS). Claiming B: 23503 (composite FK). `system` with mismatched owner: 23503. B sees 0, updates 0, deletes 0 of A's items. 20 concurrent cross-owner saves all rejected |
| g | Ledger | unbalanced entry rejected at COMMIT (no rows left); balanced commits; UPDATE/DELETE/TRUNCATE on postings and UPDATE on journal_entries rejected; late posting rejected; duplicate idempotency key rejected; trial balance 0; app_user has no UPDATE grant on postings |
| h | RLS foreign tenant sweep, 33 tables (stores, store_activity_events, user_favorite_stores, order_groups, seller_orders, order_lines, order_buyer_contacts, order_status_history, returns, return_evidence, return_disputes, returner_standing, seller_analytics_facts/stock/freshness, shipments, tax_documents, carts, cart_lines, wishlists, referrals, refunds, credit_lots, payment_intents, checkout_sagas, reviews, promotion_redemptions, size_profiles, saved_searches, notification_preferences, dsar_requests, inventory_levels, price_claims) | foreign customer, foreign seller (other user and store ids) and anonymous sessions all see 0 rows on every table with a seeded row |

## Caveats
- RLS sweep is a negative test on synthetic rows (all-`x` strings, CHECKs dropped in the copy). Positive controls (owner sees own row) matched for 28 tables; they returned 0 for `stores`, `store_activity_events`, `cart_lines`, `return_evidence`, `return_disputes` because synthetic keys do not join to the owner. That is a seeding limit, not a leak finding, but those five have no verified positive path here.
- Referral, cart, notification and push-token SQL is a transcription of the Kysely adapters, not the adapters themselves (TypeScript, not executable from the node script). The referral emit-to-outbox step was left out.
- One machine, local TCP, trust auth, no PgBouncer. Not a production load test.
- Migrations 0035+ not covered; rerun the script when they land.

## Bugs found
None new in this wave. The wave-3 push-token 23505 finding no longer reproduces with the advisory-lock upsert.
