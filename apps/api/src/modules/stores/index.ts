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
