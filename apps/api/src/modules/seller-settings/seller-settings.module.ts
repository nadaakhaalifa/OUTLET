import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { SellerSettingsController } from "./adapters/controller";
import {
  DomainNameMatch,
  FakeEtaVerifier,
  FakeFieldCipher,
  FakeMemberships,
  FakeStoreIdentity,
  FakeStrongFactor,
  FakeUploadScan,
  FakeUploadStore,
  RecordingInviteDelivery,
  StaticLimits,
} from "./adapters/fakes";
import { InMemorySettingsRepository } from "./adapters/in-memory";
import { StoreScopedResolver } from "./adapters/resolvers";
import {
  SELLER_PAYOUT_ACCOUNT_PORT,
  SETTINGS_PAYOUT_RESOLVER,
  SETTINGS_PRODUCT_RESOLVER,
  SETTINGS_STAFF_RESOLVER,
  SETTINGS_REPOSITORY,
  SETTINGS_SERVICE,
  SETTINGS_STORE_IDENTITY,
  SETTINGS_STORE_RESOLVER,
} from "./adapters/tokens";
import { SettingsPayoutAccountAdapter, SettingsService } from "./application/service";
import type {
  EtaVerifierPort,
  FieldCipherPort,
  InviteDeliveryPort,
  NameMatchPort,
  PlatformLimitsPort,
  SellerMembershipsAdminPort,
  SettingsRepository,
  StoreIdentityPort,
  StrongFactorPort,
  UploadScanPort,
  UploadStorePort,
} from "./domain/ports";

export interface SellerSettingsModuleOptions {
  readonly repository?: SettingsRepository;
  readonly identity?: StoreIdentityPort;
  readonly limits?: PlatformLimitsPort;
  readonly uploads?: UploadStorePort;
  readonly scan?: UploadScanPort;
  readonly nameMatch?: NameMatchPort;
  readonly strongFactor?: StrongFactorPort;
  readonly memberships?: SellerMembershipsAdminPort;
  readonly delivery?: InviteDeliveryPort;
  readonly eta?: EtaVerifierPort;
  readonly cipher?: FieldCipherPort;
}

export class MissingSellerSettingsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`SellerSettingsModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingSellerSettingsPortsError";
  }
}

const REQUIRED = ["identity", "uploads", "scan", "nameMatch", "strongFactor", "memberships", "delivery", "eta", "cipher"] as const;

@Module({})
export class SellerSettingsModule {
  static forRoot(config: AppConfig, o: SellerSettingsModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.repository === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing = REQUIRED.filter((k) => o[k] === undefined);
      if (missing.length > 0) throw new MissingSellerSettingsPortsError(missing);
    }
    return {
      module: SellerSettingsModule,
      controllers: [SellerSettingsController],
      providers: [
        { provide: SETTINGS_REPOSITORY, useValue: o.repository ?? new InMemorySettingsRepository() },
        { provide: SETTINGS_STORE_IDENTITY, useValue: o.identity ?? new FakeStoreIdentity() },
        { provide: "SETTINGS_NOW", inject: [CLOCK], useFactory: (c: Clock) => () => c.nowMs() },
        { provide: SETTINGS_STORE_RESOLVER, useValue: new StoreScopedResolver("store_settings") },
        { provide: SETTINGS_PAYOUT_RESOLVER, useValue: new StoreScopedResolver("store_payout") },
        { provide: SETTINGS_STAFF_RESOLVER, useValue: new StoreScopedResolver("store_staff") },
        { provide: SETTINGS_PRODUCT_RESOLVER, useValue: new StoreScopedResolver("store_product") },
        {
          provide: SETTINGS_SERVICE,
          inject: [SETTINGS_REPOSITORY, SETTINGS_STORE_IDENTITY, CLOCK, ID_GENERATOR],
          useFactory: (repo: SettingsRepository, identity: StoreIdentityPort, clock: Clock, ids: IdGenerator) =>
            new SettingsService({
              repo,
              clock,
              ids,
              identity,
              limits: o.limits ?? new StaticLimits(),
              uploads: o.uploads ?? new FakeUploadStore(),
              scan: o.scan ?? new FakeUploadScan(),
              nameMatch: o.nameMatch ?? new DomainNameMatch(),
              strongFactor: o.strongFactor ?? new FakeStrongFactor(),
              memberships: o.memberships ?? new FakeMemberships(),
              delivery: o.delivery ?? new RecordingInviteDelivery(),
              eta: o.eta ?? new FakeEtaVerifier(),
              cipher: o.cipher ?? new FakeFieldCipher(),
            }),
        },
        {
          provide: SELLER_PAYOUT_ACCOUNT_PORT,
          inject: [SETTINGS_REPOSITORY, SETTINGS_STORE_IDENTITY],
          useFactory: (repo: SettingsRepository, identity: StoreIdentityPort) => new SettingsPayoutAccountAdapter(repo, identity),
        },
      ],
      exports: [SETTINGS_SERVICE, SETTINGS_REPOSITORY, SELLER_PAYOUT_ACCOUNT_PORT],
    };
  }
}
