import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../config/env";
import { CatalogModule, KyselyStoreLocations, type LatePriceBlocks, createCatalogListingSnapshots, createCatalogProductFacts, createCatalogProductionPorts, type CatalogObjectStore } from "../modules/catalog";
import { STANDARD_POOL_ID } from "../modules/inventory";
import { PRICE_BLOCK_READER } from "../modules/price-integrity";
import { KyselyFavoriteRepository, KyselyStoreRepository } from "../modules/stores";
import { CatalogBackedProductRead, NoOwnerNicknames, WishlistsModule } from "../modules/wishlists";
import type { PersistenceWiring } from "../persistence";
import { systemClock } from "../platform/system-adapters";
import { unconfigured } from "./unconfigured";

export interface CatalogWiringOptions {
  /** Public media base URL and HMAC key for signed read URLs (<= 15 min). Null: no media URLs are produced. */
  readonly media?: { readonly baseUrl: string; readonly signingKey: string; readonly ttlSeconds?: number } | null;
  /** Replaces the Unconfigured object store (tests, or a real S3 adapter once configured). */
  readonly objects?: CatalogObjectStore;
}

/**
 * Catalog and wishlists over real Postgres stores. Cross-module reads go through the other modules'
 * public surfaces (inventory, stores, sizing); the object store is the only Unconfigured provider
 * (uploads answer 503 provider_not_configured, reads of existing media keep working). Price evidence
 * is late-bound: until the price-integrity module is composed, every price is plain (no reference).
 */
export function composeCatalogAndWishlists(config: AppConfig, pg: PersistenceWiring, options: CatalogWiringOptions = {}) {
  const storesPersistence = pg.stores.persistence;
  const charts = pg.sizing.repositories?.charts;
  if (storesPersistence === undefined || charts === undefined) throw new Error("catalog wiring needs the stores and sizing Postgres repositories");
  const { ports, prices } = createCatalogProductionPorts({
    inventory: { store: pg.inventory.store, directory: pg.inventory.directory, standardPoolId: STANDARD_POOL_ID, locations: new KyselyStoreLocations(pg.db) },
    stores: {
      stores: new KyselyStoreRepository(storesPersistence.runner, storesPersistence.session),
      favorites: new KyselyFavoriteRepository(storesPersistence.runner, storesPersistence.session),
    },
    charts,
    objects: options.objects ?? unconfigured<CatalogObjectStore>("object.store"),
    media: options.media ?? null,
    clock: systemClock,
  });
  const facts = createCatalogProductFacts(pg.catalog, ports, systemClock);
  const snapshots = createCatalogListingSnapshots(pg.catalog, ports, systemClock);
  const catalog: DynamicModule = CatalogModule.forRoot(config, undefined, pg.catalog, ports);
  const wishlists: DynamicModule = WishlistsModule.forRoot(config, {
    repository: pg.wishlists.repository,
    catalog: new CatalogBackedProductRead(facts),
    owners: new NoOwnerNicknames(),
  });
  return { catalog, wishlists, prices, ports, snapshots };
}

/**
 * Attaches the price-integrity reader (PRICE_BLOCK_READER, its public surface) to the catalog's
 * late-bound price port. Until it is bound every price is plain: no reference, no percentage.
 */
@Module({})
export class CatalogPriceBridgeModule {
  static forRoot(prices: LatePriceBlocks, priceIntegrity: DynamicModule): DynamicModule {
    return {
      module: CatalogPriceBridgeModule,
      imports: [priceIntegrity],
      providers: [
        {
          provide: "outlet.catalogPriceBridge",
          inject: [PRICE_BLOCK_READER],
          useFactory: (reader: Parameters<LatePriceBlocks["bind"]>[0]): true => {
            prices.bind(reader);
            return true;
          },
        },
      ],
    };
  }
}

/** Keeps one top-level import per module: the bridge rides inside the catalog module. */
export function withPriceBridge(catalog: DynamicModule, prices: LatePriceBlocks, priceIntegrity: DynamicModule): DynamicModule {
  return { ...catalog, imports: [...(catalog.imports ?? []), CatalogPriceBridgeModule.forRoot(prices, priceIntegrity)] };
}
