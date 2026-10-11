import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "./config/env";
import { AuthModule } from "./modules/auth";
import { CartModule, FakeCatalog, StaticMembership, StaticPlatformConfig } from "./modules/cart";
import { CatalogModule, createCatalogDevFixtures } from "./modules/catalog";
import { AdminModule, type AdminModuleOptions } from "./modules/admin";
import { PRICE_BLOCK_READER, PriceIntegrityModule } from "./modules/price-integrity";
import { ReferralsModule, type ReferralsModuleOptions } from "./modules/referrals";
import {
  FakeEtaPort,
  InMemorySignedDocumentStore,
  InMemorySigningDelegations,
  InMemoryTaxEtaEventPublisher,
  TaxEtaModule,
  type TaxEtaModuleOverrides,
} from "./modules/tax-eta";
import {
  InMemoryAudit,
  InMemoryEventSource,
  SellerAnalyticsModule,
  StaticProductStoreLookup,
  type SellerAnalyticsModuleOverrides,
} from "./modules/seller-analytics";
import {
  FakeImageClassifier,
  FakePhotoUploads,
  FakeProductStore,
  FakePurchaseVerification,
  FakeReviewerProfiles,
  FakeSellerIdentity,
  FakeToxicityClassifier,
  ReviewsModule,
  type ReviewsModuleOptions,
} from "./modules/reviews";
import { InventoryModule } from "./modules/inventory";
import { NotificationsModule, type NotificationsModuleOptions } from "./modules/notifications";
import { PrivacyModule } from "./modules/privacy";
import { SizingModule } from "./modules/sizing";
import { StoresModule, type StoresModuleOptions } from "./modules/stores";
import { WishlistsModule, type WishlistsModuleOptions } from "./modules/wishlists";
import { randomBytes } from "node:crypto";
import {
  FakeBostaCourier,
  BostaStyleWebhookAdapter,
  FakeSellerOrders,
  FulfillmentModule,
  StaticCourierSecrets,
  type FulfillmentModuleOverrides,
} from "./modules/fulfillment";
import { FakeStoreLookup, OrdersModule, type OrdersModuleOverrides } from "./modules/orders";
import { PromotionsModule, StaticServiceTokenAuthenticator, type PromotionsModuleOverrides } from "./modules/promotions";
import {
  FakeEvidence,
  FakeExchangeStock,
  FakeReturnableLines,
  InMemoryReturnEventPublisher,
  ReturnsModule,
  StaticReturnerHistory,
  StaticReturnsMembership,
  type ReturnsModuleOverrides,
} from "./modules/returns";
import {
  FakeProductFacts,
  InMemorySavedSearchRepository,
  InMemorySearchIndex,
  InMemorySuggestionDirectory,
  SearchModule,
  StaticShopperScope,
  type SearchModuleOverrides,
} from "./modules/search";
import { LedgerModule } from "./modules/ledger";
import { PaymentsModule } from "./modules/payments";
import { CheckoutModule } from "./modules/checkout";
import { RefundsModule } from "./modules/refunds";
import { StoreCreditModule } from "./modules/store-credit";
import { PayoutsModule } from "./modules/payouts";
import { ReconciliationModule } from "./modules/reconciliation";
import { MoneyBridgeModule, composeMoney, type MoneyWiring } from "./composition";
import * as Subs from "./modules/subscriptions";
import * as Gift from "./modules/gift-cards";
import * as Bud from "./modules/budget";
import * as Sty from "./modules/stylist";
import * as Llm from "./modules/llm-gateway";
import * as Rec from "./modules/recommendations";
import * as Hist from "./modules/history";
import * as Ret from "./modules/retention";
import * as Rew from "./modules/rewards";
import * as Drp from "./modules/drops";
import * as Wait from "./modules/waiting-room";
import * as Crawl from "./modules/price-crawler";
import * as Hub from "./modules/hub-consolidation";
import * as Resale from "./modules/resale-lane";
import * as Aramex from "./modules/courier-aramex";
import * as Ads from "./modules/ads";
import { createPersistence } from "./persistence";
import { composeProduction, type ProductionOptions } from "./production/compose";
import { PlatformModule, type PlatformOverrides } from "./platform";

