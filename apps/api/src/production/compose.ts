import { Global, Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { Authenticator } from "../platform/ports";
import type { Kysely } from "kysely";
import type { AppConfig } from "../config/env";
import { MoneyBridgeModule, composeMoney, type MoneyWiring } from "../composition";
import { createPersistence, type PersistenceWiring } from "../persistence";
import { ReadinessRegistry, type PlatformOverrides, type ReadinessReport } from "../platform";
import { AUTHENTICATOR, CLOCK } from "../platform/tokens";
import { InMemoryRateLimiter } from "../platform/dev-fixtures";
import { systemClock } from "../platform/system-adapters";
import { AdminModule } from "../modules/admin";
import { AdsModule } from "../modules/ads";
import { BudgetModule } from "../modules/budget";
import { CartModule } from "../modules/cart";
import { CheckoutModule } from "../modules/checkout";
import { CourierAramexModule } from "../modules/courier-aramex";
import { DropsModule } from "../modules/drops";
import { FulfillmentModule } from "../modules/fulfillment";
import { GiftCardsModule } from "../modules/gift-cards";
import { HistoryModule } from "../modules/history";
import { HubConsolidationModule } from "../modules/hub-consolidation";
import { InventoryModule } from "../modules/inventory";
import { LedgerModule } from "../modules/ledger";
import { LlmGatewayModule } from "../modules/llm-gateway";
import { OrdersModule } from "../modules/orders";
import { PaymentsModule } from "../modules/payments";
import { PayoutsModule } from "../modules/payouts";
import { PriceCrawlerModule } from "../modules/price-crawler";
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
import { StoreCreditModule } from "../modules/store-credit";
import { StoresModule } from "../modules/stores";
import { StylistModule } from "../modules/stylist";
import { SubscriptionsModule } from "../modules/subscriptions";
import { TaxEtaModule } from "../modules/tax-eta";
import { WaitingRoomModule } from "../modules/waiting-room";
import { MODULE_BINDINGS } from "./bindings";
import { createProductionFlags, type ProductionFlagPorts } from "./flags";
import {
  DatabaseReadiness,
  KyselyAuditSink,
  KyselyIdempotencyStore,
  readOutboxLag,
} from "./platform-adapters";
import { PRODUCTION_PORTS } from "./ports";
import { PROVIDERS, unconfigured, type ProviderName } from "./unconfigured";
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
}

/** Every authenticated route answers 401: there is no production token service yet (auth is blocked). */
class DenyAllAuthenticator implements Authenticator {
  async authenticate(): Promise<null> {
    return null;
  }
}

@Global()
@Module({})
class ProductionAuthBlockedModule {
  static forRoot(): DynamicModule {
    return { module: ProductionAuthBlockedModule, providers: [{ provide: AUTHENTICATOR, useValue: new DenyAllAuthenticator() }], exports: [AUTHENTICATOR] };
  }
}

/** Describes provider, module and dependency status for GET /v1/ready. Names and counters only. */
export class ProductionReport implements ReadinessReport {
  constructor(private readonly db: Db) {}

  async describe(): Promise<Record<string, unknown>> {
    const providers: Record<string, "configured" | "unconfigured"> = {};
    for (const name of Object.keys(PROVIDERS)) {
      // "configured" needs a real adapter bound in this composition. None exists yet, so every
      // provider is reported unconfigured, including ones no module binds (bnpl.quotes, push).
      providers[name] = REAL_ADAPTERS.has(name as ProviderName) ? "configured" : "unconfigured";
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
    const names = (Object.keys(PROVIDERS) as ProviderName[]).filter((n) => !REAL_ADAPTERS.has(n));
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
  const money = composeMoney({ config, pg });
  const ports = PRODUCTION_PORTS(config, pg, flags, money);
  const imports: DynamicModule[] = [
    ProductionAuthBlockedModule.forRoot(),
    StoresModule.forRoot(config, pg.stores),
    InventoryModule.forRoot(config, pg.inventory),
    ReferralsModule.forRoot(config, pg.referrals),
    CartModule.forRoot(config, ports.cart),
    OrdersModule.forRoot(config, ports.orders),
    ReturnsModule.forRoot(config, ports.returns),
    PromotionsModule.forRoot(config, ports.promotions),
    FulfillmentModule.forRoot(config, ports.fulfillment),
    SearchModule.forRoot(config, ports.search),
    TaxEtaModule.forRoot(config, ports.tax),
    SellerAnalyticsModule.forRoot(config, ports.sellerAnalytics),
    AdminModule.forRoot(config, ports.admin),
    ReviewsModule.forRoot(config, ports.reviews),
    LedgerModule.forRoot(config, money.ledger),
    PaymentsModule.forRoot(config, ports.payments),
    StoreCreditModule.forRoot(config, money.storeCredit),
    RefundsModule.forRoot(config, ports.refunds),
    CheckoutModule.forRoot(config, ports.checkout),
    PayoutsModule.forRoot(config, ports.payouts),
    ReconciliationModule.forRoot(config, ports.reconciliation),
    MoneyBridgeModule.forRoot(money.lates),
    LlmGatewayModule.forRoot(config, ports.llm),
    SubscriptionsModule.forRoot(config, ports.subscriptions),
    GiftCardsModule.forRoot(config, ports.giftCards),
    BudgetModule.forRoot(config, ports.budget),
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
      executor: new KyselyPurgeExecutor(pg.db, unconfigured<BlobDeletePort>("object.store")),
      runs: new KyselyPurgeRunStore(pg.db),
    }),
    CourierAramexModule.forRoot(config, ports.aramex),
    AdsModule.forRoot(config, ports.ads),
    ProductionRuntimeModule.forRoot({ db: pg.db, ownsPool: pg.ownsPool, paymentEvents: money.paymentEvents }),
  ];
  return {
    platform: {
      idempotencyStore: new KyselyIdempotencyStore(pg.db),
      // Per process until a shared limiter exists (Redis is Unconfigured). See ADR-0029.
      rateLimiter: new InMemoryRateLimiter(),
      auditSink: new KyselyAuditSink(pg.db),
      report: new ProductionReport(pg.db),
    },
    imports,
    pg,
    money,
    flags,
  };
}
