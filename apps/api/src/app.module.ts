import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "./config/env";
import { AuthModule } from "./modules/auth";
import { CartModule, FakeCatalog, StaticMembership, StaticPlatformConfig } from "./modules/cart";
import { CatalogModule } from "./modules/catalog";
import { InventoryModule } from "./modules/inventory";
import { NotificationsModule, type NotificationsModuleOptions } from "./modules/notifications";
import { PrivacyModule } from "./modules/privacy";
import { SizingModule } from "./modules/sizing";
import { StoresModule, type StoresModuleOptions } from "./modules/stores";
import { WishlistsModule, type WishlistsModuleOptions } from "./modules/wishlists";
import { createPersistence } from "./persistence";
import { PlatformModule, type PlatformOverrides } from "./platform";

/** Per-module options for tests and local composition; production wiring passes none. */
export interface AppModuleOptions {
  readonly stores?: StoresModuleOptions;
  readonly wishlists?: WishlistsModuleOptions;
  readonly notifications?: NotificationsModuleOptions;
}

@Module({})
export class AppModule {
  static register(config: AppConfig, overrides: PlatformOverrides = {}, options: AppModuleOptions = {}): DynamicModule {
    // Postgres adapters when fixtures are off; in-memory stays the dev and test default.
    const pg = config.adapters === "in-memory-dev" ? undefined : createPersistence(config);
    // Dev boot (NODE_ENV=development, fixtures on): CartModule refuses implicit fixtures outside test
    // mode, so the development fixtures are passed explicitly here. DEVELOPMENT FIXTURES, never production.
    const devCart =
      config.adapters === "in-memory-dev" && config.env !== "test"
        ? { catalog: new FakeCatalog(), membership: new StaticMembership(), platformConfig: new StaticPlatformConfig() }
        : {};
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config, overrides),
        AuthModule.forRoot(config),
        PrivacyModule.forRoot(config),
        StoresModule.forRoot(config, { ...pg?.stores, ...options.stores }),
        CatalogModule.forRoot(config, undefined, pg?.catalog),
        WishlistsModule.forRoot(config, { ...pg?.wishlists, ...options.wishlists }),
        CartModule.forRoot(config, { ...devCart, ...pg?.cart }),
        InventoryModule.forRoot(config, pg?.inventory),
        SizingModule.forRoot(config, pg?.sizing),
        NotificationsModule.forRoot(config, { ...pg?.notifications, ...options.notifications }),
      ],
    };
  }
}
