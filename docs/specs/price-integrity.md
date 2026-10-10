# Spec: Price integrity (reference price, discount claims, enforcement)

Phase 0 spec for Phase 1 "lite" and Phase 2 "full" engines · Spec refs: master prompt §9, §B5, §A2.4, §A3, §Phase 1/2 scope · Status: Draft for review

Naming: the master prompt says HAUL, the product is Outlet NK. Internal identifiers keep the neutral prefix `price_` and never the brand.

Legal status of this document: it is an engineering spec, not legal advice. Every item tagged **VERIFY BEFORE LAUNCH** must be confirmed by Egyptian counsel before the related behaviour ships. The text of Law 181/2018 Art. 9 has not been verified by us. The EU 30-day prior-price rule is used only as a design model, not as Egyptian law.

## 0. Summary and the central finding

The engine exists for one reason: a shopper must never see a "% off" that the platform cannot defend with evidence. Sellers never type a "was" price that is displayed blindly.

**Central finding.** Outlet NK sells clearance, end-of-season, overstock and sample stock. A large share of listings are one-off or short-run SKUs listed once at their final price. Such a SKU has no 30-day price history on the platform, so an own-history engine alone produces no verified discount for exactly the inventory the product is about. (How large the share is, is unmeasured; the tier mix metric in section 14 measures it.) The spec therefore does three things:

1. Defines **evidence tiers** (E0 to E5) and states for every tier exactly what the shopper sees, including "no percentage off" as a first-class outcome.
2. Defines a **lite mode** for the Phase 1 MVP: deterministic rules only, no ML, no crawler, no image matching. Evidence is own price history plus seller-channel OAuth integrations (Shopify, WooCommerce) mapped by exact keys.
3. Defines the **path to the full engine** in Phase 2 behind the same interface, with shadow-mode rollout and a precision gate.

