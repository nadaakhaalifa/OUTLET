/** Public surface of the stores module (A2.3). */
export { StoresModule, type StoresModuleOptions } from "./stores.module";
export {
  APPLY_SELLER_KYC_EVENT,
  CHANGE_STORE_STATUS,
  FAVORITE_REPOSITORY,
  STORE_ACTIVITY_FEED,
  STORE_REPOSITORY,
} from "./adapters/tokens";
export type { ApplySellerKycEvent, ChangeStoreStatus } from "./application/seller-lifecycle";
export type { Store } from "./domain/store";
export { SYSTEM_SESSION as STORES_SYSTEM_SESSION, type StoresDb } from "./adapters/kysely";
// Read-side surface for composition (catalog legal-identity projection, favourites).
export { KyselyStoreRepository, KyselyFavoriteRepository } from "./adapters/kysely";
export type { FavoriteRepository, StoreRepository } from "./domain/ports";

// Store provisioning from approved brand applications.
export * from "./provisioning";
export { InMemoryStoreRepository } from "./adapters/in-memory";
export { publicDiscountPct, publicRating } from "./domain/store";
