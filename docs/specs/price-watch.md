# Spec: Price Watch: connect the seller's own website and catch fake discounts

Status: draft v1 (2026-11-07), owner request. It extends master prompt §9 (Price Integrity Engine) and follows template A3.
Goal: a seller connects their own website or online store. Outlet NK tracks the prices and items there continuously. A fake discount is **stopped before shoppers see it**, and any later manipulation is **caught within minutes to hours** and handled automatically.

## 1. Core idea: block it first, then keep watching
"Catching" a fake discount after it is live is too late, because shoppers have already seen it and the law is already broken. Price Watch therefore works at three moments:

| Moment | What happens | Speed |
|---|---|---|
| **A. Before publish** | When a seller lists an item or changes a price, the system checks the connected website live. A "% off" with no evidence is never shown. | Instant: the check runs inside the publish step, and its result is on the screen in under 10 s |
| **B. While live** | Watchers re-check the seller's website on a schedule and through webhooks. If the "was" price is fake or the item is cheaper on their own site, the display is corrected **automatically** at once. | Webhook: under 1 min · API poll: 15 min · Crawler: 1–6 h, by risk |
| **C. Over time** | History analysis catches tricks that only show over weeks: raising a price then "discounting" it, ping-pong pricing, re-listing to reset history. | Daily batch plus on every price event |

## 2. Flow

### 2.1 Connect the website (Seller Center → Store design → "Connect your website")
1. The seller chooses a connection type, best first:
   1. **Shopify app** (OAuth, read-only scopes `read_products`, `read_inventory`, plus `products/update` webhooks).
   2. **WooCommerce** (REST keys, read-only, plus webhooks).
   3. **Odoo / other ERP** (P3).
   4. **Product feed URL** (Google Merchant XML/CSV, JSON).
   5. **Website only**, via a polite crawler.
   6. **Instagram/Facebook shop**, through the Meta Commerce API only and only with the seller's authorization. Never by scraping.
2. **Prove ownership** of the domain: a DNS TXT record, a meta tag, or an `/outletnk-verify.txt` file. OAuth counts as proof for Shopify and Woo. An unverified domain cannot be connected, which stops a seller "connecting" someone else's cheaper site.
3. **Consent:** the Seller Agreement clause on monitoring and price parity is shown and accepted (versioned and stored).
4. **First scan:** the system imports the catalog and prices and **matches** them to Outlet NK listings using the §9.2 waterfall (GTIN/SKU → image hash → embeddings → attributes). The seller confirms uncertain matches with one tap.
5. The dashboard shows "Connected ✓", the last sync time, matched items and the **Price Trust Score**.

### 2.2 Before publish (moment A)
When the seller clicks Publish or edits a price:
1. Run a **live fetch** of the matched item on the seller's own site (API call, or a single-page crawl under 10 s).
2. Compute the VRP: the strictest of the internal 30-day low and the external 30-day low.
3. Result on the seller's screen:
   - ✅ **Verified**: the "% off" will show.
   - ⚠ **Not enough history**: the item shows as "Launch price" or "Great price" with no %.
   - ❌ **Your website sells it cheaper (X EGP)**: publishing is blocked until the price is ≤ the seller's own price, or the seller accepts no-% display and a parity warning.
   - ❌ **The "was" price you entered is higher than any real price in the last 30 days**: the entered reference is ignored and the evidence is shown.

### 2.3 While live (moment B)
- **Triggers:** shop webhooks (real time) · API polling every 15 min · crawler every 1–6 h (high-risk sellers and hot items more often; the Drop Hour items re-check 1 h before the drop).
- **Rules checked on every new price event:**
  1. **Fake reference:** our displayed reference > the true 30-day low → auto-correct the display to the VRP at once.
  2. **Pre-discount inflation:** the price was raised on their site or ours within 30 days before the discount → remove the % for 30 days.
  3. **Parity:** their own site price < our price → demote in ranking, notify the seller, 48 h to fix, then auto-pause the SKU.
  4. **Ghost discount:** the "original price" on their site was never actually sold or displayed (it appears only on our listing).
  5. **Stock mismatch:** the item is out of stock on their site but "plenty" here, or the reverse → stock-sync alert. This catches fake scarcity.
  6. **Re-listing to reset history:** a new listing that matches an old one (image hash plus attributes) inherits the old price history.
