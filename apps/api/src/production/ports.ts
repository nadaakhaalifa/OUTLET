import { createHmac, randomBytes } from "node:crypto";
import type { AppConfig } from "../config/env";
import {
  AddressBookDeliverability,
  CatalogSellerSkuResolver,
  CheckoutCapBudgetGate,
  CrawlStoreChannelDirectory,
  InventoryStockSink,
  LiveSkuQuote,
  PlusMemberEligibility,
  PriceIntegrityPriceSink,
  createPhase3Lates,
  lazy,
  type MoneyWiring,
  type Phase3Lates,
} from "../composition";
import { InventoryStockReader, KyselySkuLookup } from "../modules/catalog";
import { STANDARD_POOL_ID } from "../modules/inventory";
import {
  JsonVaultOdooSecretReader,
  ProxiedOdooEgress,
  type ChannelOdooOptions,
  type EgressProxyPort,
  type OdooDnsPort,
  type OdooSecretReaderPort,
  type SecretExistsPort,
} from "../modules/channel-odoo";
import type { AgePolicyPort } from "../modules/subscriptions";
import { RefundStoreLineRefunds } from "../composition/line-refunds";
import type { PersistenceWiring } from "../persistence";
import type { AdminModuleOptions } from "../modules/admin";
import type { AdsModuleOptions } from "../modules/ads";
import type { ForecastingModuleOptions } from "../modules/forecasting";
import type { RankingModuleOptions } from "../modules/ranking";
import type { ProductMediaModuleOptions } from "../modules/product-media";
import type { HomeBannersModuleOptions } from "../modules/home-banners";
import type { BudgetModuleOptions } from "../modules/budget";
import type { AutoBuyModuleOptions } from "../modules/auto-buy";
import type { CartModuleOverrides } from "../modules/cart";
import type { CheckoutModuleOverrides } from "../modules/checkout";
import type { CourierAramexOptions } from "../modules/courier-aramex";
import type { DropsModuleOptions } from "../modules/drops";
import type { CourierPort, CourierWebhookAdapter, FulfillmentModuleOverrides } from "../modules/fulfillment";
import type { GiftCardsModuleOptions } from "../modules/gift-cards";
import type { HistoryModuleOptions } from "../modules/history";
import type { HubConsolidationOptions } from "../modules/hub-consolidation";
import type { LlmGatewayModuleOptions } from "../modules/llm-gateway";
import type { OrdersModuleOverrides } from "../modules/orders";
import { assertCreatorsOrdersPrerequisites, MODULE_BINDINGS } from "./bindings";
import type { PaymentProviderPort, PaymentsModuleOverrides } from "../modules/payments";
import type { PayoutsModuleOverrides } from "../modules/payouts";
import { PriceIntegrityParityAdapter, type PriceCrawlerOptions } from "../modules/price-crawler";
import { KyselyEnforcementStore } from "../modules/price-integrity";
import {
  AdmissionVerifier,
  CheckoutDropAdmission,
  WaitingRoomOpsCounters,
  jwtAdmissionCodec,
  type QueuePort,
  type SecretPort,
} from "../modules/waiting-room";
import { systemClock } from "../platform/system-adapters";
import {
  EXPORTER_MANIFEST,
  INVENTORY_SNAPSHOT,
  KyselyErasureExecutor,
  createKyselyExporters,
  type FieldDecryptPort,
  type ObjectStorePort,
  type PrivacyModuleOptions,
} from "../modules/privacy";
import type { PromotionsModuleOverrides } from "../modules/promotions";
import type { RecommendationsModuleOptions } from "../modules/recommendations";
import type { ReconciliationModuleOverrides } from "../modules/reconciliation";
import type { RefundsModuleOverrides } from "../modules/refunds";
import type { ResaleLaneOptions } from "../modules/resale-lane";
import { ReturnsLineReturns, type ReturnsModuleOverrides } from "../modules/returns";
import type { ReviewsModuleOptions } from "../modules/reviews";
import type { RewardsModuleOptions } from "../modules/rewards";
import { SettingsReturnWindowAdapter } from "../modules/seller-settings";
import type { SearchModuleOverrides } from "../modules/search";
import type { SellerAnalyticsModuleOverrides } from "../modules/seller-analytics";
import { KyselyBatchOutbox, KyselyConsentReader, PrimedShopperKeyer, VerifierAttestationCheck, type AnalyticsIngestOverrides, type IngestDb, type PlausibilityStore } from "../modules/analytics-ingest";
import type { AttestationVerifier } from "@outlet/auth-core";
import type { StylistModuleOptions } from "../modules/stylist";
import type { SubscriptionsModuleOptions } from "../modules/subscriptions";
import type { TaxEtaModuleOverrides } from "../modules/tax-eta";
import type { WaitingRoomModuleOptions } from "../modules/waiting-room";
import type { ProductionFlagPorts } from "./flags";
import { AdminStoreVoidApprovals, FlagBackendOverRegistry, ProcessMetrics, UnmeasuredWhenUnavailableQueue } from "./adapters";
import { DenyAllWebhookIps } from "./adapters";
import { getRedisAdapters } from "./adapters/redis";
import { KyselyExportAudit } from "./platform-adapters";
import { isRealProvider, markUnconfigured, ProviderNotConfiguredError, unconfigured, type ProviderName } from "./unconfigured";
import { awsAdaptersFor } from "./adapters-index";

