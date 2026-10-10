# Inconsistencies, gaps and unknowns found in the spec's data blocks

Status: Draft for review · Source: `docs/haul-master-prompt-v3.md` (read HAUL as Outlet NK) · Scope: the Data blocks of Part C, §T3, §T4, §A2 and §B, compared with each other, with the migrations in `packages/db/migrations` (0001 to 0007) and with `docs/privacy/data_inventory.yaml`. Conventions: [../data-model.md](../data-model.md).

How to read this file. Each row has an id (`I-nn`) that the module documents cite. "Resolution" is what the data model does today. "Decision" says who must confirm. Nothing here changes the spec. Items that touch law or provider behaviour are tagged **VERIFY BEFORE LAUNCH** and also appear in decisionsForOwner of the ERD handover.

Severity: **H** blocks correct implementation or breaks a hard rule (money, privacy, tenancy). **M** needs a decision before the module's migration. **L** cosmetic or naming.

## 1. Identity, privacy, auth (§1, §2, §B1, §B6)

| Id | Sev | Spec says | Problem | Resolution in the model | Decision |
|---|---|---|---|---|---|
| I-01 | H | `users(phone_e164 P3-enc, phone_hash, email P2-enc ...)`, "one account per phone number" | A uniqueness rule cannot be enforced on a field-encrypted column. Email is also not unique in practice (Apple private relay, shared inboxes). | Unique constraint on the HMAC blind index `phone_hash`. `email_hash` is indexed, not unique. | Eng |
| I-02 | M | `devices(id, user_id, ...)` | OTP, consent, age block and attestation all happen before a user exists. | `devices.user_id` nullable until bound. | Eng |
| I-03 | M | `sessions(id, device_id, refresh_hash, family_id ...)` | "List my sessions" and "revoke family" need the user, and a device can be shared. | `sessions.user_id` added (migration 0006 already has it). | Eng |
| I-04 | L | "Account merge between Apple and phone identities only after both are verified" | No entity records a merge or its audit. | `account_merges` (auth). | Eng |
| I-05 | H | Under-18: "soft-blocked ... (device ID + DOB hash)" and acceptance "no PII beyond the device hash is stored" | A plain DOB hash is brute-forceable (a few tens of thousands of candidates), and a DOB hash is arguably more than "the device hash". | `age_block_devices` stores a keyed HMAC of the device and DOB, never the DOB, 30 days. | DPO |
| I-06 | H | `consent_records(user_id, purpose, ...)`, purposes list | Consent is given during onboarding before registration, so `user_id` is not available. SMS marketing has no purpose although SMS is a channel in §24. | `subject_type` and `subject_id`, re-linked on registration (matches migration 0006). `marketing_sms` proposed. | DPO |
| I-07 | L | `users.age_band` | A stored band goes stale as the user ages. | Derived daily, never edited. | Eng |
| I-53 | M | Staff roles (seller team, admin) appear in §0 and §19 with no table | Staff must authenticate like shoppers (passkey) but have no entity. | Staff are `users` rows with `store_members` (sellers) or `role_assignments` and `staff_accounts` (admin). `users.staff_memberships_ref` is a read model. | Eng |
| I-69 | M | §8: gift purchase ships to the owner's hidden address via an "address token" | No entity or API for tokens, and the buyer must never see the address. | `address_tokens` (users), referenced by cart, checkout and orders only. | Eng |
| I-72 | M | §16 "worn by the community looks (consented)" | The §B1 consent purpose list has no purpose for publishing a user photo. | Treated as a content type in trust-safety. A new purpose is proposed in privacy. **VERIFY BEFORE LAUNCH** with counsel. | DPO |
| I-77 | M | Audit log retention "follows §B1" | §B1 has no audit-log row. | 7 years proposed in the retention schedule, flagged verify. | DPO |
| I-78 | H | Raw webhooks kept 7 years (§B1) | Raw bodies contain payer PII, which collides with erasure on deletion. | Pseudonymize fields in place on erasure, keep row for evidence. **VERIFY BEFORE LAUNCH**. | DPO |

