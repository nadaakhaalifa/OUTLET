import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeFaceDetector,
  FakeImageEmbedder,
  FakeImageSafety,
  FakeQueryImageStore,
  FakeShopperContext,
  FakeVisualCatalog,
  FakeVisualConsent,
  InMemoryVisualIndex,
  InMemoryVisualMetrics,
  InMemoryVisualStore,
  NoFaceDetector,
  StaticVisualFlags,
  UnconfiguredImageEmbedder,
  UnconfiguredImageSafety,
  UnconfiguredQueryImageStore,
} from "./adapters/in-memory";
import * as T from "./adapters/tokens";
import { VisualSearchController } from "./adapters/visual-search.controller";
import { IssueQueryUpload, SearchByImage, SimilarByProduct, SweepVisualSearch, type VisualDeps } from "./application/visual-search";
import {
  DEFAULT_LIMITS,
  type FaceRegionDetectorPort,
  type ImageEmbedderPort,
  type ImageSafetyPort,
  type QueryImageStorePort,
  type ShopperContextPort,
  type VisualCatalogPort,
  type VisualConsentPort,
  type VisualFlagsPort,
  type VisualIndexPort,
  type VisualLimits,
  type VisualMetrics,
  type VisualSearchStore,
} from "./domain/ports";

export interface VisualSearchModuleOptions {
  readonly store?: VisualSearchStore;
  readonly images?: QueryImageStorePort;
  readonly embedder?: ImageEmbedderPort;
  readonly faces?: FaceRegionDetectorPort;
  readonly safety?: ImageSafetyPort;
  readonly index?: VisualIndexPort;
  readonly catalog?: VisualCatalogPort;
  readonly shopper?: ShopperContextPort;
  readonly consent?: VisualConsentPort;
  /** Backed by `kill.visual_search`. Absent outside test mode means blocked. */
  readonly flags?: VisualFlagsPort;
  readonly metrics?: VisualMetrics;
  readonly limits?: Partial<VisualLimits>;
}

/**
 * Outside test mode nothing is faked: a missing real port leaves the feature fail-closed (503 with
 * a Problem+JSON code) instead of preventing the API from booting. The embedder, object store and
 * safety classifier are Unconfigured until the model and bucket exist (VR-P3-13, ADR-0023).
 */
@Module({})
export class VisualSearchModule {
  static forRoot(config: AppConfig, o: VisualSearchModuleOptions = {}): DynamicModule {
    const real = config.adapters !== "in-memory-dev";
    const dev = !real;
    const store = o.store ?? (dev ? new InMemoryVisualStore() : null);
    const flags = o.flags ?? new StaticVisualFlags(dev && config.env === "test");
    const embedder = o.embedder ?? (dev && config.env === "test" ? new FakeImageEmbedder() : new UnconfiguredImageEmbedder());
    const images = o.images ?? (dev && config.env === "test" ? new FakeQueryImageStore() : new UnconfiguredQueryImageStore());
    const safety = o.safety ?? (dev && config.env === "test" ? new FakeImageSafety() : new UnconfiguredImageSafety());
    const faces = o.faces ?? (dev && config.env === "test" ? new FakeFaceDetector() : new NoFaceDetector());
    const index = o.index ?? new InMemoryVisualIndex();
    const catalog = o.catalog ?? new FakeVisualCatalog();
    const shopper = o.shopper ?? new FakeShopperContext();
    const consent = o.consent ?? new FakeVisualConsent();
    const metrics = o.metrics ?? new InMemoryVisualMetrics();
    const limits: VisualLimits = { ...DEFAULT_LIMITS, ...o.limits };
    // Without a store (production, not yet composed) nothing can be recorded: stay blocked.
    const effectiveFlags: VisualFlagsPort = store === null ? new StaticVisualFlags(false) : flags;
    const effectiveStore: VisualSearchStore = store ?? new InMemoryVisualStore();

    const RUNTIME = Symbol("visualSearch.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: VisualDeps = { store: effectiveStore, images, embedder, faces, safety, index, catalog, shopper, consent, flags: effectiveFlags, metrics, clock, ids, limits };
      return { issue: new IssueQueryUpload(d), search: new SearchByImage(d), similar: new SimilarByProduct(d), sweep: new SweepVisualSearch(d) };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({ provide: token, inject: [RUNTIME], useFactory: (r: Runtime) => pick(r) });
    return {
      module: VisualSearchModule,
      controllers: [VisualSearchController],
      providers: [
        { provide: T.VISUAL_STORE, useValue: effectiveStore },
        { provide: T.VISUAL_IMAGES, useValue: images },
        { provide: T.VISUAL_EMBEDDER, useValue: embedder },
        { provide: T.VISUAL_INDEX, useValue: index },
        { provide: T.VISUAL_CATALOG, useValue: catalog },
        { provide: T.VISUAL_FLAGS, useValue: effectiveFlags },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids) },
        from(T.ISSUE_QUERY_UPLOAD, (r) => r.issue),
        from(T.SEARCH_BY_IMAGE, (r) => r.search),
        from(T.SIMILAR_BY_PRODUCT, (r) => r.similar),
        from(T.SWEEP_VISUAL_SEARCH, (r) => r.sweep),
      ],
      exports: [T.SWEEP_VISUAL_SEARCH, T.VISUAL_STORE],
    };
  }
}
