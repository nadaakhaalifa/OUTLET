import { Module, type DynamicModule } from "@nestjs/common";
import type { Csprng } from "@outlet/auth-core";
import { hmacSha256, toHex, utf8 } from "@outlet/auth-core";
import { CONSENT_PURPOSES, type ConsentPurpose } from "@outlet/privacy";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, CSPRNG, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeBlockers,
  FakeExporter,
  InMemoryBreachRepository,
  InMemoryConsentRepository,
  InMemoryObjectStore,
  InMemoryPrivacyOutbox,
  InMemoryPrivacyRequestRepository,
  RecordingErasureExecutor,
  createIpHasher,
} from "./adapters/in-memory";
import { PrivacyController } from "./adapters/privacy.controller";
import { DpoPrivacyController } from "./adapters/dpo.controller";
import { PrivacyDeletionController, PrivacyExportController } from "./adapters/requests.controller";
import { ExportResourceResolver } from "./adapters/resolvers";
import {
  BREACH_REGISTER,
  CANCEL_DELETION,
  EXPIRE_EXPORTS,
  EXPORT_RESOLVER,
  GET_CONSENTS,
  GET_DELETION,
  GET_EXPORT,
  LIST_DSAR_QUEUE,
  PRIVACY_BLOCKERS,
  PRIVACY_BREACH_REPOSITORY,
  PRIVACY_CONSENT_REPOSITORY,
  PRIVACY_ERASURE_EXECUTOR,
  PRIVACY_EXPORTER_REGISTRY,
  PRIVACY_OBJECT_STORE,
  PRIVACY_OUTBOX,
  PRIVACY_REQUEST_REPOSITORY,
  PROCESS_DELETIONS,
  PROCESS_EXPORT,
  REQUEST_DELETION,
  REQUEST_EXPORT,
  UPDATE_CONSENTS,
} from "./adapters/tokens";
import { GetConsents, UpdateConsents } from "./application/consents";
import { CancelDeletion, GetDeletion, ProcessDeletions, RequestDeletion } from "./application/deletion";
import { BreachRegister, ListDsarQueue } from "./application/dsar";
import { ExpireExports, GetExport, ProcessExport, RequestExport } from "./application/export";
import { ExporterRegistry } from "./application/exporters";
import { EXPORTER_MANIFEST } from "./application/exporter-manifest";
import type { InventoryTable } from "./domain/bridge";
import type {
  BlockersPort,
  BreachRepository,
  ConsentRepository,
  ErasureExecutorPort,
  ExporterPort,
  ObjectStorePort,
  PrivacyRequestRepository,
} from "./domain/ports";

/**
 * Overrides for composition. Everything defaults to a DEVELOPMENT FIXTURE (in-memory repositories,
 * fake blockers, fake exporters returning no rows, a recording erasure executor), so
 * `PrivacyModule.forRoot(config)` keeps working unchanged in AppModule.
 */
export interface PrivacyModuleOptions {
  readonly consentRepository?: ConsentRepository;
  readonly requestRepository?: PrivacyRequestRepository;
  readonly breachRepository?: BreachRepository;
  readonly blockers?: BlockersPort;
  readonly objectStore?: ObjectStorePort;
  readonly exporters?: readonly ExporterPort[];
  readonly erasureExecutor?: ErasureExecutorPort;
  /** Resolved data inventory, drives the erasure plan. Empty means the deletion worker refuses to run. */
  readonly inventory?: readonly InventoryTable[];
  readonly coolingDays?: number;
  /** Secret for stable pseudonyms in retained records. Must be held outside the retained dataset. */
  readonly pseudonymKey?: Uint8Array;
}

