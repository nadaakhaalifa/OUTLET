import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { ConsumeSellerAnalytics } from "./application/consume";
import { ForgetShopper } from "./application/forget-shopper";
import { MaintainRollupPartitions } from "./application/maintain-partitions";
import { ReconcileRollups } from "./application/reconcile";
import { TelemetryRollupMetrics } from "./adapters/telemetry-metrics";
import type { ShopperFactsEraser, ShopperPseudonymDeriver } from "./domain/erasure-ports";
import type { RollupMaintenance } from "./domain/rollup-ports";
import { SellerAnalyticsQueries } from "./application/queries";
import { SellerAnalyticsController } from "./adapters/analytics.controller";
import { InMemorySellerRollupReader } from "./adapters/rollup-reader";
import { SellerSeriesController, type SellerSeriesOptions } from "./adapters/series.controller";
import { MetricSourceUnconfiguredError } from "../platform-metrics";
import type { SellerRollupReader } from "./domain/series-ports";
import type { InMemoryRollups } from "./adapters/in-memory-rollups";
import { InMemoryAnalyticsStore, InMemoryAudit, InMemoryEventSource, StaticProductStoreLookup } from "./adapters/in-memory";
import { SellerDashboardController, type SellerDashboardOptions } from "./adapters/dashboard.controller";
import { SellerDashboardSummary } from "./application/dashboard";
import { SellerMeController } from "./adapters/seller-me.controller";
import { AnalyticsStoreResolver, SellerMeResolver, SellerStoreMeResolver } from "./adapters/resolvers";
import { StaticStoreStatusLookup, UnconfiguredStoreStatusLookup } from "./adapters/store-status";
import * as T from "./adapters/tokens";
import type { AnalyticsStore, AuditPort, EventSourcePort, ProductStoreLookup } from "./domain/ports";
import type { StoreStatusLookup } from "./domain/store-status";

export interface SellerAnalyticsModuleOverrides {
  readonly store?: AnalyticsStore;
  readonly audit?: AuditPort;
  readonly source?: EventSourcePort;
  readonly productStore?: ProductStoreLookup;
  /** Store lifecycle status for `/seller/me`. Production without it fails closed (503). */
  readonly storeStatus?: StoreStatusLookup;
  /** Rollup repair and housekeeping (track 6). Defaults to the store itself when it implements `RollupMaintenance` (Kysely and in-memory do). */
  readonly rollups?: RollupMaintenance;
  /** `forgetShopper` persistence (track 6). Defaults to the store when it implements `ShopperFactsEraser`. */
  readonly eraser?: ShopperFactsEraser;
  /** Pseudonym derivation under every live KMS key version (track 6). No default: without it `forgetShopper` fails closed. */
  readonly pseudonyms?: ShopperPseudonymDeriver;
  /** Time-series read side (track 4). Production without a reader answers 503 metric_source_unconfigured, never zeros. */
  /** Dashboard summary flag (`release.seller_analytics.dashboard_summary`). Default blocked (404). */
  readonly dashboard?: Partial<SellerDashboardOptions>;
  readonly series?: Partial<SellerSeriesOptions> & { readonly reader?: SellerRollupReader };
}

/** Fail closed: a production composition that has not supplied the rollup reader. */
class UnconfiguredSeriesReader implements SellerRollupReader {
  freshness(): never {
    throw new MetricSourceUnconfiguredError("seller rollups");
  }
  read(): never {
    throw new MetricSourceUnconfiguredError("seller rollups");
  }
}

const isRollups = (x: unknown): x is RollupMaintenance =>
  typeof x === "object" && x !== null && typeof (x as { casRepair?: unknown }).casRepair === "function" && typeof (x as { maintainPartitions?: unknown }).maintainPartitions === "function";
const isEraser = (x: unknown): x is ShopperFactsEraser =>
  typeof x === "object" && x !== null && typeof (x as { nullShopperKeys?: unknown }).nullShopperKeys === "function";

