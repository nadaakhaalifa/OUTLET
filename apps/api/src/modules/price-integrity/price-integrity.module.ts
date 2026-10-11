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
  type PriceIntegrityDb,
  type SessionProvider,
} from "./adapters/kysely";
import { PriceTrustAccess, ProductPriceEvidenceController, SellerPriceTrustController } from "./adapters/price-integrity.controller";
import { PRICE_BLOCK_READER, PRICE_INTEGRITY_FIXTURES, PRICE_INTEGRITY_SERVICE } from "./adapters/tokens";
import { PriceIntegrityService } from "./application/service";

export interface PriceIntegrityPersistence {
  readonly runner: KyselyTransactionRunner<PriceIntegrityDb>;
  readonly session: SessionProvider;
}

/**
 * Exports PRICE_BLOCK_READER (the catalog's `PriceBlockReader` port) and PRICE_INTEGRITY_SERVICE.
 * Without `persistence` the in-memory fixtures back everything (dev and tests).
 * The SKU directory stays a fixture until the catalog exposes a product-to-SKU read.
 */
@Module({})
export class PriceIntegrityModule {
  static forRoot(
    config: AppConfig,
    fixtures: PriceIntegrityDevFixtures = createPriceIntegrityDevFixtures(),
    persistence?: PriceIntegrityPersistence,
  ): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    const events = persistence ? new KyselyPriceEventStore(persistence.runner, persistence.session) : fixtures.events;
    const claims = persistence ? new KyselyClaimStore(persistence.runner, persistence.session) : fixtures.claims;
    const enforcement = persistence ? new KyselyEnforcementStore(persistence.runner, persistence.session) : fixtures.enforcement;
    return {
      module: PriceIntegrityModule,
      controllers: [ProductPriceEvidenceController, SellerPriceTrustController],
      providers: [
        { provide: PRICE_INTEGRITY_FIXTURES, useValue: fixtures },
        {
          provide: PRICE_INTEGRITY_SERVICE,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator) =>
            new PriceIntegrityService({ events, external: fixtures.external, claims, enforcement, directory: fixtures.directory, clock, ids }),
        },
        { provide: PRICE_BLOCK_READER, inject: [PRICE_INTEGRITY_SERVICE], useFactory: (s: PriceIntegrityService) => s },
        PriceTrustAccess,
      ],
      exports: [PRICE_INTEGRITY_SERVICE, PRICE_BLOCK_READER, PRICE_INTEGRITY_FIXTURES],
    };
  }
}
