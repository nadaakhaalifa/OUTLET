import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
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

@Module({})
export class CatalogModule {
  static forRoot(config: AppConfig, fixtures: CatalogDevFixtures = createCatalogDevFixtures()): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    return {
      module: CatalogModule,
      controllers: [ShopperCatalogController, SellerCatalogController],
      providers: [
        { provide: CATALOG_DEV_FIXTURES, useValue: fixtures },
        { provide: "catalog.ProductRepository", useValue: fixtures.products },
        { provide: "catalog.ImportRepository", useValue: fixtures.imports },
        {
          provide: DEPS,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator): CatalogDeps => ({
            products: fixtures.products,
            taxonomy: fixtures.taxonomy,
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
          useFactory: (d: CatalogDeps, c: CreateProduct) => new CreateImport({ ...d, imports: fixtures.imports }, c),
        },
        { provide: GET_IMPORT, useFactory: () => new GetImport(fixtures.imports) },
        { provide: PRODUCT_RESOLVER, useClass: ProductResolver },
        { provide: IMPORT_RESOLVER, useClass: ImportResolver },
        StoreAccess,
      ],
    };
  }
}