/** Per-module options for tests and local composition; production wiring passes none. */
export interface AppModuleOptions {
  /** Production composition inputs (a test database handle). Ignored unless config.adapters is "production". */
  readonly production?: ProductionOptions;
  readonly stores?: StoresModuleOptions;
  readonly wishlists?: WishlistsModuleOptions;
  readonly notifications?: NotificationsModuleOptions;
  readonly orders?: OrdersModuleOverrides;
  readonly returns?: ReturnsModuleOverrides;
  readonly promotions?: PromotionsModuleOverrides;
  readonly fulfillment?: FulfillmentModuleOverrides;
  readonly search?: SearchModuleOverrides;
  readonly referrals?: ReferralsModuleOptions;
  readonly tax?: TaxEtaModuleOverrides;
  readonly sellerAnalytics?: SellerAnalyticsModuleOverrides;
  readonly admin?: AdminModuleOptions;
  readonly reviews?: ReviewsModuleOptions;
  /** Phase 2 modules: per-module overrides win over the dev fixtures and Postgres adapters. */
  readonly phase2?: {
    readonly subscriptions?: Subs.SubscriptionsModuleOptions;
    readonly giftCards?: Gift.GiftCardsModuleOptions;
    readonly budget?: Bud.BudgetModuleOptions;
    readonly stylist?: Sty.StylistModuleOptions;
    readonly llmGateway?: Llm.LlmGatewayModuleOptions;
    readonly recommendations?: Rec.RecommendationsModuleOptions;
    readonly history?: Hist.HistoryModuleOptions;
    readonly rewards?: Rew.RewardsModuleOptions;
    readonly drops?: Drp.DropsModuleOptions;
    readonly waitingRoom?: Wait.WaitingRoomModuleOptions;
    readonly priceCrawler?: Crawl.PriceCrawlerOptions;
    readonly hub?: Hub.HubConsolidationOptions;
    readonly resale?: Resale.ResaleLaneOptions;
    readonly aramex?: Aramex.CourierAramexOptions;
    readonly ads?: Ads.AdsModuleOptions;
  };
  /** Wave 4 money core: per-module overrides win over the composed wiring (tests, staging). */
  readonly money?: Partial<Pick<MoneyWiring, "ledger" | "payments" | "checkout" | "refunds" | "storeCredit" | "payouts" | "reconciliation">>;
}

type PriceBlocks = ReturnType<typeof createCatalogDevFixtures>["prices"];

/**
 * Catalog price reader: price-integrity evidence wins; the catalog fixture reader answers for SKUs
 * the service has no history for (absent means "no verified evidence", never a fabricated claim).
 * Bound after boot by PriceBridgeModule, so the catalog does not import the price-integrity module.
 */
function bindPriceIntegrity(prices: PriceBlocks, reader: { blocks: PriceBlocks["blocks"] }): void {
  const fallback = prices.blocks.bind(prices);
  prices.blocks = async (skuIds) => {
    const out = new Map(await fallback(skuIds));
    for (const [id, block] of await reader.blocks(skuIds)) out.set(id, block);
    return out;
  };
}

