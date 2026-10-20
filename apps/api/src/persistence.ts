import type { Kysely } from "kysely";
import type { AppConfig } from "./config/env";
import { KyselyCartRepository, type CartDb } from "./modules/cart";
import { KyselyInventoryStore, LevelBackedSkuDirectory, type InventoryDb } from "./modules/inventory";
import {
  KyselyDeliveryLogRepository,
  KyselyFrequencyStore,
  KyselyInboxRepository,
  KyselyPreferenceRepository,
  KyselyPushTokenRepository,
  KyselyRequestRepository,
  KyselySuppressionRepository,
  KyselyTemplateRepository,
  type NotificationsDb,
  type NotificationsRepositories,
} from "./modules/notifications";
import {
  KyselyDemandRepository,
  KyselyFeedbackRepository,
  KyselySizeChartRepository,
  KyselySizeProfileRepository,
  type SizingDb,
  type SizingModuleOptions,
} from "./modules/sizing";
import {
  KyselyBreachRepository,
  KyselyConsentRepository,
  KyselyDeletionBlockers,
  KyselyPrivacyRequestRepository,
  type PrivacyDb,
} from "./modules/privacy";
import { KyselyOrderRepository, type OrdersDb } from "./modules/orders";
import { KyselyReturnRepository, type ReturnsDb } from "./modules/returns";
import { KyselyCalendarStore, KyselyPromotionRepository, type PromotionDb } from "./modules/promotions";
import { KyselyFulfillmentRepository, type FulfillmentDb } from "./modules/fulfillment";
import { KyselySavedSearchRepository, type SearchDb } from "./modules/search";
import { KyselyWishlistRepository, type WishlistDb } from "./modules/wishlists";
import {
  PRICE_INTEGRITY_SYSTEM_SESSION,
  type PriceIntegrityDb,
  type PriceIntegrityPersistence,
} from "./modules/price-integrity";
import { KyselyReferralStore, type ReferralDb } from "./modules/referrals";
import {
  KyselySignedDocumentStore,
  KyselySigningDelegations,
  KyselyTaxConfigRepository,
  KyselyTaxDocumentRepository,
  type TaxEtaDb,
} from "./modules/tax-eta";
import { KyselySellerAnalyticsStore, type SellerAnalyticsDb } from "./modules/seller-analytics";
import { KyselySettingsRepository, type SettingsDb } from "./modules/seller-settings";
import { KyselyAdminAudit, KyselyAdminStore, KyselySellerKyc, type AdminDb } from "./modules/admin";
import { KyselyReviewStore, type ReviewDb } from "./modules/reviews";
import { STORES_SYSTEM_SESSION, type StoresDb, type StoresModuleOptions } from "./modules/stores";
import { CATALOG_SYSTEM_SESSION, type CatalogDb, type CatalogPersistence } from "./modules/catalog";
import {
  KyselyIntegritySnapshots,
  KyselyLedgerReadModel,
  KyselyLedgerStore,
  ledgerTxOf,
  type LedgerDb,
  type LedgerDbTx,
} from "./modules/ledger";
import { KyselyPaymentStore, type PaymentsDb } from "./modules/payments";
import { KyselySagaRepository, type CheckoutDb } from "./modules/checkout";
import { KyselyRefundStore, type RefundsDb } from "./modules/refunds";
import { KyselyStoreCredit, type StoreCreditDb } from "./modules/store-credit";
import { KyselyPayoutStore, type PayoutsDb } from "./modules/payouts";
import { KyselyReconStore, type ReconDb } from "./modules/reconciliation";
import { KyselyFamilyStore, KyselyStudentStore, KyselySubscriptionStore, type PlusDb } from "./modules/subscriptions";
import { KyselyGiftCardStore, type GiftCardDb } from "./modules/gift-cards";
import { KyselyBudgetStore, type BudgetDb } from "./modules/budget";
import { KyselyAddressStore, type AddressDb } from "./modules/addresses";
import { KyselyBrandApplicationRepository, type SellersDb } from "./modules/sellers";
import { KyselyStylistChatStore, KyselyStylistStore, type ChatDb, type StylistDb } from "./modules/stylist";
import { KyselyOutfitCalendarStore, KyselyStoreDeliveryEta, type OutfitCalendarDb } from "./modules/outfit-calendar";
import { KyselyProductMediaStore, type ProductMediaDb } from "./modules/product-media";
import { KyselyHomeBannerStore, type HomeBannerDb } from "./modules/home-banners";
import { KyselyWardrobeStore, type WardrobeDb } from "./modules/wardrobe";
import { KyselyAuditStore, KyselyTokenUsage, type GatewayDb } from "./modules/llm-gateway";
import { KyselyRecoStore, PgVectorIndex, type RecoDb } from "./modules/recommendations";
import { KyselyHistoryStore, type HistoryDb } from "./modules/history";
import { KyselyPurgeExecutor, KyselyPurgeRunStore, UnconfiguredBlobDelete, type RetentionDb } from "./modules/retention";
import { KyselyRewardsStore, type RewardsDb } from "./modules/rewards";
import { KyselyDropStore, type DropDb } from "./modules/drops";
import { KyselyAdmissionStore, type WaitingRoomDb } from "./modules/waiting-room";
import { KyselyCrawlStore, type CrawlDb } from "./modules/price-crawler";
import { KyselyHubStore, type HubDb } from "./modules/hub-consolidation";
import { KyselyResaleStore, type ResaleDb } from "./modules/resale-lane";
import { KyselyForecastStore, type ForecastingDb } from "./modules/forecasting";
import { KyselyCreatorStore, type CreatorDb } from "./modules/creators";
import { KyselyOdooStore, type OdooDb } from "./modules/channel-odoo";
import { KyselyRankingStore, type RankingDb } from "./modules/ranking";
import { KyselyAdsStore, type AdsDb } from "./modules/ads";
import { KyselyAutoBuyStore, type AutoBuyDb } from "./modules/auto-buy";
import { KyselyBrandVerificationStore, type BrandVerificationDb } from "./modules/brand-verification";
import type { LedgerUnitOfWork } from "./composition/ledger-gateway";
import { KyselyOutboxStore, KyselyTransactionRunner, createPgDatabase } from "./platform/db";
import type { PlatformTables } from "./platform/db";
import { createIdGenerator, nodeCsprng, systemClock } from "./platform/system-adapters";