## 1b. Platform kernel (§A2.5, §A2.7, §A2.9, §T3)

| Id | Sev | Spec says | Problem | Resolution in the model | Decision |
|---|---|---|---|---|---|
| I-35 | M | "Each consumer records `message_id` in `inbox_processed`" | Two consumers legitimately process the same message, so `message_id` alone as key would drop the second consumer's work. | Key is `(consumer, message_id)` (matches migration 0004). | Eng |
| I-36 | H | "Append-only, hash-chained `audit_log`" | One global chain serialises every writer and is a hot row. Application-level immutability is not enough. | One chain per tenant and month, UPDATE and DELETE revoked, daily signed checkpoints (matches migration 0005). | Eng |

## 2. Catalog, search, pricing integrity (§3, §4, §5, §9, §16, §19, §20.4)

| Id | Sev | Spec says | Problem | Resolution in the model | Decision |
|---|---|---|---|---|---|
| I-14 | M | No Data block for products, SKUs, brands, categories | Core entities are undefined though every other block references `sku_id`. | Derived from §4, §5, §19, §B5 (catalog). | Product |
| I-15 | H | `haul_sku` (§9.7), `sku_group` (§10 API), `sku_id` (§6 and §20.2), `product_id` (§8, §11) | Four identifiers for two concepts. | `skus.id` is the purchasable unit, `products.id` the display grouping. `haul_sku` resolves to `skus.id`, `sku_group` to `products.id`. | Eng |
| I-16 | L | `price_events(... valid_from, valid_to ...)` | A stored `valid_to` is a second write per change and can be inconsistent. | Interval derived by `LEAD(valid_from)`. | Eng |
| I-17 | M | Array columns: `evidence_ids[]`, `seller_order_ids[]`, `events[]`, `items[]`, `cart` style lists | Arrays cannot hold foreign keys, per-link attributes or be partitioned. | Junction tables: `price_claim_evidence`, `shipment_seller_orders`, `shipment_events`, `outfit_items`. Bounded preference arrays in users stay arrays. | Eng |
| I-18 | H | §9.3: each order line stores `vrp_snapshot`, `evidence_ids` and the claim type. Orders Data block lists only `vrp_snapshot`. | The evidence trail required for consumer-agency inquiries has no home, and claims are re-scored (rows change). | `order_line_price_evidence` (immutable copy of evidence ids and prices) and `order_lines.claim_type`. | Eng |
| I-19 | L | §9.7 `channel_snapshots` "partitioned daily" vs T3 "monthly" | Two different partition grains. | Monthly per T3, with a daily index. | Eng |
| I-85 | M | Master prompt §9 claim types (verified discount, lowest 30 d, launch price) versus `docs/specs/price-integrity.md` tiers E0 to E5 and decisions | Two vocabularies for the same output. | Tier and decision are the stored truth, `display_kind` is derived. Orders snapshot the tier. | Eng |
| I-20 | M | `product_matches(haul_sku, external_ref, method, conf, model_version)` | The external listing has no row, so `external_ref` is a free string. | `channel_listings` (pricing-integrity). | Eng |
| I-39 | H | Sponsored products (§4, §19, §23), "promotions or ads modules" (§12) | T1 lists no `ads` module, yet ads appear in search rules, seller marketing, admin and the budget lint rule. | Provisional `sponsored_*` tables in promotions. Needs an owner module or an ADR. | CTO |
| I-40 | M | §3 My Stores 1 to 30 favorites; §16 "follow stores"; §17 "store follower" promotions | Favorites (capped, ordered) and follows (uncapped, counted) may be different concepts. | One table (`user_favorite_stores`) serves both for now, `follower_count` derived. | Product |
| I-48 | H | `saved_searches.filter_json` with "Fits my remaining budget" | An embedded amount would copy P3 budget data into a P2 table and into search logs. | Symbolic flag `fits_budget: true`, resolved server side per request. | Eng |
| I-59 | M | Explore feed, drops feed, social, live shopping content (§16) | No T1 module owns feed content. | `feed_items` housed in recommendations-gateway, reviews and chat in trust-safety. | CTO |
| I-62 | M | `wishlist_items(wishlist_id, product_id, sku_pref ...)` | The only place where a product, not a SKU, is the reference. Alerts for "back in size" need a SKU. | `product_id` plus `sku_pref_id`, alerts use `product_alerts`. | Eng |
| I-64 | M | Free-delivery threshold, vacation, SLAs in §6, §19 | No Data block, tempting to put it on product rows. | `store_settings`, `store_vacation_windows` (sellers). | Eng |
| I-65 | M | Price columns in data blocks have no `currency` (e.g. `price_at_add`, `unit_price`) while §A2.4 says every amount carries a currency | Contradiction between rule and blocks. | Every amount has a sibling `currency` column. | Eng |
| I-81 | M | §3 "Local means seller registered and stock held in Egypt" | `kind` is on the store, stock is per location. A mixed seller breaks the rule. | Separate stores per origin, or a per-SKU origin flag. | Product |

