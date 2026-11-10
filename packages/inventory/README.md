# @outlet/inventory

Row-per-unit reservations (ADR-0005). Fungible SKUs keep a pool of `available` rows; serialised SKUs hold graded one-off units
(`defect_card_id` set). A SKU is one kind or the other: the fungible picker filters `defect_card_id IS NULL`, the service refuses
mixing and trigger `inventory_units_no_mix` (migration 0013) is the backstop.

## Lock order (deadlock avoidance)

Every transaction that touches a SKU acquires locks in this order:

1. `pg_advisory_xact_lock(hashtext(sku_id))` (`SKU_LOCK_SQL`): taken first by `adjustOnHand` / `addSerializedUnit` (in `core()`) and by `replenishIn`. Re-entrant within a transaction.
2. `inventory_levels` row (`FOR UPDATE` in `core()`, `UPDATE` in claim / pool_target).
3. `inventory_units` rows (`FOR UPDATE SKIP LOCKED` in the reserve pick, which never waits).

Multi-SKU reservations sort (sku_id, location_id) before locking. Never take the level row lock and then the advisory lock.
