import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock as PlatformClock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { FakeBannerImageUrls, InMemoryHomeBannerStore, RecordingBannerAudit, StaticBannerFlags, UnconfiguredBannerImageUrls } from "./adapters/in-memory";
import { HomeBannersAdminController, HomeBannersController, PublicHomeBannersController } from "./adapters/home-banners.controller";
import { HomeBannerAdminResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import { ChangeBannerStatus, CreateBanner, DeleteBanner, GetBannerAdmin, ListActiveBanners, ListBannersAdmin, PreviewBanners, UpdateBanner, type BannerDeps } from "./application/banners";
import { FLAG_HOME_BANNERS, type BannerAuditPort, type BannerFlagPort, type BannerImageUrlPort, type HomeBannerStore } from "./domain/ports";

export interface HomeBannersModuleOptions {
  readonly store?: HomeBannerStore;
  /** Same hash-chained admin audit the other admin modules use. Required outside dev. */
  readonly audit?: BannerAuditPort;
  /** Backed by `kill.home_banners` (allowed-when-true, ADR-0028). Required outside test mode. */
  readonly flags?: BannerFlagPort;
  /** Default outside dev: Unconfigured (images omitted, the app draws `art_variant`). */
  readonly images?: BannerImageUrlPort;
}

export class MissingHomeBannerPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`HomeBannersModule requires real ${missing.join(", ")} outside test mode: supply them through forRoot(config, options)`);
    this.name = "MissingHomeBannerPortsError";
  }
}

@Module({})
export class HomeBannersModule {
  static forRoot(config: AppConfig, o: HomeBannersModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (o.store === undefined || o.audit === undefined)) throw new NoProductionAdaptersError();
    if ((production || config.env !== "test") && o.flags === undefined) throw new MissingHomeBannerPortsError(["flags (kill.home_banners)"]);
    const inMemory = o.store === undefined;
    const store = o.store ?? new InMemoryHomeBannerStore();
    const audit = o.audit ?? new RecordingBannerAudit();
    const flags = o.flags ?? new StaticBannerFlags(new Set([FLAG_HOME_BANNERS]));
    const images = o.images ?? (inMemory ? new FakeBannerImageUrls() : new UnconfiguredBannerImageUrls());

    const RUNTIME = Symbol("home-banners.Runtime");
    const runtime = (clock: PlatformClock, ids: IdGenerator) => {
      const d: BannerDeps = { store, audit, clock, uuid: () => ids.uuidV7(), flags };
      return {
        create: new CreateBanner(d),
        update: new UpdateBanner(d),
        change: new ChangeBannerStatus(d),
        remove: new DeleteBanner(d),
        list: new ListBannersAdmin(d),
        get: new GetBannerAdmin(d),
        active: new ListActiveBanners(d),
        preview: new PreviewBanners(d),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({ provide: token, inject: [RUNTIME], useFactory: (r: Runtime) => pick(r) });

    return {
      module: HomeBannersModule,
      controllers: [HomeBannersController, HomeBannersAdminController, PublicHomeBannersController],
      providers: [
        { provide: T.HOME_BANNER_STORE, useValue: store },
        { provide: T.HOME_BANNER_AUDIT, useValue: audit },
        { provide: T.HOME_BANNER_FLAGS, useValue: flags },
        { provide: T.HOME_BANNER_IMAGES, useValue: images },
        { provide: T.HOME_BANNER_ADMIN_RESOLVER, useValue: new HomeBannerAdminResolver() },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: PlatformClock, ids: IdGenerator) => runtime(c, ids) },
        from(T.CREATE_HOME_BANNER, (r) => r.create),
        from(T.UPDATE_HOME_BANNER, (r) => r.update),
        from(T.CHANGE_HOME_BANNER_STATUS, (r) => r.change),
        from(T.DELETE_HOME_BANNER, (r) => r.remove),
        from(T.LIST_HOME_BANNERS_ADMIN, (r) => r.list),
        from(T.GET_HOME_BANNER_ADMIN, (r) => r.get),
        from(T.LIST_ACTIVE_HOME_BANNERS, (r) => r.active),
        from(T.PREVIEW_HOME_BANNERS, (r) => r.preview),
      ],
      exports: [T.HOME_BANNER_STORE],
    };
  }
}
