# @outlet/pricing-integrity

Price Watch, step P1-03a: internal price evidence only (external channels and the crawler are P1-03b+). Migration `0012_price_events.sql`.

- `domain/`: `computeWindow`, `vrpFromInternal`, `discountPct` (integer floor on minor units), `claimAllowed` (>= 5%), `displayDecision` (brand mode public / member_only / hidden).
- `application/`: `PriceEventIngestor` (consumes `price.changed` through the inbox, closes the open row and opens a new one in one tx, refreshes `sku_price_windows`), `PriceSnapshotService.snapshotForOrderLine`, `PriceEvidencePublic.get`.
- Reference rule: lowest price in the 30 days before the FIRST reduction of the current run of decreases; only with >= 30 days of history before that reduction and a run that started within the last 30 days. A price that went back up ends the run (reference resets). Launch items (< 30 days) never get a percentage.
- Kill switch `pricing.price_watch` (register it in `@outlet/flags` as a money-class, fail-closed switch): killed or unreadable means plain prices everywhere; ingestion keeps recording evidence.
- `sku_price_windows` is a maintained table (one targeted upsert per event), not a materialized view. Its low is exact as of `updated_at`; shopper-facing reads recompute from events at `now`.