Honest consequence for product and marketing: in the MVP many clearance listings will show a plain price or a "first listed price" label and no percentage. Marketing copy and ads are subject to the same rule: no "up to X% off" banner unless real verified claims back it. The way to earn a percentage is evidence (connect the seller's own store, supply channel history, later brand RRP), which is also the seller-facing incentive.

## 1. Flow

### 1.1 Seller side
1. Seller sets the **selling price** of a SKU (UI, CSV bulk, or API). The price is the only price input. There is no "original price" field that is displayed.
2. Seller may optionally attach **evidence** of a higher earlier price:
   - connect a sales channel (Shopify or WooCommerce via OAuth/API key), or
   - upload a document (price tag photo, brand price list) with structured fields (declared reference price, document date, GTIN if any).
3. Each price change appends an immutable `price_events` row (server time as `valid_from`; backdating is impossible).
4. The engine evaluates the SKU (triggers in 1.3) and writes a `price_claims` row: tier, reference, percentage, decision, reason codes, evidence ids.
5. Seller sees per SKU: current claim state, what evidence would unlock a higher tier, any violation and its reason code, and the appeal action (section 7).

### 1.2 Shopper side
1. Listing card and product page render the claim state from the latest `price_claims` row through the public evidence endpoint (section 6), never from seller-supplied fields.
2. Tapping the badge or the price opens the **price history sheet**: own-platform price history chart plus the "How we verify prices" explainer.
3. Cart and checkout always charge the listed selling price. The engine only governs **claims**, never the amount charged. A re-evaluation can remove a claim between view and checkout; it can never raise the charged price.
4. Each order line stores a `price_claim_id` and a denormalised snapshot (selling price, reference, percentage, tier, evidence ids, engine version). This is the evidence trail for a regulator inquiry or a dispute.

### 1.3 Evaluation triggers
Re-evaluate a SKU on: `price.changed`; new or revoked evidence; channel snapshot ingested; availability change (stock to zero or back); hourly sweep for time-based expiry (30-day windows, 72-hour staleness, claim age limit); config version change (batched, rate limited).

## 2. Rules

### 2.1 Definitions
- **Selling price** `P`: current price in integer piastres (`bigint`, EGP). Must be `> 0`. VAT-inclusive as charged to the shopper (VERIFY BEFORE LAUNCH: price display rules incl. VAT, with section B4 of the master prompt).
- **Day**: exactly 24 hours of instants. Windows are computed on instants (UTC), not calendar days, so DST or timezone rules never change a result. Display uses Cairo local time.
- **Purchasable interval**: a period in which the SKU was active, visible and had at least one unit available. Price history counts only purchasable intervals, so a seller cannot manufacture a "prior price" by listing a price while the item cannot be bought.
- **Reduction sequence**: a maximal run of price events ending at the current price in which no event is an increase. Its start `s` is the time of the first reduction of that run. A price increase ends any sequence. If the current price is the first listed price, or the last change was an increase, there is **no reduction** and no internal claim is possible.
- **Reference price (VRP)**: the highest price the platform is willing to display as the "before" price, derived by section 2.3.

### 2.2 Evidence classes
| Class | Source | Lite (Phase 1) | Full (Phase 2) |
|---|---|---|---|
| `INTERNAL` | Own immutable price ledger | Yes | Yes |
| `CHANNEL` | Seller-channel OAuth/API price snapshots, mapped by exact key | Yes | Yes |
| `EXTERNAL` | Crawler snapshots of matched third-party listings | No | Yes |
| `BRAND_RRP` | Official brand price, separate class, never mixed | No | Yes |
| `DOCUMENT` | Seller-uploaded document, structured fields | Yes, behind flag, display capped | Yes, OCR + extraction scoring |

Key mapping in lite mode (no ML, no images): a channel product maps to an Outlet NK SKU only by exact GTIN/EAN, or exact seller SKU plus exact variant id, supplied through the integration import and attested by the seller. Anything fuzzy is unmapped and produces no evidence. A mapped item whose attributes disagree on a hard field (brand, colour, size) is rejected deterministically.

### 2.3 Algorithm (deterministic, integer math)
Inputs: `now`, `P`, price events, availability intervals, channel snapshots, document evidence, config.

```
# internal candidate (needs a reduction sequence)
s            = start of current reduction sequence            # null if no reduction
age_claim    = now - s
W            = [s - 30d, s)
covered      = history_start <= s - 30d                        # first price event is old enough
purch_ratio  = purchasable_time(W) / 30d
if s != null and covered and purch_ratio >= 0.80 and age_claim <= claim_max_age:
    internal_ref = min(price over purchasable instants in W)
else: internal_ref = null

# channel candidate (needs mapping, history, fresh snapshot)
if mapped and channel_history >= 30d and latest_snapshot_age <= 72h:
    channel_ref = min(channel price over [now - 30d, now])      # trailing, includes channel's own current price
else: channel_ref = null

# external candidate (Phase 2 only) same shape as channel, requires match_conf >= tau

candidates = {internal_ref, channel_ref, external_ref} minus nulls
VRP        = min(candidates)                                    # strictest wins
if VRP != null and VRP > P:
    discount_pct = ((VRP - P) * 100) / VRP                      # bigint division, floor
else: discount_pct = 0
claim_allowed = VRP != null and 5 <= discount_pct <= anomaly_pct_threshold
```

Document candidate (support only): used for display **only when `candidates` is empty**, the flag `tier2_display` is on, document checks pass, and the resulting percentage is `<= doc_claim_cap_pct` (30). It never lowers or overrides a quantitative candidate. If its percentage exceeds the cap, no percentage and no reference price are shown (the claim is withheld, not shrunk, because showing a reference price next to a smaller percentage would be internally inconsistent).

Rules:
1. **Strictest wins.** Among quantitative candidates the minimum is the reference. A seller who is cheaper elsewhere, or who held a lower price recently, gets the smaller claim.
2. **Anti-inflation.** Because the reference is the minimum over the 30 days before the reduction, a price raised and then cut inside that window never produces a claim above the true lowest price of the window.
3. **Successive reductions** keep the reference of the first reduction in the sequence while the price never goes back up. Any increase ends the sequence and starts a new window.
4. **Claim age.** A claim from internal evidence is displayed for at most `claim_max_age` (default 30 days) from `s`. After that the price is just the price. A permanent "discount" is the pattern the engine exists to prevent. Parameter and wording are VERIFY BEFORE LAUNCH.
5. **Floor, never round up.** The percentage is floored on integers, never rounded to nearest, so the displayed percentage never exceeds the true one. Minimum displayed claim is 5%.
6. **Anomaly threshold.** `anomaly_pct_threshold` default 70. A computed claim above it is withheld (reason `ABOVE_ANOMALY_THRESHOLD`), the seller is told, and the claim can be re-scored when corroborating evidence is added. Withholding is automatic and does not need a human. The value is an owner decision (it directly trades abuse protection against genuine deep clearance).
7. **Vouchers, coins, cart discounts** never create a reference price or a percentage (master prompt §6/§vouchers). A voucher shows as "voucher -X".
8. **Cross-channel parity.** If a fresh mapped channel price is below `P`, the SKU is demoted in ranking, the seller is notified and has 48 hours; after that the SKU is auto-paused. (Parity does not require a claim to exist.)
9. **No timers, no scarcity attached to a claim.** The engine output carries no countdown, "only N left" or "selling fast" text. Those are separate features with their own truthfulness rules.

### 2.4 Configurable parameters (admin-editable, versioned, audited)
`history_days=30`, `min_purchasable_ratio=0.80`, `min_claim_pct=5`, `anomaly_pct_threshold=70`, `claim_max_age_days=30`, `snapshot_stale_hours=72`, `doc_claim_cap_pct=30`, `doc_max_age_days=180`, `tier2_display=false`, `parity_grace_hours=48`, `violation_window_days=90`, `violations_for_badge_loss=3`, `min_channel_store_age_days` (value unset; owner decision), `match_tau=0.92` (Phase 2, to be tuned, not trusted until a labelled set exists). Every change writes an audit row and bumps `config_version`; each claim stores the config version it was computed under.

## 3. Algorithms compared and the choice

| Criterion | A. Own 30-day history (EU-style prior price) | B. Seller-supplied evidence + spot checks | C. Seller-channel integration history | D. External crawling + matching (+ brand RRP) |
|---|---|---|---|---|
| Coverage of one-off clearance SKUs | Very low: no history by construction | High (every seller can upload) | Medium: only sellers with an online store | Medium-high once matching works; fashion matching of clearance items is hard |
| False-claim risk | Very low | High: documents are forgeable; the seller is the interested party | Low-medium: dummy or inflated store is possible | Low if precision is gated; mis-match risk otherwise |
| Gaming resistance | Good (min over window, purchasable time) | Weak | Medium (needs store-age and parity checks) | Good but seller can block crawlers or change listings |
| Legal defensibility | Strongest: platform's own immutable record | Weak alone: attributed to the seller | Good: first-party price from the seller's own channel, timestamped | Good if sources are citable; scraping terms and robots.txt risk (VERIFY) |
| Build cost and time | Low | Low-medium (forms, hashing); OCR/LLM extraction is extra | Medium (OAuth, snapshots, mapping) | High (crawler fleet, ANN, classifier, labelled set) |
| Operational burden | None | Spot-check audits need people | Token revocation, sync failures | Crawler maintenance, model drift |
| Needs ML or crawler | No | Only for OCR scoring (not in lite) | No | Yes |

**Choice: a layered, strictest-wins engine.** Use A as the always-on, highest-trust baseline (it can only ever produce a claim for items that were genuinely reduced), add C as the main route to claims for one-off clearance in Phase 1, keep B as capped, flag-gated, clearly attributed support (never "Verified"), and defer D to Phase 2 where the product matching waterfall and labelled set make it safe. No single algorithm is sufficient: A alone leaves clearance SKUs without claims; B alone is not defensible; D alone is too costly and too risky for the MVP.

**Spot checks.** Spot-checking seller documents is a human audit and conflicts with the master prompt's "zero manual review" principle for the display path. Decision: audits are **asynchronous and never gate display**; they feed seller violation records and the document class's future scoring. Whether any human audit is allowed at all is an owner decision (section 17). If not allowed, document evidence stays off (default).

## 4. Evidence tiers and what is displayed

Tier is a property of the claim, computed from the evidence that actually produced the reference.

| Tier | Name | Condition | Strikethrough reference | Percentage | Badge / label (see section 8 for Arabic) |
|---|---|---|---|---|---|
| E0 | Unverified | No qualifying history or evidence, listing older than `history_days` or evidence stale | No | **No** | None. Plain price. |
| E1 | First listed | Listing younger than 30 days, no other evidence | No | **No** | "First listed price" (optional label, never a discount word) |
| E2 | Seller-declared (document) | Only a document candidate, flag on, checks pass, `pct <= 30` | Yes, labelled "as stated by the seller" | Yes, capped, labelled declared | "Original price as stated by seller" |
| E3 | Own price history | `INTERNAL` produced the reference, `pct >= 5` | Yes, labelled "previous price on Outlet NK" | Yes | "Verified discount" + history sheet |
| E4 | Seller-channel history | `CHANNEL` produced or co-produced the reference | Yes, labelled "seller's online store price" | Yes | "Verified discount" + history sheet |
| E5 | External / brand RRP (Phase 2) | `EXTERNAL` or `BRAND_RRP`. RRP is displayed as its own label, never merged into the min above | Yes | Yes | "Brand price" or "Verified discount" |

Additional label: **"Lowest price on the app in 30 days"**, allowed only when a reduction occurred in the last 30 days, history covers 30 days, and `P` is at most every purchasable price of the trailing 30 days. It is a statement about Outlet NK only and says so.

Display rules per tier:
- E0 and E1 never render a strikethrough, a percentage, a "sale" ribbon, or any discount color treatment. E1 is a fact about the listing, not a promotion.
- Percentage is rendered only with a visible source label of the reference.
- If a claim disappears after the shopper saw it (re-evaluation), the UI shows the plain price with no animation or apology copy; the charged price is unchanged.
- The price history sheet shows only own-platform prices over purchasable intervals. Channel prices are described in words ("seller's online store price over the last 30 days: from X to Y"), without the store URL, to avoid exposing the seller's channel.

## 5. Lite mode and path to the full engine

### 5.1 Lite mode (Phase 1, MVP)
In: internal ledger; Shopify and WooCommerce integrations with exact-key mapping; deterministic rules of section 2.3; automated enforcement ladder; public evidence endpoint; `DOCUMENT` class implemented but `tier2_display=false`.
Out (explicitly): crawler, image hashing and embeddings, LLM extraction, OCR scoring, classifier, anomaly model, Price Trust Score as a learned number.
Lite substitutes: deterministic anomaly rule (threshold, section 2.3 rule 6); deterministic duplicate-listing guard (same seller plus same GTIN, same seller SKU, or byte-identical image SHA-256 inherits price history); a **seller price trust level** computed from violation counts only (no model).

Pre-launch supply dependency (master prompt launch checklist): launch brands need channel integrations connected at least 30 days before launch, otherwise channel history is under the 30-day minimum and most items are E1 at launch.

### 5.2 Full engine (Phase 2)
Add providers behind the same interface `EvidenceProvider -> Candidate[]`: crawler snapshots (≤ 1 request per 5 s per domain, robots.txt respected, seller-verified domains only), matching waterfall (exact key, pHash/dHash, embeddings, attribute extraction, calibrated classifier with `match_conf`), brand RRP, OCR plus extraction for documents, robust z-score or isolation-forest anomaly detection, and a Price Trust Score 0-100 feeding ranking.

### 5.3 Migration and safety
1. The domain function is pure: `evaluatePriceClaim(input, config) -> PriceClaimDecision` (no I/O, no clock, `now` injected). Lite and full are the same function with more candidates.
2. `engine_version` is stored on every claim. v2 runs in **shadow mode** (computed and stored, not displayed) for a fixed period and is compared with v1 on: claim disagreement rate, claims v2 would add or remove, appeals.
3. Gate to enable displayed v2 claims from `EXTERNAL`: precision `>= 0.98` at the chosen `tau` on a labelled Egyptian pair set (master prompt suggests 2,000 pairs; no published accuracy exists, so VERIFY with our own measurement) and counsel sign-off on crawling.
4. Rollback is a config flag per evidence class; claims recompute under the previous config and fail closed.

## 6. API

All money fields are decimal strings of integer piastres (converted to `bigint` by Zod at the boundary). Errors use the platform problem+json envelope.

| Endpoint | Auth scope | Idempotent | Rate limit | Notes |
|---|---|---|---|---|
| `GET /v1/products/{id}/price-evidence` | public | n/a (read) | per IP, cached | Returns tier, display kind, reference label and amount, percentage, history summary, evidence class names only. Never returns seller ids, store URLs, document content, tokens, or reason codes of violations. |
| `GET /v1/products/{id}/price-history` | public | read | per IP, cached | Own-platform purchasable price intervals, last 30 days only. |
| `POST /v1/seller/channels` | seller, store-scoped | yes (`Idempotency-Key`) | low | Starts OAuth/API-key connection. Domain must be seller-verified. |
| `DELETE /v1/seller/channels/{id}` | seller | yes | low | Disconnect. Evidence from it expires from claims on next evaluation. |
| `POST /v1/seller/price-evidence` | seller | yes | low | Upload structured document evidence (file hash plus fields). Stored private. |
| `GET /v1/seller/price-claims?sku_id=` | seller (own SKUs only) | read | normal | Claim state with reason codes and "what unlocks a higher tier". |
| `POST /v1/seller/price-claims/{id}/appeal` | seller | yes | low | Triggers automatic re-score with supplied evidence. |
| `GET /v1/seller/price-trust` | seller | read | normal | Violation counts, strikes in window, ladder state. |
| `POST /v1/products/{id}/price-reports` | shopper (verified) | yes | strict per user and per product | A signal only; never changes display directly. |
| `GET/PUT /v1/admin/price-integrity/config` | admin, role-checked, audit | PUT idempotent by version | low | Versioned parameters of 2.4. |

Server never accepts `vrp`, `tier`, `discount_pct`, `claim_type` or `trust_level` from any client (mass-assignment guard, OWASP API3).

## 7. Enforcement ladder (automatic)

| Trigger | Automatic action | Cure |
|---|---|---|
| Not enough evidence | Plain price (E0/E1). Not a violation. | Add evidence |
| Seller-asserted reference above computed reference | Display set to computed claim (or none); seller notified with reason code and evidence ids. Counts as one **violation** only if the asserted value was an explicit seller-entered "was" price (evidence upload) and it was more than the computed reference by a material margin (parameter, owner decision) | Re-score by appeal |
| Price raised then cut inside 30 days to create a claim | Claim withheld until the window clears; if repeated in `violation_window_days`, "Verified discount" badge removed for 30 days and ranking penalty | Wait or evidence |
| Mapped channel price below `P` | Ranking demotion immediately; 48 h; then SKU auto-paused | Reprice or unmap |
| 3 violations in 90 days | Loses "Verified" seller badge; commission surcharge (amount set in Seller Agreement, VERIFY); price-claim features blocked for 30 days | Window rolls off |
| Severe or repeat (forged document confirmed by duplicate hash or contradicted channel data; repeated lapses after the above) | Store auto-suspended; payouts held per Seller Agreement | Human review of suspension within 5 business days |

Constraints on the ladder:
- Every action is an `enforcement_actions` row with reason code, evidence ids, config version, and is idempotent per (seller, trigger, window).
- Notifications are in Arabic first, state the rule, the numbers (in piastres rendered as EGP), and the cure.
- Strikes expire on a rolling 90-day window.
- Display correction is never punishment by itself: the plain price is the neutral state.
- **VERIFY BEFORE LAUNCH** with counsel and in the Seller Agreement: that automatic suspension, commission surcharge and payout hold without prior human review are acceptable and contractually enforceable; seller monitoring consent for channel integrations.
- A human queue exists only for suspensions (fairness), not for price claims.

## 8. Transparency and Arabic wording constraints

### 8.1 Shopper transparency
- Every reference carries a **source label** (previous price on the app, seller's store, brand price, as stated by seller).
- "How we verify prices" explainer in Arabic and English describing tiers in plain words; no statistic about our accuracy unless measured and dated.
- "Report price" feeds the engine as a rate-limited signal weighted by reporter standing; it triggers a re-score, never a direct change.
- The order page shows the claim as it was when ordered (from the snapshot).

### 8.2 Arabic wording constraints (all strings are drafts; Arabic legal copy review is VERIFY BEFORE LAUNCH)
1. Arabic is the authoritative text. English is a translation and must never be stronger than Arabic.
2. No "discount" vocabulary (خصم، تخفيض، وفّر، عرض) for E0 and E1. The E1 label states a fact about the listing only.
3. Never use absolute or comparative claims (أرخص، الأقل سعرًا في مصر، أفضل سعر) unless the scope is stated and verified; "lowest" is always scoped to "on the app" and "30 days".
4. "Verified" wording (موثّق) is permitted only for tiers E3 to E5. E2 must name the seller as the source.
5. A percentage is never shown without its reference label and never as a range or "up to" (حتى) on a single item.
6. No fake urgency attached to price claims (countdowns, "ends soon" without a true scheduled end time).
7. Numerals and sign: follow the i18n package locale setting (Arabic-Indic or Western digits); percent and minus signs must be wrapped with bidi isolation so "-16%" does not flip in RTL; currency is shown as "ج.م" consistently.
8. Register: standard Arabic for labels and legal-adjacent text, no dialect in claims.
9. Do not copy the seller's free text into any price label (seller text is untrusted and may itself contain misleading claims). Seller product titles containing percent or "sale" words are subject to a separate listing-content rule; deterministic pattern check, detail out of scope here.

Candidate strings (keys for the i18n catalogue; AR is a draft):
| Key | Arabic (draft) | English |
|---|---|---|
| `price.first_listed` | سعر العرض الأول على التطبيق | First listed price on the app |
| `price.declared_by_seller` | السعر الأصلي كما ذكره البائع | Original price as stated by the seller |
| `price.verified_discount` | خصم موثّق | Verified discount |
| `price.source.internal` | السعر السابق على التطبيق | Previous price on the app |
| `price.source.channel` | سعر البائع في متجره الإلكتروني | Seller's online store price |
| `price.lowest_30d` | أقل سعر على التطبيق خلال ٣٠ يومًا | Lowest price on the app in 30 days |
| `price.how_we_verify` | كيف نتحقق من الأسعار | How we verify prices |

Law reference: Consumer Protection Law 181/2018 prohibits misleading advertising. The content of **Art. 9 is VERIFY BEFORE LAUNCH**; this spec does not rely on its exact wording. The product of this spec is the engineering control; legal sufficiency is for counsel to confirm.

## 9. Edge cases

- **No history, no evidence:** E0 or E1; never an error.
- **Brand-new SKU but seller has older identical listing:** exact key match inherits history (duplicate-listing guard), so relisting does not reset the window.
- **Price equals or exceeds reference:** no claim.
- **Reduction smaller than 5%:** no claim, reason `BELOW_MIN_PCT`.
- **Out of stock or paused SKU:** intervals when not purchasable are excluded; claim hidden while unavailable; returns to the same evidence when back.
- **Variants:** price history is keyed per SKU (product + colour + size). A seller varying prices by size does not pool them. Pooling across sizes is an open owner decision (section 17).
- **VAT inclusive vs exclusive:** channel prices must be normalised to the tax basis stated at integration time; unknown basis means channel evidence is not used (fail closed).
- **Bulk CSV reprice:** events apply in server receive order with server time; no backdating; a file that raises then cuts in one upload still creates two events and the anti-inflation rule applies.
- **Clock skew / duplicated events:** `valid_from` is assigned by the server; duplicates are collapsed by idempotency key.
- **Seller suspended or deleted:** claims hidden immediately, history retained for the audit period.
- **Concurrent evaluation:** evaluation key is (`sku_id`, `price_event_id`, `evidence_version`, `config_version`); a unique constraint makes it idempotent and last-writer-wins is not possible.
- **Maximum amounts:** `bigint` with a platform-defined upper bound; `(VRP - P) * 100` is computed in `bigint` so there is no overflow.
- **RTL and locale:** all strings through i18n; percent and currency bidi-isolated.
- **Offline app:** client renders the last server claim snapshot with its `evaluated_at`; the checkout call revalidates and shows the charged price.

## 10. Data

PII classes: P0 public, P1 internal, P2 personal, P3 sensitive. No real seller documents or personal data may be stored anywhere until ADR-0002 (data residency) is accepted; development uses labelled fixtures only. Final table names and types belong to the data-model owner; this is the required shape.

| Entity | Key columns | Indexes / constraints | PII |
|---|---|---|---|
| `price_events` (append-only) | `id`, `sku_id`, `seller_id`, `amount bigint`, `currency`, `valid_from timestamptz`, `source` (seller_ui, seller_api, channel_sync, system), `actor_id`, `idempotency_key` | `(sku_id, valid_from)`, unique `idempotency_key`; no UPDATE/DELETE | P1 |
| `sku_availability_events` (append-only) | `sku_id`, `purchasable bool`, `valid_from` | `(sku_id, valid_from)` | P1 |
| `channel_connections` | `id`, `seller_id`, `type` (shopify, woo), `domain`, `credential_ref` (KMS reference, never the secret), `status`, `store_created_at`, `connected_at` | `(seller_id)`, unique `(type, domain)` | P1 |
| `channel_snapshots` (partitioned by day) | `connection_id`, `external_ref`, `sku_id`, `amount bigint`, `tax_basis`, `observed_at` | `(sku_id, observed_at)` | P1 |
| `product_matches` | `sku_id`, `external_ref`, `method` (gtin, seller_sku_variant; later others), `conf`, `attested_by`, `model_version` | unique `(sku_id, external_ref)` | P1 |
| `price_evidence_documents` | `id`, `seller_id`, `sku_id`, `doc_type`, `declared_amount bigint`, `doc_date`, `file_sha256`, `storage_ref`, `status` | index on `file_sha256` (cross-seller duplicate check) | P2 if the file shows people or personal data |
| `price_claims` | `id`, `sku_id`, `price_event_id`, `price_amount`, `vrp_amount null`, `discount_pct`, `tier`, `decision`, `reason_codes[]`, `evidence_ids[]`, `engine_version`, `config_version`, `evaluated_at` | unique `(sku_id, price_event_id, evidence_version, config_version)`; `(sku_id, evaluated_at desc)` | P0 for the public projection, P1 otherwise |
| `price_violations`, `enforcement_actions` | seller, sku, rule code, claim id, action, valid_until, config_version | `(seller_id, created_at)` | P1 |
| `price_reports` | `id`, `product_id`, `reporter_user_id`, `reason`, `created_at` | unique `(product_id, reporter_user_id)` | P2 (user id) |
| `price_engine_config` + audit | version, parameters json, actor, `created_at` | unique version | P1 |
| Order line snapshot | `price_claim_id` plus denormalised price/reference/pct/tier | on order lines | P1 |

Retention: `price_events` and `price_claims` for the audit period required by counsel (VERIFY BEFORE LAUNCH); document files per the retention policy once ADR-0002 is decided.

## 11. Events

Domain (outbox, `aggregate.action`): `price.changed`, `price_claim.evaluated`, `price_claim.appealed`, `price_enforcement.applied`, `price_enforcement.lifted`, `channel_snapshot.ingested`, `channel_connection.revoked`, `price_report.submitted`.

Analytics (snake_case, no forbidden tokens, no PII, no seller free text): `price_claim_shown` (tier, pct_bucket, surface), `price_history_opened`, `price_explainer_opened`, `price_report_submitted` (reason code only), `seller_evidence_added` (class), `seller_appeal_started`.

All events are Zod-typed in the analytics package; amounts travel as piastre integers.

## 12. Failure handling

- **Fail closed:** engine error, timeout or missing inputs produce no claim (plain price). A claim is never extended past its evidence.
- **Staleness:** channel snapshot older than 72 h drops the `CHANNEL` candidate; the claim degrades to the remaining evidence or plain.
- **Channel sync failures:** retry with exponential backoff plus jitter, max 5 attempts, then dead-letter and seller alert; nothing blocks checkout.
- **Token revoked / auth failure:** connection `status=revoked`, seller alert, evidence expires.
- **Outbox and consumers:** at-least-once, idempotent consumers; DLQ with alert.
- **Re-score storms (config change):** batched and rate limited; prior claims remain valid until re-scored; a config change cannot take the whole catalogue to plain price at once without an explicit approved rollout.
- **Shopper-visible fallback:** plain price, no error banner.

## 13. Security and abuse

AuthZ: sellers touch only their own SKUs and connections (OWASP API1); admin config requires role and writes an audit row; claims are server-computed only (API3).

| Abuse | Control |
|---|---|
| Hold a high price for 30 days, then "discount" | Genuine-offer rule: only purchasable intervals count; 80% purchasable coverage; claim age limit; later: sell-through anomaly signal |
| Inflate then cut | Minimum over prior window; sequence reset on any increase |
| Relist to reset history or evade parity | Duplicate-listing guard by exact keys and image hash; Phase 2 pHash plus attributes |
| Forged document | Capped and flag-off by default; file hash duplicate detection across sellers; structured fields cross-checked; never labelled "Verified" |
| Dummy channel store with inflated price | Seller-verified domain; store creation age check (`min_channel_store_age_days`, owner decision); anomaly threshold; parity check; violation on contradiction |
| Cheaper elsewhere than on app | Parity demotion and pause |
| Report brigading (competitors, shoppers) | Verified user, per-user per-product uniqueness, rate limit, reports are signals only |
| SSRF through WooCommerce store URL (self-hosted) | Only seller-verified domains, https, resolve and block private/link-local/loopback addresses, DNS-rebinding guard, dedicated egress, no internal credentials (OWASP API7) |
| Webhook spoofing | Verify provider signature on webhooks; provider details are VERIFY (we have not checked provider docs in this spec) |
| Credential theft | Channel credentials only by KMS reference; never logged, never in events (note analytics forbids `token`) |
| Prompt injection (Phase 2 LLM extraction) | Seller text is untrusted input to the LLM; output schema-validated by Zod; LLM never decides display alone (OWASP LLM01) |
| Enumeration of evidence | Public endpoint returns the minimum projection, no seller/store identifiers |

## 14. Metrics

Product KPIs (targets are targets, not claims about the market):
- Distribution of listings and of GMV by tier (E0 to E5): the key lite-mode measure of the central finding.
- Share of active sellers with at least one connected channel; time from onboarding to first E4 claim.
- Claim auto-correction rate (seller-asserted vs computed).
- Appeals: volume, share upheld; target upheld share under 2% (master prompt target).
- Complaints about misleading discounts per 10,000 orders; target near zero.
- Conversion and return rate by tier (is a verified claim worth the effort).

SLIs/SLOs: evaluation latency p95 after a price change under 5 s (target to confirm); public evidence endpoint p95 and availability per platform SLO; staleness: share of channel connections with snapshot older than 72 h.

Guardrails: the engine must never change a charged price; zero claims with `vrp <= price`; share of claims above the anomaly threshold; enforcement actions per 1,000 sellers (to catch an over-aggressive config).

## 15. Acceptance (Gherkin-style, become tests)

```
Scenario: anti-inflation (property test, fast-check)
  Given any sequence of price events and availability intervals
  When a price is raised and cut within 30 days
  Then the reference is never above the minimum purchasable price in the 30 days before the first reduction of the sequence
  And discount_pct = floor((VRP - P) * 100 / VRP) computed in bigint

Scenario: no claim without evidence
  Given a SKU listed 3 days ago with no channel and no document
  Then tier is E1, no reference, no percentage

Scenario: clearance SKU with declared document, flag off
  Given tier2_display is false and a document declaring 90,000 piastres
  Then the shopper sees no percentage and no strikethrough

Scenario: document claim above cap
  Given tier2_display is true, document price 90,000 and P 45,000
  Then no percentage and no reference are shown, the seller is notified (ABOVE_DOC_CAP)

Scenario: channel evidence
  Given a mapped channel with 45 days of history, minimum 90,000, snapshot 10 hours old, P 45,000
  Then tier is E4, discount_pct is 50, label "Verified discount"

Scenario: stale evidence fails closed
  Given the same channel but the latest snapshot is 80 hours old
  Then no channel candidate, plain price

Scenario: parity
  Given a fresh mapped channel price of 40,000 and P 45,000
  Then the SKU is demoted, the seller is notified, and after 48 hours auto-paused
  And no claim is shown (VRP 40,000 is not above P)

Scenario: voucher
  Given a voucher applied at checkout
  Then no reference price or percentage is created from it

Scenario: charged price invariance
  Given any change of claim state between view and checkout
  Then the amount charged equals the listed selling price at order time

Scenario: order snapshot
  When an order is placed
  Then each line stores price_claim_id, reference, pct, tier, evidence ids, engine and config versions

Scenario: suspension review
  Given an automatic store suspension
  Then a human review exists within 5 business days

Scenario: Arabic parity
  Given any price label key
  Then an Arabic string exists; CI fails if missing
```

Testing requirements: property tests with fast-check for window, sequence and floor math; table-driven tests for the worked examples below; mutation score target 80% for the engine module per master prompt §A2.10.

## 16. Worked example (integer piastres; EGP 1.00 = 100 piastres)

Time is in days relative to `now` (day 0). All intervals are fully purchasable. Defaults from 2.4.

**Example 1: raised then cut (anti-inflation).**
Events: day -60 price 120,000 (EGP 1,200.00); day -20 raised to 150,000; day -5 cut to 100,000. `P = 100,000`.
- Sequence start `s = -5` (the cut is the first reduction after the increase at day -20).
- Window `W = [-35, -5)`: 120,000 for 15 days (-35 to -20), then 150,000 for 15 days. History starts at day -60, so it covers the window; purchasable ratio 1.0.
- `internal_ref = min(120,000; 150,000) = 120,000`. The seller's "was" price of 150,000 would give `(50,000 * 100) / 150,000 = 33` and is rejected.
- `discount_pct = floor((120,000 - 100,000) * 100 / 120,000) = floor(2,000,000 / 120,000) = floor(16.67) = 16`.
- Claim age 5 days is within 30. Tier E3: shopper sees "EGP 1,000.00", struck "EGP 1,200.00 previous price on the app", "16%", "Verified discount".

**Example 2: successive reductions, then a bounce.**
Events: day -50 price 200,000; day -10 cut to 160,000; day -3 cut to 140,000. `P = 140,000`.
- Sequence is non-increasing since day -10, so `s = -10`; `W = [-40, -10)` holds only 200,000. `internal_ref = 200,000`.
- `discount_pct = floor(60,000 * 100 / 200,000) = 30`. The second cut does not reset the reference.
- Now add: day -2 raised to 150,000; day -1 cut to 140,000. The increase ends the sequence: `s = -1`, `W = [-31, -1)` contains 200,000 (21 days), 160,000 (7 days), 140,000 (1 day), 150,000 (1 day). `internal_ref = 140,000 = P`, so **no claim**. A raise-then-cut cannot manufacture a claim.

**Example 3: one-off clearance SKU, no history.**
Listed today at `P = 45,000`; seller declares an original price 90,000 with a tag photo.
- Internal: no reduction, no history. Candidates empty.
- Flag off (default): tier E1, plain price with the "first listed price" label, no percentage. Document stored as support.
- Flag on: declared percentage `floor((90,000 - 45,000) * 100 / 90,000) = 50`, above the cap 30, so no percentage and no reference (`ABOVE_DOC_CAP`). If the declared price were 60,000: `floor(15,000 * 100 / 60,000) = 25`, within the cap, so E2 renders "EGP 450.00", "original price as stated by the seller EGP 600.00", "25%" and no "Verified" wording.

**Example 4: the same SKU with a connected store.**
Seller's Shopify store maps the item by exact GTIN. Channel has 45 days of history; minimum over the last 30 days is 90,000; current channel price 90,000; latest snapshot 10 hours old; store age passes the owner-set minimum.
- `channel_ref = 90,000`; `VRP = 90,000`; `discount_pct = 50`; `50 <= 70`.
- Tier E4: "EGP 450.00", struck "EGP 900.00 seller's online store price", "50%", "Verified discount". Parity: channel current 90,000 is not below 45,000, no demotion.
- If the snapshot were 80 hours old, or the history only 20 days, the candidate is dropped and the listing is E1.
- If the channel price had been 40,000 for a day in the last 30, `VRP = 40,000 < P`, so no claim and parity applies.

**Example 5: both sources.** `internal_ref = 120,000`, `channel_ref = 110,000`, `P = 100,000`: `VRP = 110,000`, `discount_pct = floor(10,000 * 100 / 110,000) = floor(9.09) = 9`, tier E4 (channel participated). Strictest wins.

These numbers are the first test table for the engine. Division is bigint division on positive operands, which floors.

## 17. Decisions for the owner

1. **Anomaly threshold** (default 70%): withhold above it. Trade-off between abuse protection and deep clearance. Needed before launch.
2. **Document tier** (`tier2_display`, cap 30%): ship off. Turn on only after counsel review. Also decide whether any asynchronous human audit of documents is allowed, given "zero manual review".
3. **Claim age limit** (default 30 days) and wording for long-running reductions: VERIFY BEFORE LAUNCH with counsel.
4. **Minimum channel store age and seller verification** for dummy-store resistance.
5. **Violation materiality margin** for counting a seller-entered "was" price as a violation.
6. **Variant pooling**: per SKU (default, stricter for sellers) or pooled per product-colour.
7. **Automatic suspension, commission surcharge and payout hold** without prior human review: counsel and Seller Agreement. VERIFY BEFORE LAUNCH.
8. **Art. 9 text** and the legal sufficiency of the labels in section 8: counsel. VERIFY BEFORE LAUNCH.
9. **Crawling terms, robots.txt and database-rights risk** for Phase 2: counsel. VERIFY BEFORE LAUNCH.
10. **Marketing policy**: confirm that ads and push notifications follow the same claim rules (no unverified "up to X% off").
11. **Retention period** for claims and documents; depends on ADR-0002 and counsel.

## 18. Open items

- No code exists yet. Proposed home for the pure evaluation function: `packages/domain/src/price-integrity` (not created by this task).
- Provider API specifics (Shopify, WooCommerce price and history endpoints, webhooks, rate limits) are unverified and must be confirmed before building the connectors.
- The labelled pair set and precision gate for Phase 2 do not exist.
- Interaction with promotions and drops (flash discount windows, mega-event pre-drop spikes) is covered only by the generic rules here; event-specific rules belong in the promotions spec.
