import { Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { AppConfig } from "../config/env";
import { MoneyBridgeModule, Phase3BridgeModule, composeMoney, createPhase3Lates, type MoneyWiring } from "../composition";
import { ChannelOdooModule } from "../modules/channel-odoo";
import { createPersistence, type PersistenceWiring } from "../persistence";
import { ReadinessRegistry, type PlatformOverrides, type ReadinessReport } from "../platform";
import { CLOCK } from "../platform/tokens";
import { InMemoryRateLimiter } from "../platform/dev-fixtures";
import { createIdGenerator, nodeCsprng, systemClock } from "../platform/system-adapters";
import { AddressesModule, checkoutAddressPort, createAddressService } from "../modules/addresses";
import { NullFunnel, SellersApplicationOwnership, SellersModule, type BrandDocumentStore, type ScanPort } from "../modules/sellers";
import { BrandVerificationModule, NodeDnsResolver, UnconfiguredSanctionsScreening, UnconfiguredTrademarkRegistry, UnconfiguredVerificationEmail, type VerificationSecretPort } from "../modules/brand-verification";
import { AdminModule, BrandReviewModule, KyselyBrandReviewOverlay, type BrandReviewDb } from "../modules/admin";
import { AuthModule, UnconfiguredOtpSender, type AuthProductionPorts, type FieldCipher, type TokenKeySource } from "../modules/auth";
import type { AttestationVerifier } from "@outlet/auth-core";
import { AdsModule } from "../modules/ads";
import { ForecastingModule } from "../modules/forecasting";
import { RankingModule } from "../modules/ranking";
import { BudgetModule } from "../modules/budget";
import { AutoBuyModule } from "../modules/auto-buy";
import { CartModule } from "../modules/cart";
import { GuestMergeModule, KyselyGuestMergeUnitOfWork } from "../modules/guest-merge";
import { CheckoutModule } from "../modules/checkout";
import { CourierAramexModule } from "../modules/courier-aramex";
import { DropsModule } from "../modules/drops";
import { FulfillmentModule } from "../modules/fulfillment";
import { GiftCardsModule } from "../modules/gift-cards";
import { HistoryModule } from "../modules/history";
import { HubConsolidationModule } from "../modules/hub-consolidation";
import { InventoryModule } from "../modules/inventory";
import { AdminAttentionModule, KyselyAuditChainReader, type AuditReadDb } from "../modules/admin-attention";
import { LedgerModule } from "../modules/ledger";
import { LlmGatewayModule } from "../modules/llm-gateway";
import { OrdersModule } from "../modules/orders";
import { PaymentsModule } from "../modules/payments";
import { PayoutsModule } from "../modules/payouts";
import { PriceCrawlerModule } from "../modules/price-crawler";
import { PriceIntegrityModule } from "../modules/price-integrity";
import { PrivacyModule } from "../modules/privacy";
import { PromotionsModule } from "../modules/promotions";
import { KyselyPurgeExecutor, KyselyPurgeRunStore, RetentionModule, type BlobDeletePort } from "../modules/retention";
import { RecommendationsModule } from "../modules/recommendations";
import { ReconciliationModule } from "../modules/reconciliation";
import { ReferralsModule } from "../modules/referrals";
import { RefundsModule } from "../modules/refunds";
import { ResaleLaneModule } from "../modules/resale-lane";
import { ReturnsModule } from "../modules/returns";
import { ReviewsModule } from "../modules/reviews";
import { RewardsModule } from "../modules/rewards";
import { SearchModule } from "../modules/search";
import { SellerAnalyticsModule } from "../modules/seller-analytics";
import { AnalyticsIngestModule } from "../modules/analytics-ingest";
import { KyselyPlatformRollups, PlatformMetricsModule, type PlatformMetricsDb } from "../modules/platform-metrics";
import {
  SellerSettingsModule,
  type EtaVerifierPort,
  type InviteDeliveryPort,
  type NameMatchPort,
  type SellerMembershipsAdminPort,
  type StoreIdentityPort,
  type StrongFactorPort,
  type UploadScanPort,
  type UploadStorePort,
} from "../modules/seller-settings";
import { StoreCreditModule } from "../modules/store-credit";
import { StoresModule } from "../modules/stores";
import { brandReviewProduction } from "../composition/brand-wiring";
import { StylistModule } from "../modules/stylist";
import { ProductMediaModule } from "../modules/product-media";
import { HomeBannersModule } from "../modules/home-banners";
import { WardrobeModule } from "../modules/wardrobe";
import { OutfitCalendarModule } from "../modules/outfit-calendar";
import { SubscriptionsModule } from "../modules/subscriptions";
import { TaxEtaModule } from "../modules/tax-eta";
import { WaitingRoomModule } from "../modules/waiting-room";
import { KyselyConsentRepository, type PrivacyDb } from "../modules/privacy";
import { NotificationsModule, DroppingAnalytics, KyselyInboxProcessed, LogNotificationEvents, PrivacyConsentPort, unconfiguredProviderRegistry, type ContactPort } from "../modules/notifications";
import { EnvelopeFieldCipher, PrivacyMeasurementsConsent, SizingModule, type FitCatalogPort, type KmsPort, type OrderLineFitPort, type SizingEventPublisher } from "../modules/sizing";
import { ProviderNotConfiguredError } from "./unconfigured";
import { MODULE_BINDINGS } from "./bindings";
import { composeCatalogAndWishlists, withPriceBridge } from "./catalog-wiring";
import { createProductionFlags, type ProductionFlagPorts } from "./flags";
import {
  DatabaseReadiness,
  KyselyAuditSink,
  KyselyIdempotencyStore,
  readOutboxLag,
} from "./platform-adapters";
import { PRODUCTION_PORTS } from "./ports";
import { composeSearchPorts } from "./search-wiring";
import { awsAdaptersFor } from "./adapters-index";
import { PROVIDERS, isRealProvider, providerStatus, unconfigured, type ProviderName } from "./unconfigured";
import type { PaymentEventsToCheckout } from "../composition";

type Db = Kysely<Record<string, never>>;

/** Providers with a real adapter wired into this composition. Empty until a provider contract lands. */
export const REAL_ADAPTERS: ReadonlySet<ProviderName> = new Set<ProviderName>();

export const PRODUCTION_RUNTIME = Symbol("outlet.productionRuntime");

/** What the worker needs from the booted production graph. */
export interface ProductionRuntime {
  readonly db: Db;
  readonly paymentEvents: PaymentEventsToCheckout;
}

export interface ProductionOptions {
  /** Injectable for tests (PGlite). Without it a pool is created from DATABASE_URL. */
  readonly db?: Db;
  /**
   * Real auth providers. Every field defaults to an Unconfigured adapter (503 or 401, fail
   * closed): KMS (`kms.envelope`), signing keys (`secrets.manager`), attestation, SMS/WhatsApp.
   */
  readonly auth?: Partial<Omit<AuthProductionPorts, "db">>;
}

/** Describes provider, module and dependency status for GET /v1/ready. Names and counters only. */
export class ProductionReport implements ReadinessReport {
  constructor(private readonly db: Db) {}

  async describe(): Promise<Record<string, unknown>> {
    const providers: Record<string, "configured" | "unconfigured" | "unreachable"> = {};
    for (const name of Object.keys(PROVIDERS)) {
      // "configured" needs a real adapter bound in this composition. None exists yet, so every
      // provider is reported unconfigured, including ones no module binds (bnpl.quotes, push).
      providers[name] = REAL_ADAPTERS.has(name as ProviderName) ? "configured" : await providerStatus(name as ProviderName);
    }
    const outbox = await readOutboxLag(this.db, systemClock);
    const blocked = Object.entries(MODULE_BINDINGS)
      .filter(([, b]) => b.status === "blocked")
      .map(([id]) => id);
    return {
      providers,
      modules: {
        composed: Object.values(MODULE_BINDINGS).filter((b) => b.status === "composed").length,
        blocked,
      },
      dependencies: {
        outbox: { state: outbox.state, pending: outbox.pending, oldest_age_seconds: outbox.oldestAgeSeconds, dead_lettered: outbox.deadLettered },
      },
    };
  }
}

@Injectable()
class ProductionBootstrap implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(ReadinessRegistry) private readonly registry: ReadinessRegistry,
    @Inject(PRODUCTION_RUNTIME) private readonly runtime: ProductionRuntime & { readonly ownsPool: boolean },
  ) {}

  onModuleInit(): void {
    this.registry.register(new DatabaseReadiness(this.runtime.db));
    const names = (Object.keys(PROVIDERS) as ProviderName[]).filter((n) => !REAL_ADAPTERS.has(n) && !isRealProvider(n));
    // Names only. Never values, never PII.
    process.stdout.write(`${JSON.stringify({ level: "warn", event: "providers.unconfigured", providers: names })}\n`);
    const blocked = Object.entries(MODULE_BINDINGS).filter(([, b]) => b.status === "blocked").map(([id]) => id);
    process.stdout.write(`${JSON.stringify({ level: "warn", event: "modules.not_composed", modules: blocked })}\n`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.runtime.ownsPool) await this.runtime.db.destroy();
  }
}