/**
 * Production composition of the Postgres adapters (ADR-0020). Used by AppModule when
 * `config.adapters !== "in-memory-dev"`; in-memory stays the dev and test default.
 *
 * Identity: the adapters run under the `system` role (the inventory convention) because request
 * identity is not yet propagated to the persistence layer. Tenant and owner filtering is enforced in
 * the application layer and by PolicyGuard. Moving to request-scoped RLS sessions is open work.
 */
export class MissingDatabaseConfigError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`persistence requires ${missing.join(", ")} when DEV_FIXTURES is off`);
    this.name = "MissingDatabaseConfigError";
  }
}

export interface PersistenceWiring {
  /** The shared Kysely handle (readiness, platform adapters, the worker relays). Closed by the owner of the pool. */
  readonly db: Kysely<Record<string, never>>;
  /** True when createPersistence built the pool itself (and so the caller must destroy it on shutdown). */
  readonly ownsPool: boolean;
  readonly stores: StoresModuleOptions;
  readonly addresses: { readonly store: KyselyAddressStore };
  readonly sellers: { readonly repository: KyselyBrandApplicationRepository };
  readonly catalog: CatalogPersistence;
  readonly wishlists: { readonly repository: KyselyWishlistRepository };
  readonly cart: { readonly repository: KyselyCartRepository };
  readonly sizing: SizingModuleOptions;
  readonly notifications: { readonly repositories: NotificationsRepositories };
  readonly inventory: { readonly store: KyselyInventoryStore; readonly directory: LevelBackedSkuDirectory };
  readonly orders: { readonly repository: KyselyOrderRepository };
  readonly returns: { readonly repository: KyselyReturnRepository };
  readonly promotions: { readonly repository: KyselyPromotionRepository; readonly calendar: KyselyCalendarStore };
  readonly fulfillment: { readonly repository: KyselyFulfillmentRepository };
  readonly search: { readonly savedSearches: KyselySavedSearchRepository };
  readonly priceIntegrity: PriceIntegrityPersistence;
  /** Privacy stores over the shared pool; the events they write join the outbox in the same transaction. */
  readonly privacy: {
    readonly db: PrivacyDb;
    readonly consent: KyselyConsentRepository;
    readonly requests: KyselyPrivacyRequestRepository;
    readonly breach: KyselyBreachRepository;
    readonly blockers: KyselyDeletionBlockers;
  };
  readonly referrals: { readonly store: KyselyReferralStore };
  readonly tax: {
    readonly config: KyselyTaxConfigRepository;
    readonly documents: KyselyTaxDocumentRepository;
    readonly signed: KyselySignedDocumentStore;
    readonly delegations: KyselySigningDelegations;
  };
  readonly sellerAnalytics: { readonly store: KyselySellerAnalyticsStore };
  readonly sellerSettings: { readonly repo: KyselySettingsRepository };
  readonly admin: { readonly store: KyselyAdminStore; readonly audit: KyselyAdminAudit; readonly kyc: KyselySellerKyc };
  readonly reviews: { readonly store: KyselyReviewStore };
  /** Wave 4 money core. One shared pool, system role (see the identity note above). */
  readonly money: {
    readonly ledger: {
      readonly store: KyselyLedgerStore<LedgerDbTx>;
      readonly reads: KyselyLedgerReadModel;
      readonly snapshots: KyselyIntegritySnapshots;
      readonly uow: LedgerUnitOfWork;
    };
    readonly payments: { readonly store: KyselyPaymentStore };
    readonly checkout: { readonly repository: KyselySagaRepository };
    readonly refunds: { readonly store: KyselyRefundStore };
    readonly storeCredit: { readonly store: KyselyStoreCredit };
    readonly payouts: { readonly store: KyselyPayoutStore };
    readonly reconciliation: { readonly store: KyselyReconStore };
  };
  readonly retention: { readonly executor: KyselyPurgeExecutor; readonly runs: KyselyPurgeRunStore };
  /** Phase 2 stores (system role, same identity note as above). Non-store ports stay with the module's real adapters. */
  readonly phase2: {
    readonly subscriptions: {
      readonly store: KyselySubscriptionStore;
      readonly familyStore: KyselyFamilyStore;
      readonly studentStore: KyselyStudentStore;
    };
    readonly giftCards: { readonly store: KyselyGiftCardStore };
    readonly budget: { readonly store: KyselyBudgetStore };
    readonly stylist: { readonly store: KyselyStylistStore; readonly chatStore: KyselyStylistChatStore };
    readonly outfitCalendar: { readonly store: KyselyOutfitCalendarStore; readonly eta: KyselyStoreDeliveryEta };
    readonly wardrobe: { readonly store: KyselyWardrobeStore };
    readonly productMedia: { readonly store: KyselyProductMediaStore };
    readonly homeBanners: { readonly store: KyselyHomeBannerStore };
    readonly llmGateway: { readonly audit: KyselyAuditStore; readonly usage: KyselyTokenUsage };
    readonly recommendations: { readonly store: KyselyRecoStore; readonly vectors: PgVectorIndex };
    readonly history: { readonly store: KyselyHistoryStore };
    readonly rewards: { readonly store: KyselyRewardsStore };
    readonly drops: { readonly store: KyselyDropStore };
    readonly waitingRoom: { readonly store: KyselyAdmissionStore };
    readonly priceCrawler: { readonly store: KyselyCrawlStore };
    readonly hub: { readonly store: KyselyHubStore };
    readonly resale: { readonly store: KyselyResaleStore };
    readonly ads: { readonly store: KyselyAdsStore };
    readonly autoBuy: { readonly store: KyselyAutoBuyStore };
    readonly forecasting: { readonly store: KyselyForecastStore };
    readonly creators: { readonly store: KyselyCreatorStore };
    readonly channelOdoo: { readonly store: KyselyOdooStore };
    readonly ranking: { readonly shadowStore: KyselyRankingStore; readonly evalStore: KyselyRankingStore };
  };
  /** Brand verification (ADR-0031). Not composed in production until the sellers module supplies the application port. */
  readonly brandVerification: { readonly store: KyselyBrandVerificationStore };
}

