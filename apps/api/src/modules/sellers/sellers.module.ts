import { randomBytes } from "node:crypto";
import { Module, type DynamicModule } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { LocalKeyFieldCipher } from "../auth";
import { BrandApplicationsAdmin } from "./application/admin-port";
import { BrandApplicationService, type StoreNameLookup } from "./application/service";
import { STORE_REPOSITORY, type StoreRepository } from "../stores";
import { SETTINGS_SERVICE, type SettingsService } from "../seller-settings";
import {
  FakeBrandDocumentStore,
  FakeScanPort,
  InMemoryBrandApplicationRepository,
  NullFunnel,
} from "./adapters/in-memory";
import { LazyBrandVerificationLink } from "./adapters/verification-link";
import { SellerApplicationsController } from "./adapters/sellers.controller";
import {
  SELLERS_ADMIN_PORT,
  SELLERS_CIPHER,
  SELLERS_VERIFICATION,
  SELLERS_FUNNEL,
  SELLERS_NOW,
  SELLERS_REPOSITORY,
  SELLERS_SCANNER,
  SELLERS_SERVICE,
  SELLERS_STORE,
} from "./adapters/tokens";
import type {
  BrandApplicationRepository,
  BrandDocumentStore,
  VerificationLink,
  FieldCipherPort,
  FunnelAnalyticsPort,
  ScanPort,
} from "./domain/ports";

export interface SellersModuleOptions {
  readonly repository?: BrandApplicationRepository;
  readonly cipher?: FieldCipherPort;
  /** Private KYC bucket. Unconfigured in production => 503 provider_not_configured on document routes. */
  readonly store?: BrandDocumentStore;
  readonly scanner?: ScanPort;
  /** Link to the brand-verification module. Default resolves it lazily from the Nest container. */
  readonly verification?: VerificationLink;
  readonly analytics?: FunnelAnalyticsPort;
}

/** Resolves the stores module lazily (module-ref, strict false) so the modules compose in either order. */
class LazyStoreNames implements StoreNameLookup {
  constructor(private readonly refs: ModuleRef) {}
  async hasEnglishName(storeId: string): Promise<boolean | null> {
    const present = (v: string | null | undefined): boolean => v !== null && v !== undefined && v.trim().length > 0;
    try {
      // The seller-edited profile wins once saved; before that it mirrors the store identity.
      const settings = this.refs.get<SettingsService>(SETTINGS_SERVICE, { strict: false });
      const p = await settings?.getProfile(storeId);
      if (p !== null && p !== undefined) return present(p.nameEn);
    } catch {
      // fall through to the store row
    }
    try {
      const repo = this.refs.get<StoreRepository>(STORE_REPOSITORY, { strict: false });
      const store = await repo?.findById(storeId);
      return store === null || store === undefined ? null : present(store.nameEn);
    } catch {
      return null;
    }
  }
}

@Module({})
export class SellersModule {
  static forRoot(config: AppConfig, o: SellersModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (o.repository === undefined || o.cipher === undefined || o.store === undefined || o.scanner === undefined)) {
      throw new NoProductionAdaptersError();
    }
    const fakeStore = new FakeBrandDocumentStore();
    return {
      module: SellersModule,
      controllers: [SellerApplicationsController],
      providers: [
        {
          provide: SELLERS_REPOSITORY,
          useFactory: (): BrandApplicationRepository => o.repository ?? new InMemoryBrandApplicationRepository(),
        },
        { provide: SELLERS_CIPHER, useValue: o.cipher ?? new LocalKeyFieldCipher(randomBytes(32)) },
        { provide: SELLERS_STORE, useValue: o.store ?? fakeStore },
        { provide: SELLERS_SCANNER, useValue: o.scanner ?? new FakeScanPort(fakeStore) },
        { provide: SELLERS_VERIFICATION, inject: [ModuleRef], useFactory: (m: ModuleRef): VerificationLink => o.verification ?? new LazyBrandVerificationLink(m) },
        { provide: SELLERS_FUNNEL, useValue: o.analytics ?? new NullFunnel() },
        { provide: SELLERS_NOW, inject: [CLOCK], useFactory: (c: Clock) => () => c.nowMs() },
        {
          provide: SELLERS_SERVICE,
          inject: [SELLERS_REPOSITORY, SELLERS_CIPHER, SELLERS_STORE, SELLERS_SCANNER, SELLERS_VERIFICATION, SELLERS_FUNNEL, CLOCK, ID_GENERATOR, ModuleRef],
          useFactory: (
            repo: BrandApplicationRepository, cipher: FieldCipherPort, store: BrandDocumentStore, scanner: ScanPort,
            verification: VerificationLink, analytics: FunnelAnalyticsPort, clock: Clock, ids: IdGenerator, refs: ModuleRef,
          ) => new BrandApplicationService({ repo, cipher, store, scanner, verification, analytics, clock, ids, storeNames: new LazyStoreNames(refs) }),
        },
        { provide: SELLERS_ADMIN_PORT, inject: [SELLERS_SERVICE], useFactory: (s: BrandApplicationService) => new BrandApplicationsAdmin(s) },
      ],
      exports: [SELLERS_ADMIN_PORT, SELLERS_SERVICE, SELLERS_REPOSITORY],
    };
  }
}
