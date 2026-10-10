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
import { createPersistence } from "./persistence";
import { PlatformModule, type PlatformOverrides } from "./platform";

/** Per-module options for tests and local composition; production wiring passes none. */
export interface AppModuleOptions {
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
    // Postgres adapters when fixtures are off; in-memory stays the dev and test default.
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
    const catalogFixtures = createCatalogDevFixtures();
    const priceIntegrity = PriceIntegrityModule.forRoot(config, undefined, pg?.priceIntegrity);
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
      ],
    };
  }
}