- Each finding creates an **evidence record**: screenshot, DOM hash, timestamp, URL, fetched price, and the rule that triggered it. It is stored immutably, so a seller cannot later claim we were wrong without proof.

### 2.4 What the seller sees
- A push, WhatsApp and email alert: "We fixed a discount on 'Air Fryer 6L': your site shows 2,450 EGP on 1 Nov, so we can't show 3,600 as the old price. See evidence."
- **Price Trust Score** (0–100) with the reasons and how to improve it.
- **Appeal:** one tap. The seller connects an API or uploads machine-readable evidence, and the claim is re-scored automatically. A human reviews only suspensions (within 5 business days).

### 2.5 What the shopper sees
- Only verified discounts, plus the public **price-proof page**: a price history chart and "We checked this price on the seller's website on {date}".
- **Report price**, which the model takes as a signal and which is rate-limited.

## 3. Enforcement ladder (automatic)
| Event | Action |
|---|---|
| First fake reference | Display auto-corrected, seller educated |
| Inflation before a discount | Badge removed for 30 days, ranking penalty |
| Parity breach | Demote → 48 h → auto-pause SKU |
| 3 violations in 90 days | Lose the "Verified" badge, a commission surcharge (amount = owner decision), drops blocked for 30 days |
| Severe or repeat | Store suspended (human-reviewed), payouts held under the Seller Agreement |
| Disconnecting the website to hide prices | All "% off" removed for that store until it is reconnected (fail closed) |

## 4. Rules and parameters (admin-editable, audited)
- Reference window 30 days. Minimum claim 5%. Match confidence τ = 0.92 to start (⚠ tune on the labelled set).
- Evidence older than 72 h → the claim drops to "no %" (fail closed).
- Crawl politeness: robots.txt respected, ≤ 1 request / 5 s per domain, a declared user agent, and only seller-verified domains.
- Check schedule by risk tier: Trusted (score ≥ 80) every 6 h · Normal every 3 h · Watched (< 50) every 1 h.

## 5. Edge cases
| Case | Handling |
|---|---|
| Seller's site is down or blocks the crawler | Evidence goes stale → "no %" after 72 h. The seller is asked to fix it or connect an API. |
| Site shows prices only after login, or by city | Use the API or feed instead. If there is none, show no % for those items. |
| Different variant or size priced differently | Match at SKU or variant level. Never compare across variants. |
| Prices with/without VAT, shipping included | Normalize to the VAT-inclusive item price. Shipping is compared separately. |
| Coupon-only prices on their site | Counted as their price if public. Logged as an "evidence class". |
| Currency or Eastern Arabic digits | Parser normalizes. Unparseable → no claim. |
| Seller has no website | Only internal history plus document evidence (capped at 30% off). Shown as "Launch price" until 30 days of history exist. |
| Brand outlet vs franchise site (different legal sellers) | Only the seller's own verified channels count for parity. Brand RRP is a separate labelled class (§9.2). |
| Seller edits their own site to fake a high "was" price | The history keeps the real lowest price. Inflation within 30 days resets the reference to that low. |

## 6. Data
| Table | Key columns | PII |
|---|---|---|
| `channel_connections` | id, store_id, type, domain, verify_method, verified_at, oauth_token_ref (KMS), status, consent_version | P1 |
| `channel_snapshots` (partitioned daily) | id, connection_id, external_ref, price_piastres, compare_at, in_stock, fetched_at, dom_hash, screenshot_ref, method | P1 |
| `product_matches` | outlet_sku_id, external_ref, method, confidence, model_version, confirmed_by | P1 |
| `price_events` | sku_id, price, valid_from, valid_to, source, actor | P0 |
| `price_claims` | sku_id, vrp, evidence_ids[], trust_score, status | P0 |
| `price_findings` | id, sku_id, rule, severity, evidence_ids[], detected_at, action_taken | P1 |
| `enforcement_actions` | id, store_id, finding_id, action, expires_at, appeal_status | P1 |

