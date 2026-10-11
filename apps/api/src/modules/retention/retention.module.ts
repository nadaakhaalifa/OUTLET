import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { InMemoryPurgeExecutor, InMemoryRunStore, LogRetentionMetrics, RecordingMetrics } from "./adapters/in-memory";
import * as T from "./adapters/tokens";
import { PurgeRetentionJob, RunRetention } from "./application/purge";
import type { PurgeExecutor, PurgeRunStore, RetentionMetrics } from "./domain/ports";

export interface RetentionModuleOptions {
  readonly executor?: PurgeExecutor;
  readonly runs?: PurgeRunStore;
  readonly metrics?: RetentionMetrics;
}

@Module({})
export class RetentionModule {
  static forRoot(config: AppConfig, o: RetentionModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (o.executor === undefined || o.runs === undefined)) throw new NoProductionAdaptersError();
    const executor = o.executor ?? new InMemoryPurgeExecutor();
    const runs = o.runs ?? new InMemoryRunStore();
    const metrics = o.metrics ?? (production ? new LogRetentionMetrics() : new RecordingMetrics());
    return {
      module: RetentionModule,
      providers: [
        { provide: T.RETENTION_EXECUTOR, useValue: executor },
        { provide: T.RETENTION_RUNS, useValue: runs },
        { provide: T.RETENTION_METRICS, useValue: metrics },
        {
          provide: T.RETENTION_RUNNER,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator) => new RunRetention({ executor, runs, metrics, clock, ids }),
        },
        { provide: T.RETENTION_PURGE, inject: [T.RETENTION_RUNNER], useFactory: (r: RunRetention) => new PurgeRetentionJob(r) },
      ],
      exports: [T.RETENTION_PURGE, T.RETENTION_RUNNER],
    };
  }
}
