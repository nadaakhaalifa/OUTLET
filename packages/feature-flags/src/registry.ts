/**
 * Typed flag registry. Naming: kill switches are "kill.<area>.<name>" and are boolean where
 * `true` means "the capability is allowed to run". They are DEFAULT-OFF and FAIL CLOSED: an
 * unknown flag, missing provider, provider error, type mismatch or timeout evaluates to false.
 *
 * POLARITY (ADR-0028, "allowed when true"): the word "kill" names the switch, not its value.
 *   true  -> the capability is ALLOWED to run   (operators and the admin console say "Allowed")
 *   false -> the capability is BLOCKED           (operators and the admin console say "Blocked")
 * Never describe a switch as "on" or "off" in UI, runbooks or incident notes; use `describeState`.
 * Inverting the polarity was rejected: default-off would then mean everything is allowed.
 * A rename to `capability.<area>.<name>` (same polarity) is a tracked pre-launch follow-up.
 *
 * A switch that is `false` by default means a fresh environment has everything off until it is
 * explicitly turned on per environment. That is intentional: launching a payment method or
 * payout is a deliberate act (several are legally gated, VERIFY BEFORE LAUNCH).
 *
 * `KILL_SWITCHES` is the A2.12 core set of 14. `PHASE2_KILL_SWITCHES` adds the switches the
 * Phase 2 specs and modules read. Both are registered in `FLAG_REGISTRY`.
 */
