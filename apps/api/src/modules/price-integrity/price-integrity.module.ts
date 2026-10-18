import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import type { KyselyTransactionRunner } from "../../platform/db";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { createPriceIntegrityDevFixtures, type PriceIntegrityDevFixtures } from "./adapters/in-memory";
import {
  KyselyClaimStore,
  KyselyEnforcementStore,
  KyselyPriceEventStore,
  KyselySkuDirectory,
  ShadowExternalEvidence,
  type PriceIntegrityDb,
  type SessionProvider,
} from "./adapters/kysely";
import { PriceTrustAccess, ProductPriceEvidenceController, SellerPriceTrustController } from "./adapters/price-integrity.controller";
import { PRICE_BLOCK_READER, PRICE_INTEGRITY_FIXTURES, PRICE_INTEGRITY_SERVICE } from "./adapters/tokens";
import { PriceIntegrityService } from "./application/service";
import type { ExternalEvidencePort, SkuDirectory } from "./domain/ports";

export interface PriceIntegrityPersistence {
  readonly runner: KyselyTransactionRunner<PriceIntegrityDb>;
  readonly session: SessionProvider;
  /** Defaults to the read-only Kysely directory over products and skus. */
  readonly directory?: SkuDirectory;
  /** Defaults to shadow-only evidence (none), so claims rest on the internal ledger. */
  readonly external?: ExternalEvidencePort;
}

/**
 * Exports PRICE_BLOCK_READER (the catalog's `PriceBlockReader` port) and PRICE_INTEGRITY_SERVICE.
 * Without `persistence` the in-memory fixtures back everything (dev and tests).
 * With `persistence` (production) the SKU directory is a read-only query over products and skus and
 * the external evidence port is shadow-only (none).
 */
@Module({})
export class PriceIntegrityModule {
  static forRoot(
    config: AppConfig,
    fixtures: PriceIntegrityDevFixtures = createPriceIntegrityDevFixtures(),
    persistence?: PriceIntegrityPersistence,
  ): DynamicModule {
    // Persistence is read FIRST: with it, every store is a Kysely adapter and nothing is a fixture.
    if (config.adapters !== "in-memory-dev" && persistence === undefined) throw new NoProductionAdaptersError();
    const events = persistence ? new KyselyPriceEventStore(persistence.runner, persistence.session) : fixtures.events;
    const claims = persistence ? new KyselyClaimStore(persistence.runner, persistence.session) : fixtures.claims;
    const enforcement = persistence ? new KyselyEnforcementStore(persistence.runner, persistence.session) : fixtures.enforcement;
    const production = config.adapters !== "in-memory-dev";
    // Dev with persistence keeps the fixture directory and evidence (tests seed them); production never does.
    const directory: SkuDirectory = persistence
      ? persistence.directory ?? (production ? new KyselySkuDirectory(persistence.runner, persistence.session) : fixtures.directory)
      : fixtures.directory;
    const external: ExternalEvidencePort = persistence
      ? persistence.external ?? (production ? new ShadowExternalEvidence() : fixtures.external)
      : fixtures.external;
    return {
      module: PriceIntegrityModule,
      controllers: [ProductPriceEvidenceController, SellerPriceTrustController],
      providers: [
        { provide: PRICE_INTEGRITY_FIXTURES, useValue: fixtures },
        {
          provide: PRICE_INTEGRITY_SERVICE,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator) =>
            new PriceIntegrityService({ events, external, claims, enforcement, directory, clock, ids }),
        },
        { provide: PRICE_BLOCK_READER, inject: [PRICE_INTEGRITY_SERVICE], useFactory: (s: PriceIntegrityService) => s },
        PriceTrustAccess,
      ],
      exports: [PRICE_INTEGRITY_SERVICE, PRICE_BLOCK_READER, PRICE_INTEGRITY_FIXTURES],
    };
  }
}
