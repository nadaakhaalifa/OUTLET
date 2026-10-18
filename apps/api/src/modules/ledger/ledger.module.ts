import { Logger, Module, type DynamicModule } from "@nestjs/common";
import { sha256Hex } from "@outlet/idempotency";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { instruments, registerIntegrityGauges } from "../../platform/telemetry/metrics";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { InMemoryLedger, InMemoryProjection } from "./adapters/in-memory";
import { InMemoryIntegrityRuns } from "./adapters/in-memory-integrity";
import { LedgerController } from "./adapters/ledger.controller";
import {
  GET_ENTRY,
  INTEGRITY_GAUGES,
  INTEGRITY_JOB,
  INTEGRITY_MODE,
  INTEGRITY_RECORDER,
  INTEGRITY_ROUTES_ENABLED,
  INTEGRITY_RUN_READER,
  INTEGRITY_RUN_STORE,
  LEDGER_FLAGS,
  LEDGER_PROJECTION,
  LEDGER_READ_MODEL,
  LEDGER_SNAPSHOTS,
  LEDGER_STORE,
  LIST_BALANCES,
  POSTING_SERVICE,
} from "./adapters/tokens";
import { cachedGaugeReader } from "./application/integrity-gauge";
import { IntegrityJob } from "./application/integrity-job";
import { RecordIntegrityRun } from "./application/integrity-recorder";
import type { IntegrityMode } from "./domain/integrity-runs";
import { PostingService } from "./application/posting-service";
import { GetEntry, ListBalances } from "./application/queries";
import type {
  IntegrityReadScope,
  IntegrityRunReader,
  IntegrityRunStore,
  IntegritySnapshots,
  LedgerReadModel,
  LedgerStore,
  LedgerTxn,
  PostingFlags,
  ProjectionSource,
} from "./domain/ports";

export interface LedgerModuleOverrides {
  readonly store?: LedgerStore<LedgerTxn>;
  readonly reads?: LedgerReadModel;
  readonly snapshots?: IntegritySnapshots;
  readonly projection?: ProjectionSource;
  readonly flags?: PostingFlags;
  /**
   * Persisted integrity result (ADR-0046). Both travel together. Without them production fails closed
   * (the recorder and the routes cannot reach a table), in-memory-dev uses an in-memory pair.
   */
  readonly integrity?: { readonly store: IntegrityRunStore; readonly reader: IntegrityRunReader };
  /** `release.admin.ledger_integrity`. Default false (blocked): both routes answer 404. */
  readonly integrityRoutesEnabled?: () => Promise<boolean> | boolean;
  /** Event mode (30-minute cadence, 90-minute staleness) or batch (nightly, 26 h). Default reads WORKER_EVENT_MODE. */
  readonly integrityMode?: () => IntegrityMode;
}

/** Production without a configured result store: every call fails closed (ADR-0029). */
class UnconfiguredIntegrityRuns implements IntegrityRunStore, IntegrityRunReader {
  private fail(): never {
    throw new NoProductionAdaptersError();
  }
  recordStarted(): Promise<void> {
    return this.fail();
  }
  completeRun(): Promise<void> {
    return this.fail();
  }
  recordFailure(): Promise<void> {
    return this.fail();
  }
  snapshot(_scope: IntegrityReadScope): Promise<never> {
    return this.fail();
  }
  listCompleted(_scope: IntegrityReadScope): Promise<never> {
    return this.fail();
  }
}

/**
 * Production wiring needs the Kysely store, read model and snapshots, so all three travel together:
 * a half-wired ledger (writes in Postgres, reads in memory) would show finance the wrong numbers.
 */
