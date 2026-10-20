import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { ReconAccess } from "./adapters/access";
import { FakeEtaSource, FakeIntegrity, FakeLedgerClearing, FakeReconAlerts, FakeReconFlags, FixtureSettlementFilePort } from "./adapters/fakes";
import { InMemoryReconStore } from "./adapters/in-memory";
import { ReconciliationController } from "./adapters/recon.controller";
import {
  FINANCE_RECON_READ,
  INGEST_SETTLEMENT_FILE,
  RECON_ALERTS,
  RECON_CLEARING,
  RECON_ETA,
  RECON_FILE_PARSER,
  RECON_FINANCE_VIEWS_ENABLED,
  RECON_FLAGS,
  RECON_INTEGRITY,
  RECON_NOW,
  RECON_RAIL_INPUTS,
  RECON_STORE,
  RUN_RECONCILIATION,
  SCHEDULE_RECONCILIATION,
} from "./adapters/tokens";
import { IngestSettlementFile } from "./application/ingest";
import { FinanceReconReadModel, type RailInputs } from "./application/queries";
import { RunReconciliation, ScheduleReconciliation, type ReconDeps } from "./application/run";
import type {
  EtaSourcePort,
  IntegrityPort,
  LedgerClearingPort,
  ReconAlertPort,
  ReconFlagsPort,
  ReconStore,
  SettlementFilePort,
} from "./domain/ports";

export interface ReconciliationModuleOverrides {
  readonly store?: ReconStore;
  readonly parser?: SettlementFilePort;
  readonly clearing?: LedgerClearingPort;
  readonly eta?: EtaSourcePort;
  readonly integrity?: IntegrityPort;
  readonly alerts?: ReconAlertPort;
  readonly flags?: ReconFlagsPort;
  /** Provider readiness per rail, from the same registry as /v1/ready. Absent means every rail reports "unconfigured". */
  readonly railInputs?: RailInputs;
  /** release.admin.finance_views. Absent means BLOCKED: the B-2 fields are omitted from the summary. */
  readonly financeViewsEnabled?: () => Promise<boolean> | boolean;
}

/** Thrown at boot when a non-test environment has no real source for a reconciliation suite. */
export class MissingReconciliationPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `ReconciliationModule requires real ${missing.join(", ")} outside test mode: ` +
        "supply them through ReconciliationModule.forRoot(config, overrides)",
    );
    this.name = "MissingReconciliationPortsError";
  }
}

@Module({})
export class ReconciliationModule {
  static forRoot(config: AppConfig, overrides: ReconciliationModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing = (
        [
          ["clearing (RECON_CLEARING: ledger clearing movements)", overrides.clearing],
          ["eta (RECON_ETA: tax module submissions)", overrides.eta],
          ["integrity (RECON_INTEGRITY: ledger integrity source)", overrides.integrity],
          ["alerts (RECON_ALERTS: finance alert channel)", overrides.alerts],
          ["flags (RECON_FLAGS: mega-event mode)", overrides.flags],
        ] as const
      )
        .filter(([, v]) => v === undefined)
        .map(([n]) => n);
      if (missing.length > 0) throw new MissingReconciliationPortsError(missing);
    }
    const deps = (
      store: ReconStore,
      clearing: LedgerClearingPort,
      eta: EtaSourcePort,
      integrity: IntegrityPort,
      alerts: ReconAlertPort,
      flags: ReconFlagsPort,
      clock: Clock,
      ids: IdGenerator,
    ): ReconDeps => ({ store, clearing, eta, integrity, alerts, flags, clock, ids });
    const injectDeps = [RECON_STORE, RECON_CLEARING, RECON_ETA, RECON_INTEGRITY, RECON_ALERTS, RECON_FLAGS, CLOCK, ID_GENERATOR];
    return {
      module: ReconciliationModule,
      controllers: [ReconciliationController],
      providers: [
        ReconAccess,
        {
          provide: RECON_STORE,
          useFactory: (): ReconStore => overrides.store ?? new InMemoryReconStore(),
        },
        { provide: RECON_FILE_PARSER, useValue: overrides.parser ?? new FixtureSettlementFilePort() },
        { provide: RECON_CLEARING, useValue: overrides.clearing ?? new FakeLedgerClearing() },
        { provide: RECON_ETA, useValue: overrides.eta ?? new FakeEtaSource() },
        { provide: RECON_INTEGRITY, useValue: overrides.integrity ?? new FakeIntegrity() },
        { provide: RECON_ALERTS, useValue: overrides.alerts ?? new FakeReconAlerts() },
        { provide: RECON_FLAGS, useValue: overrides.flags ?? new FakeReconFlags() },
        { provide: RECON_NOW, inject: [CLOCK], useFactory: (c: Clock) => () => c.nowMs() },
        {
          provide: INGEST_SETTLEMENT_FILE,
          inject: [RECON_STORE, RECON_FILE_PARSER, CLOCK, ID_GENERATOR],
          useFactory: (s: ReconStore, p: SettlementFilePort, c: Clock, i: IdGenerator) => new IngestSettlementFile(s, p, c, i),
        },
        {
          provide: RUN_RECONCILIATION,
          inject: injectDeps,
          useFactory: (...a: Parameters<typeof deps>) => new RunReconciliation(deps(...a)),
        },
        {
          provide: SCHEDULE_RECONCILIATION,
          inject: injectDeps,
          useFactory: (...a: Parameters<typeof deps>) => {
            const d = deps(...a);
            return new ScheduleReconciliation(d, new RunReconciliation(d));
          },
        },
        { provide: RECON_RAIL_INPUTS, useValue: overrides.railInputs ?? (() => ({})) },
        { provide: RECON_FINANCE_VIEWS_ENABLED, useValue: overrides.financeViewsEnabled ?? (() => false) },
        {
          provide: FINANCE_RECON_READ,
          inject: [RECON_STORE, RECON_NOW, RECON_RAIL_INPUTS],
          useFactory: (s: ReconStore, now: () => number, rails: RailInputs) => new FinanceReconReadModel(s, now, rails),
        },
      ],
      exports: [RECON_STORE, INGEST_SETTLEMENT_FILE, RUN_RECONCILIATION, SCHEDULE_RECONCILIATION, FINANCE_RECON_READ],
    };
  }
}