## 7. API (auth scope · idempotent · rate limit)
- `POST /v1/seller/channels`: connect (seller:manager) · idem · 10/h
- `POST /v1/seller/channels/{id}/verify`: run the domain check · 20/h
- `GET /v1/seller/channels/{id}/matches` · `PATCH …/matches/{id}` (confirm or reject)
- `POST /v1/seller/listings/{id}/price-check`: pre-publish live check · 60/min per store
- `GET /v1/seller/price-trust`: score plus findings
- `POST /v1/seller/price-findings/{id}/appeal` · idem
- `POST /v1/webhooks/shopify|woocommerce`: HMAC-verified
- `GET /v1/products/{id}/price-evidence`: public proof summary (no seller internals)

## 8. Events
`channel.connected`, `channel.verification_failed`, `channel_snapshot.ingested`, `price.changed`, `price_claim.scored`, `price_finding.detected(rule)`, `price_enforcement.applied`, `price_appeal.resolved`.

## 9. Failure handling
- Crawler and API calls: timeout 10 s, 3 retries with backoff and jitter, then DLQ.
- Persistent failure → stale evidence → fail closed (no %).
- Webhook gaps of more than 2 h → fall back to polling.
- A kill switch on the crawler (§A2.12). Disabling it makes every claim fall back to internal history only.

## 10. Security and abuse
- **SSRF (API7):** only verified domains, private IP ranges blocked, DNS-rebinding guard, egress through a dedicated proxy, no internal credentials.
- OAuth tokens live in KMS, read-only scopes, and sellers can revoke them at any time.
- Untrusted HTML/text from seller sites: the parser is sandboxed, and the LLM receives it only as data (LLM01).
- **Abuse vectors:**
  - Connecting a competitor's site → blocked by domain verification.
  - Cloaking (showing our crawler different prices) → random user agents within policy, plus spot checks from residential egress ⚠ legal review, plus shopper "report price".
  - Rapid price flipping between checks → webhooks plus history.
- **Legal:** monitoring rests on seller consent in the Seller Agreement. Only the seller's own channels are monitored. No scraping of third-party marketplaces or Instagram outside the official APIs. ⚠ VERIFY with counsel.

## 11. Metrics
- % of listings with a connected channel (target ≥ 60% of GMV by month 6).
- Time to detect: webhook p95 < 1 min, crawler p95 < 6 h.
- Fake-discount displays reaching shoppers ≈ 0.
- Appeals upheld < 2%.
- Seller churn caused by enforcement (guardrail).

## 12. Acceptance (become E2E and property tests)
- *Given* a seller whose site sold the item at 2,450 EGP within 30 days, *when* they list it here with "was 3,600", *then* no % is shown and the evidence is displayed to the seller.
- *Given* a connected Shopify store, *when* its price drops below ours, *then* within 1 minute the SKU is demoted and the seller is notified. After 48 h unfixed, it is paused.
- *Given* the seller's site is unreachable for 72 h, *then* all their "% off" badges disappear.
- *Given* a domain without verification, *then* connection is refused.
- **Property test:** for any sequence of prices across both channels, the displayed reference never exceeds the true 30-day minimum.

## 13. Phasing
- **MVP:** Shopify plus WooCommerce connectors, product feed URL, domain verification, pre-publish check, auto-correction, parity rule, evidence records, Trust Score.
- **V2:** website crawler with image matching, cloaking spot checks, re-list detection, Meta Commerce API.
- **V3:** Odoo and other ERPs, and the anomaly ML model (isolation forest).

## 14. Verify register rows
- **V27:** legality of monitoring seller websites with contract consent, and of residential-IP spot checks.
- **V28:** whether a "commission surcharge" as a penalty is enforceable under the Seller Agreement.
