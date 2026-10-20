import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock as PlatformClock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  DenyCrossBorderConsent,
  FakeBackgroundRemoval,
  FakeProductMediaBlobs,
  InMemoryProductMediaStore,
  StaticProductMediaFlags,
} from "./adapters/in-memory";
import { ProductMediaController } from "./adapters/product-media.controller";
import { ProductMediaJobResolver, ProductMediaStoreResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import { UnconfiguredBackgroundRemoval, UnconfiguredProductMediaBlobs } from "./adapters/unconfigured";
import {
  DecideProductPhoto,
  GetProductPhoto,
  IssueProductPhotoUpload,
  ListProductPhotos,
  ProcessProductPhoto,
  RerunProductPhoto,
} from "./application/product-media";
import { ProductImageLinker } from "./application/catalog-link";
import { ListProductVersions, RefineProductPhoto, RestoreProductVersion } from "./application/refine";
import { DEFAULT_PRODUCT_MEDIA_CONFIG, type ProductMediaConfig, type ProductMediaDeps } from "./application/shared";
import {
  FLAG_BACKGROUND_REMOVAL,
  type BackgroundRemovalPort,
  type ProductMediaBlobPort,
  type ProductMediaConsentPort,
  type ProductMediaFlagPort,
  type ProductMediaStore,
} from "./domain/ports";

export interface ProductMediaModuleOptions {
  readonly config?: ProductMediaConfig;
  readonly store?: ProductMediaStore;
  /** Private bucket facade. Default outside dev: Unconfigured (503), nothing is stored. */
  readonly blobs?: ProductMediaBlobPort;
  /** Default outside dev: Unconfigured (503 provider_not_configured). The self-hosted sidecar adapter is bound by the composition root. */
  readonly removal?: BackgroundRemovalPort;
  /** Default: cross-border processing denied. */
  readonly consent?: ProductMediaConsentPort;
  /** Backed by `kill.background_removal` (allowed-when-true, ADR-0028). Fails closed outside test mode when absent. */
  readonly flags?: ProductMediaFlagPort;
}

export class MissingProductMediaPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`ProductMediaModule requires real ${missing.join(", ")} outside test mode: supply them through forRoot(config, options)`);
    this.name = "MissingProductMediaPortsError";
  }
}

@Module({})
export class ProductMediaModule {
  static forRoot(config: AppConfig, o: ProductMediaModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      if (o.flags === undefined) throw new MissingProductMediaPortsError(["flags (kill.background_removal)"]);
    }
    const store = o.store ?? new InMemoryProductMediaStore();
    const inMemory = o.store === undefined;
    const blobs = o.blobs ?? (inMemory ? new FakeProductMediaBlobs() : new UnconfiguredProductMediaBlobs());
    const removal = o.removal ?? (inMemory ? new FakeBackgroundRemoval() : new UnconfiguredBackgroundRemoval());
    const consent = o.consent ?? new DenyCrossBorderConsent();
    const flags = o.flags ?? new StaticProductMediaFlags(new Set([FLAG_BACKGROUND_REMOVAL]));
    const cfg = o.config ?? DEFAULT_PRODUCT_MEDIA_CONFIG;

    const RUNTIME = Symbol("product-media.Runtime");
    const runtime = (clock: PlatformClock, ids: IdGenerator) => {
      const d: ProductMediaDeps = { store, blobs, removal, flags, consent, clock, ids: { uuidV7: () => ids.uuidV7() }, cfg };
      const process = new ProcessProductPhoto(d);
      return {
        issue: new IssueProductPhotoUpload(d),
        process,
        decide: new DecideProductPhoto(d),
        rerun: new RerunProductPhoto(d, process),
        get: new GetProductPhoto(d),
        list: new ListProductPhotos(d),
        refine: new RefineProductPhoto(d),
        versions: new ListProductVersions(d),
        restore: new RestoreProductVersion(d),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({ provide: token, inject: [RUNTIME], useFactory: (r: Runtime) => pick(r) });

    return {
      module: ProductMediaModule,
      // Global so the catalog can resolve "catalog.ImageJobs" without importing this module.
      global: true,
      controllers: [ProductMediaController],
      providers: [
        { provide: "catalog.ImageJobs", useValue: new ProductImageLinker(store, blobs) },
        { provide: T.PRODUCT_MEDIA_STORE, useValue: store },
        { provide: T.PRODUCT_MEDIA_BLOBS, useValue: blobs },
        { provide: T.PRODUCT_MEDIA_REMOVAL, useValue: removal },
        { provide: T.PRODUCT_MEDIA_FLAGS, useValue: flags },
        { provide: T.PRODUCT_MEDIA_STORE_RESOLVER, useValue: new ProductMediaStoreResolver() },
        { provide: T.PRODUCT_MEDIA_RESOLVER, useValue: new ProductMediaJobResolver(store) },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: PlatformClock, ids: IdGenerator) => runtime(c, ids) },
        from(T.ISSUE_PRODUCT_PHOTO_UPLOAD, (r) => r.issue),
        from(T.PROCESS_PRODUCT_PHOTO, (r) => r.process),
        from(T.DECIDE_PRODUCT_PHOTO, (r) => r.decide),
        from(T.RERUN_PRODUCT_PHOTO, (r) => r.rerun),
        from(T.GET_PRODUCT_PHOTO, (r) => r.get),
        from(T.LIST_PRODUCT_PHOTOS, (r) => r.list),
        from(T.REFINE_PRODUCT_PHOTO, (r) => r.refine),
        from(T.LIST_PRODUCT_VERSIONS, (r) => r.versions),
        from(T.RESTORE_PRODUCT_VERSION, (r) => r.restore),
      ],
      exports: [T.PRODUCT_MEDIA_STORE, T.PROCESS_PRODUCT_PHOTO, "catalog.ImageJobs"],
    };
  }
}
