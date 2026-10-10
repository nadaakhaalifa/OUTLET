import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock } from "../../platform/ports";
import { CLOCK } from "../../platform/tokens";
import { devSeedStores } from "./adapters/dev-seed";
import { InMemoryFavoriteRepository, InMemoryStoreActivityFeed, InMemoryStoreRepository } from "./adapters/in-memory";
import { FavoriteStoresController, StoresController } from "./adapters/stores.controller";
import {
  APPLY_SELLER_KYC_EVENT,
  CHANGE_STORE_STATUS,
  FAVORITE_REPOSITORY,
  GET_NEW_COUNTS,
  GET_STORE,
  LIST_FAVORITES,
  LIST_STORES,
  MARK_FAVORITE_SEEN,
  REPLACE_FAVORITES,
  STORE_ACTIVITY_FEED,
  STORE_REPOSITORY,
} from "./adapters/tokens";
import { GetStore, ListStores } from "./application/directory";
import { GetNewCounts, ListFavorites, MarkFavoriteSeen, ReplaceFavoriteStores } from "./application/favorites";
import { ApplySellerKycEvent, ChangeStoreStatus } from "./application/seller-lifecycle";
import type { Store } from "./domain/store";

export interface StoresModuleOptions {
  /** Replaces the synthetic dev seed (tests). */
  readonly seed?: readonly Store[];
}

@Module({})
export class StoresModule {
  static forRoot(config: AppConfig, options: StoresModuleOptions = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    const clockOf = (c: Clock) => ({ nowMs: () => c.nowMs() });
    return {
      module: StoresModule,
      controllers: [StoresController, FavoriteStoresController],
      providers: [
        { provide: STORE_REPOSITORY, useValue: new InMemoryStoreRepository(options.seed ?? devSeedStores()) },
        { provide: FAVORITE_REPOSITORY, useValue: new InMemoryFavoriteRepository() },
        { provide: STORE_ACTIVITY_FEED, useValue: new InMemoryStoreActivityFeed() },
        {
          provide: LIST_STORES,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY],
          useFactory: (s: InMemoryStoreRepository, f: InMemoryFavoriteRepository) => new ListStores(s, f),
        },
        {
          provide: GET_STORE,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY],
          useFactory: (s: InMemoryStoreRepository, f: InMemoryFavoriteRepository) => new GetStore(s, f),
        },
        {
          provide: LIST_FAVORITES,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY],
          useFactory: (s: InMemoryStoreRepository, f: InMemoryFavoriteRepository) => new ListFavorites(s, f),
        },
        {
          provide: REPLACE_FAVORITES,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY, CLOCK],
          useFactory: (s: InMemoryStoreRepository, f: InMemoryFavoriteRepository, c: Clock) =>
            new ReplaceFavoriteStores(s, f, clockOf(c)),
        },
        {
          provide: GET_NEW_COUNTS,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY, STORE_ACTIVITY_FEED],
          useFactory: (s: InMemoryStoreRepository, f: InMemoryFavoriteRepository, a: InMemoryStoreActivityFeed) =>
            new GetNewCounts(s, f, a),
        },
        {
          provide: MARK_FAVORITE_SEEN,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY, CLOCK],
          useFactory: (s: InMemoryStoreRepository, f: InMemoryFavoriteRepository, c: Clock) =>
            new MarkFavoriteSeen(s, f, clockOf(c)),
        },
        {
          provide: APPLY_SELLER_KYC_EVENT,
          inject: [STORE_REPOSITORY],
          useFactory: (s: InMemoryStoreRepository) => new ApplySellerKycEvent(s),
        },
        {
          provide: CHANGE_STORE_STATUS,
          inject: [STORE_REPOSITORY],
          useFactory: (s: InMemoryStoreRepository) => new ChangeStoreStatus(s),
        },
      ],
    };
  }
}
