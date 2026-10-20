# Spec P3-04: Creators and affiliates

Refs: §15.4, §16 (shop-the-look), §11, §B4, §B6, ADR-0008, ADR-0037, VR-17, VR-P3-03, VR-P3-04. Depends on: referrals (device/instrument graph, self-referral block), ledger, orders and returns (return window closure), payouts (rail, dual approval), notifications, stylist (curated looks), admin.
Status: attribution, accrual and dashboards buildable now on synthetic data with a fake payout port; cash payout stays off until VR-P3-03 is Verified.

## Flow
1. Application: shopper (21+) applies -> KYC (national ID, payout identity, tax form data, P3 encrypted) -> terms accepted (AR/EN, versioned) -> admin approval (auto checks where possible, human queue for rejections) -> `ACTIVE`.
2. Creator gets a profile, affiliate links per product, store or look (`/c/{handle}`), a curated-look builder (items from the catalog, price and stock live), and a dashboard.
3. A visitor opens a link -> deep link / universal link -> click recorded -> attribution cookie or app token (last-click, 7-day window, configurable) -> order -> after the return window and no refund, commission accrues -> payout per ADR-0037.

## Rules
- Eligibility: 21+, KYC complete, not a seller of the same store (conflict rule), terms accepted.
- Commission = rate x net merchandise value of eligible lines (after item discount, vouchers excluded from base only per the rule set in ADR-0037, excluding shipping, VAT, gift cards, Plus fees and store credit top-ups). Rates are per category, admin-editable, versioned and snapshot onto the attribution.
- Accrual only after the line is `CLOSED` and not refunded; refund after accrual creates a clawback entry (negative balance netted from the next payout).
- Self-purchase through own link earns nothing; self-referral by device, instrument or address cluster earns nothing and is logged silently.
- Disclosure: every creator surface (look, link share page) shows a localized "affiliate / paid partnership" label (wording pending VR-P3-04). Looks may only reference real catalog items; prices are never creator-entered.
- Verified-discount rules (§9) apply unchanged; creators cannot display reference prices or "% off" not supplied by the price-integrity engine.
- Caps: max payout per creator per month (fraud guard), max link clicks per IP per hour counted.
- Creator content is UGC: moderated (§27), report flow, takedown.
- Budget data and size measurements are never visible to creators; analytics to creators are aggregates with k >= 50 for any demographic cut.

## Edge cases
Attribution conflict between two creators (last valid click wins, tie by timestamp); referral program and creator link on the same order (creator wins for commission, referral reward rules unchanged and non-stacking per spec decision recorded in ADR-0037); order partially returned (pro-rata); order cancelled; click fraud (bot, no session, headless user agent); deleted product in a look; creator suspended -> accruals held, links disabled, existing orders honored; handle squatting and impersonation (reserved list, verification for brand names); deep link without app installed (web fallback); currency EGP only; creator also a shopper under 21 (blocked from payouts, allowed as shopper).

## Data
`creator_accounts(id, user_id, handle, status, kyc_state, terms_version, payout_pref cash|credit)` · `creator_kyc` P3-enc · `affiliate_links(id, creator_id, target_type, target_id, slug, created_at)` · `affiliate_clicks(link_id, ts, device_hash, ip_hash, ua_class)` partitioned monthly · `attributions(order_group_id, creator_id, link_id, rate_bps, window_end, status)` · `commissions(id, attribution_id, order_line_id, base BIGINT, amount BIGINT, state ACCRUING|ACCRUED|CLAWED_BACK|PAID)` · `creator_looks(id, creator_id, items[], status)`. Ledger accounts: `creator_payable:{creator}`, `creator_commission_expense`. Commission state machine table-driven.

