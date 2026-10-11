# Spec 09: Aramex adapter, hub consolidation, returns-resale lane

Refs: §21, §22, §28 (rows 6, 16), §B5, VR-11, ADR-0021 (COD). Phase 2. Extends `docs/specs/fulfillment.md` and `returns.md`.

## Part A: Aramex adapter (`CourierPort`)
**Flow:** shipment created -> adapter creates AWB (idempotent with shipment id) -> label A6 PDF -> pickup -> tracking webhooks/poll normalised to Z-OUTLET statuses -> delivered with proof -> COD collected -> remittance -> reconciliation.
**Rules:** courier choice by governorate SLA, cost, seller preference; Bosta remains default, Aramex as second and failover; ETA promise uses p80 transit time per courier x governorate; 3 attempts then RTO. Adapter conforms to the existing port contract suite (same tests as Bosta, plus Pact for Aramex). Response schemas Zod-validated; timeouts 10 s, circuit breaker.
**Edge:** AWB creation down -> queued, seller sees "label pending"; webhook gap > 48 h -> poll; COD remittance mismatch -> finance alert; replay of webhooks idempotent (dedup by courier event id); unsupported governorate -> adapter returns typed `NotCovered`.
**Blocked:** VR-11 (API spec, COD cycle, fees) and sandbox credentials.
**Acceptance:**
```
Given replaying all Aramex webhooks twice, Then shipment state is identical.
Given Bosta unavailable, Then new shipments route to Aramex where the governorate is covered.
Given a COD shipment, Then remittance reconciles against cod_clearing with no unmatched lines after the import.
```

## Part B: Hub consolidation
**Flow:** multi-seller order -> each SellerOrder ships to the Z-OUTLET hub (cross-dock) -> QC/scan -> one outbound parcel and one delivery fee to the shopper.
**Rules:** delivery fee allocated once to the OrderGroup; seller handoff SLA to hub 48 h; hub scan states `AT_HUB_EXPECTED -> RECEIVED -> CONSOLIDATED -> DISPATCHED`; partial arrival: dispatch what is ready only if shopper preference "ship together" is off (default ship together up to 72 h wait, then split with fee waived); hub operator role with scoped access; fee and ledger: `shipping_revenue` single posting, consolidation cost expense account added in chart of accounts.
**Edge:** one seller late -> split shipment, fee refunded to the shopper if charged twice; damaged at hub -> hub liability vs seller per Seller Agreement; return of consolidated parcel -> per-line return still by seller order.
**Data:** `hubs(id, name, governorate)` P1 · `hub_receipts(shipment_id, seller_order_id, scanned_at, operator_id, condition)` P1 · `consolidated_shipments(id, order_group_id, seller_order_ids[], awb, status)` P2 · extend `shipments.seller_order_ids[]` (already array).
**API:** `POST /v1/hub/receipts` (hub operator, idem, 120/min) · `POST /v1/hub/consolidations/{id}/dispatch` (hub operator, idem) · `GET /v1/me/orders/{id}/tracking` shows a single parcel.
**Metrics:** cost per order, parcels per order, hub dwell time p95, gCO2e per shipment. **Kill switch:** `hub_consolidation`.
**Acceptance:**
```
Given orders from 3 sellers, Then one outbound parcel and one delivery fee.
Given one seller misses the 72 h window, Then the rest dispatch and the second fee is waived.
Given a hub operator scans a seller order of another hub, Then 404.
```

## Part C: Returns-resale lane ("Open-box returned")
**Flow:** return inspected `PASS` by seller or hub QC -> seller opts in (or hub-owned stock under return-to-vendor terms) -> condition grading (A like-new, B minor wear, C defect disclosed with photos) -> relisted in a dedicated lane with `condition = open_box_returned`.
**Rules:** original price evidence unaffected; relisted item has **no % off** claim against the original VRP (it is a different condition: plain price or a Launch price label), enforced by price-integrity contract test; condition + photos mandatory; standard return rights apply (14/30 days) to the new buyer; hygiene categories excluded; inventory enters via a new `inventory_units` pool tagged `condition_grade`; separate SKU variant so size recommendations and fit feedback stay clean; sustainability counter counts only real sold units.
**Edge:** grade dispute by buyer -> defect return 30 days; return of resold item loops once only (second return -> not relisted); seller declines resale -> returned to seller as today.
**Data:** `resale_listings(id, return_id, sku_id, grade, photos[], price, status)` P0/P1.
**API:** `POST /v1/seller/returns/{id}/resale` (seller, idem) · `GET /v1/search?condition=open_box_returned`.
**Events:** `return.relisted`, `resale.sold`.
**Metrics:** recovery rate, resale sell-through, return rate of resale items (guardrail). **Kill switch:** `returns_resale`.
**Acceptance:**
```
Given an inspected return graded B, Then a listing exists with condition open_box_returned, photos, and no strike-through price.
Given a hygiene category, Then resale is refused.
Given a second return of the same unit, Then it is not relisted.
```
