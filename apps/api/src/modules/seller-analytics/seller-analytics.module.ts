import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { ConsumeSellerAnalytics } from "./application/consume";
import { SellerAnalyticsQueries } from "./application/queries";
import { SellerAnalyticsController } from "./adapters/analytics.controller";
import { InMemoryAnalyticsStore, InMemoryAudit, InMemoryEventSource, StaticProductStoreLookup } from "./adapters/in-memory";
import { AnalyticsStoreResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import type { AnalyticsStore, AuditPort, EventSourcePort, ProductStoreLookup } from "./domain/ports";

export interface SellerAnalyticsModuleOverrides {
  readonly store?: AnalyticsStore;
  readonly audit?: AuditPort;
  readonly source?: EventSourcePort;
  readonly productStore?: ProductStoreLookup;
}

/**
 * Thrown at boot outside test mode when a port is missing. An in-memory audit port would let CSV
 * exports leave without a durable audit record, so it is never defaulted in production.
 */
export class MissingSellerAnalyticsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`SellerAnalyticsModule requires real ${missing.join(", ")} outside test mode: supply them through forRoot(config, overrides)`);
    this.name = "MissingSellerAnalyticsPortsError";
  }
}

@Module({})
export class SellerAnalyticsModule {
  static forRoot(config: AppConfig, overrides: SellerAnalyticsModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (overrides.audit === undefined) missing.push("audit (SELLER_ANALYTICS_AUDIT: hash-chained audit_log)");
      if (overrides.source === undefined) missing.push("source (SELLER_ANALYTICS_SOURCE: event relay)");
      if (overrides.productStore === undefined) missing.push("productStore (SELLER_ANALYTICS_PRODUCT_STORE)");
      if (missing.length > 0) throw new MissingSellerAnalyticsPortsError(missing);
    }
    const store = overrides.store ?? new InMemoryAnalyticsStore();
    return {
      module: SellerAnalyticsModule,
      controllers: [SellerAnalyticsController],
      providers: [
        { provide: T.SELLER_ANALYTICS_STORE, useValue: store },
        { provide: T.SELLER_ANALYTICS_AUDIT, useValue: overrides.audit ?? new InMemoryAudit() },
        { provide: T.SELLER_ANALYTICS_SOURCE, useValue: overrides.source ?? new InMemoryEventSource() },
        { provide: T.SELLER_ANALYTICS_PRODUCT_STORE, useValue: overrides.productStore ?? new StaticProductStoreLookup() },
        { provide: T.SELLER_ANALYTICS_STORE_RESOLVER, useValue: new AnalyticsStoreResolver("store_order") },
        { provide: T.SELLER_ANALYTICS_SETTINGS_RESOLVER, useValue: new AnalyticsStoreResolver("store_settings") },
        {
          provide: T.SELLER_ANALYTICS_QUERIES,
          inject: [T.SELLER_ANALYTICS_STORE, T.SELLER_ANALYTICS_AUDIT, CLOCK, ID_GENERATOR],
          useFactory: (s: AnalyticsStore, a: AuditPort, clock: Clock, ids: IdGenerator) =>
            new SellerAnalyticsQueries({ store: s, audit: a, clock, mintWatermark: () => `wm-${ids.hex(12)}` }),
        },
        {
          provide: T.SELLER_ANALYTICS_CONSUMER,
          inject: [T.SELLER_ANALYTICS_SOURCE, T.SELLER_ANALYTICS_STORE, T.SELLER_ANALYTICS_PRODUCT_STORE, CLOCK],
          useFactory: (src: EventSourcePort, s: AnalyticsStore, l: ProductStoreLookup, clock: Clock) =>
            new ConsumeSellerAnalytics(src, s, l, clock),
        },
      ],
      exports: [T.SELLER_ANALYTICS_CONSUMER, T.SELLER_ANALYTICS_STORE],
    };
  }
}
