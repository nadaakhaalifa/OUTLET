import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock } from "../../platform/ports";
import { CLOCK, CSPRNG, ID_GENERATOR } from "../../platform/tokens";
import type { WishlistRepository } from "./domain/ports";
import type { Csprng } from "@outlet/auth-core";
import type { IdGenerator } from "../../platform/ports";
import {
  InMemoryCatalogRead,
  InMemoryOwnerProfiles,
  InMemoryWishlistEventLog,
  InMemoryWishlistRepository,
  WishlistResourceResolver,
} from "./adapters/in-memory";
import {
  ADD_WISHLIST_ITEM,
  CREATE_SHARE_LINK,
  CREATE_WISHLIST,
  DELETE_WISHLIST,
  GET_SHARED_WISHLIST,
  HANDLE_CATALOG_SIGNAL,
  LIST_WISHLISTS,
  REMOVE_WISHLIST_ITEM,
  REVOKE_SHARE_LINK,
  SCHEDULE_DATE_ALERTS,
  UPDATE_WISHLIST,
  WISHLIST_CATALOG,
  WISHLIST_DETAILS,
  WISHLIST_EVENTS,
  WISHLIST_OWNER_PROFILES,
  WISHLIST_REPOSITORY,
  WISHLIST_RESOLVER,
} from "./adapters/tokens";
import { WishlistsController } from "./adapters/wishlists.controller";
import { HandleCatalogSignal, ScheduleDateAlerts } from "./application/alerts";
import { CreateShareLink, GetSharedWishlist, RevokeShareLink } from "./application/sharing";
import {
  AddWishlistItem,
  CreateWishlist,
  DeleteWishlist,
  ListWishlists,
  RemoveWishlistItem,
  UpdateWishlist,
  WishlistDetails,
} from "./application/wishlists";

export interface WishlistsModuleOptions {
  /** Public base of share links, without a trailing slash. */
  readonly shareBaseUrl?: string;
  /** Replaces the in-memory repository (e.g. KyselyWishlistRepository) once persistence is wired. */
  readonly repository?: WishlistRepository;
}

const DEFAULT_SHARE_BASE_URL = "https://outletnk.invalid/w";

@Module({})
export class WishlistsModule {
  static forRoot(config: AppConfig, options: WishlistsModuleOptions = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    const baseUrl = (options.shareBaseUrl ?? DEFAULT_SHARE_BASE_URL).replace(/\/+$/, "");
    return {
      module: WishlistsModule,
      controllers: [WishlistsController],
      providers: [
        { provide: WISHLIST_REPOSITORY, useValue: options.repository ?? new InMemoryWishlistRepository() },
        { provide: WISHLIST_CATALOG, useValue: new InMemoryCatalogRead() },
        { provide: WISHLIST_OWNER_PROFILES, useValue: new InMemoryOwnerProfiles() },
        { provide: WISHLIST_EVENTS, useValue: new InMemoryWishlistEventLog() },
        {
          provide: WISHLIST_RESOLVER,
          inject: [WISHLIST_REPOSITORY],
          useFactory: (r: WishlistRepository) => new WishlistResourceResolver(r),
        },
        {
          provide: CREATE_WISHLIST,
          inject: [WISHLIST_REPOSITORY, CLOCK, ID_GENERATOR],
          useFactory: (r: WishlistRepository, c: Clock, ids: IdGenerator) =>
            new CreateWishlist(r, c, ids),
        },
        {
          provide: LIST_WISHLISTS,
          inject: [WISHLIST_REPOSITORY, CLOCK],
          useFactory: (r: WishlistRepository, c: Clock) => new ListWishlists(r, c),
        },
        {
          provide: WISHLIST_DETAILS,
          inject: [WISHLIST_REPOSITORY, WISHLIST_CATALOG, CLOCK],
          useFactory: (r: WishlistRepository, cat: InMemoryCatalogRead, c: Clock) =>
            new WishlistDetails(r, cat, c),
        },
        {
          provide: UPDATE_WISHLIST,
          inject: [WISHLIST_REPOSITORY, WISHLIST_DETAILS, CLOCK],
          useFactory: (r: WishlistRepository, d: WishlistDetails, c: Clock) => new UpdateWishlist(r, d, c),
        },
        {
          provide: DELETE_WISHLIST,
          inject: [WISHLIST_REPOSITORY],
          useFactory: (r: WishlistRepository) => new DeleteWishlist(r),
        },
        {
          provide: ADD_WISHLIST_ITEM,
          inject: [WISHLIST_REPOSITORY, WISHLIST_CATALOG, CLOCK, ID_GENERATOR],
          useFactory: (r: WishlistRepository, cat: InMemoryCatalogRead, c: Clock, ids: IdGenerator) =>
            new AddWishlistItem(r, cat, c, ids),
        },
        {
          provide: REMOVE_WISHLIST_ITEM,
          inject: [WISHLIST_REPOSITORY],
          useFactory: (r: WishlistRepository) => new RemoveWishlistItem(r),
        },
        {
          provide: CREATE_SHARE_LINK,
          inject: [WISHLIST_REPOSITORY, CLOCK, CSPRNG, WISHLIST_EVENTS],
          useFactory: (r: WishlistRepository, c: Clock, rng: Csprng, ev: InMemoryWishlistEventLog) =>
            new CreateShareLink(r, c, rng, ev, baseUrl),
        },
        {
          provide: REVOKE_SHARE_LINK,
          inject: [WISHLIST_REPOSITORY, CLOCK, WISHLIST_EVENTS],
          useFactory: (r: WishlistRepository, c: Clock, ev: InMemoryWishlistEventLog) =>
            new RevokeShareLink(r, c, ev),
        },
        {
          provide: GET_SHARED_WISHLIST,
          inject: [WISHLIST_REPOSITORY, WISHLIST_CATALOG, WISHLIST_OWNER_PROFILES, CLOCK],
          useFactory: (
            r: WishlistRepository,
            cat: InMemoryCatalogRead,
            o: InMemoryOwnerProfiles,
            c: Clock,
          ) => new GetSharedWishlist(r, cat, o, c),
        },
        {
          provide: HANDLE_CATALOG_SIGNAL,
          inject: [WISHLIST_REPOSITORY, WISHLIST_EVENTS],
          useFactory: (r: WishlistRepository, ev: InMemoryWishlistEventLog) => new HandleCatalogSignal(r, ev),
        },
        {
          provide: SCHEDULE_DATE_ALERTS,
          inject: [WISHLIST_REPOSITORY, WISHLIST_EVENTS, CLOCK],
          useFactory: (r: WishlistRepository, ev: InMemoryWishlistEventLog, c: Clock) =>
            new ScheduleDateAlerts(r, ev, c),
        },
      ],
    };
  }
}
