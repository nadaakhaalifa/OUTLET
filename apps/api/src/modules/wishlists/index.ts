/** Public surface of the wishlists module. Other code imports only this file (A2.3). */
export { MissingWishlistPortsError, WishlistsModule, type WishlistsModuleOptions } from "./wishlists.module";
export { CatalogBackedProductRead, NoOwnerNicknames } from "./adapters/production";
export {
  HANDLE_CATALOG_SIGNAL,
  SCHEDULE_DATE_ALERTS,
  WISHLIST_CATALOG,
  WISHLIST_EVENTS,
  WISHLIST_OWNER_PROFILES,
  WISHLIST_REPOSITORY,
} from "./adapters/tokens";
export { InMemoryCatalogRead, InMemoryOwnerProfiles, InMemoryWishlistEventLog } from "./adapters/in-memory";
export type { HandleCatalogSignal, ScheduleDateAlerts } from "./application/alerts";
export type {
  CatalogProduct,
  CatalogReadPort,
  GiftAddressTokenPort,
  OwnerProfilePort,
  WishlistEvent,
  WishlistEventPublisher,
} from "./domain/ports";
export { KyselyWishlistRepository, type WishlistDb } from "./adapters/kysely-store";
export { createWishlist, itemKey } from "./domain/wishlist";
export { LIMITS as WISHLIST_LIMITS, type Wishlist, type WishlistIntent, type WishlistItem } from "./domain/types";
export type { WishlistRepository } from "./domain/ports";