## 3. Cart, checkout, orders, payments (§6, §7, §15.6, §20.1)

| Id | Sev | Spec says | Problem | Resolution in the model | Decision |
|---|---|---|---|---|---|
| I-23 | L | `cart_lines(... price_at_add ...)` | No currency, no state (available, unavailable, saved for later). | `currency`, `state`, `source_ref`. | Eng |
| I-83 | H | §B5 "refund within 14 days from delivery" versus §15.6 SLO "assume 14 days from return receipt" | The master prompt contradicts itself. The bases differ materially. | Both clocks stored per return, earlier wins (ADR-0009 proposed). **VERIFY BEFORE LAUNCH**. | Legal |
| I-84 | M | §6 free delivery from 2,000 EGP per store, hub consolidation in Phase 2 | Who funds the waiver is not stated and the ledger needs the field from the start (ADR-0010). | `shipping_waiver_amount` and `shipping_waiver_funded_by` on seller orders, funding rule on store settings. | Finance |
| I-24 | M | `payment_intents(amount)` and "split tender: credit/gift card + one external" | It is unclear whether `amount` is the order total or the external remainder. | External remainder only, tenders in `payment_tenders`. | Eng |
| I-25 | M | RefundRouter, Refund state machine (§A2.6, §15.6), refund API | T1 has no refund module and no Data block. | `refunds`, `refund_lines`, `refund_attempts` in payments, decision source in returns, orders, admin. | CTO |
| I-26 | M | §20.1 SellerOrder states include return states; A2.6 lists Return and Refund as separate machines | One enumeration is overloaded. | Orders mirrors a coarse subset, returns owns the full state machine. | Eng |
| I-27 | H | Return window 14 d and 30 d for defects; payout eligibility "CLOSED (return window plus 3 days)"; `CLOSED` "after the return window" | Which window defines `CLOSED`? With 30 d defects, `CLOSED` at 14 d lets money leave before a valid defect claim. | `closed_at` uses the longest window, payout accrual has a configurable holdback. Needs Finance and Legal. **VERIFY BEFORE LAUNCH**. | Finance |
| I-28 | L | `order_groups(totals…)` | Elided. | Explicit money columns (orders). | Eng |
| I-29 | M | `order_lines(discount_alloc, vat)` | One column cannot carry funding (platform, seller, split), which the ledger and VAT base need (§17, §B4). | `platform_funded_amount`, `seller_funded_amount`, `order_line_promotions`. | Eng |
| I-30 | M | States `PAID | CONFIRMED_COD` as alternatives | COD has no paid state until remittance, yet payouts depend on `CLOSED`. | Payout accrual keys on `CLOSED`, not `PAID`. COD cash is clearing, not seller money. | Finance |
| I-31 | M | §23 contribution margin per order includes shipping cost | No courier cost or billing entity exists. | Gap: `courier_charges` listed, not modelled. | Ops |
| I-37 | H | `payment_events_raw.event_id UNIQUE`, `courier_events_raw` dedup, `order_groups.idempotency_key`, T3 monthly partitions | A unique index on a partitioned table must include the partition key, so global uniqueness is impossible. | Small unpartitioned dedup tables written in the same transaction. | Eng |
| I-67 | L | T1 module list; §7 Data block lists `order_groups`, `payment_intents`, `reservations` under checkout; wishlists have no module | Table ownership differs from T1. | Ownership follows T1 (orders, payments, inventory). Wishlists housed in cart. A checkout session table is added. | Eng |
| I-73 | M | "One payment intent per OrderGroup", PSP idempotency key = order group id | A shopper who fails and retries with a different method cannot reuse the key with different parameters. | Attempts on one intent while open, a new group after terminal failure. | Eng |
| I-75 | M | OrderGroup is in the A2.6 state-machine list with no states | Missing definition. | Proposed set in orders. | Eng |

