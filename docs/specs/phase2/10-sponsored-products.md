# Spec 10: Sponsored products (CPC)

Refs: §4 (sponsored rules), §19, §20.5, `docs/specs/search.md` (cap rule exists). Phase 2.

## Flow
Seller Center -> Marketing -> Sponsored: pick SKUs, daily budget, max CPC, optional keywords/categories -> campaign runs -> auction fills sponsored slots in search results and category pages -> seller sees spend, clicks, ROAS.

## Rules
- Labelled "Sponsored" (`sponsored: true`); **max 2 in first 10 global-ranked results** (existing cap logic in search is authoritative; ads module only supplies candidates). Sponsored item must pass the same filters, stock, size and age gates.
- Auction: generalized second price with quality score = relevance x seller health x price trust; ties by earliest bid. Option comparison: GSP vs first-price vs fixed rate card; GSP default for stability. Floor price admin-configured.
- **Targeting never uses budget, measurement or other P3 data**; only query, category, store scope, locale (lint: `ads` cannot import `budget`, `sizing` measurements).
- Prepaid ad balance (seller wallet, closed-loop, not shopper-facing): top-up through PSP, ad spend is a B2B service so ETA e-invoice with VAT 14% (VR-B4); ledger accounts `ads_prepaid_liability:{store}`, `ads_revenue`, `platform_vat_output`. Budget caps enforced atomically; invalid click filtering with credit-back.
- Sellers with active price enforcement (suspension, auto-pause) cannot run ads; paused SKU stops serving.
- Click: server-issued signed click token, dedup per user/device/ad per window, bots filtered; billed on valid click only.
- Admin kill switch `sponsored_products`; frequency cap per user; no sponsored items in My Stores scoped results unless store is in scope.

## Edge cases
Budget exhausted mid-day -> stops; two campaigns same SKU -> best bid; seller balance negative via refunds -> campaign paused; timezone day reset Cairo; click during outage -> not billed; ad for item that became out of size for shopper -> filtered.

## Data
`ad_campaigns(id, store_id, status, daily_budget, max_cpc, keywords[], starts, ends)` P1 · `ad_sku_bids(campaign_id, sku_id, bid)` P1 · `ad_impressions(partitioned; id, campaign_id, query_hash, position, ts)` P1 (no user id; pseudonymous session) · `ad_clicks(id, campaign_id, token_jti, valid, cost, ts)` P1 · `ad_balances(store_id, balance)` P1.

## API
`CRUD /v1/seller/ads/campaigns` (seller finance/marketing role, RLS, idem on writes, 30/min) · `POST /v1/seller/ads/topup` (idem, 5/h) · `GET /v1/seller/ads/reports` · internal `POST /v1/ads/select` (service only) · `POST /v1/ads/click` (shopper token, 60/min) · admin `PUT /v1/admin/ads/config` (dual approval).

## Events
`ad.impression`, `ad.click_valid`, `ad.budget_exhausted`, `ad.balance_topped_up`.

## Failure handling
Ads service down -> search returns organic only; balance posting idempotent on click id; reconciliation daily clicks vs ledger.

## Security and abuse
Cross-tenant negative tests on every seller endpoint; click fraud (competitor drain) detection; self-click; token replay.

## Metrics
Ad revenue, fill rate, CTR, seller ROAS, organic CTR guardrail, complaint rate.

## Acceptance
```
Given 5 sponsored candidates in the top 10, Then at most 2 appear in the first 10, labelled Sponsored.
Given a campaign with budget exhausted, Then it is not served.
Given the same click token twice, Then billed once.
Given seller A requests seller B campaign, Then 404.
Given ads imports budget module, Then CI fails.
```
