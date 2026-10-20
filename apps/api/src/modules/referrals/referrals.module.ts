import { Module, type DynamicModule } from "@nestjs/common";
import type { Csprng } from "@outlet/auth-core";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, CSPRNG, ID_GENERATOR } from "../../platform/tokens";
import { InMemoryAppAttest, InMemoryReferralIdentity, InMemoryReferralStore } from "./adapters/in-memory";
import { ReferralsController } from "./adapters/referrals.controller";
import {
  ATTRIBUTE_REFERRAL,
  GET_MY_REFERRAL,
  HANDLE_ORDER_CLOSED,
  QUOTE_REFEREE_OFFER,
  REFERRAL_APP_ATTEST,
  REFERRAL_IDENTITY,
  REFERRAL_OPTIONS,
  REFERRAL_STORE,
} from "./adapters/tokens";
import type { AppAttestPort, ReferralIdentityPort, ReferralStore } from "./domain/ports";
import { AttributeReferral, GetMyReferral, HandleOrderClosed, QuoteRefereeOffer, type ReferralRuntimeOptions } from "./application/referrals";
import { DEFAULT_REFERRAL_CONFIG, validateReferralConfig, type ReferralConfig } from "./domain/rules";

export interface ReferralsModuleOptions {
  readonly config?: ReferralConfig;
  /** Default true: attribution needs a verified App Attest assertion. */
  readonly requireAttest?: boolean;
  readonly deepLinkBase?: string;
  /** Replaces the in-memory store (KyselyReferralStore) once persistence is wired. */
  readonly store?: ReferralStore;
  readonly identity?: ReferralIdentityPort;
  readonly attest?: AppAttestPort;
}

const DEFAULT_LINK_BASE = "https://outletnk.invalid/r";

@Module({})
export class ReferralsModule {
  static forRoot(config: AppConfig, options: ReferralsModuleOptions = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev" && options.store === undefined) throw new NoProductionAdaptersError();
    const runtime: ReferralRuntimeOptions = {
      config: validateReferralConfig(options.config ?? DEFAULT_REFERRAL_CONFIG),
      requireAttest: options.requireAttest ?? true,
      deepLinkBase: options.deepLinkBase ?? DEFAULT_LINK_BASE,
    };
    return {
      module: ReferralsModule,
      controllers: [ReferralsController],
      providers: [
        { provide: REFERRAL_OPTIONS, useValue: runtime },
        { provide: REFERRAL_STORE, useValue: options.store ?? new InMemoryReferralStore() },
        { provide: REFERRAL_IDENTITY, useValue: options.identity ?? new InMemoryReferralIdentity() },
        { provide: REFERRAL_APP_ATTEST, useValue: options.attest ?? new InMemoryAppAttest() },
        {
          provide: GET_MY_REFERRAL,
          inject: [REFERRAL_STORE, CLOCK, ID_GENERATOR, CSPRNG],
          useFactory: (s: ReferralStore, c: Clock, ids: IdGenerator, rng: Csprng) =>
            new GetMyReferral(s, c, ids, rng, runtime),
        },
        {
          provide: ATTRIBUTE_REFERRAL,
          inject: [REFERRAL_STORE, REFERRAL_IDENTITY, REFERRAL_APP_ATTEST, CLOCK, ID_GENERATOR],
          useFactory: (s: ReferralStore, i: ReferralIdentityPort, a: AppAttestPort, c: Clock, ids: IdGenerator) =>
            new AttributeReferral(s, i, a, c, ids, runtime),
        },
        {
          provide: QUOTE_REFEREE_OFFER,
          inject: [REFERRAL_STORE, REFERRAL_IDENTITY],
          useFactory: (s: ReferralStore, i: ReferralIdentityPort) => new QuoteRefereeOffer(s, i, runtime),
        },
        {
          provide: HANDLE_ORDER_CLOSED,
          inject: [REFERRAL_STORE, REFERRAL_IDENTITY, CLOCK],
          useFactory: (s: ReferralStore, i: ReferralIdentityPort, c: Clock) =>
            new HandleOrderClosed(s, i, c, runtime),
        },
      ],
    };
  }
}
