import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock } from "../../platform/ports";
import { CLOCK, CSPRNG, ID_GENERATOR } from "../../platform/tokens";
import type { CatalogReadPort, OwnerProfilePort, WishlistRepository } from "./domain/ports";
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

/** Thrown at boot when a production port is missing; the in-memory fixtures are never a production fallback. */
export class MissingWishlistPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`WishlistsModule requires ${missing.join(", ")} in production: supply them through WishlistsModule.forRoot(config, options)`);
    this.name = "MissingWishlistPortsError";
  }
}

export interface WishlistsModuleOptions {
  /** Public base of share links, without a trailing slash. */
  readonly shareBaseUrl?: string;
  /** Replaces the in-memory repository (e.g. KyselyWishlistRepository) once persistence is wired. */
  readonly repository?: WishlistRepository;
  /** Product facts (listed, price, summary) through the catalog public surface. */
  readonly catalog?: CatalogReadPort;
  /** Public owner nickname. */
  readonly owners?: OwnerProfilePort;
}

const DEFAULT_SHARE_BASE_URL = "https://outletnk.invalid/w";

@Module({})
export class WishlistsModule {
  static forRoot(config: AppConfig, options: WishlistsModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production) {
      // Persistence option first, then the genuinely external or cross-module ports.
      if (options.repository === undefined) throw new NoProductionAdaptersError();
      const missing = (["catalog", "owners"] as const).filter((k) => options[k] === undefined);
      if (missing.length > 0) throw new MissingWishlistPortsError(missing);
    }
    // Dev/test only: events land in an in-memory log. Postgres writes them to the outbox in the repository transaction.
    const eventLog = new InMemoryWishlistEventLog();
    const catalogPort: CatalogReadPort = options.catalog ?? new InMemoryCatalogRead();
    const ownersPort: OwnerProfilePort = options.owners ?? new InMemoryOwnerProfiles();
    const rawBaseUrl = options.shareBaseUrl ?? DEFAULT_SHARE_BASE_URL;
    let baseEnd = rawBaseUrl.length;
    while (baseEnd > 0 && rawBaseUrl[baseEnd - 1] === "/") baseEnd -= 1;
    const baseUrl = rawBaseUrl.slice(0, baseEnd);
    return {
      module: WishlistsModule,
      controllers: [WishlistsController],
      providers: [
        { provide: WISHLIST_REPOSITORY, useValue: options.repository ?? new InMemoryWishlistRepository(eventLog) },
        { provide: WISHLIST_CATALOG, useValue: catalogPort },
        { provide: WISHLIST_OWNER_PROFILES, useValue: ownersPort },
        ...(production ? [] : [{ provide: WISHLIST_EVENTS, useValue: eventLog }]),
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
          useFactory: (r: WishlistRepository, cat: CatalogReadPort, c: Clock) =>
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
          useFactory: (r: WishlistRepository, cat: CatalogReadPort, c: Clock, ids: IdGenerator) =>
            new AddWishlistItem(r, cat, c, ids),
        },
        {
          provide: REMOVE_WISHLIST_ITEM,
          inject: [WISHLIST_REPOSITORY],
          useFactory: (r: WishlistRepository) => new RemoveWishlistItem(r),
        },
        {
          provide: CREATE_SHARE_LINK,
          inject: [WISHLIST_REPOSITORY, CLOCK, CSPRNG],
          useFactory: (r: WishlistRepository, c: Clock, rng: Csprng) => new CreateShareLink(r, c, rng, baseUrl),
        },
        {
          provide: REVOKE_SHARE_LINK,
          inject: [WISHLIST_REPOSITORY, CLOCK],
          useFactory: (r: WishlistRepository, c: Clock) => new RevokeShareLink(r, c),
        },
        {
          provide: GET_SHARED_WISHLIST,
          inject: [WISHLIST_REPOSITORY, WISHLIST_CATALOG, WISHLIST_OWNER_PROFILES, CLOCK],
          useFactory: (
            r: WishlistRepository,
            cat: CatalogReadPort,
            o: OwnerProfilePort,
            c: Clock,
          ) => new GetSharedWishlist(r, cat, o, c),
        },
        {
          provide: HANDLE_CATALOG_SIGNAL,
          inject: [WISHLIST_REPOSITORY],
          useFactory: (r: WishlistRepository) => new HandleCatalogSignal(r),
        },
        {
          provide: SCHEDULE_DATE_ALERTS,
          inject: [WISHLIST_REPOSITORY, CLOCK],
          useFactory: (r: WishlistRepository, c: Clock) => new ScheduleDateAlerts(r, c),
        },
      ],
    };
  }
}
