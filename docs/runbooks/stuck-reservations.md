# Runbook: stuck reservations and the expiry sweeper

Owner: Commerce on-call. Sev2; Sev1 during a mega event or if checkout reserve latency SLO burns. Design: row-per-unit pool, SKIP LOCKED, TTL 10 min (ADR-0005, ADR-0011).

## What exists
- `SweepExpiredReservations` (`apps/api/src/modules/inventory/application/lifecycle.ts`): one batch per call, returns `SweepResult`; designed to be scheduled every 30 s and called again while `expiredReservations === batch`. `ReplenishPools` tops pools up. Providers: `INVENTORY_SWEEP_EXPIRED`, `INVENTORY_REPLENISH_POOLS` in `inventory.module.ts`.
- Proven by `inventory/test/application.test.ts` ("expiry returns stock...", "release after claim is a no-op"), `kysely-store.pglite.test.ts`, and `tooling/db/inventory-concurrency.sh` (concurrency on real PG16 when run).
- NOT available: pg_cron or any scheduler entry that invokes the sweeper in this repository (the spec's pg_cron job is not defined in migrations; VERIFY). Without it, expired holds are not returned.

## Detect
Available stock lower than `on_hand - committed`, PDP "sold out" while units sit `reserved` past `expires_at`, reserve p95 SLO burn (`tooling/observability`).
```sql
select sku_id, count(*) from inventory_units where state='reserved' and expires_at < now() group by 1 order by 2 desc limit 20;
select count(*) from inventory_units where state='reserved' and expires_at < now() - interval '5 minutes';
```
(Verify table and column names against `packages/db/migrations/0016_inventory.sql`.)

## Act
1. Check the scheduler is alive; if not, run the sweeper manually from an engineer script in batches of 500 until the result shows fewer than batch.
2. Paid orders must not lose stock: claim is idempotent and a late payment auto-claims or refunds. Do not hand-release `claimed` units.
3. Long Fawry holds (24 h, separate pool) and wallet holds (30 min) have their own TTLs (ADR-0011); do not shorten them to fix a drop.
4. Pool exhausted but `on_hand` fine: run `ReplenishPools`; for a hot SKU rely on the single inline replenisher under advisory lock.
5. Connection exhaustion (Shopify lesson, spec §20.2): check PgBouncer saturation and `application_name=checkout.reserve` pool isolation; statement timeout 2 s on reserve path (VERIFY configured).

## After
Add the SKU/pattern to the chaos or concurrency script; record oversell count (must be 0).