@Module({})
export class PrivacyModule {
  static forRoot(config: AppConfig, options: PrivacyModuleOptions = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    const versions = Object.fromEntries(
      CONSENT_PURPOSES.map((p) => [p, config.consentTextVersion]),
    ) as Record<ConsentPurpose, number>;
    return {
      module: PrivacyModule,
      controllers: [PrivacyController, PrivacyExportController, PrivacyDeletionController, DpoPrivacyController],
      providers: [
        { provide: PRIVACY_OUTBOX, useValue: new InMemoryPrivacyOutbox() },
        {
          provide: PRIVACY_CONSENT_REPOSITORY,
          inject: [PRIVACY_OUTBOX],
          useFactory: (o: InMemoryPrivacyOutbox) => options.consentRepository ?? new InMemoryConsentRepository(o),
        },
        {
          provide: PRIVACY_REQUEST_REPOSITORY,
          inject: [PRIVACY_OUTBOX],
          useFactory: (o: InMemoryPrivacyOutbox) => options.requestRepository ?? new InMemoryPrivacyRequestRepository(o),
        },
        {
          provide: PRIVACY_BREACH_REPOSITORY,
          inject: [PRIVACY_OUTBOX],
          useFactory: (o: InMemoryPrivacyOutbox) => options.breachRepository ?? new InMemoryBreachRepository(o),
        },
        { provide: PRIVACY_BLOCKERS, useValue: options.blockers ?? new FakeBlockers() },
        {
          provide: PRIVACY_OBJECT_STORE,
          inject: [CSPRNG],
          useFactory: (rng: Csprng) => options.objectStore ?? new InMemoryObjectStore(rng.randomBytes(32)),
        },
        {
          provide: PRIVACY_EXPORTER_REGISTRY,
          useValue: new ExporterRegistry(options.exporters ?? EXPORTER_MANIFEST.map((d) => new FakeExporter(d))),
        },
        { provide: PRIVACY_ERASURE_EXECUTOR, useValue: options.erasureExecutor ?? new RecordingErasureExecutor() },
        {
          provide: EXPORT_RESOLVER,
          inject: [PRIVACY_REQUEST_REPOSITORY],
          useFactory: (r: PrivacyRequestRepository) => new ExportResourceResolver(r),
        },
        {
          provide: GET_CONSENTS,
          inject: [PRIVACY_CONSENT_REPOSITORY],
          useFactory: (r: ConsentRepository) => new GetConsents(r, versions),
        },
        {
          provide: UPDATE_CONSENTS,
          inject: [PRIVACY_CONSENT_REPOSITORY, CLOCK, CSPRNG, ID_GENERATOR],
          useFactory: (r: ConsentRepository, clock: Clock, rng: Csprng, ids: IdGenerator) =>
            new UpdateConsents(
              r,
              versions,
              { now: () => new Date(clock.nowMs()) },
              createIpHasher(
                config.ipHashKey !== undefined ? new TextEncoder().encode(config.ipHashKey) : rng.randomBytes(32),
              ),
              ids,
            ),
        },
        {
          provide: REQUEST_EXPORT,
          inject: [PRIVACY_REQUEST_REPOSITORY, CLOCK, ID_GENERATOR],
          useFactory: (r: PrivacyRequestRepository, c: Clock, ids: IdGenerator) => new RequestExport(r, c, ids),
        },
        {
          provide: GET_EXPORT,
          inject: [PRIVACY_REQUEST_REPOSITORY, PRIVACY_OBJECT_STORE, CLOCK],
          useFactory: (r: PrivacyRequestRepository, s: ObjectStorePort, c: Clock) => new GetExport(r, s, c),
        },
        {
          provide: PROCESS_EXPORT,
          inject: [PRIVACY_REQUEST_REPOSITORY, PRIVACY_EXPORTER_REGISTRY, PRIVACY_OBJECT_STORE, CLOCK, ID_GENERATOR],
          useFactory: (r: PrivacyRequestRepository, reg: ExporterRegistry, s: ObjectStorePort, c: Clock, ids: IdGenerator) =>
            new ProcessExport(r, reg, s, c, ids),
        },
        {
          provide: EXPIRE_EXPORTS,
          inject: [PRIVACY_REQUEST_REPOSITORY, PRIVACY_OBJECT_STORE, CLOCK],
          useFactory: (r: PrivacyRequestRepository, s: ObjectStorePort, c: Clock) => new ExpireExports(r, s, c),
        },
        {
          provide: REQUEST_DELETION,
          inject: [PRIVACY_REQUEST_REPOSITORY, PRIVACY_BLOCKERS, CLOCK, ID_GENERATOR],
          useFactory: (r: PrivacyRequestRepository, b: BlockersPort, c: Clock, ids: IdGenerator) =>
            new RequestDeletion(r, b, c, ids, options.coolingDays),
        },
        {
          provide: CANCEL_DELETION,
          inject: [PRIVACY_REQUEST_REPOSITORY, CLOCK, ID_GENERATOR],
          useFactory: (r: PrivacyRequestRepository, c: Clock, ids: IdGenerator) => new CancelDeletion(r, c, ids),
        },
        {
          provide: GET_DELETION,
          inject: [PRIVACY_REQUEST_REPOSITORY],
          useFactory: (r: PrivacyRequestRepository) => new GetDeletion(r),
        },
        {
          provide: PROCESS_DELETIONS,
          inject: [PRIVACY_REQUEST_REPOSITORY, PRIVACY_BLOCKERS, PRIVACY_ERASURE_EXECUTOR, CLOCK, ID_GENERATOR, CSPRNG],
          useFactory: (
            r: PrivacyRequestRepository,
            b: BlockersPort,
            e: ErasureExecutorPort,
            c: Clock,
            ids: IdGenerator,
            rng: Csprng,
          ) => {
            const key = options.pseudonymKey ?? rng.randomBytes(32);
            return new ProcessDeletions(
              r,
              b,
              e,
              () => options.inventory ?? [],
              (input) => toHex(hmacSha256(key, utf8(`pseudonym:v1:${input}`))),
              c,
              ids,
            );
          },
        },
        {
          provide: LIST_DSAR_QUEUE,
          inject: [PRIVACY_REQUEST_REPOSITORY, CLOCK],
          useFactory: (r: PrivacyRequestRepository, c: Clock) => new ListDsarQueue(r, c),
        },
        {
          provide: BREACH_REGISTER,
          inject: [PRIVACY_BREACH_REPOSITORY, CLOCK, ID_GENERATOR],
          useFactory: (r: BreachRepository, c: Clock, ids: IdGenerator) => new BreachRegister(r, c, ids),
        },
      ],
    };
  }
}
