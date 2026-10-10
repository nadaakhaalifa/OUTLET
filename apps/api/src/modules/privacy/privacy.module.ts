import { Module, type DynamicModule } from "@nestjs/common";
import { CONSENT_PURPOSES, type ConsentPurpose } from "@outlet/privacy";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock } from "../../platform/ports";
import { CLOCK, CSPRNG } from "../../platform/tokens";
import type { Csprng } from "@outlet/auth-core";
import { InMemoryConsentRepository, createIpHasher } from "./adapters/in-memory";
import { PrivacyController } from "./adapters/privacy.controller";
import { GET_CONSENTS, UPDATE_CONSENTS } from "./adapters/tokens";
import { GetConsents, UpdateConsents } from "./application/consents";

const REPO = Symbol("privacy.ConsentRepository");

@Module({})
export class PrivacyModule {
  static forRoot(config: AppConfig): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    const versions = Object.fromEntries(
      CONSENT_PURPOSES.map((p) => [p, config.consentTextVersion]),
    ) as Record<ConsentPurpose, number>;
    return {
      module: PrivacyModule,
      controllers: [PrivacyController],
      providers: [
        { provide: REPO, useValue: new InMemoryConsentRepository() },
        { provide: GET_CONSENTS, inject: [REPO], useFactory: (r: InMemoryConsentRepository) => new GetConsents(r, versions) },
        {
          provide: UPDATE_CONSENTS,
          inject: [REPO, CLOCK, CSPRNG],
          useFactory: (r: InMemoryConsentRepository, clock: Clock, rng: Csprng) =>
            new UpdateConsents(
              r,
              versions,
              { now: () => new Date(clock.nowMs()) },
              createIpHasher(
                config.ipHashKey !== undefined ? new TextEncoder().encode(config.ipHashKey) : rng.randomBytes(32),
              ),
            ),
        },
      ],
    };
  }
}
