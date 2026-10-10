import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "./config/env";
import { AuthModule } from "./modules/auth";
import { CartModule } from "./modules/cart";
import { CatalogModule } from "./modules/catalog";
import { InventoryModule } from "./modules/inventory";
import { NotificationsModule, type NotificationsModuleOptions } from "./modules/notifications";
import { PrivacyModule } from "./modules/privacy";
import { SizingModule } from "./modules/sizing";
import { StoresModule, type StoresModuleOptions } from "./modules/stores";
import { WishlistsModule, type WishlistsModuleOptions } from "./modules/wishlists";
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
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config, overrides),
        AuthModule.forRoot(config),
        PrivacyModule.forRoot(config),
        StoresModule.forRoot(config, options.stores),
        CatalogModule.forRoot(config),
        WishlistsModule.forRoot(config, options.wishlists),
        CartModule.forRoot(config),
        InventoryModule.forRoot(config),
        SizingModule.forRoot(config),
        NotificationsModule.forRoot(config, options.notifications),
      ],
    };
  }
}
