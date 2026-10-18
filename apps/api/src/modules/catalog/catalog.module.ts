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
  ListSellerCategories,
  ListSellerProducts,
  UpdateProduct,
  type CatalogDeps,
} from "./application/products";
import { SellerCatalogController, ShopperCatalogController } from "./adapters/catalog.controller";
import { PublicCatalogController } from "./adapters/public.controller";
import { GetAnonymousProduct, ListProductSitemap } from "./application/public";
import type { ProductImageJobs } from "./domain/ports";
import { createCatalogDevFixtures, type CatalogDevFixtures } from "./adapters/in-memory";
import { KyselyImportRepository, KyselyProductRepository, KyselyTaxonomy } from "./adapters/kysely";
import type { CatalogDb, SessionProvider } from "./adapters/kysely";
import { MissingCatalogPortsError, REQUIRED_CATALOG_PORTS, TransactionalOutboxEvents, type CatalogProductionPorts } from "./adapters/production";
import { ImportResolver, ProductResolver } from "./adapters/resolvers";
import { StoreAccess } from "./adapters/store-access";
import {
  CATALOG_DEV_FIXTURES,
  CREATE_IMPORT,
  CREATE_PRODUCT,
  GET_IMPORT,
  GET_ANONYMOUS_PRODUCT,
  GET_PUBLIC_PRODUCT,
  GET_SELLER_PRODUCT,
  IMPORT_RESOLVER,
  LIST_PRODUCT_SITEMAP,
  LIST_SELLER_CATEGORIES,
  LIST_SELLER_PRODUCTS,
  PRODUCT_RESOLVER,
  UPDATE_PRODUCT,
} from "./adapters/tokens";

const DEPS = Symbol("catalog.Deps");

/**
 * Selects the Postgres repositories for products (events appended in the same transaction),
 * taxonomy and imports.
 */
export interface CatalogPersistence {
  readonly runner: KyselyTransactionRunner<CatalogDb>;
  readonly session: SessionProvider;
}

@Module({})
export class CatalogModule {
  /**
   * Dev and tests: any port not supplied falls back to the in-memory fixtures. Production
   * (`adapters !== "in-memory-dev"`): the persistence option is read first, then every genuinely
   * external or cross-module port must be supplied in `ports`, otherwise boot fails with
   * MissingCatalogPortsError. Fixtures are never a production fallback.
   */
  static forRoot(
    config: AppConfig,
    fixtures: CatalogDevFixtures = createCatalogDevFixtures(),
    persistence?: CatalogPersistence,
    ports?: CatalogProductionPorts,
  ): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && persistence === undefined) throw new NoProductionAdaptersError();
    if (production) {
      const missing = REQUIRED_CATALOG_PORTS.filter((k) => ports?.[k] === undefined);
      if (missing.length > 0) throw new MissingCatalogPortsError(missing);
    }
    const products = persistence ? new KyselyProductRepository(persistence.runner, persistence.session) : fixtures.products;
    const taxonomy = persistence ? new KyselyTaxonomy(persistence.runner, persistence.session) : fixtures.taxonomy;
    const imports = persistence ? new KyselyImportRepository(persistence.runner, persistence.session) : fixtures.imports;
    const p = {
      uploads: ports?.uploads ?? fixtures.uploads,
      stock: ports?.stock ?? fixtures.stock,
      stockSeeder: ports?.stockSeeder ?? fixtures.stock,
      prices: ports?.prices ?? fixtures.prices,
      stores: ports?.stores ?? fixtures.stores,
      sizeCharts: ports?.sizeCharts ?? fixtures.sizeCharts,
      media: ports?.media ?? fixtures.media,
      // Postgres products append their events to the outbox themselves, in the write transaction.
      events: persistence ? new TransactionalOutboxEvents() : fixtures.events,
    };
    return {
      module: CatalogModule,
      controllers: [ShopperCatalogController, SellerCatalogController, PublicCatalogController],
      providers: [
        ...(production ? [] : [{ provide: CATALOG_DEV_FIXTURES, useValue: fixtures }]),
        { provide: "catalog.ProductRepository", useValue: products },
        { provide: "catalog.ImportRepository", useValue: imports },
        {
          provide: DEPS,
          // "catalog.ImageJobs" is bound (globally) by the product-media module when it is composed.
          inject: [CLOCK, ID_GENERATOR, { token: "catalog.ImageJobs", optional: true }],
          useFactory: (clock: Clock, ids: IdGenerator, imageJobs: ProductImageJobs | undefined): CatalogDeps => ({
            products,
            taxonomy,
            ...p,
            clock,
            ids,
            imageJobs: ports?.imageJobs ?? imageJobs,
          }),
        },
        { provide: CREATE_PRODUCT, inject: [DEPS], useFactory: (d: CatalogDeps) => new CreateProduct(d) },
        { provide: LIST_SELLER_PRODUCTS, inject: [DEPS], useFactory: (d: CatalogDeps) => new ListSellerProducts(d) },
        { provide: LIST_SELLER_CATEGORIES, inject: [DEPS], useFactory: (d: CatalogDeps) => new ListSellerCategories(d) },
        { provide: GET_SELLER_PRODUCT, inject: [DEPS], useFactory: (d: CatalogDeps) => new GetSellerProduct(d) },
        { provide: UPDATE_PRODUCT, inject: [DEPS], useFactory: (d: CatalogDeps) => new UpdateProduct(d) },
        { provide: GET_PUBLIC_PRODUCT, inject: [DEPS], useFactory: (d: CatalogDeps) => new GetPublicProduct(d) },
        { provide: GET_ANONYMOUS_PRODUCT, inject: [DEPS], useFactory: (d: CatalogDeps) => new GetAnonymousProduct(d) },
        { provide: LIST_PRODUCT_SITEMAP, inject: [DEPS], useFactory: (d: CatalogDeps) => new ListProductSitemap(d) },
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