@Module({})
class ProductionRuntimeModule {
  static forRoot(runtime: ProductionRuntime & { readonly ownsPool: boolean }): DynamicModule {
    return {
      module: ProductionRuntimeModule,
      providers: [{ provide: PRODUCTION_RUNTIME, useValue: runtime }, { provide: CLOCK, useValue: systemClock }, ProductionBootstrap],
      exports: [PRODUCTION_RUNTIME],
    };
  }
}

export interface ProductionComposition {
  readonly platform: PlatformOverrides["production"];
  readonly imports: readonly DynamicModule[];
  readonly pg: PersistenceWiring;
  readonly money: MoneyWiring;
  readonly flags: ProductionFlagPorts;
}

/** Postgres stores for every composed module, Unconfigured providers for everything external. */
export function composeProduction(config: AppConfig, options: ProductionOptions = {}): ProductionComposition {
  const pg = createPersistence(config, options.db);
  const flags = createProductionFlags();
  const aws = awsAdaptersFor(config);
  const money = composeMoney({ config, pg });
  const phase3 = createPhase3Lates();
  const ports = PRODUCTION_PORTS(config, pg, flags, money, phase3);
  const catalogWiring = composeCatalogAndWishlists(config, pg, aws.objectStore === null ? {} : { objects: aws.objectStore.catalog() });
  const priceIntegrity = PriceIntegrityModule.forRoot(config, undefined, pg.priceIntegrity);
  // One field cipher for auth and addresses; KMS Unconfigured => 503 provider_not_configured on encrypted fields.
  const fieldCipher = options.auth?.cipher ?? aws.fieldCipher ?? unconfigured<FieldCipher>("kms.envelope");
  const addressService = createAddressService(pg.addresses.store, fieldCipher, systemClock, createIdGenerator(systemClock, nodeCsprng));
  const authModule = AuthModule.forRoot(config, {
      db: pg.db,
      cipher: fieldCipher,
      keySource: options.auth?.keySource ?? aws.tokenKeySource ?? unconfigured<TokenKeySource>("secrets.manager"),
      attestation: options.auth?.attestation ?? unconfigured<AttestationVerifier>("attestation.app-attest"),
      senders: options.auth?.senders ?? [new UnconfiguredOtpSender("sms"), new UnconfiguredOtpSender("whatsapp")],
      ...(options.auth?.jwksHttp === undefined ? {} : { jwksHttp: options.auth.jwksHttp }),
      ...(options.auth?.passkeyVerifier === undefined ? {} : { passkeyVerifier: options.auth.passkeyVerifier }),
    });
  const sellersModule = SellersModule.forRoot(config, {
      repository: pg.sellers.repository,
      cipher: fieldCipher,
      store: unconfigured<BrandDocumentStore>("object.store"),
      scanner: unconfigured<ScanPort>("object.store"),
      analytics: new NullFunnel(),
    });
  const bvModule = BrandVerificationModule.forRoot(config, {
      store: pg.brandVerification.store,
      ownership: new SellersApplicationOwnership(pg.sellers.repository, fieldCipher),
      dns: new NodeDnsResolver(),
      registry: new UnconfiguredTrademarkRegistry(),
      sanctions: new UnconfiguredSanctionsScreening(),
      email: new UnconfiguredVerificationEmail(),
      secret: unconfigured<VerificationSecretPort>("kms.envelope"),
    });
  const storesModule = StoresModule.forRoot(config, pg.stores);
  const notificationsModule = NotificationsModule.forRoot(config, {
      ...pg.notifications,
      production: {
        consent: new PrivacyConsentPort(new KyselyConsentRepository(pg.db as unknown as PrivacyDb)),
        // Auth exposes no contact lookup yet: fail closed rather than invent a recipient.
        contacts: unconfigured<ContactPort>("internal.wiring"),
        providers: unconfiguredProviderRegistry({
          push: (op) => new ProviderNotConfiguredError("push.apns-fcm", op),
          whatsapp: (op) => new ProviderNotConfiguredError("messaging.sms-whatsapp", op),
          sms: (op) => new ProviderNotConfiguredError("messaging.sms-whatsapp", op),
          email: (op) => new ProviderNotConfiguredError("messaging.email", op),
        }),
        events: new LogNotificationEvents(),
        analytics: new DroppingAnalytics(),
        inboxProcessed: new KyselyInboxProcessed(pg.db),
      },
    });
  const brandOverlay = new KyselyBrandReviewOverlay(pg.db as unknown as BrandReviewDb, systemClock);
  const imports: DynamicModule[] = [
    authModule,
    AddressesModule.forRoot(config, { store: pg.addresses.store, cipher: fieldCipher }),
    // Brand applications: Postgres store; the private KYC bucket, scanner and domain verifier are Unconfigured (503) until composed.
    sellersModule,
    // Brand verification (ADR-0031): ownership comes from sellers; trademark, sanctions, email and the HMAC key are Unconfigured.
    bvModule,
    storesModule,
    PrivacyModule.forRoot(config, ports.privacy),
    priceIntegrity,
    InventoryModule.forRoot(config, pg.inventory),
    withPriceBridge(catalogWiring.catalog, catalogWiring.prices, priceIntegrity),
    catalogWiring.wishlists,
    ReferralsModule.forRoot(config, pg.referrals),
    CartModule.forRoot(config, ports.cart),
    // Guest merge (ADR-0055 G-1): one Postgres transaction over cart, wishlists and the outbox. Dark behind flag.guest_browsing.
    GuestMergeModule.forRoot(config, { uow: new KyselyGuestMergeUnitOfWork(pg.db) }),
    OrdersModule.forRoot(config, ports.orders),
    ReturnsModule.forRoot(config, ports.returns),
    PromotionsModule.forRoot(config, ports.promotions),
    FulfillmentModule.forRoot(config, ports.fulfillment),
    SearchModule.forRoot(config, composeSearchPorts(ports.search, pg, catalogWiring.snapshots)),
    TaxEtaModule.forRoot(config, ports.tax),
    SellerAnalyticsModule.forRoot(config, ports.sellerAnalytics),
    AnalyticsIngestModule.forRoot(config, ports.analyticsIngest),
    // Seller settings: Postgres store; every external or not-yet-landed dependency fails closed (503) until composed.
    SellerSettingsModule.forRoot(config, {
      repository: pg.sellerSettings.repo,
      identity: unconfigured<StoreIdentityPort>("internal.wiring"),
      uploads: unconfigured<UploadStorePort>("object.store"),
      scan: unconfigured<UploadScanPort>("object.store"),
      nameMatch: unconfigured<NameMatchPort>("bank.name-match"),
      strongFactor: unconfigured<StrongFactorPort>("internal.wiring"),
      memberships: unconfigured<SellerMembershipsAdminPort>("internal.wiring"),
      delivery: unconfigured<InviteDeliveryPort>("messaging.sms-whatsapp"),
      eta: unconfigured<EtaVerifierPort>("eta.portal"),
      cipher: fieldCipher,
    }),
    AdminModule.forRoot(config, ports.admin),
    // Track 7. Read-only audit verify over pg; attention sources stay Unconfigured (items report unavailable); routes blocked by default.
    AdminAttentionModule.forRoot(config, {
      chains: new KyselyAuditChainReader(pg.db as unknown as AuditReadDb),
      elevations: pg.admin.store,
      audit: pg.admin.audit,
      auditLogRoutesEnabled: () => flags.client.isEnabled("release.admin.audit_log"),
      attentionRoutesEnabled: () => flags.client.isEnabled("release.admin.attention"),
    }),
    // Track 4. Platform time series over platform_metrics_hourly; blocked by default (release.admin.metrics).
    PlatformMetricsModule.forRoot(config, {
      reader: new KyselyPlatformRollups(pg.db as unknown as PlatformMetricsDb),
      elevations: pg.admin.store,
      enabled: () => flags.client.isEnabled("release.admin.metrics"),
    }),
    // Brand application review (ADR-0031): sellers + brand-verification + stores + seller auth + notifications are real,
    // cosign/parking state is Postgres (migration 0054). brand_application.* events are delivered by the worker relay.
    BrandReviewModule.forRoot(config, {
      adminStore: pg.admin.store,
      audit: pg.admin.audit,
      composed: brandReviewProduction({
        sellersModule,
        verificationModule: bvModule,
        storesModule,
        authModule,
        notificationsModule,
        overlay: brandOverlay,
        db: pg.db as unknown as Kysely<Record<string, never>>,
      }),
    }),
    ReviewsModule.forRoot(config, ports.reviews),
    LedgerModule.forRoot(config, money.ledger),
    PaymentsModule.forRoot(config, ports.payments),
    StoreCreditModule.forRoot(config, money.storeCredit),
    RefundsModule.forRoot(config, ports.refunds),
    CheckoutModule.forRoot(config, { ...ports.checkout, addresses: checkoutAddressPort(addressService) }),
    PayoutsModule.forRoot(config, ports.payouts),
    ReconciliationModule.forRoot(config, ports.reconciliation),
    MoneyBridgeModule.forRoot(money.lates),
    LlmGatewayModule.forRoot(config, ports.llm),
    SubscriptionsModule.forRoot(config, ports.subscriptions),
    GiftCardsModule.forRoot(config, ports.giftCards),
    BudgetModule.forRoot(config, ports.budget),
    AutoBuyModule.forRoot(config, ports.autoBuy),
    // Phase 3 cross-module late bindings (auto-buy eligibility, quote, budget gate; Odoo stock and price sinks).
    Phase3BridgeModule.forRoot(phase3),
    // Odoo seller channel: real store and sinks; egress proxy, DNS and vault stay Unconfigured, switch default blocked.
    ChannelOdooModule.forRoot(config, ports.channelOdoo),
    StylistModule.forRoot(config, ports.stylist),
    RecommendationsModule.forRoot(config, ports.recommendations),
    HistoryModule.forRoot(config, ports.history),
    RewardsModule.forRoot(config, ports.rewards),
    DropsModule.forRoot(config, ports.drops),
    WaitingRoomModule.forRoot(config, ports.waitingRoom),
    PriceCrawlerModule.forRoot(config, ports.priceCrawler),
    HubConsolidationModule.forRoot(config, ports.hub),
    ResaleLaneModule.forRoot(config, ports.resale),
    RetentionModule.forRoot(config, {
      executor: new KyselyPurgeExecutor(pg.db, aws.objectStore?.blobDelete() ?? unconfigured<BlobDeletePort>("object.store")),
      runs: new KyselyPurgeRunStore(pg.db),
    }),
    CourierAramexModule.forRoot(config, ports.aramex),
    AdsModule.forRoot(config, ports.ads),
    // Outfit calendar: own store and courier ETA from Postgres; stylist ports and notifications resolved lazily.
    OutfitCalendarModule.forRoot(config, {
      ...pg.phase2.outfitCalendar,
      ...(ports.stylist.flags === undefined ? {} : { flags: ports.stylist.flags }),
    }),
    // Wardrobe digitization: own store from Postgres; photos use the private bucket facade when an object
    // store exists (Unconfigured otherwise), vision stays Unconfigured until a vendor is contracted (VR-P3-13).
    WardrobeModule.forRoot(config, {
      ...pg.phase2.wardrobe,
      ...(aws.objectStore === null ? {} : { images: aws.objectStore.wardrobeImages() }),
      ...(ports.stylist.flags === undefined ? {} : { flags: ports.stylist.flags }),
    }),
    // Seller product photos: own store from Postgres; originals and derivatives in the private bucket when an object
    // store exists. The background-removal provider stays Unconfigured (503) and kill.background_removal is
    // allowed-when-true with default blocked, until the self-hosted sidecar is deployed and wired.
    ProductMediaModule.forRoot(config, {
      ...ports.productMedia,
      ...(aws.objectStore === null ? {} : { blobs: aws.objectStore.productMedia() }),
    }),
    // In-app offer banners (0084): Postgres store, admin audit chain, kill.home_banners default-blocked.
    HomeBannersModule.forRoot(config, ports.homeBanners),
    ForecastingModule.forRoot(config, ports.forecasting),
    RankingModule.forRoot(config, ports.ranking),
    SizingModule.forRoot(config, {
      ...pg.sizing,
      // Fail closed: KMS Unconfigured means measurements cannot be saved or read (503 provider_not_configured).
      // The dev AES cipher is not reachable from here (SizingModule only builds it when adapters is in-memory-dev).
      production: {
        cipher: aws.kms !== null ? new EnvelopeFieldCipher(aws.kms) : new EnvelopeFieldCipher(unconfigured<KmsPort>("kms.envelope")),
        consent: new PrivacyMeasurementsConsent(new KyselyConsentRepository(pg.db as unknown as PrivacyDb)),
        fitCatalog: unconfigured<FitCatalogPort>("internal.wiring"),
        orderLines: unconfigured<OrderLineFitPort>("internal.wiring"),
        events: unconfigured<SizingEventPublisher>("internal.wiring"),
      },
    }),
    notificationsModule,
    ProductionRuntimeModule.forRoot({ db: pg.db, ownsPool: pg.ownsPool, paymentEvents: money.paymentEvents }),
  ];
  return {
    platform: {
      idempotencyStore: new KyselyIdempotencyStore(pg.db),
      // Per process until a shared limiter exists (Redis is Unconfigured). See ADR-0029.
      rateLimiter: new InMemoryRateLimiter(),
      auditSink: new KyselyAuditSink(pg.db),
      report: new ProductionReport(pg.db),
      // kill.public_catalog: anonymous /v1/public reads stay BLOCKED until an operator allows them.
      publicReadGate: { enabled: () => flags.isEnabled("kill.public_catalog") },
      // flag.guest_browsing (ADR-0055): the guest-only reads and the merge answer 404 until an operator allows it.
      guestBrowsingGate: { enabled: () => flags.client.isEnabled("flag.guest_browsing") },
    },
    imports,
    pg,
    money,
    flags,
  };
}
