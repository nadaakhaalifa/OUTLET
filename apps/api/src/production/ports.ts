import { createHmac, randomBytes } from "node:crypto";
import type { AppConfig } from "../config/env";
import type { MoneyWiring } from "../composition";
import type { PersistenceWiring } from "../persistence";
import type { AdminModuleOptions } from "../modules/admin";
import type { AdsModuleOptions } from "../modules/ads";
import type { BudgetModuleOptions } from "../modules/budget";
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
import type { PaymentProviderPort, PaymentsModuleOverrides } from "../modules/payments";
import type { PayoutsModuleOverrides } from "../modules/payouts";
import type { PriceCrawlerOptions } from "../modules/price-crawler";
import type { PromotionsModuleOverrides } from "../modules/promotions";
import type { RecommendationsModuleOptions } from "../modules/recommendations";
import type { ReconciliationModuleOverrides } from "../modules/reconciliation";
import type { RefundsModuleOverrides } from "../modules/refunds";
import type { ResaleLaneOptions } from "../modules/resale-lane";
import type { ReturnsModuleOverrides } from "../modules/returns";
import type { ReviewsModuleOptions } from "../modules/reviews";
import type { RewardsModuleOptions } from "../modules/rewards";
import type { SearchModuleOverrides } from "../modules/search";
import type { SellerAnalyticsModuleOverrides } from "../modules/seller-analytics";
import type { StylistModuleOptions } from "../modules/stylist";
import type { SubscriptionsModuleOptions } from "../modules/subscriptions";
import type { TaxEtaModuleOverrides } from "../modules/tax-eta";
import type { WaitingRoomModuleOptions } from "../modules/waiting-room";
import type { ProductionFlagPorts } from "./flags";
import { FlagBackendOverRegistry, ProcessMetrics } from "./adapters";
import { DenyAllWebhookIps } from "./adapters";
import { KyselyExportAudit } from "./platform-adapters";
import { markUnconfigured, unconfigured } from "./unconfigured";

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
export function PRODUCTION_PORTS(config: AppConfig, pg: PersistenceWiring, flags: ProductionFlagPorts, money: MoneyWiring) {
  const internal = <T extends object>(fixed: Partial<T> = {}): T => unconfigured<T>("internal.wiring", fixed);
  const metrics = new ProcessMetrics();
  // The Typesense primary has no transport: search always degrades to the (Unconfigured) fallback.
  markUnconfigured("search.typesense");
  const cart: CartModuleOverrides = {
    ...pg.cart,
    catalog: internal(),
    membership: internal(),
    platformConfig: internal(),
  };
  const orders: OrdersModuleOverrides = { ...pg.orders, storeLookup: internal() };
  const returns: ReturnsModuleOverrides = {
    ...pg.returns,
    lines: internal(),
    membership: internal(),
    history: internal(),
    evidence: unconfigured("object.store"),
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
    fallback: internal(),
    facts: internal(),
    scope: internal(),
    directory: internal(),
    killSwitch: flags.search,
    llm: null,
  };
  const tax: TaxEtaModuleOverrides = { ...pg.tax, eta: unconfigured("eta.portal"), events: internal() };
  const sellerAnalytics: SellerAnalyticsModuleOverrides = {
    ...pg.sellerAnalytics,
    audit: new KyselyExportAudit(pg.db),
    source: unconfigured("analytics.warehouse"),
    productStore: internal(),
  };
  const admin: AdminModuleOptions = { ...pg.admin, flags: new FlagBackendOverRegistry(flags.client), pii: unconfigured("kms.envelope") };
  const reviews: ReviewsModuleOptions = {
    ...pg.reviews,
    purchases: internal(),
    sellers: internal(),
    products: internal(),
    profiles: internal(),
    photos: unconfigured("object.store"),
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
  };
  const reconciliation: ReconciliationModuleOverrides = {
    ...money.reconciliation,
    parser: unconfigured("settlement.files"),
    eta: internal(),
    alerts: internal(),
    flags: flags.recon,
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
    flags: unconfigured("queue.redis"),
    signals: unconfigured("analytics.warehouse"),
    switches: flags.switches,
    verifier: internal(),
  };
  const waitingRoom: WaitingRoomModuleOptions = {
    ...pg.phase2.waitingRoom,
    queue: unconfigured("queue.redis"),
    gate: internal(),
    secrets: unconfigured("secrets.manager"),
    bot: unconfigured("attestation.app-attest"),
    attest: unconfigured("attestation.app-attest"),
    entitlements: internal(),
    switches: flags.switches,
  };
  const priceCrawler: PriceCrawlerOptions = {
    ...pg.phase2.priceCrawler,
    flags: flags.crawl,
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
    ledger: internal(),
    bots: unconfigured("attestation.app-attest"),
    attribution: internal(),
    secret: unconfigured("kms.envelope"),
  };
  return {
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
    stylist,
    recommendations,
    history,
    rewards,
    drops,
    waitingRoom,
    priceCrawler,
    hub,
    resale,
    aramex,
    ads,
  };
}
