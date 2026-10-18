import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock } from "../../platform/ports";
import { CLOCK } from "../../platform/tokens";
import type { KyselyTransactionRunner } from "../../platform/db";
import {
  KyselyFavoriteRepository,
  KyselyStoreActivityFeed,
  KyselyStoreRepository,
  type SessionProvider,
  type StoresDb,
} from "./adapters/kysely";
import { devSeedStores } from "./adapters/dev-seed";
import { InMemoryFavoriteRepository, InMemoryStoreActivityFeed, InMemoryStoreRepository } from "./adapters/in-memory";
import { PublicStoresController } from "./adapters/public.controller";
import { FavoriteStoresController, StoresController } from "./adapters/stores.controller";
import {
  APPLY_SELLER_KYC_EVENT,
  CHANGE_STORE_STATUS,
  FAVORITE_REPOSITORY,
  GET_NEW_COUNTS,
  GET_PUBLIC_STORE,
  GET_STORE,
  LIST_FAVORITES,
  LIST_PUBLIC_STORE_SITEMAP,
  LIST_PUBLIC_STORES,
  LIST_STORES,
  MARK_FAVORITE_SEEN,
  REPLACE_FAVORITES,
  STORE_ACTIVITY_FEED,
  STORE_REPOSITORY,
} from "./adapters/tokens";
import { GetStore, ListStores } from "./application/directory";
import { GetPublicStore, ListPublicStores, ListPublicStoreSitemap } from "./application/public";
import { GetNewCounts, ListFavorites, MarkFavoriteSeen, ReplaceFavoriteStores } from "./application/favorites";
import { ApplySellerKycEvent, ChangeStoreStatus } from "./application/seller-lifecycle";
import type { FavoriteRepository, StoreActivityFeed, StoreRepository } from "./domain/ports";
import type { Store } from "./domain/store";

export interface StoresModuleOptions {
  /** Replaces the synthetic dev seed (tests). */
  readonly seed?: readonly Store[];
  /**
   * Selects the Postgres repositories (stores, favourites, activity feed) instead of the in-memory
   * ones. `session` supplies the RLS identity for each transaction.
   */
  readonly persistence?: {
    readonly runner: KyselyTransactionRunner<StoresDb>;
    readonly session: SessionProvider;
  };
}

@Module({})
export class StoresModule {
  static forRoot(config: AppConfig, options: StoresModuleOptions = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev" && options.persistence === undefined) throw new NoProductionAdaptersError();
    const clockOf = (c: Clock) => ({ nowMs: () => c.nowMs() });
    const p = options.persistence;
    const stores = p ? new KyselyStoreRepository(p.runner, p.session) : new InMemoryStoreRepository(options.seed ?? devSeedStores());
    const favorites = p ? new KyselyFavoriteRepository(p.runner, p.session) : new InMemoryFavoriteRepository();
    const feed = p ? new KyselyStoreActivityFeed(p.runner, p.session) : new InMemoryStoreActivityFeed();
    return {
      module: StoresModule,
      controllers: [StoresController, FavoriteStoresController, PublicStoresController],
      providers: [
        { provide: STORE_REPOSITORY, useValue: stores },
        { provide: FAVORITE_REPOSITORY, useValue: favorites },
        { provide: STORE_ACTIVITY_FEED, useValue: feed },
        {
          provide: LIST_STORES,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY],
          useFactory: (s: StoreRepository, f: FavoriteRepository) => new ListStores(s, f),
        },
        {
          provide: GET_STORE,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY],
          useFactory: (s: StoreRepository, f: FavoriteRepository) => new GetStore(s, f),
        },
        {
          provide: LIST_PUBLIC_STORES,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY],
          useFactory: (s: StoreRepository, f: FavoriteRepository) => new ListPublicStores(s, f),
        },
        {
          provide: GET_PUBLIC_STORE,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY],
          useFactory: (s: StoreRepository, f: FavoriteRepository) => new GetPublicStore(s, f),
        },
        {
          provide: LIST_PUBLIC_STORE_SITEMAP,
          inject: [STORE_REPOSITORY],
          useFactory: (s: StoreRepository) => new ListPublicStoreSitemap(s),
        },
        {
          provide: LIST_FAVORITES,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY],
          useFactory: (s: StoreRepository, f: FavoriteRepository) => new ListFavorites(s, f),
        },
        {
          provide: REPLACE_FAVORITES,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY, CLOCK],
          useFactory: (s: StoreRepository, f: FavoriteRepository, c: Clock) =>
            new ReplaceFavoriteStores(s, f, clockOf(c)),
        },
        {
          provide: GET_NEW_COUNTS,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY, STORE_ACTIVITY_FEED],
          useFactory: (s: StoreRepository, f: FavoriteRepository, a: StoreActivityFeed) =>
            new GetNewCounts(s, f, a),
        },
        {
          provide: MARK_FAVORITE_SEEN,
          inject: [STORE_REPOSITORY, FAVORITE_REPOSITORY, CLOCK],
          useFactory: (s: StoreRepository, f: FavoriteRepository, c: Clock) =>
            new MarkFavoriteSeen(s, f, clockOf(c)),
        },
        {
          provide: APPLY_SELLER_KYC_EVENT,
          inject: [STORE_REPOSITORY],
          useFactory: (s: StoreRepository) => new ApplySellerKycEvent(s),
        },
        {
          provide: CHANGE_STORE_STATUS,
          inject: [STORE_REPOSITORY],
          useFactory: (s: StoreRepository) => new ChangeStoreStatus(s),
        },
      ],
      // The brand onboarding composition provisions stores through the repository (composition/brand-wiring.ts).
      exports: [STORE_REPOSITORY],
    };
  }
}