@Module({})
export class LedgerModule {
  static forRoot(config: AppConfig, overrides: LedgerModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (overrides.store === undefined || overrides.reads === undefined || overrides.snapshots === undefined)) {
      throw new NoProductionAdaptersError();
    }
    const fallback = new InMemoryLedger();
    const store = overrides.store ?? (fallback as unknown as LedgerStore<LedgerTxn>);
    const reads = overrides.reads ?? fallback;
    const snapshots = overrides.snapshots ?? fallback;
    const projection = overrides.projection ?? new InMemoryProjection();
    const flags: PostingFlags = overrides.flags ?? { giftCardSalesEnabled: () => false };
    const unconfigured = new UnconfiguredIntegrityRuns();
    const runStore: IntegrityRunStore | undefined = overrides.integrity?.store;
    const runReader: IntegrityRunReader | undefined = overrides.integrity?.reader;
    const memoryRuns = production ? undefined : { holder: null as InMemoryIntegrityRuns | null };
    const logger = new Logger("LedgerIntegrity");
    return {
      module: LedgerModule,
      controllers: [LedgerController],
      providers: [
        { provide: LEDGER_STORE, useValue: store },
        { provide: LEDGER_READ_MODEL, useValue: reads },
        { provide: LEDGER_SNAPSHOTS, useValue: snapshots },
        { provide: LEDGER_PROJECTION, useValue: projection },
        { provide: LEDGER_FLAGS, useValue: flags },
        {
          provide: POSTING_SERVICE,
          inject: [LEDGER_STORE, CLOCK, ID_GENERATOR, LEDGER_FLAGS],
          useFactory: (s: LedgerStore<LedgerTxn>, clock: Clock, ids: IdGenerator, f: PostingFlags) =>
            new PostingService<LedgerTxn>({ store: s, clock, ids, sha256: sha256Hex, flags: f }),
        },
        {
          provide: INTEGRITY_JOB,
          inject: [LEDGER_SNAPSHOTS, LEDGER_PROJECTION],
          useFactory: (snap: IntegritySnapshots, proj: ProjectionSource) =>
            new IntegrityJob({ snapshots: snap, projection: proj, sha256: sha256Hex }),
        },
        {
          provide: INTEGRITY_RUN_STORE,
          inject: [CLOCK],
          useFactory: (clock: Clock): IntegrityRunStore => {
            if (runStore !== undefined) return runStore;
            if (memoryRuns === undefined) return unconfigured;
            memoryRuns.holder ??= new InMemoryIntegrityRuns(clock);
            return memoryRuns.holder;
          },
        },
        {
          provide: INTEGRITY_RUN_READER,
          inject: [CLOCK],
          useFactory: (clock: Clock): IntegrityRunReader => {
            if (runReader !== undefined) return runReader;
            if (memoryRuns === undefined) return unconfigured;
            memoryRuns.holder ??= new InMemoryIntegrityRuns(clock);
            return memoryRuns.holder;
          },
        },
        { provide: INTEGRITY_ROUTES_ENABLED, useValue: overrides.integrityRoutesEnabled ?? (() => false) },
        {
          provide: INTEGRITY_MODE,
          useValue: overrides.integrityMode ?? ((): IntegrityMode => (process.env["WORKER_EVENT_MODE"] === "true" ? "event" : "batch")),
        },
        {
          provide: INTEGRITY_RECORDER,
          inject: [INTEGRITY_JOB, INTEGRITY_RUN_STORE, CLOCK, ID_GENERATOR],
          useFactory: (job: IntegrityJob, store: IntegrityRunStore, clock: Clock, ids: IdGenerator) =>
            new RecordIntegrityRun({
              job,
              store,
              clock,
              ids,
              sha256: sha256Hex,
              metrics: {
                run: (outcome) => instruments().counter("outlet.ledger.integrity.runs").add(1, { outcome }),
                auditFailed: () => instruments().counter("outlet.ledger.integrity.audit_failed").add(1),
              },
              log: (event, fields) => logger.error(`${event} attempt=${fields.attemptId}`),
            }),
        },
        {
          provide: INTEGRITY_GAUGES,
          inject: [INTEGRITY_RUN_READER, CLOCK, INTEGRITY_MODE],
          useFactory: (reader: IntegrityRunReader, clock: Clock, mode: () => IntegrityMode) => {
            const read = cachedGaugeReader(reader, clock);
            registerIntegrityGauges(async () => ({ ...(await read()), mode: mode() }));
            return true;
          },
        },
        { provide: LIST_BALANCES, inject: [LEDGER_READ_MODEL], useFactory: (r: LedgerReadModel) => new ListBalances(r) },
        { provide: GET_ENTRY, inject: [LEDGER_READ_MODEL], useFactory: (r: LedgerReadModel) => new GetEntry(r) },
      ],
      exports: [POSTING_SERVICE, INTEGRITY_JOB, INTEGRITY_RECORDER, LEDGER_READ_MODEL, LEDGER_STORE],
    };
  }
}

export type { PostingService };