export const PAYMENT_METHODS = ["card", "apple_pay", "mobile_wallet", "instapay", "fawry"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const KILL_SWITCHES = {
  "kill.payment.card": { description: "Card payments via the PSP" },
  "kill.payment.apple_pay": { description: "Apple Pay" },
  "kill.payment.mobile_wallet": { description: "Mobile wallet payments (e.g. Vodafone Cash)" },
  "kill.payment.instapay": { description: "InstaPay QR / request-to-pay" },
  "kill.payment.fawry": { description: "Fawry reference-code payments" },
  "kill.payment.cod": { description: "Cash on delivery" },
  "kill.payment.bnpl": { description: "Buy now pay later (lender-provided; VERIFY BEFORE LAUNCH)" },
  "kill.drops": { description: "Limited drops and the waiting room" },
  "kill.games": { description: "Games and rewards mechanics" },
  "kill.stylist_llm": { description: "LLM stylist" },
  "kill.ml_ranking": { description: "ML ranking; fall back to rules-based ranking" },
  "kill.crawlers": { description: "External catalogue and price crawlers" },
  "kill.referral_payouts": { description: "Referral reward payouts" },
  "kill.gift_card_sales": { description: "Gift card sales" },
} as const;

export const COURIERS = ["bosta", "aramex", "mylerz"] as const;
export type CourierCode = (typeof COURIERS)[number];
export const PLUS_RECURRING_METHODS = ["card", "mobile_wallet", "apple_pay"] as const;
export type PlusRecurringMethod = (typeof PLUS_RECURRING_METHODS)[number];
export const DROP_TYPES = ["public", "members_only", "flash_hour", "mystery_box", "price_ladder", "last_chance"] as const;
export type DropTypeCode = (typeof DROP_TYPES)[number];

/**
 * Phase 2 switches. Polarity is the same as above: `true` allows the capability, `false` (the
 * default) blocks it. The blocked behaviour is stated per entry so operators know the outcome.
 */
export const PHASE2_KILL_SWITCHES = {
  "kill.plus.sales": { description: "Plus sign-ups and plan switches (§14). Blocked: no new subscriptions; existing members keep benefits" },
  "kill.plus.recurring.card": { description: "Plus recurring charges on cards. Blocked: renewals pause and members are told" },
  "kill.plus.recurring.mobile_wallet": { description: "Plus recurring charges on mobile wallets (VERIFY BEFORE LAUNCH). Blocked: renewals pause" },
  "kill.plus.recurring.apple_pay": { description: "Plus recurring charges on Apple Pay. Blocked: renewals pause" },
  "kill.gift_card_redemption": { description: "Gift card redemption into store credit (§15.1). Blocked: redemption answers 503" },
  "kill.rewards_coins": { description: "Earning and converting HAUL Coins (§15.5). Blocked: no new coins, conversions pause" },
  "kill.budget_caps": { description: "Hard and soft spending-cap enforcement at checkout (§12). Blocked: caps are not enforced" },
  "kill.stylist_ml": { description: "ML ranking inside the stylist (§11). Blocked: rule-based outfits (templates, popularity, colour rules)" },
  "kill.llm_search_parse": { description: "LLM natural-language search parsing (§4). Blocked: plain keyword search" },
  "kill.sponsored_products": { description: "Sponsored products and CPC billing (§19). Blocked: no sponsored slots are served or billed" },
  "kill.hub_consolidation": { description: "Hub consolidation of multi-seller orders (§21). Blocked: shipments go out per seller order" },
  "kill.resale_lane": { description: "Returns-resale lane, open-box returned items (§22). Blocked: no new listings or sales" },
  "kill.waiting_room": { description: "Waiting-room queue admission for drops (§16). Blocked: fails closed, drops are paused" },
  "kill.mystery_box": { description: "Mystery-box drops (§16; lottery rules VERIFY BEFORE LAUNCH). Blocked: mystery boxes cannot be created or bought" },
  "kill.drop_type.public": { description: "Public drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.members_only": { description: "Members-only drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.flash_hour": { description: "Flash-hour drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.mystery_box": { description: "Mystery-box drop type (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.price_ladder": { description: "Price-ladder drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.last_chance": { description: "Last-chance drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.search_engine": { description: "Typesense as the primary search engine (§4, T9). Blocked: Postgres FTS fallback with reduced features" },
  "kill.courier.bosta": { description: "Bosta courier adapter (§21). Blocked: AWB creation queues and the seller sees label pending" },
  "kill.courier.aramex": { description: "Aramex courier adapter (§21). Blocked: AWB creation queues and the seller sees label pending" },
  "kill.courier.mylerz": { description: "Mylerz courier adapter (§21). Blocked: AWB creation queues and the seller sees label pending" },
  "kill.plus.family": { description: "Family plan sales, invites, accepts and seat changes (§14, spec P3-03). Blocked: answers 503 family_unavailable; existing members keep benefits until period end" },
  "kill.plus.student": { description: "Student verification and student plan sales (§14, spec P3-03, VR-P3-09). Blocked: answers 503 student_unavailable; renewals follow the stored verification" },
  "kill.price_drop_auto_buy": { description: "Price-drop auto-buy rules and target-price notifications (§28 row 1, ADR-0036). Blocked: no new rules, the evaluator does nothing and shoppers see paused; stored rules stay armed" },
  "kill.auto_buy.charge": { description: "Unattended merchant-initiated charge for auto-buy (ADR-0036; VR-P3-01, VR-P3-02 must be Verified). Blocked: shoppers are only notified and no charge call is ever made" },
  "kill.stylist_chat": { description: "Stylist chat mode (§11, spec P3-07). Blocked: chat answers 503 stylist_chat_disabled and the app shows the structured stylist; sessions can still be read and deleted" },
  "kill.visual_search": { description: "Visual search by photo and visual similar items (§4, spec P3-08). Blocked: image search answers 503 visual_search_disabled and the PDP similar list uses attributes" },
  "kill.demand_forecasting": { description: "Demand forecasting baseline (§20.8, spec P3-05). Blocked: the nightly batch does nothing and the seller forecast read answers 503 demand_forecasting_disabled; stored forecasts are kept" },
  "kill.ranking_v2_shadow": { description: "Ranking v2 shadow scoring (§20.5, spec P3 LTR ranking v2). Blocked: v2 scores are not computed or logged; v1 serving is unaffected either way and shadow scoring never changes what a shopper sees" },
  "kill.calendar_gap_fill": { description: "Outfit calendar gap fill (§28 row 3, spec P3-02). Blocked: events still work, outfit generation answers 503 calendar_gap_fill_disabled" },
  "kill.calendar_reminders": { description: "Outfit calendar reminders (spec P3-02). Blocked: due reminders stay pending and nothing is sent" },
  "kill.wardrobe": { description: "Wardrobe digitization (§28 row 4, spec 28 feature 4). Blocked: wardrobe writes and complete-from-wardrobe answer 503 wardrobe_disabled; shoppers can still list, read and delete their items" },
  "kill.wardrobe_vision": { description: "Photo to attribute suggestions for wardrobe items (spec 28 feature 4, VR-P3-13). Blocked: suggest-attributes answers 503 wardrobe_vision_disabled; items are described by hand" },
  "kill.creator_program": { description: "Creators and affiliates: applications, links, click ingest, attribution and commission accrual (§15.4, spec P3-04, ADR-0037). Blocked: no new links or applications, clicks are not attributed and accruals pause; stored data and balances stay readable" },
  "kill.creator_payouts": { description: "Creator commission payouts (ADR-0037; VR-P3-03 must be Verified). Blocked: accruals continue, no payout instruction is ever created or sent" },
  "kill.public_catalog": { description: "Anonymous catalog reads under /v1/public (stores, products, search, sitemap feeds; spec P3-06). Blocked: every /v1/public catalog route answers 503 public_catalog_disabled; authenticated routes are unaffected" },
  "kill.background_removal": { description: "Automatic background removal for seller product photos (self-hosted rembg sidecar, spec 19 catalog media). Allowed-when-true, default blocked (ADR-0028). Blocked: process and re-run answer 503 background_removal_disabled; sellers keep their originals and can use them as is" },
  "kill.odoo_channel": { description: "Odoo seller channel polling and connection tests (§9.2, §19, spec P3 item 11, VR-P3-10). Blocked: no outbound call to any seller Odoo is made, the poll batch does nothing and connection tests answer kill_switch; stored channels and links are kept" },
  "kill.home_banners": { description: "In-app offer banners: the swipeable carousel on the shopper Home (spec 16 feed, 17 promotions). Allowed-when-true, default blocked (ADR-0028). Blocked: GET /v1/home/banners answers 200 with an empty list so the Home hides the carousel; admins can still edit and schedule banners" },
  "kill.analytics.ingest": { description: "First-party client analytics ingest, POST /v1/analytics/events (dashboard foundations track 5). Allow for real users only after VR-DASH-03 (lawful basis) and VR-DASH-07 (attestation verifier) are Verified or Accepted risk. Allowed-when-true, default blocked (ADR-0028). Blocked: The ingest route answers 503 analytics_ingest_disabled, the tracker drops batches and counts them; nothing is stored" },
  "kill.analytics.producers": { description: "Server-side analytics producers: the checkout, purchase and return facts that transitions append to the outbox for seller reporting (dashboard foundations track 5, B3). Allow only after VR-DASH-03 is Verified or Accepted risk (owner and counsel decision, with a CR checkpoint). Allowed-when-true, default blocked (ADR-0028). Blocked: server producers append no analytics event; the money transition still commits" },
  "kill.analytics.consumers": { description: "Analytics outbox consumers: seller-analytics facts and rollups, platform metrics (dashboard foundations tracks 5 and 6). Allowed-when-true, default blocked (ADR-0028). Blocked: The consumers are not registered: events are acknowledged unrouted and stay replayable from outbox_events" },
} as const;

export const ALL_KILL_SWITCHES = { ...KILL_SWITCHES, ...PHASE2_KILL_SWITCHES } as const;
export type KillSwitchKey = keyof typeof ALL_KILL_SWITCHES;

export const RELEASE_FLAGS = {
  "release.budget_suite": {
    description: "Budget suite and affordability (§12). Blocked: budget routes answer 404 and affordability filters are ignored",
  },
  "release.us_storefront_linkout": {
    description: "US-only web purchase link-out (spec section on App Store storefronts); VERIFY BEFORE LAUNCH",
  },
  "release.market.additional_markets": {
    description: "Any market other than EG (ADR-0040). Blocked: only the default market EG is available; no other market has been researched",
  },
  "release.admin_console.identity": {
    description: "GET /v1/admin/me and the console identity states (dashboard foundations track 1, VR-AC-01). Blocked: the route answers 404 and admin-web keeps its current behaviour",
  },
  "release.seller_center.role_nav": {
    description: "Role-aware Seller Center navigation from store-scoped me (dashboard foundations track 2). Blocked: seller-web keeps showing every link and the routes still decide with 403 or 404",
  },
  "release.admin.ledger_integrity": {
    description: "GET /v1/admin/ledger/integrity and /runs (dashboard foundations track 3). Blocked: both routes answer 404; recording of integrity runs is unaffected",
  },
  "release.seller_analytics.series": {
    description: "Seller analytics time-series for UNGATED metrics and the store-scoped summary route (dashboard foundations track 4). Shopper-gated series and breakdowns are controlled by release.seller_analytics.shopper_series. Blocked: the ungated series and summary routes answer 404 and the nine existing report routes are unchanged",
  },
  "release.seller_analytics.shopper_series": {
    description: "Every shopper-gated seller series and breakdown (unique_visitors, repeat_rate_bps, source and governorate breakdowns) and the switch of the legacy gated fields to the Cairo grid with the monotone suppression memo (dashboard foundations track 4, B1, B2; owner DPO; VR-DASH-02 and VR-DASH-05 must be Verified or Accepted risk first). Blocked: gated series and breakdown routes answer 404 and the legacy aggregates keep UTC days and the fold rule",
  },
  "release.admin.metrics": {
    description: "GET /v1/admin/metrics/{metricId} platform time series (dashboard foundations track 4). Blocked: the route answers 404",
  },
  "release.admin.audit_log": {
    description: "GET /v1/admin/audit-log and /verify (dashboard foundations track 7). Blocked: both routes answer 404",
  },
  "release.admin.attention": {
    description: "GET /v1/admin/attention counts-only queue (dashboard foundations track 7). Blocked: the route answers 404",
  },
  "release.seller.balance": {
    description: "GET /v1/seller/stores/{storeId}/balance (ADR-0050, payout visibility ADR-0049 / VR-DB-02). Blocked: the route answers 404 with the same body as a foreign store and seller-web keeps its not-available state",
  },
  "release.admin.finance_views": {
    description: "Finance console read additions (dashboard Phase B backend, B-1 to B-3; ADR-0045/0046/0048/0049 safe defaults): GET /v1/admin/finance/payouts/summary, the aging, unmatched_over_3d and rails fields of GET /v1/admin/finance/reconciliation/summary, and the from/to range of GET /v1/admin/tax/reconciliation. Read-only finance data, audited. Blocked (default): the payout summary route and the range form answer 404 and the reconciliation summary keeps its previous fields only",
  },
  "flag.guest_browsing": {
    description: "Guest browsing and sign-in at checkout (ADR-0055, spec guest-browsing G0): POST /v1/me/guest-merge and the guest-only public reads GET /v1/public/skus, /feed, /home/banners, /search/suggestions. VERIFY BEFORE LAUNCH: VR-GUEST-01, VR-GUEST-02, VR-GUEST-03. Blocked (default): all five routes answer 404; nothing else changes",
  },
} as const;
export type ReleaseFlagKey = keyof typeof RELEASE_FLAGS;

export type FlagKey = KillSwitchKey | ReleaseFlagKey;

export interface FlagDefinition {
  readonly key: FlagKey;
  readonly kind: "kill_switch" | "release";
  readonly description: string;
  readonly defaultValue: false;
  readonly failClosed: true;
}

export const FLAG_REGISTRY: readonly FlagDefinition[] = [
  ...(Object.keys(ALL_KILL_SWITCHES) as KillSwitchKey[]).map(
    (key): FlagDefinition => ({
      key,
      kind: "kill_switch",
      description: ALL_KILL_SWITCHES[key].description,
      defaultValue: false,
      failClosed: true,
    }),
  ),
  ...(Object.keys(RELEASE_FLAGS) as ReleaseFlagKey[]).map(
    (key): FlagDefinition => ({
      key,
      kind: "release",
      description: RELEASE_FLAGS[key].description,
      defaultValue: false,
      failClosed: true,
    }),
  ),
];

export function paymentKillSwitch(method: PaymentMethod): KillSwitchKey {
  return `kill.payment.${method}`;
}

export function courierKillSwitch(courier: CourierCode): KillSwitchKey {
  return `kill.courier.${courier}`;
}

export function plusRecurringKillSwitch(method: PlusRecurringMethod): KillSwitchKey {
  return `kill.plus.recurring.${method}`;
}

export function dropTypeKillSwitch(type: DropTypeCode): KillSwitchKey {
  return `kill.drop_type.${type}`;
}

/** What operators and the admin console show for a flag value ("allowed when true", ADR-0028). */
export type FlagState = "allowed" | "blocked";

export function describeFlagState(enabled: boolean): FlagState {
  return enabled ? "allowed" : "blocked";
}

export function isKnownFlag(key: string): key is FlagKey {
  return FLAG_REGISTRY.some((d) => d.key === key);
}
