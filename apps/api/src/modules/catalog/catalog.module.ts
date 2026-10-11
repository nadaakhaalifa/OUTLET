import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import type { KyselyTransactionRunner } from "../../platform/db";
import { CreateImport, GetImport } from "./application/imports";
import {
  CreateProduct,
  GetPublicProduct,
  GetSellerProduct,
  ListSellerProducts,
  UpdateProduct,
  type CatalogDeps,
} from "./application/products";
import { SellerCatalogController, ShopperCatalogController } from "./adapters/catalog.controller";
import { createCatalogDevFixtures, type CatalogDevFixtures } from "./adapters/in-memory";
import { KyselyImportRepository, KyselyProductRepository, KyselyTaxonomy } from "./adapters/kysely";
import type { CatalogDb, SessionProvider } from "./adapters/kysely";
import { ImportResolver, ProductResolver } from "./adapters/resolvers";
import { StoreAccess } from "./adapters/store-access";
import {
  CATALOG_DEV_FIXTURES,
  CREATE_IMPORT,
  CREATE_PRODUCT,
  GET_IMPORT,
  GET_PUBLIC_PRODUCT,
  GET_SELLER_PRODUCT,
  IMPORT_RESOLVER,
  LIST_SELLER_PRODUCTS,
  PRODUCT_RESOLVER,
  UPDATE_PRODUCT,
} from "./adapters/tokens";

const DEPS = Symbol("catalog.Deps");

/**
 * Selects the Postgres repositories for products, taxonomy and imports. The other ports (stock,
 * prices, stores, uploads, size charts, media, events) belong to other modules and stay on the
 * fixtures until those adapters land, which is why production config is still refused below.
 */
export interface CatalogPersistence {
  readonly runner: KyselyTransactionRunner<CatalogDb>;
  readonly session: SessionProvider;
}

@Module({})
export class CatalogModule {
  static forRoot(
    config: AppConfig,
    fixtures: CatalogDevFixtures = createCatalogDevFixtures(),
    persistence?: CatalogPersistence,
  ): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    const products = persistence ? new KyselyProductRepository(persistence.runner, persistence.session) : fixtures.products;
    const taxonomy = persistence ? new KyselyTaxonomy(persistence.runner, persistence.session) : fixtures.taxonomy;
    const imports = persistence ? new KyselyImportRepository(persistence.runner, persistence.session) : fixtures.imports;
    return {
      module: CatalogModule,
      controllers: [ShopperCatalogController, SellerCatalogController],
      providers: [
        { provide: CATALOG_DEV_FIXTURES, useValue: fixtures },
        { provide: "catalog.ProductRepository", useValue: products },
        { provide: "catalog.ImportRepository", useValue: imports },
        {
          provide: DEPS,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator): CatalogDeps => ({
            products,
            taxonomy,
            uploads: fixtures.uploads,
            stock: fixtures.stock,
            stockSeeder: fixtures.stock,
            prices: fixtures.prices,
            stores: fixtures.stores,
            sizeCharts: fixtures.sizeCharts,
            media: fixtures.media,
            events: fixtures.events,
            clock,
            ids,
          }),
        },
        { provide: CREATE_PRODUCT, inject: [DEPS], useFactory: (d: CatalogDeps) => new CreateProduct(d) },
        { provide: LIST_SELLER_PRODUCTS, inject: [DEPS], useFactory: (d: CatalogDeps) => new ListSellerProducts(d) },
        { provide: GET_SELLER_PRODUCT, inject: [DEPS], useFactory: (d: CatalogDeps) => new GetSellerProduct(d) },
        { provide: UPDATE_PRODUCT, inject: [DEPS], useFactory: (d: CatalogDeps) => new UpdateProduct(d) },
        { provide: GET_PUBLIC_PRODUCT, inject: [DEPS], useFactory: (d: CatalogDeps) => new GetPublicProduct(d) },
        {
          provide: CREATE_IMPORT,
          inject: [DEPS, CREATE_PRODUCT],
          useFactory: (d: CatalogDeps, c: CreateProduct) => new CreateImport({ ...d, imports }, c),
        },
        { provide: GET_IMPORT, useFactory: () => new GetImport(imports) },
        { provide: PRODUCT_RESOLVER, useClass: ProductResolver },
        { provide: IMPORT_RESOLVER, useClass: ImportResolver },
        StoreAccess,
      ],
    };
  }
}