/** Fail closed: used when a production composition supplies a store without the rollup or erasure surface. */
class UnconfiguredRollups implements RollupMaintenance {
  private fail(): never {
    throw new Error("seller analytics rollup maintenance is not configured");
  }
  snapshot(): never { return this.fail(); }
  casRepair(): never { return this.fail(); }
  repairNewKey(): never { return this.fail(); }
  record(): never { return this.fail(); }
  firstFactMs(): never { return this.fail(); }
  maintainPartitions(): never { return this.fail(); }
  defaultPartitionRows(): never { return this.fail(); }
}
class UnconfiguredEraser implements ShopperFactsEraser {
  recordErasedKeys(): never { throw new Error("seller analytics shopper erasure is not configured"); }
  nullShopperKeys(): never { throw new Error("seller analytics shopper erasure is not configured"); }
}
class UnconfiguredPseudonyms implements ShopperPseudonymDeriver {
  derive(): never { throw new Error("analytics pseudonym keys are not configured: forgetShopper refuses to report success"); }
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
    const rollups: RollupMaintenance = overrides.rollups ?? (isRollups(store) ? store : new UnconfiguredRollups());
    const eraser: ShopperFactsEraser = overrides.eraser ?? (isEraser(store) ? store : new UnconfiguredEraser());
    const rollupMetrics = new TelemetryRollupMetrics();
    const seriesReader: SellerRollupReader =
      overrides.series?.reader ??
      (production || !(store instanceof InMemoryAnalyticsStore) ? new UnconfiguredSeriesReader() : new InMemorySellerRollupReader(store.rollups as InMemoryRollups));
    const seriesOptions: SellerSeriesOptions = {
      seriesEnabled: overrides.series?.seriesEnabled ?? (() => false),
      shopperSeriesEnabled: overrides.series?.shopperSeriesEnabled ?? (() => false),
      countRead: overrides.series?.countRead ?? (() => undefined),
    };
    return {
      module: SellerAnalyticsModule,
      controllers: [SellerAnalyticsController, SellerSeriesController, SellerMeController, SellerDashboardController],
      providers: [
        { provide: T.SELLER_ANALYTICS_STORE, useValue: store },
        { provide: T.SELLER_ANALYTICS_AUDIT, useValue: overrides.audit ?? new InMemoryAudit() },
        { provide: T.SELLER_ANALYTICS_SOURCE, useValue: overrides.source ?? new InMemoryEventSource() },
        { provide: T.SELLER_ANALYTICS_PRODUCT_STORE, useValue: overrides.productStore ?? new StaticProductStoreLookup() },
        { provide: T.SELLER_ANALYTICS_STORE_RESOLVER, useValue: new AnalyticsStoreResolver("store_order") },
        { provide: T.SELLER_ME_RESOLVER, useValue: new SellerMeResolver() },
        { provide: T.SELLER_STORE_ME_RESOLVER, useValue: new SellerStoreMeResolver() },
        {
          provide: T.SELLER_ANALYTICS_STORE_STATUS,
          useValue: overrides.storeStatus ?? (production ? new UnconfiguredStoreStatusLookup() : new StaticStoreStatusLookup()),
        },
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
        { provide: T.SELLER_DASHBOARD_OPTIONS, useValue: { enabled: overrides.dashboard?.enabled ?? (() => false) } satisfies SellerDashboardOptions },
        {
          provide: T.SELLER_DASHBOARD_SUMMARY,
          inject: [T.SELLER_ANALYTICS_STORE, CLOCK],
          useFactory: (s: AnalyticsStore, clock: Clock) => new SellerDashboardSummary({ store: s, clock }),
        },
        { provide: T.SELLER_SERIES_READER, useValue: seriesReader },
        { provide: T.SELLER_SERIES_OPTIONS, useValue: seriesOptions },
        { provide: T.SELLER_ANALYTICS_ROLLUPS, useValue: rollups },
        { provide: T.SELLER_ANALYTICS_ERASER, useValue: eraser },
        { provide: T.SELLER_ANALYTICS_PSEUDONYMS, useValue: overrides.pseudonyms ?? new UnconfiguredPseudonyms() },
        {
          provide: T.SELLER_ANALYTICS_RECONCILER,
          inject: [T.SELLER_ANALYTICS_ROLLUPS, CLOCK, ID_GENERATOR],
          useFactory: (r: RollupMaintenance, clock: Clock, ids: IdGenerator) => new ReconcileRollups({ rollups: r, clock, ids, metrics: rollupMetrics }),
        },
        {
          provide: T.SELLER_ANALYTICS_PARTITIONS,
          inject: [T.SELLER_ANALYTICS_ROLLUPS, CLOCK],
          useFactory: (r: RollupMaintenance, clock: Clock) => new MaintainRollupPartitions(r, clock, rollupMetrics),
        },
        {
          provide: T.SELLER_ANALYTICS_FORGET_SHOPPER,
          inject: [T.SELLER_ANALYTICS_PSEUDONYMS, T.SELLER_ANALYTICS_ERASER, CLOCK],
          useFactory: (p: ShopperPseudonymDeriver, e: ShopperFactsEraser, clock: Clock) => new ForgetShopper(p, e, clock),
        },
      ],
      exports: [
        T.SELLER_ANALYTICS_CONSUMER,
        T.SELLER_ANALYTICS_STORE,
        T.SELLER_ANALYTICS_RECONCILER,
        T.SELLER_ANALYTICS_PARTITIONS,
        T.SELLER_ANALYTICS_FORGET_SHOPPER,
      ],
    };
  }
}