## 4. Inventory (§20.2)

| Id | Sev | Spec says | Problem | Resolution in the model | Decision |
|---|---|---|---|---|---|
| I-21 | H | `inventory_units` PK `(sku_id, location_id, id)`, reserve SQL updates `WHERE u.id = picked.id`; pool materialised from `on_hand - committed`, capped at 1,000; `location_id` has no entity | The update can touch rows of another SKU if ids are not globally unique, `on_hand` and unit counts legitimately differ, and locations are undefined. | Globally unique ids, composite PK kept for locking, `locations` entity, pool count is a cache. | Eng |
| I-22 | L | Unit state `available | reserved | claimed` | No state for lost or damaged stock found at inspection. | `WRITTEN_OFF`. | Eng |
| I-61 | M | Fawry 24 h and wallet 30 min windows "hold their reservation" with "a separate non-drop stock pool", while §7 reservation TTL is 10 min | Different TTLs and an undefined pool entity. | `stock_pools`, per-reservation `expires_at`, `reservation_ttl_policies` by payment method (ADR-0011 proposed). | Product |

## 5. Ledger, payouts, tax (§T4, §B4, §22)

| Id | Sev | Spec says | Problem | Resolution in the model | Decision |
|---|---|---|---|---|---|
| I-08 | L | Chart of accounts as free-text names | A typo creates a new account type silently. The domain spec keeps account types as static code. | `ledger_account_types` as a seed mirror of the code table, with an FK. | Eng |
| I-09 | H | Order-paid example: "platform_vat_output 32.2 ... (14% on commission 230)" in piastres | 32.2 piastres is not representable. | Single half-even rounding point, the example balances only because the fractional parts add to an integer. | Finance |
| I-10 | L | `ledger_accounts.owner_id`, ids | Migration uses `text` owner ids and v4 uuids, convention elsewhere is uuidv7. | Documented, no change needed. | Eng |
| I-11 | H | Chart of accounts in §T4 | No account for PSP and courier fees, bank settlement, coin liability, breakage or expiry income, chargebacks, or seller supply VAT, so several described flows cannot post. | `docs/specs/ledger-chart-of-accounts.md` adds bank settlement and the two fee accounts and parameterises seller receivables. Coins, breakage, chargebacks and seller-supply VAT are still open. **VERIFY BEFORE LAUNCH** tax treatment. | Finance |
| I-12 | H | §7 saga: "a ledger hold (pending entries)" vs "postings are immutable" | Pending postings contradict immutability and the zero-sum trigger. | `ledger_holds` table. | Eng |
| I-13 | L | `journal_entries(kind, ref_type, ref_id)` | No vocabularies for `kind` and `ref_type`. | Proposed set in ledger. | Eng |
| I-32 | M | "Refund after payout, seller balance negative, netted from the next payout" | No rule if the seller never earns again. | Receivable handled by Finance, undefined. | Finance |
| I-33 | M | `seller_payable` as a single account | Balance timeline (pending, eligible, held) is not defined. | `payout_accruals` status, nightly tie-out to the account. | Finance |
| I-34 | L | `payout_instruments(owner_user_id)` in the inventory | Owner may be a store or a creator. `creator_kyc_records` does not exist there either. | `owner_type`, `owner_id`. | Eng |
| I-38 | H | §B4 describes receipts and invoices only | Refunds and returns require credit notes or cancellations. | `tax_documents.kind = CREDIT_NOTE`. **VERIFY BEFORE LAUNCH** ETA process. | Tax |
| I-74 | M | §T4 "verified hash chain on journal entries" | Neither the spec columns nor migration 0003 have a hash. | `ledger_chain_links`, built after commit. | Eng |
| I-76 | H | Gift card `scope_store_id`; "redemption converts the card to store credit" | The scope would be lost on conversion, widening where the value is spendable. | `credit_sub_balances.scope_store_id`. | Eng |