## API
`POST /v1/creator/apply` · `GET /v1/creator/dashboard` · `CRUD /v1/creator/links` · `CRUD /v1/creator/looks` · `GET /v1/creator/commissions` · `POST /v1/creator/payout-preference` · public `GET /v1/c/{handle}` (rate-limited, no PII) · `POST /v1/referrals/attribute` extended with `link_id`. Admin: `CRUD /v1/admin/creators`, approvals with dual approval for payout batches. Webhooks none.

## Events
Inbox (relay consumer `creators.relay`, plus the module's own inbox rows): `order_group.paid` / `order_group.cod_confirmed` -> `AttributeOrder` (HELD throws so the relay retries, A-3); `order_line.closed` -> `AccrueClosedLine` (deferred while the attribution is HELD); `order_line.refunded` -> `ApplyLineRefund`. Payloads and guarantees: `docs/specs/commerce-events.md`. Outbox: `creator.approved`, `affiliate.click_recorded` (batched), `commission.accrued`, `commission.clawed_back`, `creator_payout.requested`. Analytics: `creator_link_clicked`, `creator_look_viewed`, `creator_look_added_to_bag`, `creator_order_attributed`.

## Failure handling
Click ingest is lossy-tolerant (batched, sampled for analytics but the attribution token is exact); accrual job idempotent by `(order_line_id, creator_id)`; ledger post failure retries, balanced entries only; payout failure -> `FAILED(retry)` per existing payout machine; reconciliation: commissions vs ledger nightly.

## Security and abuse
BOLA on creator resources; tenant isolation by creator id (RLS); link tokens unguessable for private campaigns; SSRF none (no URL fetch); fraud graph reused from referrals; affiliate-link hijack via parameter tampering (signed link params); OWASP API6 and API10; KYC data P3 encrypted, access logged with reason. Payout needs dual approval above threshold, IBAN name match.

## Metrics
Creator-attributed GMV share, commission % of GMV, return rate of attributed orders vs baseline (guardrail), fraud rejection rate, active creators, payout ageing, complaints about undisclosed endorsements (target 0).

## Acceptance
```
Given an attributed order with a line returned on day 10, then no commission accrues for that line.
Given a creator buys through their own link, then commission is 0 and a silent audit event exists.
Given an accrued commission and a later refund, then a clawback entry nets the next payout.
Given the ledger trial balance after any commission sequence, then it equals 0 (property test).
Given payout flag off, then accruals continue and no payout instruction is created.
Given creator under 21, then application is refused with the policy reason.
```

## Implementation notes (wave B backend, 2026-10-12)
Built: domain `packages/domain/src/creators`, module `apps/api/src/modules/creators`, migrations 0074 to 0077, flags `kill.creator_program` and `kill.creator_payouts` (both default blocked), ledger accounts `creator_payable:{creator_user_id}` and `creator_commission_expense` (chart rule R7 and examples 12 to 14 in `docs/specs/ledger-chart-of-accounts.md`). Backend only: no mobile, seller or admin UI.

Decisions and deviations from the text above:
- **Click ingest** is `POST /v1/affiliate/clicks` (public, always 202) instead of extending `POST /v1/referrals/attribute` with `link_id`. Clicks are anonymous and pseudonymous (device and IP hash); attribution is decided at order time from the buyer's own devices (`AttributeOrder`, called by checkout after payment), last valid click inside the window wins, ties by id. The referral attribute route is unchanged and referral rewards stay non-stacking with creator commission (the creator wins the commission, the referral rules are untouched).
- **Accrual** is driven by two orders-side messages (`LineClosedMessage`, `LineRefundedMessage`, consumed through the inbox). The orders and refunds modules do not emit them yet: the use cases are exported and tested, the producers are an integration item.
- **Claim, then post.** The commission row, the monthly-cap counter and the ledger posting intent are one transaction (`commission_postings`); the idempotent ledger entry is posted right after and a repair sweep (`PostCommissionIntents.sweep`) posts any intent left behind. `creator_payable` is the system of record for what is payable; payouts never exceed it.
- **Clawback** is pro rata and cumulative on the line (`planRefund`), never negative silently: a clawback of an already paid commission leaves a negative payable that the dashboard reports as `owes_platform`, emits `creator.balance_negative`, and blocks the next payout until netted by new accruals.
- **Held commissions** (`ACCRUING`): monthly cap (all-or-nothing, atomic counter) or creator not ACTIVE. No ledger entry until released (`ReleaseHeldCommissions`). A held commission that is fully refunded is voided.
- **Fraud** reuses the referral graph (`decideCreatorFraud`): self purchase, same device, shared payment fingerprint, shared delivery address, or a link cluster larger than the threshold voids the attribution silently (stored `VOIDED`, outbox event `creator.attribution_voided`, never shown).
- **Payouts** use the seller payout state machine and admin approval records. Engaged off: blocked flag answers 503 `creator_payouts_disabled` and creates nothing; with the flag allowed and the provider Unconfigured, send answers 503 `creator_payout_provider_unconfigured` before any ledger post. Credit-preference conversion (store-credit payout) is not built: it needs a closed-loop sub-balance without the existing expiry rules (ADR-0037 open item).
- **KYC** fields are sealed through `CreatorKycVaultPort` (KMS envelope in production, fake in tests), stored as `bytea` with a blind index for one-identity-one-creator, and never returned. Tax form fields are tagged VERIFY BEFORE LAUNCH (VR-P3-03).
- Rates, caps and thresholds in `DEFAULT_CREATOR_CONFIG` are placeholders for the owner decision in ADR-0037 (default 3%, EGP 20,000 monthly accrual cap, EGP 500 minimum payout, 7 day window).

Known gaps: DSAR exporter for creator KYC and payouts (exemptions recorded); analytics events (`creator_link_clicked`, `creator_look_viewed`, `creator_look_added_to_bag`, `creator_order_attributed`) are not in the analytics catalog yet; production composition is `blocked` in `production/bindings.ts` until identity, catalog, ledger-gateway, KMS vault, approvals and terms ports are bound; creator terms text rows (`creator_terms`) have no admin publish route; disclosure wording pending VR-P3-04; handle impersonation review for brand names beyond the reserved list.

- Phase 3 money review part A (2026-10-12): click ingest is salted, capped per device, link and IP, deduped and aggregated into one outbox event per creator per minute (`affiliate.clicks_active`, which replaces the per-click `affiliate.click_recorded`); the referral and creator reward do not stack (owner decision in ADR-0037: the commission is voided with `referral_stacking`); a missing identity profile holds the attribution. See ADR-0037 "Chief reviewer findings, part A" for the residual click-spoofing risk.

## Review follow-ups (money fix A-1, A-3, A-9)

- **A-1 install-token mint.** `POST /v1/affiliate/install-tokens` mints only for a device registered to the caller (`CreatorIdentityPort.profile(userId).deviceHashes` contains the keyed hash of the presented device id). Any other device id, owned or not by someone else, answers an identical 404 (no ownership oracle). Attestation (App Attest / Play Integrity) stays an open owner item (OD-4).
- **A-3 void callers.** `VoidAttribution` is reached by `POST /v1/admin/creators/attributions/:id/void` (`:id` = order group id; trust and safety or super admin; fraud reason code enum, no free text; policy decision audited before the action; idempotent). **No automatic caller exists**: the fraud module emits no ring-detected event today, so a consumer cannot be wired. Gap recorded; when such an event exists, a creators consumer calls `VoidAttribution` with reason `cluster`. The `MAX_SIBLINGS = 50` cluster window is unchanged (indexed set query is a separate item).
- **A-9 accrual gate.** `order_line.closed` must carry `return_window_ends_at_ms` and `open_returns`. `accrualGate` defers (relay retry) while a return is open, the line's own window has not elapsed, or either fact is absent. Orders must emit both fields (owed by the orders owner).
