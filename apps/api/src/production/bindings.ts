import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * One row per directory under `src/modules`. `composed` modules boot in production with Postgres
 * stores and Unconfigured providers. `blocked` modules cannot be composed without changing the
 * module itself; they are left out of the production module graph and reported by /v1/ready.
 * A registry test fails when a new module directory has no row (ADR-0029).
 */
export type ModuleBinding =
  /** `gaps`: composed and booting, but not functional end to end; says exactly what is missing (honest partial). */
  | { readonly status: "composed"; readonly gaps?: string }
  | { readonly status: "blocked"; readonly reason: string };

export const MODULE_BINDINGS: Readonly<Record<string, ModuleBinding>> = {
  auth: { status: "composed" },
  addresses: { status: "composed" },
  sellers: { status: "composed" },
  privacy: { status: "composed" },
  catalog: { status: "composed" },
  "price-integrity": { status: "composed" },
  wishlists: { status: "composed" },
  sizing: { status: "composed" },
  notifications: { status: "composed" },
  admin: { status: "composed" },
  ads: { status: "composed" },
  "brand-verification": { status: "composed" },
  "channel-odoo": {
    status: "composed",
    gaps:
      "PARTIAL, dark behind kill.odoo_channel (default blocked). Real: Kysely store (0071), channel directory over the crawl store, seller SKU resolver (catalog KyselySkuLookup), versioned stock sink (inventory SyncSellerStock) and price sink (price-integrity recordPriceChange, source odoo), ProxiedOdooEgress (SSRF guard, vault secret injection, size cap, timeout, no redirects), poll batch job channel-odoo.poll-batch. Missing: (1) the allow-listed egress proxy transport behind EgressProxyPort and the DNS resolver (both Unconfigured crawler.egress, so every call fails closed as network_error); (2) the vault read needs the secrets manager configured (Unconfigured secrets.manager otherwise) and a secret named by the channel's token reference holding {login, api_key}. VR-P3-10 (real Odoo sandbox and API terms) gates enablement.",
  },
  "auto-buy": {
    status: "composed",
    gaps:
      "PARTIAL, dark behind kill.price_drop_auto_buy and kill.auto_buy.charge (both off). Composed: store, use cases, sweep job (auto-buy.sweep), relay consumer for price.changed, privacy.deletion_completed, order_group.paid / order_group.cod_confirmed (CloseOnPurchase from sku_ids) and payment_method.removed (CancelAllForUser card_removed, all armed rules of the user). Producers now exist: price.changed is written in the price_events append transaction (verified = VRP claimAllowed, anomaly = pre-drop inflation, fail closed); order_group.paid carries sku_ids; payment_method.removed is written with the saved-card soft delete. Missing: (1) the merchant-initiated charge port is Unconfigured (VR-P3-01, VR-P3-02); (2) the checkout saga's place_orders step and the privacy deletion executor do not call CloseOnPurchase/CancelAllForUser directly (they are event-driven only, so a relay outage delays them; the charge-time vault.inspect and eligibility rechecks are the backstop); (3) SCA completion route POST /v1/me/auto-buy/attempts/:id/sca-complete exists, but it needs the Unconfigured charge port to do anything; (4) payment_method.removed cancels every armed rule because psp_token_ref is not known to equal the card id; (5) the vault adapter that maps a mandate token to payments saved cards is not built. Unresolved charges park in MANUAL_REVIEW and need an ops queue (not built). See docs/specs/commerce-events.md.",
  },
  budget: { status: "composed" },
  cart: { status: "composed" },
  "guest-merge": {
    status: "composed",
    gaps:
      "PARTIAL, dark behind flag.guest_browsing (platform GUEST_BROWSING_GATE bound to the flag client, default blocked: 404). Real: POST /v1/me/guest-merge over KyselyGuestMergeUnitOfWork (one Postgres transaction: cart, wishlists, outbox cart.guest_merged). Missing: the cart catalog, platform config, wishlists catalog and history consent/product ports it resolves late are the same Unconfigured/internal bindings as cart and history, so the route answers 503 until those are composed; chief-reviewer checkpoint and VR-GUEST-01/02/03 gate enabling the flag.",
  },
  checkout: { status: "composed" },
  "courier-aramex": { status: "composed" },
  drops: { status: "composed" },
  fulfillment: { status: "composed" },
  forecasting: { status: "composed" },
  "analytics-ingest": {
    status: "composed",
    gaps:
      "PARTIAL, dark: POST /v1/analytics/events is mounted behind kill.analytics.ingest (bound to the flag gate, default blocked: 503 analytics_ingest_disabled, nothing read or stored). Real: controller, use case, Kysely consent reader (consents_current) and Kysely outbox (one analytics outbox row per accepted batch). Unconfigured, so the route answers 503 even with the flag on: (1) attestation (attestation.app-attest; VR-DASH-07 also leaves the empty-challenge replay gap); (2) the plausibility store (queue.redis: production/adapters/redis has no dedupe or window adapter); (3) the pseudonym keyer is bound to PrimedShopperKeyer (secret read once at boot from SECRETS_ANALYTICS_KEYS_ID, current plus previous key for rotation) but stays Unconfigured (503) when that variable is unset or the secret is missing, unreadable or invalid; no secret is provisioned yet. The term vocabulary is empty (hashed terms only) and the dedupe key is per process random outside dev. Allowing real users also needs VR-DASH-03 and VR-DASH-07. See docs/privacy/analytics-producers-and-ingest.md.",
  },
  "admin-attention": {
    status: "composed",
    gaps:
      "PARTIAL, dark behind release.admin.audit_log and release.admin.attention (both bound to the flag client, default blocked: 404). Real: GET /v1/admin/audit-log/verify over audit_log_verify (read-only transaction, meta-audit through the admin hash chain), role gate dpo/security/super_admin (break-glass). Missing: (1) attention sources are Unconfigured, so every attention item reports unavailable (never 0); the per-module count queries named in spec 7.2 are not built; (2) GET /v1/admin/audit-log (list) is not built (planned in OpenAPI, phase-b); (3) the flag provider itself is Unconfigured (flags.provider), so the routes stay 404 until an operator binds one. See docs/specs/dashboard-foundations.md section 7.",
  },
  "platform-metrics": {
    status: "composed",
    gaps:
      "PARTIAL, dark behind release.admin.metrics (bound to the flag client, default blocked: 404). Real: GET /v1/admin/metrics/{metricId} reads platform_metrics_hourly through KyselyPlatformRollups with live elevations from the admin store. Missing: (1) the rollup consumer that fills platform_metrics_hourly is part of seller-analytics and its event source is Unconfigured (analytics.warehouse), so the table stays empty and freshness unknown until it is fed (no EventSourcePort over outbox_events exists in the repo, only InMemoryEventSource, so nothing real can feed it yet); (2) the shared db handle is not read-scoped; (3) telemetry counter outlet.admin.metrics.reads is registered but countRead is not bound in production yet. See docs/specs/dashboard-foundations.md sections 4 and 6.",
  },
  creators: {
    status: "blocked",
    reason:
      "Wave B integration pending: the identity, catalog, ledger-gateway, KMS vault, approvals and terms ports are not bound yet, and ADR-0037 / VR-P3-03 keep payouts off. Persistence and the dev composition exist; the module fails closed (MissingCreatorPortsError) without them. Event wiring is done and tested: the orders (order_line.closed after the 33-day window, orders.close-delivered sweep), refunds (order_line.refunded, cumulative) and checkout (order_group.paid with order_group_id, sku_ids, paid_at_ms) producers exist, and the creators relay consumer (creators.relay) is registered; while this module is blocked the worker acknowledges those events unrouted. Remaining before composition: bind the ports above; category_id is not available to orders (default rate only); open returns at closure ARE consulted (orders lineReturns over the returns store); seller-specific return windows beyond 33 days are not claimed here (the seller window port is bound separately). See docs/specs/commerce-events.md.",
  },
  ranking: { status: "composed" },
  "gift-cards": { status: "composed" },
  history: { status: "composed" },
  "hub-consolidation": { status: "composed" },
  inventory: { status: "composed" },
  ledger: { status: "composed" },
  "llm-gateway": { status: "composed" },
  orders: { status: "composed" },
  "outfit-calendar": { status: "composed" },
  payments: { status: "composed" },
  payouts: {
    status: "composed",
    gaps:
      "GET /v1/seller/stores/{storeId}/balance is mounted dark behind release.seller.balance (flag client, default blocked: 404). The payout source (orders, refunds, disputes items and clawbacks) is bound to internal() in production, so once the flag is on it answers 503 seller_balance_unavailable, never zeros. Hold reasons and the next payout date are not exposed (VR-DB-02 safe default, ADR-0049 owner decision). GET /v1/admin/finance/payouts/summary (staff, B-1) is read-only over the real payouts table and dark behind release.admin.finance_views (default blocked: 404); it has no payout-rail readiness field because the rail is Unconfigured (payout.rail), and SENT/SETTLED stay zero until a rail is configured.",
  },
  "price-crawler": { status: "composed" },
  promotions: { status: "composed" },
  recommendations: { status: "composed" },
  reconciliation: {
    status: "composed",
    gaps:
      "The B-2 additions to GET /v1/admin/finance/reconciliation/summary (aging, unmatched_over_3d, rails) are dark behind release.admin.finance_views (default blocked: the old shape). Every rail reports input=unconfigured because no settlement-file provider exists (settlement.files); zero open tickets with zero files received must never be read as matched. ETA submissions have no files, so files_received is null for that rail.",
  },
  referrals: { status: "composed" },
  refunds: { status: "composed" },
  "resale-lane": { status: "composed" },
  retention: { status: "composed" },
  returns: { status: "composed" },
  reviews: { status: "composed" },
  rewards: { status: "composed" },
  search: {
    status: "composed",
    gaps:
      "Dark by construction. Bound: facts (live price, stock and price block from the catalog, store cards from stores; never the index) and the catalog-to-search_documents feeder (outbox consumer search.sync, brand_id written). Unconfigured: the read fallback (Postgres FTS port is not bound as SEARCH_FALLBACK, so /v1/search answers 503 provider_not_configured), Typesense, scope (My Stores), directory (suggestions), llm. Missing upstream data, left absent not faked: rating and free-delivery eligibility (reviews and fees are not read), sponsored (ads), installments/COD/store-credit/size/budget enrichments (filters needing them fail closed). Catalog taxonomy BrandRecord has no active flag, so a brand is shown when its row exists; the catalog owner must expose one. No dedicated kill switch key for the feeder yet.",
  },
  "seller-analytics": {
    status: "composed",
    gaps:
      "Series, breakdown and summary routes (GET /v1/seller/stores/{storeId}/analytics/series/{metricId}, .../breakdown, .../summary) are mounted dark behind release.seller_analytics.series and release.seller_analytics.shopper_series (flag client, default blocked: 404). No rollup reader is bound in production (it must run under the caller's RLS context), so once the flags are on they answer 503 metric_source_unconfigured, never zeros. The event source is Unconfigured (analytics.warehouse): the only EventSourcePort implementation in the repo is InMemoryEventSource, so the rollup consumer (analytics.consume-seller-events, kill.analytics.consumers) has nothing real to read.",
  },
  "seller-settings": { status: "composed" },
  "store-credit": { status: "composed" },
  stores: { status: "composed" },
  stylist: { status: "composed" },
  subscriptions: { status: "composed" },
  "tax-eta": {
    status: "composed",
    gaps:
      "ETA is Unconfigured (eta.portal), so GET /v1/admin/tax/reconciliation reports authority_checked=false and consoles must not show \"reconciled\" (F-2). The from/to range form (B-3, at most 31 days) is dark behind release.admin.finance_views (default blocked: 404).",
  },
  "waiting-room": { status: "composed" },
  wardrobe: { status: "composed" },
  "product-media": {
    status: "composed",
    gaps:
      "Composed with the Postgres store (0083) and the private bucket facade; the background-removal provider is UnconfiguredBackgroundRemoval (503 provider_not_configured) and kill.background_removal is default-blocked until the self-hosted sidecar (apps/ml-services/bg-removal) is deployed, its model checksums are pinned and VR-P3-BG-* are closed.",
  },
  "home-banners": {
    status: "composed",
    gaps:
      "Composed with the Postgres store (0084) and the shared hash-chained admin audit; kill.home_banners is allowed-when-true and default-blocked (the shopper read then answers an empty list). Banner images resolve through UnconfiguredBannerImageUrls (image_url omitted, the app draws art_variant) until a public media base and signer are bound; sponsor_ref is a free reference with no ads/finance ledger lookup yet; impression and click counters are not emitted (no typed banner event in the analytics taxonomy).",
  },
  "visual-search": {
    status: "blocked",
    reason:
      "Phase 3 item 6 (ADR-0023): the module, Kysely store (0068, 0070) and pgvector index migration (0069) exist and the app module composes it with fakes in dev and test. Production still needs real adapters for the image embedder, the query-image object store, the safety classifier, the pgvector index, the catalog read port, shopper context and the consent port; none is bound, and the module defaults would fall back to in-memory fakes, so it is left out of the production graph. VR-P3-13 (model, bucket, safety provider) gates enablement.",
  },
};

/** Module directories on disk that have no binding row (the registry test asserts this is empty). */
export function unboundModuleDirs(modulesDir: string): readonly string[] {
  return readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && MODULE_BINDINGS[d.name] === undefined)
    .map((d) => d.name)
    .sort();
}

export function modulesDirOf(srcDir: string): string {
  return join(srcDir, "modules");
}

/**
 * Creators consumes `order_line.closed`, whose `open_returns` comes from the orders `LineReturnsPort`.
 * Without it the orders module states `open_returns: null` and creators defer every accrual forever.
 * So once creators is composed, orders MUST be given a lineReturns port; this throws at composition
 * (boot) otherwise. While creators stays blocked it is a no-op.
 */
export class MissingLineReturnsError extends Error {
  constructor() {
    super("creators is composed but orders has no lineReturns (LineReturnsPort): order_line.closed would carry open_returns=null");
    this.name = "MissingLineReturnsError";
  }
}

export function assertCreatorsOrdersPrerequisites(
  bindings: Readonly<Record<string, ModuleBinding>>,
  orders: { readonly lineReturns?: unknown },
): void {
  if (bindings["creators"]?.status === "composed" && orders.lineReturns === undefined) throw new MissingLineReturnsError();
}