## 6. Money features, loyalty, subscriptions (§12, §14, §15)

| Id | Sev | Spec says | Problem | Resolution in the model | Decision |
|---|---|---|---|---|---|
| I-41 | M | §15.1 "Redemption converts the card to store credit ... Partial use is allowed" | Two meanings of partial use. | Whole remaining value converts, partial use happens in the wallet. | Product |
| I-42 | L | Inventory `group_gift_pots` mixes pot and payer | One pot has many payers. | `group_gift_pots`, `group_gift_contributions`. | Eng |
| I-43 | M | Refund of credit-paid portion "goes back to the same sub-balance" | An expired sub-balance cannot take it back. | A new `refund_credit` grant. | Finance |
| I-44 | M | `cashback_coins` is a wallet sub-balance (§15.2), coins convert at 1 to 1 piastre (§15.5), clawback on return | Are coins in the wallet or converted into it? Clawback after conversion has no rule. | Coins live in rewards, convert into a sub-balance, debt netted from future earnings. | Product |
| I-86 | M | Phase 1 checkout lists store credit as a payment method, Phase 2 lists "gift cards & store credit" | Phase of the wallet is ambiguous, and ADR-0014 splits it. | Store credit balance is Phase 1 (non-purchasable), gift card sale and redemption Phase 2 behind kill switches. **VERIFY BEFORE LAUNCH** licence opinion. | Legal |
| I-45 | H | §12: budget never used by promotions or ads; hard cap blocks checkout | Checkout must consult budget without storing budget data. | Boolean verdict only, no stored value, import ban. | Eng |
| I-46 | M | §B7 Plan B "Stylist Pro IAP" | No entitlement model for IAP. | Not modelled until Plan B triggers. | Product |
| I-47 | L | `subscriptions.psp_token_ref` | Duplicates `payment_methods`. | FK to `payment_methods`. | Eng |
| I-49 | M | Referral reward after window closes | Rule for a refund after reward is missing. | Clawback within the claim window, otherwise absorbed. | Finance |
| I-50 | L | `referrals(referrer_id, referee_id, status, order_id)` | Click, registration and qualified order are distinct fraud signals. | `referral_attributions`. | Eng |
| I-51 | M | §12 "refund in the next cycle ... credited to the original cycle in reports and to available now in the current one" | One `spent` number cannot give both views. | `budget_cycle_entries` with `cycle_id` and `applied_cycle_id`. | Eng |
| I-52 | M | Budget fields are P3 field-encrypted (T5) | Aggregation in SQL is not possible. | Per-user in-app aggregation, bounded by cycle. | Eng |
| I-60 | M | §24 payday trigger "you can afford 3 wishlist items now" | The push payload would carry budget-derived facts to third-party providers. | Symbolic payload, count not amount, opt-in. | DPO |
| I-66 | L | Consent per channel (§B1) vs notification preferences per type (§24) | Two layers of opt-in. | Both tables, send needs both. | Eng |

## 7. Sizing, stylist, recommendations, analytics (§10, §11, §13, §26)

| Id | Sev | Spec says | Problem | Resolution in the model | Decision |
|---|---|---|---|---|---|
| I-54 | M | `fit_model_params(user_id\|item_id\|brand_id ...)` | A polymorphic key cannot have FKs. | Three tables. | Eng |
| I-55 | L | Cart alerts `product_alerts`, inventory `size_alerts` | One concept, two names. | `product_alerts`. | Eng |
| I-56 | H | `outfits(request jsonb ...)` and "no budget defaults to remaining monthly budget" | The request can persist a budget-derived amount in a P2 table. | Encrypted nullable `budget_enc`, preferably symbolic. | DPO |
| I-57 | L | `llm_audit_log` vs `llm_external_calls` | Overlap. | One table with `vendor`. | Eng |
| I-58 | L | `user_features (feature store)` | Not necessarily Postgres. | Online subset kept for deletion semantics. | Eng |
| I-63 | M | Experiments in §20.5 and §23 | No owning module. | Placed in analytics-ingest provisionally. | CTO |
| I-70 | M | Hash-keyed graph with yearly key rotation (T5) and 24-month signal window | Rotation breaks linkage across the window. | Overlap policy needed. | DPO |
| I-71 | M | Reviews, Q&A, photo reviews, live chat | No T1 module. | Housed in trust-safety. | CTO |

