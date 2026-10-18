import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { SellerForecastController } from "./adapters/forecast.controller";
import { InMemoryForecastStore, StaticForecastFlags } from "./adapters/in-memory";
import { ForecastStoreResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import { IngestDemandSeries, RunForecastBatch, SellerForecastQueries } from "./application/forecasting";
import type { ForecastFlags, ForecastStore } from "./domain/ports";

export interface ForecastingModuleOptions {
  readonly store?: ForecastStore;
  /** Backed by `kill.demand_forecasting`. Fails closed outside test mode when absent. */
  readonly flags?: ForecastFlags;
}

export class MissingForecastingPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`ForecastingModule requires real ${missing.join(", ")} outside test mode: supply them through forRoot(config, options)`);
    this.name = "MissingForecastingPortsError";
  }
}

@Module({})
export class ForecastingModule {
  static forRoot(config: AppConfig, o: ForecastingModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      if (o.flags === undefined) throw new MissingForecastingPortsError(["flags (kill.demand_forecasting)"]);
    }
    const store = o.store ?? new InMemoryForecastStore();
    const flags = o.flags ?? new StaticForecastFlags(true);
    return {
      module: ForecastingModule,
      controllers: [SellerForecastController],
      providers: [
        { provide: T.FORECAST_STORE, useValue: store },
        { provide: T.FORECAST_FLAGS, useValue: flags },
        { provide: T.FORECAST_STORE_RESOLVER, useValue: new ForecastStoreResolver() },
        {
          provide: T.FORECAST_INGEST,
          inject: [CLOCK],
          useFactory: (clock: Clock) => new IngestDemandSeries(store, clock),
        },
        {
          provide: T.FORECAST_BATCH,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator) => new RunForecastBatch(store, flags, clock, ids),
        },
        {
          provide: T.FORECAST_QUERIES,
          inject: [CLOCK],
          useFactory: (clock: Clock) => new SellerForecastQueries(store, flags, clock),
        },
      ],
      exports: [T.FORECAST_STORE, T.FORECAST_INGEST, T.FORECAST_BATCH, T.FORECAST_QUERIES],
    };
  }
}