/** Domain-separated price-lock key when CHECKOUT_LOCK_SECRET is unset (see ADR-0029). */
function lockSecret(config: AppConfig): string {
  if (config.checkoutLockSecret !== undefined) return config.checkoutLockSecret;
  // Production always has OTP_PEPPER (config validation). A non-production process without one gets a per-boot key.
  const base = config.otpPepper ?? randomBytes(32).toString("hex");
  return createHmac("sha256", base).update("outlet.checkout.price-lock.v1").digest("hex");
}

/**
 * The per-module option objects for the production composition. Real Postgres stores come from
 * `pg` and `money`; every external provider is an explicit Unconfigured adapter that fails at call
 * time with provider_not_configured (503); every capability switch reads the flag registry, whose
 * default is false (blocked).
 */
export function PRODUCTION_PORTS(config: AppConfig, pg: PersistenceWiring, flags: ProductionFlagPorts, money: MoneyWiring, phase3: Phase3Lates = createPhase3Lates()) {
  const aws = awsAdaptersFor(config);
  const internal = <T extends object>(fixed: Partial<T> = {}): T => unconfigured<T>("internal.wiring", fixed);
  const metrics = new ProcessMetrics();
  // Waiting room: ONE queue / secrets / admission store shared by the room, checkout admission and the drops ops view.
  // REDIS_URL set: Redis queue and sold-out hint (ADR-0033). Otherwise the previous Unconfigured binding.
  const redis = getRedisAdapters(config.redis);
  const roomQueue: QueuePort = redis?.queue ?? unconfigured<QueuePort>("queue.redis");
  const roomSecrets: SecretPort = aws.admissionSecrets ?? unconfigured<SecretPort>("secrets.manager");
  const roomStore = pg.phase2.waitingRoom.store;
  const admissionVerifier = new AdmissionVerifier(roomSecrets, roomStore, systemClock, jwtAdmissionCodec);
  // The Typesense primary has no transport: search always degrades to the (Unconfigured) fallback.
  markUnconfigured("search.typesense");
  const cart: CartModuleOverrides = {
    ...pg.cart,
    catalog: internal(),
    membership: internal(),
    platformConfig: internal(),
  };
  const orders: OrdersModuleOverrides = {
    ...pg.orders,
    storeLookup: internal(),
    // Cumulative refunded goods per line at closure (order_line.closed). Absent store: 0 (see LineRefundsPort).
    ...(money.refunds.store === undefined ? {} : { lineRefunds: new RefundStoreLineRefunds(money.refunds.store) }),
    // Non-terminal returns per line at closure, read from the same returns store the returns module uses
    // (read only, internal; no HTTP route). The creators prerequisite check below stays satisfied.
    lineReturns: new ReturnsLineReturns(pg.returns.repository),
    // Seller return window: longest of the profile windows, read at close time (see SettingsReturnWindowAdapter).
    sellerWindows: new SettingsReturnWindowAdapter(pg.sellerSettings.repo),
  };
  assertCreatorsOrdersPrerequisites(MODULE_BINDINGS, orders);
  const returns: ReturnsModuleOverrides = {
    ...pg.returns,
    lines: internal(),
    membership: internal(),
    history: internal(),
    evidence: aws.objectStore?.evidence() ?? unconfigured("object.store"),
    exchangeStock: internal(),
    events: internal(),
  };
  const promotions: PromotionsModuleOverrides = { ...pg.promotions, serviceAuth: unconfigured("secrets.manager") };
  const fulfillment: FulfillmentModuleOverrides = {
    ...pg.fulfillment,
    orders: internal(),
    couriers: [
      {
        port: unconfigured<CourierPort>("courier.bosta", { code: "bosta" }),
        webhook: unconfigured<CourierWebhookAdapter>("courier.bosta", { code: "bosta", maxBodyBytes: 262_144 }),
      },
    ],
    secrets: unconfigured("secrets.manager"),
  };
  const search: SearchModuleOverrides = {
    ...pg.search,
    // Read fallback stays Unconfigured on purpose (search fails closed). `facts` and the index feeder are bound over
    // the catalog and stores in production/search-wiring.ts (composeSearchPorts); this `facts` is only a placeholder.
    fallback: internal(),
    facts: internal(),
    scope: internal(),
    directory: internal(),
    killSwitch: flags.search,
    llm: null,
  };
  const tax: TaxEtaModuleOverrides = {
    ...pg.tax,
    eta: unconfigured("eta.portal"),
    events: internal(),
    financeViewsEnabled: () => flags.client.isEnabled("release.admin.finance_views"),
  };
  const sellerAnalytics: SellerAnalyticsModuleOverrides = {
    ...pg.sellerAnalytics,
    audit: new KyselyExportAudit(pg.db),
    source: unconfigured("analytics.warehouse"),
    productStore: internal(),
    // Release flags come from the flag client and default to BLOCKED (404). No rollup reader is bound here: the
    // seller reader must run under the caller's RLS context, so the series routes answer 503 until it is composed.
    series: {
      seriesEnabled: () => flags.client.isEnabled("release.seller_analytics.series"),
      shopperSeriesEnabled: () => flags.client.isEnabled("release.seller_analytics.shopper_series"),
    },
  };
  const admin: AdminModuleOptions = {
    ...pg.admin,
    flags: new FlagBackendOverRegistry(flags.client),
    pii: unconfigured("kms.envelope"),
    // GET /v1/admin/me: blocked by default; edge keys, replay store and session binding stay fail-closed until the infra pipeline supplies them.
    identity: { enabled: () => flags.client.isEnabled("release.admin_console.identity") },
  };
  const reviews: ReviewsModuleOptions = {
    ...pg.reviews,
    purchases: internal(),
    sellers: internal(),
    products: internal(),
    profiles: internal(),
    photos: aws.objectStore?.photos() ?? unconfigured("object.store"),
    toxicity: unconfigured("moderation.classifier"),
    images: unconfigured("moderation.classifier"),
  };
  const payments: PaymentsModuleOverrides = {
    ...money.payments,
    providers: [unconfigured<PaymentProviderPort>("psp.paymob", { id: "paymob", methods: ["card", "meeza", "apple_pay", "mobile_wallet", "instapay", "fawry"] })],
    methodSwitch: flags.paymentMethodSwitch,
    ipAllowList: new DenyAllWebhookIps(),
  };
  const refunds: RefundsModuleOverrides = {
    ...money.refunds,
    facts: internal(),
    executor: unconfigured("psp.paymob"),
    payoutDetails: unconfigured("bank.name-match"),
  };
  const checkout: CheckoutModuleOverrides = {
    ...money.checkout,
    risk: internal(),
    agePolicy: internal(),
    killSwitch: flags.checkoutKill,
    addresses: internal(),
    // Drop SKUs need a signed, single-use waiting-room token (spec 16); secrets Unconfigured = fail closed.
    dropAdmission: new CheckoutDropAdmission(admissionVerifier),
    appAttest: unconfigured("attestation.app-attest"),
    codConfirmation: unconfigured("messaging.sms-whatsapp"),
    metrics,
    lockSecret: lockSecret(config),
  };
  const payouts: PayoutsModuleOverrides = {
    ...money.payouts,
    source: internal(),
    statementSource: internal(),
    bank: internal(),
    nameMatch: unconfigured("bank.name-match"),
    provider: unconfigured("payout.rail"),
    risk: internal(),
    flags: flags.payouts,
    financeViewsEnabled: () => flags.client.isEnabled("release.admin.finance_views"),
    // Seller balance route: blocked by default (404). `source` is internal() above, so even when enabled it answers 503 until composed.
    balance: { enabled: () => flags.client.isEnabled("release.seller.balance") },
  };
  const reconciliation: ReconciliationModuleOverrides = {
    ...money.reconciliation,
    parser: unconfigured("settlement.files"),
    eta: internal(),
    alerts: internal(),
    flags: flags.recon,
    financeViewsEnabled: () => flags.client.isEnabled("release.admin.finance_views"),
    // Readiness per rail from the same lookup as /v1/ready; no real adapter exists yet, so every rail reads "unconfigured".
    railInputs: () => {
      const input = (p: ProviderName): "configured" | "unconfigured" => (isRealProvider(p) ? "configured" : "unconfigured");
      return {
        psp_settlement: input("settlement.files"),
        cod_remittance: input("settlement.files"),
        bnpl_settlement: input("settlement.files"),
        eta_submission: input("eta.portal"),
      };
    },
  };
  const llm: LlmGatewayModuleOptions = {
    ...pg.phase2.llmGateway,
    provider: unconfigured("llm.gateway-provider"),
    flags: flags.gate,
    cache: internal(),
  };
  const subscriptions: SubscriptionsModuleOptions = {
    ...pg.phase2.subscriptions,
    ages: internal(),
    persons: unconfigured("kms.envelope"),
    vault: unconfigured("psp.recurring"),
    charges: unconfigured("psp.recurring"),
    refunds: internal(),
    ledger: internal(),
    receipts: unconfigured("eta.portal"),
    notices: unconfigured("messaging.sms-whatsapp"),
    flags: flags.gate,
    approvals: internal(),
    hasher: unconfigured("kms.envelope"),
    webhookVerifier: unconfigured("psp.recurring"),
  };
  const giftCards: GiftCardsModuleOptions = {
    ...pg.phase2.giftCards,
    secret: unconfigured("kms.envelope"),
    cipher: unconfigured("kms.envelope"),
    storeCredit: internal(),
    audit: internal(),
    // Voids at or above the threshold need a persisted dual approval from the admin approvals store.
    approvals: new AdminStoreVoidApprovals(pg.admin.store),
    flags: flags.gift,
    age: internal(),
    payments: unconfigured("psp.paymob"),
    delivery: unconfigured("messaging.sms-whatsapp"),
  };
  const budget: BudgetModuleOptions = {
    ...pg.phase2.budget,
    consent: internal(),
    cipher: unconfigured("kms.envelope"),
    spendSource: internal(),
    bag: internal(),
    wishlists: internal(),
    flags: flags.budget,
  };
  // Auto-buy (ADR-0036): notify-and-confirm is live through the notifications module; the unattended
  // charge stays behind kill.auto_buy.charge and its merchant-initiated port is Unconfigured.
  // Cross-module ports are bound to the real modules where a suitable public port exists (composition/auto-buy-adapters).
  // `risk` (no fraud module exists) and `inventory` (the reservation port is keyed by order group and cannot be
  // handed over to the MIT checkout, so a hold would starve the order it is meant to protect) stay Unconfigured.
  // `ages` is the same port subscriptions uses and is itself unbound, so eligibility fails closed until it lands.
  const skuLookup = new KyselySkuLookup(pg.catalog.runner, pg.catalog.session);
  const autoBuy: AutoBuyModuleOptions = {
    ...pg.phase2.autoBuy,
    flags: flags.autoBuy,
    eligibility: new PlusMemberEligibility(lazy(phase3.entitlements), internal<Pick<AgePolicyPort, "plusMinAge" | "ageYears">>()),
    catalog: new LiveSkuQuote({
      skus: skuLookup,
      prices: lazy(phase3.priceIntegrity),
      stock: new InventoryStockReader(pg.inventory.store, pg.inventory.directory, STANDARD_POOL_ID),
      directory: pg.inventory.directory,
    }),
    deliverability: new AddressBookDeliverability(lazy(phase3.addresses)),
    risk: internal(),
    budget: new CheckoutCapBudgetGate(lazy(phase3.capGuard), () => randomBytes(12).toString("hex")),
    vault: unconfigured("psp.recurring"),
    inventory: internal(),
    mit: unconfigured("psp.recurring"),
    notices: "notifications",
    opsAudit: pg.admin.audit,
  };
  // Odoo seller channel (spec 9.2/19, Phase 3 item 11). Store, directory, SKU resolver, stock and price sinks are real;
  // the egress proxy transport, DNS and the vault read stay Unconfigured until infrastructure is provided (VR-P3-10).
  const secretStore = aws.secrets !== null ? { get: (id: string) => aws.secrets?.get(id) ?? Promise.resolve(null) } : unconfigured<{ get(id: string): Promise<string | null> }>("secrets.manager");
  const odooSecrets: OdooSecretReaderPort = new JsonVaultOdooSecretReader((id) => secretStore.get(id));
  const odooExists: SecretExistsPort = {
    exists: async (tokenRef) => {
      const id = tokenRef.startsWith("vault://") ? tokenRef.slice("vault://".length) : tokenRef;
      return id.length > 0 && (await secretStore.get(id)) !== null;
    },
  };
  const channelOdoo: ChannelOdooOptions = {
    store: pg.phase2.channelOdoo.store,
    directory: new CrawlStoreChannelDirectory(pg.phase2.priceCrawler.store),
    secrets: odooExists,
    flags: flags.odoo,
    egress: new ProxiedOdooEgress(unconfigured<EgressProxyPort>("crawler.egress"), odooSecrets),
    dns: unconfigured<OdooDnsPort>("crawler.egress"),
    skus: new CatalogSellerSkuResolver(skuLookup),
    stock: new InventoryStockSink(lazy(phase3.stockSync)),
    prices: new PriceIntegrityPriceSink(lazy(phase3.priceIntegrity)),
    metrics: metrics,
    sleeper: { sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) },
  };
  const stylist: StylistModuleOptions = {
    ...pg.phase2.stylist,
    candidates: internal(),
    live: internal(),
    bag: internal(),
    personalization: internal(),
    budget: internal(),
    flags: flags.gate,
  };
  const recommendations: RecommendationsModuleOptions = {
    ...pg.phase2.recommendations,
    catalog: internal(),
    ranker: internal(),
    personalization: internal(),
    sizes: internal(),
    flags: flags.mlRanking,
  };
  const history: HistoryModuleOptions = { ...pg.phase2.history, consent: internal(), products: internal(), flags: flags.mlRanking };
  const rewards: RewardsModuleOptions = {
    ...pg.phase2.rewards,
    ledger: internal(),
    credit: internal(),
    plus: internal(),
    vouchers: internal(),
    switches: flags.rewards,
    attest: unconfigured("attestation.app-attest"),
    approvals: internal(),
  };
  const drops: DropsModuleOptions = {
    ...pg.phase2.drops,
    inventory: internal(),
    flags: redis?.soldOut ?? unconfigured("queue.redis"),
    signals: unconfigured("analytics.warehouse"),
    switches: flags.switches,
    verifier: internal(),
    ops: new WaitingRoomOpsCounters(new UnmeasuredWhenUnavailableQueue(roomQueue), roomStore, systemClock),
  };
  const waitingRoom: WaitingRoomModuleOptions = {
    ...pg.phase2.waitingRoom,
    queue: roomQueue,
    gate: internal(),
    secrets: roomSecrets,
    bot: unconfigured("attestation.app-attest"),
    attest: unconfigured("attestation.app-attest"),
    entitlements: internal(),
    switches: flags.switches,
  };
  const priceCrawler: PriceCrawlerOptions = {
    ...pg.phase2.priceCrawler,
    flags: flags.crawl,
    // Open cross-channel findings from price-integrity, paged (no record cap).
    parity: new PriceIntegrityParityAdapter(new KyselyEnforcementStore(pg.priceIntegrity.runner, pg.priceIntegrity.session)),
    fetcher: unconfigured("crawler.egress"),
    dns: unconfigured("crawler.egress"),
    parser: unconfigured("crawler.egress"),
    verifier: unconfigured("crawler.egress"),
    vault: unconfigured("kms.envelope"),
    embeddings: internal(),
    attributes: internal(),
    fingerprints: internal(),
  };
  const hub: HubConsolidationOptions = {
    ...pg.phase2.hub,
    flags: flags.hub,
    facts: internal(),
    outbound: internal(),
    ledger: internal(),
  };
  const resale: ResaleLaneOptions = {
    ...pg.phase2.resale,
    returns: internal(),
    consent: internal(),
    terms: internal(),
    catalog: internal(),
    flags: flags.resale,
    ledger: internal(),
  };
  const aramex: CourierAramexOptions = { transport: unconfigured("courier.aramex"), credentials: unconfigured("secrets.manager") };
  const ads: AdsModuleOptions = {
    ...pg.phase2.ads,
    flags: flags.ads,
    enforcement: internal(),
    eligibility: internal(),
    charges: unconfigured("psp.b2b-intents"),
    topUpPsp: "paymob", // primary PSP (F-1); must match the settlement-file name used by reconciliation
    ledger: internal(),
    bots: unconfigured("attestation.app-attest"),
    attribution: internal(),
    secret: unconfigured("kms.envelope"),
  };
  const forecasting: ForecastingModuleOptions = {
    ...pg.phase2.forecasting,
    flags: { enabled: () => flags.gate.isEnabled("kill.demand_forecasting") },
  };
  // Background removal: allowed-when-true (ADR-0028), default blocked; provider and bucket are bound in compose.ts.
  const productMedia: ProductMediaModuleOptions = {
    ...pg.phase2.productMedia,
    flags: { isEnabled: () => flags.gate.isEnabled("kill.background_removal") },
  };
  // Home banners: Postgres store (0084), the shared hash-chained admin audit, kill.home_banners allowed-when-true (default
  // blocked). Image URLs stay Unconfigured (the app draws art_variant) until a public media base is bound.
  const homeBanners: HomeBannersModuleOptions = {
    ...pg.phase2.homeBanners,
    audit: pg.admin.audit,
    flags: { isEnabled: () => flags.gate.isEnabled("kill.home_banners") },
  };
  const ranking: RankingModuleOptions = {
    ...pg.phase2.ranking,
    flags: { shadowAllowed: () => flags.gate.isEnabled("kill.ranking_v2_shadow") },
  };
  // Privacy: real Kysely stores, exporters and erasure; only the KMS cipher and the object store are
  // external. Exports stay `requested` (never failed) until an object store is configured.
  const privacyCipher: FieldDecryptPort = aws.fieldCipher?.bytes ?? unconfigured<FieldDecryptPort>("kms.envelope");
  const privacyStore: ObjectStorePort = aws.objectStore?.privacy() ?? unconfigured<ObjectStorePort>("object.store", { configured: false });
  const pseudonymSecret = config.sizeDemandPseudonymKey;
  if (pseudonymSecret === undefined) throw new Error("SIZE_DEMAND_PSEUDONYM_KEY is required to derive the erasure pseudonym key");
  const privacy: PrivacyModuleOptions = {
    consentRepository: pg.privacy.consent,
    requestRepository: pg.privacy.requests,
    breachRepository: pg.privacy.breach,
    blockers: pg.privacy.blockers,
    objectStore: privacyStore,
    exporters: createKyselyExporters(EXPORTER_MANIFEST, pg.privacy.db, privacyCipher),
    erasureExecutor: new KyselyErasureExecutor(pg.privacy.db, {
      objectStore: privacyStore,
      inventory: INVENTORY_SNAPSHOT,
      onReport: (r) => {
        // Counts and table names only (never ids or values).
        process.stdout.write(
          `${JSON.stringify({ level: "info", event: "privacy.erasure.report", deleted: r.deleted, scrubbed: r.scrubbed, no_locator: r.noLocator.length, immutable: r.immutableTables.length, unscrubbable: r.unscrubbableColumns.length })}\n`,
        );
      },
    }),
    inventory: INVENTORY_SNAPSHOT,
    // Domain-separated from the shared secret; held outside the retained dataset (an env var).
    pseudonymKey: new Uint8Array(createHmac("sha256", pseudonymSecret).update("outlet.privacy.erasure-pseudonym.v1").digest()),
  };
  // Client analytics ingest (dashboard foundations track 5). Gate is kill.analytics.ingest (default blocked). Consent and
  // outbox are real Kysely adapters over pg. Attestation (attestation.app-attest), the Redis plausibility store
  // (queue.redis: no plausibility adapter exists in production/adapters/redis) and the pseudonym keyer
  // (secrets.manager: primed once at boot when SECRETS_ANALYTICS_KEYS_ID is set, else Unconfigured) fail closed: the route answers 503.
  const analyticsKeysId = config.aws?.secrets?.analyticsKeysId;
  const analyticsIngest: AnalyticsIngestOverrides = {
    gate: { enabled: () => flags.gate.isEnabled("kill.analytics.ingest") },
    attestation: new VerifierAttestationCheck(unconfigured<AttestationVerifier>("attestation.app-attest")),
    consent: new KyselyConsentReader(pg.db as unknown as IngestDb),
    outbox: new KyselyBatchOutbox(pg.db as unknown as IngestDb),
    store: unconfigured<PlausibilityStore>("queue.redis"),
    // Secret read once at boot (OnModuleInit prime). Absent SECRETS_ANALYTICS_KEYS_ID or an unreadable secret = 503.
    keyer: analyticsKeysId !== undefined && aws.secrets !== null
      ? new PrimedShopperKeyer(() => aws.secrets?.get(analyticsKeysId) ?? Promise.resolve(null), () => new ProviderNotConfiguredError("secrets.manager", "analytics.keyer"))
      : unconfigured("secrets.manager"),
  };
  return {
    privacy,
    analyticsIngest,
    cart,
    orders,
    returns,
    promotions,
    fulfillment,
    search,
    tax,
    sellerAnalytics,
    admin,
    reviews,
    payments,
    refunds,
    checkout,
    payouts,
    reconciliation,
    llm,
    subscriptions,
    giftCards,
    budget,
    autoBuy,
    stylist,
    recommendations,
    history,
    rewards,
    drops,
    waitingRoom,
    priceCrawler,
    channelOdoo,
    hub,
    resale,
    aramex,
    ads,
    forecasting,
    productMedia,
    homeBanners,
    ranking,
  };
}