## 8. Sellers (§19, §9.5)

| Id | Sev | Spec says | Problem | Resolution in the model | Decision |
|---|---|---|---|---|---|
| I-68 | L | `stores.health_score` (§3) vs "Seller Health Score" (§19) | Seller or store level. | Store level, cached on `stores`. | Product |
| I-80 | M | KYC `APPROVED -> SUSPENDED` (seller) vs enforcement ladder "Store auto-suspended" | Two levels. | Both statuses. | Product, **VERIFY BEFORE LAUNCH** legality of automatic suspension. |

## 9. Documents and migrations drift

| Id | Item | Notes |
|---|---|---|
| D-01 | `users` in migration 0006 has `status` values `pending, active, suspended, deleted` and locale `ar, en`. The model uses `ACTIVE, SUSPENDED, PENDING_DELETION, DELETED` and `ar-EG`. | Align by migration 0008 or update the doc. Phone, email and DOB columns arrive in later expand migrations (the inventory says so). |
| D-02 | `outbox_events` in migration 0004 has `PRIMARY KEY (id)` and is not partitioned. Platform model says `(id, occurred_at)` partitioned monthly. | Expand and contract with a new partitioned table. |
| D-03 | `devices.push_token` (spec, auth model) not in migration 0006. | Pending expand migration. |
| D-04 | `consent_records.ip_hash` is `text` in the migration, `bytea` for hashes elsewhere. | Pick one. |
| D-05 | Data inventory table names differ from the model for: `size_alerts` (model `product_alerts`), `group_gift_pots` (split), `llm_external_calls` (merged), `staff_accounts` (admin plus `store_members`), `payout_instruments` (owner type). | Regenerate the inventory after review. |
| D-06 | The inventory has no entries for most Phase 1 and 2 tables (promotions, payouts detail, tax documents, voc, etc.). CI "fail on untagged column" will fail once migrations exist. | Extend `data_inventory.yaml` per module. |
| D-07 | `packages/policy/RLS.md` and `src/rules.ts` use table and variable names that differ from this model: `cart_items` (cart_lines), `store_orders` (seller_orders), `return_requests` (returns), `store_credit_accounts` (credit_sub_balances), `courier_tasks` (shipments), `creator_links` and `creator_payouts` (affiliate_links, payouts), `listings` and `product_variants` (products, skus), `store_staff` (store_members), `app.store_ids` (spec: `app.current_store_id`). | Policy owner and data-model owner to agree one list before the first tenant migration. |

## 10. Gaps (entities the spec needs that are not modelled)

| Gap | Where it is needed | Status |
|---|---|---|
| Courier billing (`courier_charges`) | §23 contribution margin, courier invoice reconciliation | Not modelled (I-31). |
| `ads` module (auction, billing, pacing) | §4, §19, §23 | Minimal sponsored tables only (I-39). |
| IAP entitlements (Plan B) | §B7 | Deferred (I-46). |
| Partner wallet (Phase 3) | §B2 | Placeholder table only. |
| Cross-border import and duties | §3 Global (Phase 3) | Not modelled. Owner decision 2026-10-10 treats foreign sellers as long-lead. |
| Warehouse (ClickHouse) fact tables | §26, §19.1 | Control plane only, dbt models are listed, not specified. |
| Feature store and model registry schema | §T3 | Outside Postgres. |
| Hub consolidation, try-at-door, resale lane details | §21, §22, §28 | Phase 2 minimal columns, no workflow tables. |
