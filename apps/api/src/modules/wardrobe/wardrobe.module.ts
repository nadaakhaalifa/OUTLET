import { Module, type DynamicModule } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock as PlatformClock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { FakeVision, FakeWardrobeImages, InMemoryWardrobeStore, StaticWardrobeFlags } from "./adapters/in-memory";
import { WardrobeItemResolver } from "./adapters/resolvers";
import { LazyStylistPorts } from "./adapters/stylist-ports";
import * as T from "./adapters/tokens";
import { UnconfiguredVision, UnconfiguredWardrobeImages } from "./adapters/unconfigured";
import { WardrobeController } from "./adapters/wardrobe.controller";
import { CompleteFromWardrobe, SuggestOwnedSlots } from "./application/complete";
import { DEFAULT_WARDROBE_CONFIG, FLAG_WARDROBE, FLAG_WARDROBE_VISION, type StylistPorts, type WardrobeConfig, type WardrobeDeps } from "./application/shared";
import {
  ClearWardrobe,
  CreateWardrobeItem,
  DeleteWardrobeItem,
  GetWardrobeImageUrl,
  GetWardrobeItem,
  IssueWardrobeUpload,
  ListWardrobeItems,
  SuggestWardrobeAttributes,
  UpdateWardrobeAttributes,
} from "./application/wardrobe";
import type { VisionAttributePort, WardrobeConsentPort, WardrobeFlagPort, WardrobeImageStorePort, WardrobeStore } from "./domain/ports";

export interface WardrobeModuleOptions {
  readonly config?: WardrobeConfig;
  readonly store?: WardrobeStore;
  /** Private bucket facade. Default outside dev: Unconfigured (503), nothing is stored. */
  readonly images?: WardrobeImageStorePort;
  /** Default outside dev: Unconfigured (503, no vendor contracted, VR-P3-13). */
  readonly vision?: VisionAttributePort;
  /** Default: the stylist's personalization port (consent plus toggle), resolved lazily; cross-border ML denied. */
  readonly consent?: WardrobeConsentPort;
  /** Backed by `kill.wardrobe` and `kill.wardrobe_vision`. Fails closed outside test mode when absent. */
  readonly flags?: WardrobeFlagPort;
  /** Default: the stylist module's own ports, resolved lazily from the same container. */
  readonly stylist?: StylistPorts;
}

export class MissingWardrobePortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`WardrobeModule requires real ${missing.join(", ")} outside test mode: supply them through forRoot(config, options)`);
    this.name = "MissingWardrobePortsError";
  }
}

/**
 * Wardrobe digitization (spec 28 feature 4). Owns persistence, the photo facade and the vision port;
 * the catalog, outfit store, fair use and flags are the stylist's, reached through its public surface.
 */
@Module({})
export class WardrobeModule {
  static forRoot(config: AppConfig, o: WardrobeModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      if (o.flags === undefined) throw new MissingWardrobePortsError(["flags (kill.wardrobe, kill.wardrobe_vision)"]);
    }
    const store = o.store ?? new InMemoryWardrobeStore();
    const inMemory = o.store === undefined;
    const images = o.images ?? (inMemory ? new FakeWardrobeImages() : new UnconfiguredWardrobeImages());
    const vision = o.vision ?? (inMemory ? new FakeVision() : new UnconfiguredVision());
    const flags = o.flags ?? new StaticWardrobeFlags(new Set([FLAG_WARDROBE, FLAG_WARDROBE_VISION]));
    const cfg = o.config ?? DEFAULT_WARDROBE_CONFIG;

    const RUNTIME = Symbol("wardrobe.Runtime");
    const runtime = (ref: ModuleRef, clock: PlatformClock, ids: IdGenerator) => {
      const stylist = o.stylist ?? new LazyStylistPorts(ref);
      const consent: WardrobeConsentPort = o.consent ?? {
        personalizationGranted: (u) => stylist.personalization.enabled(u),
        crossBorderMlGranted: async () => false,
      };
      const d: WardrobeDeps = { store, images, vision, consent, flags, stylist, clock, ids, cfg };
      const owned = new SuggestOwnedSlots(d);
      return {
        issue: new IssueWardrobeUpload(d),
        create: new CreateWardrobeItem(d),
        list: new ListWardrobeItems(d),
        get: new GetWardrobeItem(d),
        update: new UpdateWardrobeAttributes(d),
        suggest: new SuggestWardrobeAttributes(d),
        remove: new DeleteWardrobeItem(d),
        clear: new ClearWardrobe(d),
        image: new GetWardrobeImageUrl(d),
        owned,
        complete: new CompleteFromWardrobe(d, owned),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: WardrobeModule,
      controllers: [WardrobeController],
      providers: [
        { provide: T.WARDROBE_STORE, useValue: store },
        { provide: T.WARDROBE_IMAGES, useValue: images },
        { provide: T.WARDROBE_VISION, useValue: vision },
        { provide: T.WARDROBE_FLAGS, useValue: flags },
        { provide: T.WARDROBE_ITEM_RESOLVER, useValue: new WardrobeItemResolver(store) },
        {
          provide: RUNTIME,
          inject: [ModuleRef, CLOCK, ID_GENERATOR],
          useFactory: (ref: ModuleRef, c: PlatformClock, ids: IdGenerator) => runtime(ref, c, ids),
        },
        from(T.ISSUE_WARDROBE_UPLOAD, (r) => r.issue),
        from(T.CREATE_WARDROBE_ITEM, (r) => r.create),
        from(T.LIST_WARDROBE_ITEMS, (r) => r.list),
        from(T.GET_WARDROBE_ITEM, (r) => r.get),
        from(T.UPDATE_WARDROBE_ATTRIBUTES, (r) => r.update),
        from(T.SUGGEST_WARDROBE_ATTRIBUTES, (r) => r.suggest),
        from(T.DELETE_WARDROBE_ITEM, (r) => r.remove),
        from(T.CLEAR_WARDROBE, (r) => r.clear),
        from(T.GET_WARDROBE_IMAGE_URL, (r) => r.image),
        from(T.SUGGEST_OWNED_SLOTS, (r) => r.owned),
        from(T.COMPLETE_FROM_WARDROBE, (r) => r.complete),
      ],
      exports: [T.WARDROBE_STORE, T.SUGGEST_OWNED_SLOTS],
    };
  }
}
