# Ops gap endpoints, part D (resale, hub, stylist inclusion, seller me)

Spec written before code. Owner modules: resale-lane, hub-consolidation, stylist, seller-analytics.

## Routes
| Route | Audience / policy | Notes |
|---|---|---|
| GET /v1/admin/resale/listings | admin_api, `admin_console` read, roles ops/finance/trust_safety/super_admin (else 403) | Keyset on (listed_at, id) desc, `status` filter, `limit` <= 50, malformed cursor 400, money `{amount_minor,currency}`. |
| GET /v1/admin/hub/consolidations | same | Parcels newest first. Ids, status, AWB, courier, shopper fee, gCO2e estimate (labelled estimate). No recipient data. |
| GET /v1/seller/hub/consolidations?order_group_id= | seller_api, `store_order` read (first store resolver), rows filtered to ALL stores in the caller's grants | Keyset on seller_order_id. Seller sees only its own seller orders and the parcel status/AWB. No buyer name, phone, address or user id. Another seller's order group returns an empty page, indistinguishable from a missing one. |
| GET /v1/seller/stylist/inclusion | seller_api, `store_order` read | Per store of the caller over `[from,to)` (default 30 days, max 366). A store with fewer than 50 distinct shoppers is `suppressed:true` and every figure is null (k-anonymity, §19.1). Suppression is applied in the application layer, never in SQL. |
| GET /v1/seller/me | seller_api, `store_product` read (any brand role) | `{user_id, memberships:[{store_id, role}]}` from token grants only. |

## Data
No new tables. `ResaleStore.listAll`, `HubStore.listParcelsPage`, `HubStore.listLegsForStores`, `StylistStore.inclusionByStore` are added to the ports and implemented by both the in-memory and Kysely adapters, and covered by the shared store contract suites (in-memory and PGlite).

## Threats
- BOLA: seller routes derive the store set from the token, never from the request; non-owned data is absent, not 403.
- Re-identification: stylist aggregates are suppressed under k=50; raw counts never leave the use case.
- PII: hub views expose no P2/P3 fields (tested by key scan).
- Wrong audience: 401. Missing role: 403.

## OpenAPI
Also tightens the size-curve response to `SellerSizeCurveReport` (real shape from adapters/wire.ts).
