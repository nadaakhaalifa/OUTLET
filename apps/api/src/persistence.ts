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
import { KyselyOrderRepository, type OrdersDb } from "./modules/orders";
import { KyselyReturnRepository, type ReturnsDb } from "./modules/returns";
import { KyselyPromotionRepository, type PromotionDb } from "./modules/promotions";
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
import { KyselyAdminAudit, KyselyAdminStore, KyselySellerKyc, type AdminDb } from "./modules/admin";
import { KyselyReviewStore, type ReviewDb } from "./modules/reviews";
import { STORES_SYSTEM_SESSION, type StoresDb, type StoresModuleOptions } from "./modules/stores";
import { CATALOG_SYSTEM_SESSION, type CatalogDb, type CatalogPersistence } from "./modules/catalog";
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
  readonly stores: StoresModuleOptions;
  readonly catalog: CatalogPersistence;
  readonly wishlists: { readonly repository: KyselyWishlistRepository };
  readonly cart: { readonly repository: KyselyCartRepository };
  readonly sizing: SizingModuleOptions;
  readonly notifications: { readonly repositories: NotificationsRepositories };
  readonly inventory: { readonly store: KyselyInventoryStore; readonly directory: LevelBackedSkuDirectory };
  readonly orders: { readonly repository: KyselyOrderRepository };
  readonly returns: { readonly repository: KyselyReturnRepository };
  readonly promotions: { readonly repository: KyselyPromotionRepository };
  readonly fulfillment: { readonly repository: KyselyFulfillmentRepository };
  readonly search: { readonly savedSearches: KyselySavedSearchRepository };
  readonly priceIntegrity: PriceIntegrityPersistence;
  readonly referrals: { readonly store: KyselyReferralStore };
  readonly tax: {
    readonly config: KyselyTaxConfigRepository;
    readonly documents: KyselyTaxDocumentRepository;
    readonly signed: KyselySignedDocumentStore;
    readonly delegations: KyselySigningDelegations;
  };
  readonly sellerAnalytics: { readonly store: KyselySellerAnalyticsStore };
  readonly admin: { readonly store: KyselyAdminStore; readonly audit: KyselyAdminAudit; readonly kyc: KyselySellerKyc };
  readonly reviews: { readonly store: KyselyReviewStore };
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
    stores: { persistence: { runner: runnerOf<StoresDb>(), session: () => STORES_SYSTEM_SESSION } },
    catalog: { runner: runnerOf<CatalogDb>(), session: () => CATALOG_SYSTEM_SESSION },
    wishlists: { repository: new KyselyWishlistRepository(handle as WishlistDb) },
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
    promotions: { repository: new KyselyPromotionRepository(handle as PromotionDb) },
    fulfillment: { repository: new KyselyFulfillmentRepository(handle as FulfillmentDb) },
    search: { savedSearches: new KyselySavedSearchRepository(handle as SearchDb) },
    priceIntegrity: { runner: runnerOf<PriceIntegrityDb>(), session: () => PRICE_INTEGRITY_SYSTEM_SESSION },
    referrals: { store: new KyselyReferralStore(handle as ReferralDb, ids) },
    tax: {
      config: new KyselyTaxConfigRepository(handle as TaxEtaDb),
      documents: new KyselyTaxDocumentRepository(handle as TaxEtaDb),
      signed: new KyselySignedDocumentStore(handle as TaxEtaDb),
      delegations: new KyselySigningDelegations(handle as TaxEtaDb),
    },
    sellerAnalytics: { store: new KyselySellerAnalyticsStore(handle as SellerAnalyticsDb) },
    admin: {
      store: new KyselyAdminStore(handle as AdminDb),
      audit: new KyselyAdminAudit(handle as AdminDb),
      kyc: new KyselySellerKyc(handle as AdminDb),
    },
    reviews: { store: new KyselyReviewStore(handle as ReviewDb, ids) },
  };
}
