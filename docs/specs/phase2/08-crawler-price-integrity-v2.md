# Spec 08: Crawler and image matching (price integrity v2)

Refs: §9.2, §9.3, §T3, §T5 (API7), ADR-0013, ADR-0027, VR-13. Phase 2. Extends `docs/specs/price-integrity.md`.

## Flow
Seller verifies a domain (DNS TXT or file) and consents -> crawler schedules daily snapshots (price, availability, DOM hash) -> matcher links external product to Z-OUTLET SKU -> evidence feeds VRP -> claim scored automatically; stale evidence fails closed to plain price.

## Rules
- Domains: only seller-verified domains plus approved brand-RRP list. robots.txt honoured (cached 24h; disallow = skip and record), per-domain rate <= 1 req / 5 s, conditional GET (ETag / If-Modified-Since), DOM hash change detection, identified User-Agent.
- Egress: dedicated isolated segment and allow-listed proxy (ADR-0027); no internal credentials, no metadata endpoints.
- **SSRF guard:** resolve DNS server-side, reject private/loopback/link-local/metadata ranges, pin resolved IP for the connection (DNS-rebinding guard), re-validate on every redirect (max 3), HTTPS only, response size and time caps, content-type allow-list.
- Matching waterfall: GTIN/EAN/seller SKU exact -> pHash/dHash near-duplicate -> CLIP/SigLIP ANN -> LLM attribute check (seller text untrusted, LLM01) -> calibrated classifier `match_conf`. Only `match_conf >= tau` counts.
- **tau tuning:** start 0.92; build a 2,000-pair labelled Egyptian set (stratified by category, brand, seller; 20% hard negatives: same style different colour/size run); double-labelled, kappa >= 0.8; choose tau on a validation split for precision >= 0.98 with recall reported; test split untouched; recalibrate (isotonic) per model version; tau change is an admin-audited config with shadow-mode comparison for 7 days. Until the set exists (VR-13), external evidence is **shadow only** and VRP uses internal ledger only.
- Evidence staleness: > 72 h -> claim degrades to plain price. Cross-channel parity: external cheaper than Z-OUTLET -> demotion, 48 h to fix, then auto-pause (§9.3).
- Fraud/anomaly detectors per §9.4 (isolation forest, ping-pong pricing, image reuse across sellers).
- Document evidence alone never justifies more than 30% off.
- Model cards and drift monitoring for embedding/classifier; shadow deploys.

## Edge cases
Site blocks bot -> backoff, mark `unreachable`, no penalty to seller; JS-rendered pages -> headless pool in the isolated segment with CPU/time caps; currency/VAT-inclusive vs exclusive normalisation; variant selectors; geo-priced sites; seller revokes OAuth -> alert; honeypot/robots trap links never followed.

## Data
`crawl_targets(id, seller_id, domain, verified_at, robots_cache, status)` P1 · `channel_snapshots(partitioned daily; sku_ref, price, avail, dom_hash, fetched_at)` P1 · `product_matches(haul_sku, external_ref, method, conf, model_version)` P1 · `match_labels(pair_id, labels[], split)` P1 · `price_claims`, `price_events`, `enforcement_actions` (existing).

## API
`POST /v1/seller/channels` (seller owner, idem, 10/h) · `POST /v1/seller/channels/{id}/verify-domain` (5/h) · `POST /v1/seller/price-claims/{id}/appeal` (idem, 5/day) · `GET /v1/seller/price-trust` · `GET /v1/products/{id}/price-evidence` (public summary) · admin `POST /v1/admin/matching/threshold` (dual approval).

## Events
`channel_snapshot.ingested`, `product_match.scored`, `price_claim.scored`, `price_enforcement.applied`, `crawler.target_blocked`.

## Failure handling
Per-domain circuit breaker; retries exp backoff + jitter max 3; DLQ for parser errors; stale -> fail closed; queue depth alarms.

## Security and abuse
Crawler has no access to production DB (writes through ingest API); secrets never in crawler; SSRF tests with rebinding fixtures; seller-supplied URLs validated; matching LLM output schema-validated; seller gaming (planting fake external pages) mitigated by domain verification + cross-source check.

## Metrics
% listings with verified claims, auto-corrections, appeals upheld < 2%, matcher precision on labelled set >= 0.98, crawler success rate, politeness violations = 0.

## Acceptance
```
Given a URL resolving to 169.254.169.254 or a DNS record that rebinds to 10.0.0.1, Then the fetch is refused and logged.
Given robots.txt disallow, Then no request to the path.
Given 2,000 labelled pairs, Then precision at the chosen tau >= 0.98 on the held-out test split.
Given evidence older than 72 h, Then the product shows a plain price.
Given a price raised then cut within 30 days, Then no claim exceeds the true 30-day minimum (property test).
Given rate-limit config 1 req/5 s, Then no domain sees > 12 req/min.
```

## Addendum: incident and parity read APIs, ad click review

- `GET /v1/admin/price-crawler/incidents` (admin: ops, trust_safety, security, super_admin), `GET /v1/seller/crawl-incidents?store_id=` (owner, manager of that store; a foreign store is 404). Rows carry kind, host, detail, time only (never URLs). Keyset cursor `(created_at desc, id desc)`, limit max 50, an invalid cursor is 400.
- `GET /v1/seller/parity-warnings?store_id=` reads open `cross_channel_cheaper` findings through `ParityWarningsPort` (adapter over price-integrity's public `trustForStore`; this module imports nothing from it). `fix_deadline_at = opened_at + 48h`; after it price-integrity auto-pauses the SKU. Wire up with `new PriceIntegrityParityAdapter(priceIntegrityService)` in the `parity` option.
- Ads: `GET /v1/admin/ads/invalid-clicks` lists unreviewed invalid clicks with a fraud reason (too_fast, duplicate_window, burst, self_click, bot, campaign_drain); `POST .../{id}/decision` (`confirm_invalid` | `flag_store`, reason code) is idempotent, one decision per click, 409 on a different later decision, and never moves money. Stored in `ad_click_reviews` (migration 0048, append-only).
- Threats: IDOR on store query (central policy, 404), cursor tampering (Zod + decode, 400), information leak (no URL, no session hash in responses).