/** Builds every Postgres adapter over ONE shared pool. `db` is injectable for tests (PGlite). */
export function createPersistence(config: AppConfig, db?: Kysely<Record<string, never>>): PersistenceWiring {
  const missing: string[] = [];
  if (db === undefined && config.databaseUrl === undefined) missing.push("DATABASE_URL");
  if (config.sizeDemandPseudonymKey === undefined) missing.push("SIZE_DEMAND_PSEUDONYM_KEY");
  if (missing.length > 0 || config.sizeDemandPseudonymKey === undefined) throw new MissingDatabaseConfigError(missing);
  const handle: Kysely<Record<string, never>> =
    db ??
    createPgDatabase<Record<string, never>>({
      connectionString: config.databaseUrl ?? "",
      max: config.databasePoolMax,
      applicationName: "outlet-api",
    });
  const ids = createIdGenerator(systemClock, nodeCsprng);
  const runnerOf = <T extends PlatformTables>(): KyselyTransactionRunner<T> => {
    const typed = handle as unknown as Kysely<T>;
    return new KyselyTransactionRunner<T>({
      db: typed,
      outbox: new KyselyOutboxStore(typed as unknown as Kysely<PlatformTables>),
      clock: systemClock,
      ids,
    });
  };
  const notificationsDb: NotificationsDb = handle;
  return {
    db: handle,
    ownsPool: db === undefined,
    stores: { persistence: { runner: runnerOf<StoresDb>(), session: () => STORES_SYSTEM_SESSION } },
    catalog: { runner: runnerOf<CatalogDb>(), session: () => CATALOG_SYSTEM_SESSION },
    wishlists: { repository: new KyselyWishlistRepository(handle as WishlistDb, { uuidV7: () => ids.uuidV7() }) },
    cart: { repository: new KyselyCartRepository(handle as CartDb) },
    sizing: {
      repositories: {
        profiles: new KyselySizeProfileRepository(handle as SizingDb),
        charts: new KyselySizeChartRepository(handle as SizingDb),
        feedback: new KyselyFeedbackRepository(handle as SizingDb),
        demand: new KyselyDemandRepository(handle as SizingDb, Buffer.from(config.sizeDemandPseudonymKey, "utf8")),
      },
    },
    notifications: {
      repositories: {
        templates: new KyselyTemplateRepository(notificationsDb),
        requests: new KyselyRequestRepository(notificationsDb),
        log: new KyselyDeliveryLogRepository(notificationsDb),
        frequency: new KyselyFrequencyStore(notificationsDb),
        preferences: new KyselyPreferenceRepository(notificationsDb),
        suppressions: new KyselySuppressionRepository(notificationsDb),
        inbox: new KyselyInboxRepository(notificationsDb),
        pushTokens: new KyselyPushTokenRepository(notificationsDb),
      },
    },
    inventory: {
      store: new KyselyInventoryStore(handle as InventoryDb),
      directory: new LevelBackedSkuDirectory(handle as InventoryDb),
    },
    orders: { repository: new KyselyOrderRepository(handle as OrdersDb, systemClock) },
    returns: { repository: new KyselyReturnRepository(handle as ReturnsDb) },
    promotions: { repository: new KyselyPromotionRepository(handle as PromotionDb), calendar: new KyselyCalendarStore(handle as PromotionDb) },
    fulfillment: { repository: new KyselyFulfillmentRepository(handle as FulfillmentDb) },
    search: { savedSearches: new KyselySavedSearchRepository(handle as SearchDb) },
    priceIntegrity: { runner: runnerOf<PriceIntegrityDb>(), session: () => PRICE_INTEGRITY_SYSTEM_SESSION },
    privacy: {
      db: handle as PrivacyDb,
      consent: new KyselyConsentRepository(handle as PrivacyDb),
      requests: new KyselyPrivacyRequestRepository(handle as PrivacyDb),
      breach: new KyselyBreachRepository(handle as PrivacyDb),
      blockers: new KyselyDeletionBlockers(handle as PrivacyDb),
    },
    referrals: { store: new KyselyReferralStore(handle as ReferralDb, ids) },
    tax: {
      config: new KyselyTaxConfigRepository(handle as TaxEtaDb),
      documents: new KyselyTaxDocumentRepository(handle as TaxEtaDb),
      signed: new KyselySignedDocumentStore(handle as TaxEtaDb),
      delegations: new KyselySigningDelegations(handle as TaxEtaDb),
    },
    sellerAnalytics: { store: new KyselySellerAnalyticsStore(handle as SellerAnalyticsDb) },
    sellerSettings: { repo: new KyselySettingsRepository(handle as SettingsDb) },
    admin: {
      store: new KyselyAdminStore(handle as AdminDb),
      audit: new KyselyAdminAudit(handle as AdminDb),
      kyc: new KyselySellerKyc(handle as AdminDb),
    },
    reviews: { store: new KyselyReviewStore(handle as ReviewDb, ids) },
    addresses: { store: new KyselyAddressStore(handle as AddressDb) },
    sellers: { repository: new KyselyBrandApplicationRepository(handle as SellersDb) },
    retention: { executor: new KyselyPurgeExecutor(handle as RetentionDb, new UnconfiguredBlobDelete()), runs: new KyselyPurgeRunStore(handle as RetentionDb) },
    phase2: {
      subscriptions: {
        store: new KyselySubscriptionStore(handle as PlusDb, ids),
        familyStore: new KyselyFamilyStore(handle as PlusDb, ids),
        studentStore: new KyselyStudentStore(handle as PlusDb, ids),
      },
      giftCards: { store: new KyselyGiftCardStore(handle as GiftCardDb, ids) },
      budget: { store: new KyselyBudgetStore(handle as BudgetDb, ids) },
      stylist: { store: new KyselyStylistStore(handle as StylistDb, ids), chatStore: new KyselyStylistChatStore(handle as ChatDb, ids) },
      outfitCalendar: { store: new KyselyOutfitCalendarStore(handle as OutfitCalendarDb, ids), eta: new KyselyStoreDeliveryEta(handle as OutfitCalendarDb) },
      wardrobe: { store: new KyselyWardrobeStore(handle as WardrobeDb, ids) },
      productMedia: { store: new KyselyProductMediaStore(handle as ProductMediaDb) },
      homeBanners: { store: new KyselyHomeBannerStore(handle as HomeBannerDb) },
      llmGateway: { audit: new KyselyAuditStore(handle as GatewayDb), usage: new KyselyTokenUsage(handle as GatewayDb) },
      recommendations: { store: new KyselyRecoStore(handle as RecoDb, ids), vectors: new PgVectorIndex(handle as RecoDb) },
      history: { store: new KyselyHistoryStore(handle as HistoryDb, ids) },
      rewards: { store: new KyselyRewardsStore(handle as RewardsDb, ids) },
      drops: { store: new KyselyDropStore(handle as DropDb, ids) },
      waitingRoom: { store: new KyselyAdmissionStore(handle as WaitingRoomDb, ids) },
      priceCrawler: { store: new KyselyCrawlStore(handle as CrawlDb, ids) },
      hub: { store: new KyselyHubStore(handle as HubDb, ids) },
      resale: { store: new KyselyResaleStore(handle as ResaleDb, ids) },
      ads: { store: new KyselyAdsStore(handle as AdsDb, ids) },
      autoBuy: { store: new KyselyAutoBuyStore(handle as AutoBuyDb, ids) },
      forecasting: { store: new KyselyForecastStore(handle as ForecastingDb) },
      creators: { store: new KyselyCreatorStore(handle as CreatorDb, ids) },
      channelOdoo: { store: new KyselyOdooStore(handle as OdooDb) },
      ranking: (() => {
        const store = new KyselyRankingStore(handle as RankingDb);
        return { shadowStore: store, evalStore: store };
      })(),
    },
    brandVerification: { store: new KyselyBrandVerificationStore(handle as BrandVerificationDb, ids) },
    money: {
      ledger: {
        store: new KyselyLedgerStore<LedgerDbTx>(),
        reads: new KyselyLedgerReadModel(handle as LedgerDb),
        snapshots: new KyselyIntegritySnapshots(handle as LedgerDb),
        // The posting joins this transaction; the system role is the one the chain lock runs under.
        uow: {
          run: (fn) =>
            runnerOf<PlatformTables>().run(
              { session: { userId: null, role: "system" }, process: "ledger.post", profile: "default" },
              (tx) => fn(ledgerTxOf(tx)),
            ),
        },
      },
      payments: { store: new KyselyPaymentStore(handle as PaymentsDb, systemClock, () => ids.uuidV7()) },
      checkout: { repository: new KyselySagaRepository(handle as CheckoutDb) },
      refunds: { store: new KyselyRefundStore(handle as RefundsDb, { uuidV7: () => ids.uuidV7() }) },
      storeCredit: { store: new KyselyStoreCredit(handle as StoreCreditDb) },
      payouts: { store: new KyselyPayoutStore(handle as PayoutsDb, systemClock) },
      reconciliation: { store: new KyselyReconStore(handle as ReconDb) },
    },
  };
}