@Module({})
class PriceBridgeModule {
  static forRoot(prices: PriceBlocks, priceIntegrity: DynamicModule): DynamicModule {
    return {
      module: PriceBridgeModule,
      imports: [priceIntegrity],
      providers: [
        {
          provide: "outlet.priceBridge",
          inject: [PRICE_BLOCK_READER],
          useFactory: (reader: { blocks: PriceBlocks["blocks"] }): true => {
            bindPriceIntegrity(prices, reader);
            return true;
          },
        },
      ],
    };
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig, overrides: PlatformOverrides = {}, options: AppModuleOptions = {}): DynamicModule {
    // Production: Postgres stores for every composed module, Unconfigured providers for everything
    // external (apps/api/src/production, ADR-0029). Fixtures never load.
    if (config.adapters === "production") {
      const prod = composeProduction(config, options.production);
      return {
        module: AppModule,
        imports: [PlatformModule.forRoot(config, { ...overrides, ...(prod.platform === undefined ? {} : { production: prod.platform }) }), ...prod.imports],
      };
    }
    // In-memory stays the dev and test default.
    const pg = config.adapters === "in-memory-dev" ? undefined : createPersistence(config);
    // Dev boot (NODE_ENV=development, fixtures on): CartModule refuses implicit fixtures outside test
    // mode, so the development fixtures are passed explicitly here. DEVELOPMENT FIXTURES, never production.
    const devCart =
      config.adapters === "in-memory-dev" && config.env !== "test"
        ? { catalog: new FakeCatalog(), membership: new StaticMembership(), platformConfig: new StaticPlatformConfig() }
        : {};
    // Dev boot only (NODE_ENV=development, fixtures on): the wave-3 modules refuse implicit fixtures
    // outside test mode, so explicit DEVELOPMENT FIXTURES are passed here. Never production: with
    // adapters !== in-memory-dev only real repositories are passed and any missing port fails boot.
    const dev = config.adapters === "in-memory-dev" && config.env !== "test";
    const devOrders: OrdersModuleOverrides = dev ? { storeLookup: new FakeStoreLookup() } : {};
    const devReturns: ReturnsModuleOverrides = dev
      ? {
          lines: new FakeReturnableLines(),
          membership: new StaticReturnsMembership(),
          history: new StaticReturnerHistory(),
          evidence: new FakeEvidence(),
          exchangeStock: new FakeExchangeStock(),
          events: new InMemoryReturnEventPublisher(),
        }
      : {};
    const devPromotions: PromotionsModuleOverrides = dev
      ? { serviceAuth: new StaticServiceTokenAuthenticator(randomBytes(24).toString("hex")) }
      : {};
    const devFulfillment: FulfillmentModuleOverrides = dev
      ? {
          orders: new FakeSellerOrders(),
          couriers: [{ port: new FakeBostaCourier(), webhook: new BostaStyleWebhookAdapter() }],
          secrets: new StaticCourierSecrets(),
        }
      : {};
    const devIndex = new InMemorySearchIndex();
    const devSearch: SearchModuleOverrides = dev
      ? {
          fallback: devIndex,
          indexWriter: devIndex,
          savedSearches: new InMemorySavedSearchRepository(),
          facts: new FakeProductFacts(),
          scope: new StaticShopperScope(),
          directory: new InMemorySuggestionDirectory(),
        }
      : {};
    // Development fixtures for the standalone modules (dev only; production passes real adapters or
    // boot fails with the module's MissingPorts error). The ETA portal has no real adapter yet.
    const devTax: TaxEtaModuleOverrides = dev
      ? {
          eta: new FakeEtaPort(),
          signed: new InMemorySignedDocumentStore(),
          delegations: new InMemorySigningDelegations(),
          events: new InMemoryTaxEtaEventPublisher(),
        }
      : {};
    const devAnalytics: SellerAnalyticsModuleOverrides = dev
      ? { audit: new InMemoryAudit(), source: new InMemoryEventSource(), productStore: new StaticProductStoreLookup() }
      : {};
    const devReviews: ReviewsModuleOptions = dev
      ? {
          purchases: new FakePurchaseVerification(),
          sellers: new FakeSellerIdentity(),
          products: new FakeProductStore(),
          profiles: new FakeReviewerProfiles(),
          photos: new FakePhotoUploads(),
          toxicity: new FakeToxicityClassifier(),
          images: new FakeImageClassifier(),
        }
      : {};
    // Phase 2 development fixtures. Same rule as above: dev boot only, never production (production
    // passes the Postgres stores below and every other port must be a real adapter or boot fails with
    // the module's Missing*PortsError). Test mode needs none: each module defaults to its fakes.
    const p2 = options.phase2 ?? {};
    const nowMs = (): number => Date.now();
    const devSubs: Subs.SubscriptionsModuleOptions = dev
      ? {
          ages: new Subs.FakeAgePolicy(),
          persons: new Subs.FakePersonKeys(),
          vault: new Subs.FakeCardVault(),
          charges: new Subs.FakeRecurringCharges(),
          refunds: new Subs.FakeRefunds(),
          ledger: new Subs.FakeLedger(),
          receipts: new Subs.FakeTaxReceipts(),
          notices: new Subs.FakeNotices(),
          flags: new Subs.FakeFlags(),
          approvals: new Subs.FakePlanApprovals(),
          hasher: new Subs.HmacKeyHasher(randomBytes(24).toString("hex")),
          // Dev has no PSP recurring MAC: every recurring webhook is rejected.
          webhookVerifier: { async verify() { return { kind: "rejected" as const }; } },
        }
      : {};
    const devGift: Gift.GiftCardsModuleOptions = dev
      ? {
          secret: new Gift.FakeSecret(),
          cipher: new Gift.DevAesGcmFieldCipher(),
          storeCredit: new Gift.FakeStoreCredit(),
          audit: new Gift.FakeAudit(),
          flags: new Gift.FakeFlags(),
          age: new Gift.FakeAgeGate(),
          payments: new Gift.FakePayments(),
          delivery: new Gift.FakeDelivery(),
        }
      : {};
    const devBudget: Bud.BudgetModuleOptions = dev
      ? {
          consent: new Bud.FakeBudgetConsent(),
          cipher: new Bud.DevAesGcmFieldCipher(),
          spendSource: new Bud.FakeOrderSpendSource(),
          bag: new Bud.FakeBagTotal(),
          wishlists: new Bud.FakeWishlistPlanSource(),
          flags: new Bud.FakeBudgetFlags(),
        }
      : {};
    const devStylist: Sty.StylistModuleOptions = dev
      ? {
          candidates: new Sty.FakeCandidateSource(),
          live: new Sty.FakeLivePrices(),
          bag: new Sty.FakeBag(),
          personalization: new Sty.FakePersonalization(),
          budget: new Sty.FakeBudget(),
          flags: new Sty.StaticStylistFlags(),
        }
      : {};
    const devLlm: Llm.LlmGatewayModuleOptions = dev
      ? { provider: new Llm.FakeLlmProvider(), flags: new Llm.StaticFlags(), cache: new Llm.InMemoryGatewayCache(nowMs) }
      : {};
    const devRec: Rec.RecommendationsModuleOptions = dev
      ? {
          catalog: new Rec.FakeCatalog(),
          vectors: new Rec.InMemoryVectorIndex(),
          ranker: new Rec.SpyRanker(),
          personalization: new Rec.FakePersonalization(),
          sizes: new Rec.FakeUserSizes(),
          flags: new Rec.FakeFlags(),
        }
      : {};
    const devHistory: Hist.HistoryModuleOptions = dev
      ? { consent: new Hist.FakeConsent(), products: new Hist.FakeProductLookup(), flags: new Hist.FakeFlags() }
      : {};
    const devRewards: Rew.RewardsModuleOptions = dev
      ? (() => {
          const ledger = new Rew.FakeLedger();
          return {
            ledger,
            credit: new Rew.FakeStoreCredit(ledger),
            plus: new Rew.FakePlusEntitlements(),
            vouchers: new Rew.FakeVouchers(),
            // Games stay OFF in dev as in production (kill.games fails closed).
            switches: new Rew.StaticRewardsSwitch(false, true),
            attest: new Rew.FakeAttestation(),
            approvals: new Rew.FakeApprovals(),
          };
        })()
      : {};
    const devDrops: Drp.DropsModuleOptions = dev
      ? {
          inventory: new Drp.InMemoryDropInventory(),
          flags: new Drp.InMemorySoldOutFlags(nowMs),
          signals: new Drp.FakeSocialSignals(),
          switches: new Drp.FakeDropSwitches(),
          verifier: { verify: async () => ({ ok: false, code: "no_verifier" }), consume: async () => "unknown" },
        }
      : {};
    const devWaiting: Wait.WaitingRoomModuleOptions = dev
      ? {
          queue: new Wait.InMemoryQueue(),
          store: new Wait.InMemoryAdmissionStore(),
          gate: new Wait.FakeDropGate(),
          secrets: new Wait.FakeSecrets("k1", randomBytes(32).toString("hex")),
          bot: new Wait.FakeBotScore(),
          attest: new Wait.FakeAttestation(),
          entitlements: new Wait.FakeEntitlements(),
          switches: new Wait.FakeSwitches(),
        }
      : {};
    const devCrawler: Crawl.PriceCrawlerOptions = dev
      ? {
          // Crawling stays OFF in dev (kill.crawlers fails closed); the fake fetcher has no network.
          flags: new Crawl.StaticCrawlFlags(false),
          fetcher: new Crawl.FakeHttpFetch(),
          dns: new Crawl.FakeDns(),
          parser: new Crawl.JsonOfferParser(),
          verifier: new Crawl.FakeDomainVerifier(),
          vault: new Crawl.FakeTokenVault(),
          embeddings: new Crawl.FakeEmbeddingIndex(),
          attributes: new Crawl.FakeAttributeCheck(),
          fingerprints: new Crawl.FakeFingerprints(),
        }
      : {};
    const devHub: Hub.HubConsolidationOptions = dev
      ? {
          flags: new Hub.StaticHubFlags(true),
          facts: new Hub.FakeParcelFacts(),
          outbound: new Hub.FakeOutboundCourier(),
          ledger: new Hub.FakeHubLedger(),
        }
      : {};
    const devResale: Resale.ResaleLaneOptions = dev
      ? {
          returns: new Resale.FakeReturnFacts(),
          consent: new Resale.FakeResaleConsent(),
          terms: new Resale.StaticResaleTerms(),
          catalog: new Resale.FakeResaleCatalog(),
          flags: new Resale.StaticResaleFlags(true),
          ledger: new Resale.FakeResaleLedger(),
        }
      : {};
    const devAramex: Aramex.CourierAramexOptions =
      config.adapters === "in-memory-dev" && config.env !== "test"
        ? { transport: new Aramex.FakeAramexTransport(), credentials: new Aramex.StaticAramexCredentials() }
        : {};
    const devAds: Ads.AdsModuleOptions = dev
      ? {
          flags: new Ads.FakeAdsFlags(),
          enforcement: new Ads.FakeEnforcement(),
          eligibility: new Ads.FakeEligibility(),
          charges: new Ads.FakeChargeIntents(),
          ledger: new Ads.FakeLedger(),
          bots: new Ads.FakeBotScore(),
          attribution: new Ads.FakeAttribution(),
          secret: new Ads.FakeSecret(),
        }
      : {};
    const catalogFixtures = createCatalogDevFixtures();
    const priceIntegrity = PriceIntegrityModule.forRoot(config, undefined, pg?.priceIntegrity);
    // Money core (wave 4). Real adapters join the modules through their public surfaces (composition/).
    const money = composeMoney({ config, pg });
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config, overrides),
        AuthModule.forRoot(config),
        PrivacyModule.forRoot(config),
        StoresModule.forRoot(config, { ...pg?.stores, ...options.stores }),
        CatalogModule.forRoot(config, catalogFixtures, pg?.catalog),
        priceIntegrity,
        PriceBridgeModule.forRoot(catalogFixtures.prices, priceIntegrity),
        WishlistsModule.forRoot(config, { ...pg?.wishlists, ...options.wishlists }),
        CartModule.forRoot(config, { ...devCart, ...pg?.cart }),
        InventoryModule.forRoot(config, pg?.inventory),
        SizingModule.forRoot(config, pg?.sizing),
        NotificationsModule.forRoot(config, { ...pg?.notifications, ...options.notifications }),
        OrdersModule.forRoot(config, { ...devOrders, ...pg?.orders, ...options.orders }),
        ReturnsModule.forRoot(config, { ...devReturns, ...pg?.returns, ...options.returns }),
        PromotionsModule.forRoot(config, { ...devPromotions, ...pg?.promotions, ...options.promotions }),
        FulfillmentModule.forRoot(config, { ...devFulfillment, ...pg?.fulfillment, ...options.fulfillment }),
        SearchModule.forRoot(config, { ...devSearch, ...pg?.search, ...options.search }),
        ReferralsModule.forRoot(config, { ...pg?.referrals, ...options.referrals }),
        TaxEtaModule.forRoot(config, { ...devTax, ...pg?.tax, ...options.tax }),
        SellerAnalyticsModule.forRoot(config, { ...devAnalytics, ...pg?.sellerAnalytics, ...options.sellerAnalytics }),
        AdminModule.forRoot(config, { ...pg?.admin, ...options.admin }),
        ReviewsModule.forRoot(config, { ...devReviews, ...pg?.reviews, ...options.reviews }),
        LedgerModule.forRoot(config, { ...money.ledger, ...options.money?.ledger }),
        PaymentsModule.forRoot(config, { ...money.payments, ...options.money?.payments }),
        StoreCreditModule.forRoot(config, { ...money.storeCredit, ...options.money?.storeCredit }),
        RefundsModule.forRoot(config, { ...money.refunds, ...options.money?.refunds }),
        CheckoutModule.forRoot(config, { ...money.checkout, ...options.money?.checkout }),
        PayoutsModule.forRoot(config, { ...money.payouts, ...options.money?.payouts }),
        ReconciliationModule.forRoot(config, { ...money.reconciliation, ...options.money?.reconciliation }),
        MoneyBridgeModule.forRoot(money.lates),
        // Phase 2. The LLM gateway is global; stores come from Postgres when adapters !== in-memory-dev.
        Llm.LlmGatewayModule.forRoot(config, { ...devLlm, ...pg?.phase2.llmGateway, ...p2.llmGateway }),
        Subs.SubscriptionsModule.forRoot(config, { ...devSubs, ...pg?.phase2.subscriptions, ...p2.subscriptions }),
        Gift.GiftCardsModule.forRoot(config, { ...devGift, ...pg?.phase2.giftCards, ...p2.giftCards }),
        Bud.BudgetModule.forRoot(config, { ...devBudget, ...pg?.phase2.budget, ...p2.budget }),
        Sty.StylistModule.forRoot(config, { ...devStylist, ...pg?.phase2.stylist, ...p2.stylist }),
        Rec.RecommendationsModule.forRoot(config, { ...devRec, ...pg?.phase2.recommendations, ...p2.recommendations }),
        Hist.HistoryModule.forRoot(config, { ...devHistory, ...pg?.phase2.history, ...p2.history }),
        Ret.RetentionModule.forRoot(config, pg?.retention),
        Rew.RewardsModule.forRoot(config, { ...devRewards, ...pg?.phase2.rewards, ...p2.rewards }),
        Drp.DropsModule.forRoot(config, { ...devDrops, ...pg?.phase2.drops, ...p2.drops }),
        Wait.WaitingRoomModule.forRoot(config, { ...devWaiting, ...pg?.phase2.waitingRoom, ...p2.waitingRoom }),
        Crawl.PriceCrawlerModule.forRoot(config, { ...devCrawler, ...pg?.phase2.priceCrawler, ...p2.priceCrawler }),
        Hub.HubConsolidationModule.forRoot(config, { ...devHub, ...pg?.phase2.hub, ...p2.hub }),
        Resale.ResaleLaneModule.forRoot(config, { ...devResale, ...pg?.phase2.resale, ...p2.resale }),
        Aramex.CourierAramexModule.forRoot(config, { ...devAramex, ...p2.aramex }),
        Ads.AdsModule.forRoot(config, { ...devAds, ...pg?.phase2.ads, ...p2.ads }),
      ],
    };
  }
}
