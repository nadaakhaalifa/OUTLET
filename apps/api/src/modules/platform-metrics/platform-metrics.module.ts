import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import { InMemoryPlatformRollups } from "./adapters/in-memory";
import { PlatformMetricsController, type ElevationReader, type PlatformMetricsOptions } from "./adapters/metrics.controller";
import { PLATFORM_METRICS_OPTIONS, PLATFORM_ROLLUP_READER } from "./adapters/tokens";
import type { PlatformRollupReader } from "./domain/ports";

export interface PlatformMetricsOverrides {
  /** KyselyPlatformRollups in production. Without it production fails closed at boot. */
  readonly reader?: PlatformRollupReader;
  /** The admin store (live elevations). Without it production fails closed at boot. */
  readonly elevations?: ElevationReader;
  /** `release.admin.metrics`. Default false (blocked): the route answers 404. */
  readonly enabled?: () => Promise<boolean> | boolean;
  readonly countRead?: (metricId: string) => void;
}

/**
 * Platform metrics (dashboard foundations track 4): `GET /v1/admin/metrics/{metricId}` over the hourly platform
 * rollups. Behind `release.admin.metrics` (blocked by default). The rollup consumer itself lives in seller-analytics.
 */
@Module({})
export class PlatformMetricsModule {
  static forRoot(config: AppConfig, overrides: PlatformMetricsOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (overrides.reader === undefined || overrides.elevations === undefined)) throw new NoProductionAdaptersError();
    const options: PlatformMetricsOptions = {
      enabled: overrides.enabled ?? (() => false),
      elevations: overrides.elevations ?? { liveElevations: async () => [] },
      countRead: overrides.countRead ?? (() => undefined),
    };
    return {
      module: PlatformMetricsModule,
      controllers: [PlatformMetricsController],
      providers: [
        { provide: PLATFORM_ROLLUP_READER, useValue: overrides.reader ?? new InMemoryPlatformRollups() },
        { provide: PLATFORM_METRICS_OPTIONS, useValue: options },
      ],
      exports: [PLATFORM_ROLLUP_READER],
    };
  }
}
