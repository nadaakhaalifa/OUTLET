import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { BrandDomainVerificationController, BrandVerificationAdminController } from "./adapters/controller";
import {
  FakeApplicationOwnership,
  FakeDnsResolver,
  FakeSanctionsScreening,
  FakeVerificationEmail,
  FixtureTrademarkRegistry,
  InMemoryBrandVerificationStore,
  StaticVerificationSecret,
} from "./adapters/in-memory";
import { BrandVerificationAdminResolver } from "./adapters/resolvers";
import { APPLICATION_OWNERSHIP, BRAND_VERIFICATION, BRAND_VERIFICATION_ADMIN_RESOLVER, BRAND_VERIFICATION_STORE } from "./adapters/tokens";
import { BrandVerificationService } from "./application/service";
import type {
  ApplicationOwnershipPort,
  BrandVerificationStore,
  DnsResolverPort,
  SanctionsScreeningPort,
  TrademarkRegistryPort,
  VerificationEmailPort,
  VerificationSecretPort,
} from "./domain/ports";

export interface BrandVerificationModuleOptions {
  readonly store?: BrandVerificationStore;
  /** Supplied by the sellers module (ApplicationOwnershipPort). */
  readonly ownership?: ApplicationOwnershipPort;
  readonly dns?: DnsResolverPort;
  readonly registry?: TrademarkRegistryPort;
  readonly sanctions?: SanctionsScreeningPort;
  readonly email?: VerificationEmailPort;
  readonly secret?: VerificationSecretPort;
}

export class MissingBrandVerificationPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`BrandVerificationModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingBrandVerificationPortsError";
  }
}

@Module({})
export class BrandVerificationModule {
  static forRoot(config: AppConfig, o: BrandVerificationModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.ownership === undefined) missing.push("ownership (sellers ApplicationOwnershipPort)");
      if (o.dns === undefined) missing.push("dns");
      if (o.registry === undefined) missing.push("registry (trademark)");
      if (o.sanctions === undefined) missing.push("sanctions");
      if (o.email === undefined) missing.push("email");
      if (o.secret === undefined) missing.push("secret (KMS HMAC key)");
      if (missing.length > 0) throw new MissingBrandVerificationPortsError(missing);
    }
    const store = o.store ?? new InMemoryBrandVerificationStore();
    const ownership = o.ownership ?? new FakeApplicationOwnership();
    const ports = {
      dns: o.dns ?? new FakeDnsResolver(),
      registry: o.registry ?? new FixtureTrademarkRegistry(),
      sanctions: o.sanctions ?? new FakeSanctionsScreening(),
      email: o.email ?? new FakeVerificationEmail(),
      secret: o.secret ?? new StaticVerificationSecret(),
    };
    return {
      module: BrandVerificationModule,
      controllers: [BrandDomainVerificationController, BrandVerificationAdminController],
      providers: [
        { provide: BRAND_VERIFICATION_STORE, useValue: store },
        { provide: APPLICATION_OWNERSHIP, useValue: ownership },
        { provide: BRAND_VERIFICATION_ADMIN_RESOLVER, useValue: new BrandVerificationAdminResolver() },
        {
          provide: BRAND_VERIFICATION,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator) => new BrandVerificationService({ store, clock, ids, ...ports }),
        },
      ],
      exports: [BRAND_VERIFICATION, BRAND_VERIFICATION_STORE, APPLICATION_OWNERSHIP],
    };
  }
}
